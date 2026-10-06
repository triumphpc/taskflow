#!/usr/bin/env node
// Демон делегирования: один прогон по расписанию launchd. Берёт делегированные задачи на сегодня,
// запускает claude (режим с отправкой под gate или «только чтение»), пишет результат условной командой
// agent_finish вместе с журналом отправок.
// Без зависимостей, Node 18+. Секреты и тексты задач в логи не попадают (C15).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { toDateStr, datePart } from '../js/core.js';
import { LIMITS } from '../js/agent.js';
import { createTaskflowClient, TaskflowRejected, TaskflowUnavailable } from './lib/taskflow-client.mjs';
import { runClaude, killTrackedGroups } from './lib/claude-run.mjs';
import { createLock } from './lib/lock.mjs';
import { ensureSandbox } from './lib/sandbox.mjs';
import { buildClaudeArgs, buildFallbackInvocation, isSendEnabled, LIMITS_RUN } from './lib/policy.mjs';
import { buildPrompt } from './lib/prompt.mjs';
import { parseClaudeOutput } from './lib/output.mjs';
import { defaultPolicyPath, policyState } from './lib/send-policy.mjs';
import { createRunDir, findLatestRunDir, pruneRunDirs, sweepMcpConfigs } from './lib/run-dir.mjs';
import { buildSendMcpConfig, writeMcpConfig, removeMcpConfig, removeAllMcpConfigs } from './lib/mcp-config.mjs';
import { readAudit, buildJournal } from './lib/audit.mjs';
import { checkSettingsForSend } from './lib/settings-preflight.mjs';
import { readFileSync } from 'node:fs';

export const GATE_PATH = fileURLToPath(new URL('./hooks/send-gate.mjs', import.meta.url));

/** Заметка со спайками S1..S3: вердикты вносит пользователь (SEC03: предупреждение, не запрет). */
export const SPIKE_NOTE = fileURLToPath(new URL('../openspec/changes/archive/2026-10-06-agent-send-actions/spike-s1-s3.md', import.meta.url));
/** @returns {{ s1: boolean, s3: boolean }} true только при строке `S1: PASS` / `S3: PASS` */
export function spikeVerdicts(path = SPIKE_NOTE) {
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { /* нет файла: не пройдено */ }
  return { s1: /^S1: PASS\s*$/m.test(text), s3: /^S3: PASS\s*$/m.test(text) };
}

export const EXIT = Object.freeze({ OK: 0, FAILURE: 1, CONFIG: 78 });
export const REQUIRED_ENV = ['TASKFLOW_MCP_URL', 'TASKFLOW_MCP_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
  'AI_LAUNCHER_PAIW_DISABLED_ITEMS', 'CLAUDE_BIN'];

const MAX_TEXT = 4 * LIMITS.NOTE_MAX;
const errText = (e) => String(e?.message || e).slice(0, 160);

/** Счётчики журнала для лога: только числа, ни адресатов, ни ссылок, ни текстов (C13). */
const journalCounts = (j) => {
  const by = (o) => (j?.entries || []).filter((e) => e.outcome === o).length;
  return { ok: by('ok'), blocked: by('blocked'), error: by('error'), started: by('started'), hiddenBlocked: j?.hidden?.blocked || 0 };
};

/**
 * @returns {Promise<{outcome:'locked'|'empty'|'unavailable'|'done', processed:{id:string,status:string}[], reaped:string[]}>}
 */
export async function runOnce({
  client, run = runClaude, lock, env = process.env, now = () => new Date(), log = () => {},
  command, argsPrefix = [], invocation, limits = LIMITS_RUN, cwd, signal, passEnv,
  send = isSendEnabled(env), stateDir = lock?.stateDir, policyPath, nodePath = process.execPath, gatePath = GATE_PATH,
  runDirs = { create: createRunDir, find: findLatestRunDir, prune: pruneRunDirs },
  mcp = { build: buildSendMcpConfig, write: writeMcpConfig, remove: removeMcpConfig }, audit = { read: readAudit }, spikeNote = SPIKE_NOTE,
}) {
  const result = { outcome: 'done', processed: [], reaped: [] };
  if (send && !stateDir) throw new TypeError('stateDir обязателен в режиме с отправкой');
  const policyFile = policyPath || env.TASKFLOW_AGENT_SEND_POLICY || defaultPolicyPath(env.HOME || homedir());
  /** Журнал из каталога прогона: аудит хуков, склеенный по tool_use_id. Сбой чтения даёт unavailable. */
  const readJournal = (dir, due, id) => {
    try { return buildJournal(audit.read(dir), { due }); } catch (err) {
      log({ event: 'journal_unavailable', id, error: errText(err) });
      return { due: due ?? null, entries: [], unavailable: true };
    }
  };
  if (!lock.acquire()) { log({ event: 'locked' }); return { ...result, outcome: 'locked' }; }
  try {
    const today = toDateStr(now());                       // локальная дата Mac (C4, C8)
    // Остатки mcp.json после SIGKILL прошлого прогона (под замком, живых прогонов нет): и при send=off, чтобы секреты не залёживались.
    if (stateDir) {
      try { const n = sweepMcpConfigs({ stateDir }); if (n) log({ event: 'mcp_config_swept', count: n }); } catch (err) { log({ event: 'mcp_sweep_failed', error: errText(err) }); }
    }
    if (send) {
      // prune делает то же для старых каталогов.
      try { runDirs.prune({ stateDir, now: now().getTime() }); } catch (err) { log({ event: 'prune_failed', error: errText(err) }); }
      log({ event: 'send_mode', send: true, policy: policyState(policyFile) });
      const sp = spikeVerdicts(spikeNote);
      if (!sp.s1 || !sp.s3) log({ event: 'send_spikes_not_passed', s1: sp.s1, s3: sp.s3 });
    } else log({ event: 'send_mode', send: false });
    let q;
    try { q = await client.queue({ today }); } catch (err) {
      if (err instanceof TaskflowUnavailable) { log({ event: 'unavailable', step: 'queue', error: errText(err) }); return { ...result, outcome: 'unavailable' }; }
      throw err;
    }

    for (const s of q.stale || []) {
      // Журнал зависшего прогона берётся из последнего каталога задачи; нет каталога или аудит нечитаем: перевод без журнала.
      let journal;
      if (send) {
        try {
          const found = runDirs.find({ stateDir, taskId: s.id, now: now().getTime(), claimedAt: s.claimedAt ?? null });
          if (found) journal = buildJournal(audit.read(found.dir), { due: found.meta?.due ?? null });
        } catch (err) { log({ event: 'journal_unavailable', id: s.id, error: errText(err) }); journal = undefined; }
      }
      try { await client.reap(journal ? { id: s.id, journal } : { id: s.id }); result.reaped.push(s.id); log({ event: 'reaped', id: s.id }); } catch (err) {
        log({ event: 'reap_refused', id: s.id, error: errText(err) });
      }
    }

    if (!q.queue?.length) { log({ event: 'empty' }); return { ...result, outcome: 'empty' }; }

    for (const item of q.queue.slice(0, limits.MAX_TASKS_PER_RUN)) {
      if (signal?.aborted) break;
      // Захват прямо перед запуском, не пачкой: ожидающая задача не истечёт по TTL.
      let claimed;
      try { claimed = await client.claim({ id: item.id, today }); } catch (err) {
        if (err instanceof TaskflowRejected) { log({ event: 'claim_refused', id: item.id, reason: err.reason }); continue; }
        if (err instanceof TaskflowUnavailable) { log({ event: 'unavailable', step: 'claim', id: item.id }); result.outcome = 'unavailable'; break; }
        throw err;
      }
      const { claimToken } = claimed;
      log({ event: 'claimed', id: item.id });

      const task = claimed.task || item;
      const due = datePart(task.due) ?? null;
      const writeFailed = async (text) => {
        try {
          await client.finish({ id: item.id, claimToken, status: 'failed', text });
          result.processed.push({ id: item.id, status: 'failed' });
        } catch (err) {
          log({ event: err instanceof TaskflowRejected ? 'finish_refused' : 'finish_unavailable', id: item.id, reason: err.reason, error: errText(err) });
          result.processed.push({ id: item.id, status: 'not_written' });
        }
      };

      let runDir;
      if (send) {
        // C15: без ключа journals сервер старый, отправка прошла бы без журнала. До запуска claude задача падает.
        if (!Array.isArray(claimed.journals)) {
          log({ event: 'journals_unsupported', id: item.id });
          await writeFailed('Сервер не поддерживает журнал действий');
          continue;
        }
        try { runDir = runDirs.create({ stateDir, taskId: item.id, due, now: now().getTime(), claim: { claimToken, claimedAt: claimed.claimedAt } }).dir; } catch (err) {
          log({ event: 'run_dir_failed', id: item.id, error: errText(err) });
          await writeFailed('Не удалось подготовить каталог прогона');
          continue;
        }
      }

      // mcp.json (секреты серверов) живёт только вокруг запуска claude: finally ниже снимает его на любом пути
      // (выход, таймаут, abort, SIGTERM демона, spawn_error, исключение). После SIGKILL остаётся sweep.
      let mcpPath = null;
      let mcpFailed = false;
      let r;
      try {
        let mcpSecrets = [];
        if (send) {
          try {
            const cfg = mcp.build({ configDir: env.CLAUDE_CONFIG_DIR, home: env.HOME || homedir() });
            mcpPath = mcp.write(runDir, cfg);
            mcpSecrets = cfg.secrets || [];
            log({ event: 'mcp_config', id: item.id, servers: cfg.found, ...(cfg.missing?.length ? { missing: cfg.missing } : {}) });   // только имена
          } catch (err) {
            mcpFailed = true;
            log({ event: 'mcp_config_failed', id: item.id, reason: err?.reason || 'write_failed' });
          }
        }
        if (!mcpFailed) {
          const buildOpts = send ? { send: true, gate: { nodePath, gatePath, runDir, policyPath: policyFile }, mcpConfigPath: mcpPath } : {};
          const inv = invocation ? invocation(buildOpts) : { command, args: [...argsPrefix, ...buildClaudeArgs(buildOpts)] };
          const prompt = send ? buildPrompt(task, { send: true, previous: claimed.journals.map((j) => j?.text).filter((t) => typeof t === 'string') }) : buildPrompt(task);
          // AUTONOMOUS_RUN=1 только в режиме с отправкой (C14, ADR-008); TASKFLOW_* по-прежнему не доходят до claude.
          const runEnv = send ? { ...env, AUTONOMOUS_RUN: '1' } : env;
          const runPassEnv = send ? [...(passEnv || []), /^AUTONOMOUS_RUN$/] : passEnv;
          r = await run({
            command: inv.command, args: inv.args, input: prompt, env: runEnv, cwd,
            timeoutMs: limits.TASK_TIMEOUT_MS, pollMs: limits.POLL_MS, killGraceMs: limits.KILL_GRACE_MS,
            stdoutCapBytes: limits.STDOUT_CAP_BYTES, log, signal, passEnv: runPassEnv, extraSecrets: mcpSecrets,
            shouldAbort: async () => {
              const t = (await client.queue({ today, taskId: item.id })).task;
              return !t || !t.exists || t.done || t.status !== 'in_progress' || t.claimToken !== claimToken;
            },
          });
        }
      } finally {
        if (mcpPath) {
          try { mcp.remove(mcpPath); } catch (err) { log({ event: 'mcp_config_remove_failed', id: item.id, error: errText(err) }); }
        }
      }
      if (mcpFailed) {
        await writeFailed('Не удалось подготовить MCP-конфиг');
        continue;
      }

      let outcome;
      if (r.kind === 'aborted') {
        log({ event: signal?.aborted ? 'interrupted' : 'aborted', id: item.id });
        if (send) log({ event: 'audit_at_abort', id: item.id, ...journalCounts(readJournal(runDir, due, item.id)) });
        result.processed.push({ id: item.id, status: 'aborted' });
        continue;                                      // при остановке демона цикл выше прервётся; задачу вернёт reaper по TTL
      }
      if (r.kind === 'timeout') outcome = { status: 'failed', text: 'Таймаут 15 минут' };
      else if (r.kind === 'spawn_error') outcome = { status: 'failed', text: `Не удалось запустить claude: ${r.error?.code || 'ошибка'}` };
      else outcome = parseClaudeOutput({ stdout: r.stdout, code: r.code, signal: r.signal });
      const text = outcome.text.length > MAX_TEXT ? outcome.text.slice(0, MAX_TEXT) : outcome.text;
      // Журнал строится из аудита хуков при любом исходе (review, needs_info, failed, таймаут, spawn_error), не из текста модели.
      const journal = send ? readJournal(runDir, due, item.id) : undefined;

      try {
        const fin = await client.finish(send
          ? { id: item.id, claimToken, status: outcome.status, text, journal }
          : { id: item.id, claimToken, status: outcome.status, text });
        if (send && fin?.journalStored !== true) log({ event: 'journal_not_stored', id: item.id });   // результат уже записан, повторять нельзя
        log({ event: 'finished', id: item.id, status: outcome.status, ms: r.durationMs, costUsd: outcome.costUsd, ...(send ? journalCounts(journal) : {}) });
        result.processed.push({ id: item.id, status: outcome.status });
      } catch (err) {
        // Без повторов (C12): отказ — закрыли или сняли делегирование; недоступность — закроет reaper по TTL.
        log({ event: err instanceof TaskflowRejected ? 'finish_refused' : 'finish_unavailable', id: item.id, reason: err.reason, error: errText(err) });
        result.processed.push({ id: item.id, status: 'not_written' });
      }
    }
    return result;
  } finally {
    lock.release();
  }
}

/** JSON-строка в stdout: launchd пишет её в файл лога. */
const stdoutLog = (e) => console.log(JSON.stringify({ at: new Date().toISOString(), ...e }));

export async function main(env = process.env, { log = stdoutLog, run = runClaude, createClient = createTaskflowClient, killChildGroups = killTrackedGroups, exit = (c) => process.exit(c), passEnv } = {}) {
  const fallback = env.TASKFLOW_AGENT_LAUNCH === 'fallback';
  const missing = REQUIRED_ENV.filter((k) => !env[k] && !(fallback && !['TASKFLOW_MCP_URL', 'TASKFLOW_MCP_TOKEN'].includes(k)));
  if (missing.length) {
    log({ event: 'config_error', missing });                    // имена, не значения
    return EXIT.CONFIG;
  }
  let cwd;
  try { cwd = ensureSandbox({ override: env.TASKFLOW_AGENT_CWD, home: env.HOME || homedir() }); } catch (err) {
    log({ event: 'config_error', problem: 'sandbox', error: errText(err) });
    return EXIT.CONFIG;
  }
  if (isSendEnabled(env)) {
    const pf = checkSettingsForSend({ home: env.HOME || homedir(), cwd, configDir: env.CLAUDE_CONFIG_DIR });
    if (!pf.ok) {
      log({ event: 'config_error', problem: 'settings_allow_send', files: pf.problems.map((p) => ({ file: p.file, reason: p.reason })) });   // без значений правил
      return EXIT.CONFIG;
    }
  }
  if (isSendEnabled(env)) {
    try {
      const cfg = buildSendMcpConfig({ configDir: env.CLAUDE_CONFIG_DIR, home: env.HOME || homedir() });
      if (cfg.missing.length) log({ event: 'mcp_servers_missing', servers: cfg.missing });      // только имена
    } catch (err) {
      log({ event: 'config_error', problem: 'mcp_config', reason: err?.reason || 'unknown' });   // без путей и значений
      return EXIT.CONFIG;
    }
  }
  const ac = new AbortController();
  // Повторный сигнал (SEC06): не ждём вежливой остановки, убиваем группу ребёнка и выходим.
  let signals = 0;
  const onSignal = (name) => () => {
    signals++;
    log({ event: 'signal', signal: name, count: signals });
    if (signals === 1) { ac.abort(); return; }
    killChildGroups();
    removeAllMcpConfigs();                        // exit() не даёт выполниться finally: секреты убираем здесь
    exit(128 + (name === 'SIGINT' ? 2 : 15));
  };
  const onTerm = onSignal('SIGTERM');
  const onInt = onSignal('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  process.on('exit', removeAllMcpConfigs);        // последняя страховка: синхронное удаление при любом выходе процесса
  const stateDir = env.TASKFLOW_AGENT_STATE || join(homedir(), '.local', 'state', 'taskflow-agent');
  try {
    const out = await runOnce({
      client: createClient({ url: env.TASKFLOW_MCP_URL, token: env.TASKFLOW_MCP_TOKEN }),
      run, lock: createLock(stateDir), env, log, passEnv,
      command: env.CLAUDE_BIN, invocation: fallback ? buildFallbackInvocation : undefined,
      cwd, signal: ac.signal,
      // Режим и путь политики: TASKFLOW_AGENT_SEND (только `on` включает отправку, SEC03), TASKFLOW_AGENT_SEND_POLICY.
      send: isSendEnabled(env), stateDir,
      policyPath: env.TASKFLOW_AGENT_SEND_POLICY || defaultPolicyPath(env.HOME || homedir()),
    });
    log({ event: 'run_end', outcome: out.outcome, processed: out.processed.length, reaped: out.reaped.length });
    return EXIT.OK;
  } catch (err) {
    log({ event: 'unexpected_error', error: errText(err) });
    return EXIT.FAILURE;
  } finally {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    process.off('exit', removeAllMcpConfigs);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
