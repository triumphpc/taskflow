// Запуск процесса claude: своя группа процессов, промпт через stdin, остановка по таймауту или по
// запросу демона (shouldAbort), лимит stdout, из окружения ребёнка вырезаются токены TaskFlow.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const STDERR_TAIL = 4096;
// Белый список (SEC07): ребёнок получает только то, что нужно claude и прокси; всё остальное из окружения
// демона (токены, TASKFLOW_*, прочие секреты) не передаётся.
const ENV_ALLOW = [
  /^(PATH|HOME|USER|LOGNAME|LANG|TMPDIR|TERM|SHELL)$/, /^LC_[A-Z_]+$/,
  /^ANTHROPIC_/, /^AI_LAUNCHER_PAIW_/,
  /^(http_proxy|https_proxy|no_proxy|HTTP_PROXY|HTTPS_PROXY|NO_PROXY)$/,
  /^CLAUDE_(CODE_|CONFIG_DIR$)/,
];

/** Окружение ребёнка: только белый список; TASKFLOW_* не проходят никогда (C9). `extra` — дополнительные шаблоны (тесты). */
export function childEnv(env = process.env, extra = []) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^TASKFLOW_/.test(k)) continue;
    if (ENV_ALLOW.some((re) => re.test(k)) || extra.some((re) => re.test(k))) out[k] = v;
  }
  return out;
}

const MIN_SECRET_LEN = 6;
const HEADER_LINE = /(authorization|x-proxy-token|proxy-authorization)\s*[:=][^\n]*/gi;
const BEARER = /bearer\s+[A-Za-z0-9._~+\/=-]+/gi;

/** Набор секретов из окружения: значения, их строки и значения «Имя-заголовка: значение». */
export function secretsOf(env = {}) {
  const secrets = new Set();
  for (const v of Object.values(env)) {
    if (typeof v !== 'string') continue;
    if (v.length >= MIN_SECRET_LEN) secrets.add(v);
    for (const line of v.split(/\r?\n/)) if (line.length >= MIN_SECRET_LEN) secrets.add(line.trim());
    for (const line of v.split(/\r?\n/)) {          // «Имя-заголовка: значение» — значение отдельно
      const m = /^[A-Za-z0-9-]+:\s*(.+)$/.exec(line.trim());
      if (m && m[1].length >= MIN_SECRET_LEN) secrets.add(m[1].trim());
    }
  }
  return secrets;
}

/**
 * Хвост stderr для лога (C15): все секреты окружения и строки Authorization / X-Proxy-Token заменены
 * на <redacted>. Длина и sha256 в логе считаются по сырому хвосту.
 */
export function redactStderr(tail, env = {}) {
  const secrets = secretsOf(env);
  let out = tail.replace(HEADER_LINE, '$1: <redacted>').replace(BEARER, 'Bearer <redacted>');
  for (const sec of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(sec).join('<redacted>');
  return out;
}

/**
 * Редактирование по окну (STDERR_TAIL + длина секрета), и только потом обрезка до STDERR_TAIL:
 * секрет на границе хвоста не остаётся обрезанным куском. Неполная первая строка отбрасывается.
 */
export function safeTail(window, truncated, env) {
  let red = redactStderr(window, env);
  if (truncated) { const i = red.indexOf('\n'); red = i >= 0 ? red.slice(i + 1) : ''; }
  if (red.length > STDERR_TAIL) {
    red = red.slice(-STDERR_TAIL);
    const i = red.indexOf('\n');
    red = i >= 0 ? red.slice(i + 1) : '';
  }
  return red;
}

const LIVE = new Set();

/** Немедленно SIGKILL всем живым группам детей (повторный сигнал демону, SEC06). */
export function killTrackedGroups() {
  for (const pid of LIVE) { try { process.kill(-pid, 'SIGKILL'); } catch { /* уже нет */ } }
  LIVE.clear();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

async function stopGroup(pid, killGraceMs) {
  try { process.kill(-pid, 'SIGTERM'); } catch { /* уже нет */ }
  const started = Date.now();
  let killed = false;
  while (groupAlive(pid)) {
    if (!killed && Date.now() - started >= killGraceMs) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* уже нет */ }
      killed = true;
    }
    if (killed && Date.now() - started > killGraceMs + 3000) break;
    await sleep(25);
  }
}

/**
 * @returns {Promise<{kind:'exit',code,signal,stdout,durationMs}|{kind:'aborted',durationMs}|{kind:'timeout',durationMs}|{kind:'spawn_error',error}>}
 */
export function runClaude({
  command, args = [], input = '', env = process.env, cwd,
  timeoutMs, pollMs, killGraceMs = 10_000, stdoutCapBytes = 1_048_576, passEnv = [],
  shouldAbort, signal, spawnImpl = spawn, log = () => {},
}) {
  return new Promise((resolve) => {
    const started = Date.now();
    if (signal?.aborted) { resolve({ kind: 'aborted', durationMs: 0 }); return; }
    const cenv = childEnv(env, passEnv);
    // Секреты — из ПОЛНОГО окружения демона (включая TASKFLOW_MCP_TOKEN), а не только из окружения ребёнка (SEC05).
    const secretLen = Math.min(65_536, Math.max(0, ...[...secretsOf(env)].map((x) => x.length)));
    const windowLen = STDERR_TAIL + secretLen;
    let child;
    try {
      child = spawnImpl(command, args, { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: cenv, cwd });
    } catch (err) {
      resolve({ kind: 'spawn_error', error: err });
      return;
    }

    if (child.pid) LIVE.add(child.pid);
    let settled = false;
    let stopping = null;
    let stdoutBytes = 0;
    const out = [];
    let errTail = '';                              // окно: STDERR_TAIL + максимальная длина секрета
    let errTruncated = false;
    let pollTimer = null;
    let timeoutTimer = null;
    let polling = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (child.pid) LIVE.delete(child.pid);
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', onSignal);
      resolve(result);
    };

    // Остановка демона (SIGTERM/SIGINT): группа ребёнка убивается так же, как при отмене задачи.
    const onSignal = () => stop('aborted');
    signal?.addEventListener('abort', onSignal, { once: true });

    child.on('error', (error) => finish({ kind: 'spawn_error', error }));

    child.stdout.on('data', (d) => {
      if (stdoutBytes >= stdoutCapBytes) return;
      const room = stdoutCapBytes - stdoutBytes;
      const chunk = d.length > room ? d.subarray(0, room) : d;
      stdoutBytes += chunk.length;
      out.push(chunk);
    });
    child.stderr.on('data', (d) => {
      errTail += d.toString('utf8');
      if (errTail.length > windowLen) { errTail = errTail.slice(-windowLen); errTruncated = true; }
    });

    const stop = (kind) => {
      if (stopping || settled) return;
      stopping = kind;
      stopGroup(child.pid, killGraceMs).then(() => finish({ kind, durationMs: Date.now() - started }));
    };

    child.on('close', (code, signal) => {
      if (errTail) {
        const raw = errTail.slice(-STDERR_TAIL);
        log({
          event: 'claude_stderr_tail', length: raw.length,
          sha256: createHash('sha256').update(raw).digest('hex'), tail: safeTail(errTail, errTruncated, env),
        });
      }
      if (stopping) return;                       // результат вернёт stop() после гибели группы
      // Остатки группы (дочерние MCP-процессы) не оставляем.
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* никого нет */ }
      finish({ kind: 'exit', code, signal, stdout: Buffer.concat(out).toString('utf8'), durationMs: Date.now() - started });
    });

    child.stdin.on('error', () => { /* процесс мог закрыть stdin раньше */ });
    child.stdin.end(input);

    if (timeoutMs > 0) timeoutTimer = setTimeout(() => stop('timeout'), timeoutMs);
    if (typeof shouldAbort === 'function' && pollMs > 0) {
      pollTimer = setInterval(async () => {
        if (polling || stopping || settled) return;
        polling = true;
        try {
          if (await shouldAbort()) stop('aborted');
        } catch (err) {
          log({ event: 'abort_check_failed', error: String(err?.message || err).slice(0, 120) });
        } finally { polling = false; }
      }, pollMs);
    }
  });
}
