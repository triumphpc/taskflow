#!/usr/bin/env node
// Демон делегирования: один прогон по расписанию launchd. Берёт делегированные задачи на сегодня,
// запускает claude (только чтение), пишет результат условной командой agent_finish.
// Без зависимостей, Node 18+. Секреты и тексты задач в логи не попадают (C15).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toDateStr } from '../js/core.js';
import { LIMITS } from '../js/agent.js';
import { createTaskflowClient, TaskflowRejected, TaskflowUnavailable } from './lib/taskflow-client.mjs';
import { runClaude, killTrackedGroups } from './lib/claude-run.mjs';
import { createLock } from './lib/lock.mjs';
import { ensureSandbox } from './lib/sandbox.mjs';
import { buildClaudeArgs, buildFallbackInvocation, LIMITS_RUN } from './lib/policy.mjs';
import { buildPrompt } from './lib/prompt.mjs';
import { parseClaudeOutput } from './lib/output.mjs';

export const EXIT = Object.freeze({ OK: 0, FAILURE: 1, CONFIG: 78 });
export const REQUIRED_ENV = ['TASKFLOW_MCP_URL', 'TASKFLOW_MCP_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
  'AI_LAUNCHER_PAIW_DISABLED_ITEMS', 'CLAUDE_BIN'];

const MAX_TEXT = 4 * LIMITS.NOTE_MAX;
const errText = (e) => String(e?.message || e).slice(0, 160);

/**
 * @returns {Promise<{outcome:'locked'|'empty'|'unavailable'|'done', processed:{id:string,status:string}[], reaped:string[]}>}
 */
export async function runOnce({
  client, run = runClaude, lock, env = process.env, now = () => new Date(), log = () => {},
  command, argsPrefix = [], invocation, limits = LIMITS_RUN, cwd, signal, passEnv,
}) {
  const result = { outcome: 'done', processed: [], reaped: [] };
  if (!lock.acquire()) { log({ event: 'locked' }); return { ...result, outcome: 'locked' }; }
  try {
    const today = toDateStr(now());                       // локальная дата Mac (C4, C8)
    let q;
    try { q = await client.queue({ today }); } catch (err) {
      if (err instanceof TaskflowUnavailable) { log({ event: 'unavailable', step: 'queue', error: errText(err) }); return { ...result, outcome: 'unavailable' }; }
      throw err;
    }

    for (const s of q.stale || []) {
      try { await client.reap({ id: s.id }); result.reaped.push(s.id); log({ event: 'reaped', id: s.id }); } catch (err) {
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

      const inv = invocation ? invocation() : { command, args: [...argsPrefix, ...buildClaudeArgs()] };
      const r = await run({
        command: inv.command, args: inv.args, input: buildPrompt(claimed.task || item), env, cwd,
        timeoutMs: limits.TASK_TIMEOUT_MS, pollMs: limits.POLL_MS, killGraceMs: limits.KILL_GRACE_MS,
        stdoutCapBytes: limits.STDOUT_CAP_BYTES, log, signal, passEnv,
        shouldAbort: async () => {
          const t = (await client.queue({ today, taskId: item.id })).task;
          return !t || !t.exists || t.done || t.status !== 'in_progress' || t.claimToken !== claimToken;
        },
      });

      let outcome;
      if (r.kind === 'aborted') {
        log({ event: signal?.aborted ? 'interrupted' : 'aborted', id: item.id });
        result.processed.push({ id: item.id, status: 'aborted' });
        continue;                                      // при остановке демона цикл выше прервётся; задачу вернёт reaper по TTL
      }
      if (r.kind === 'timeout') outcome = { status: 'failed', text: 'Таймаут 15 минут' };
      else if (r.kind === 'spawn_error') outcome = { status: 'failed', text: `Не удалось запустить claude: ${r.error?.code || 'ошибка'}` };
      else outcome = parseClaudeOutput({ stdout: r.stdout, code: r.code, signal: r.signal });
      const text = outcome.text.length > MAX_TEXT ? outcome.text.slice(0, MAX_TEXT) : outcome.text;

      try {
        await client.finish({ id: item.id, claimToken, status: outcome.status, text });
        log({ event: 'finished', id: item.id, status: outcome.status, ms: r.durationMs, costUsd: outcome.costUsd });
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
  const ac = new AbortController();
  // Повторный сигнал (SEC06): не ждём вежливой остановки, убиваем группу ребёнка и выходим.
  let signals = 0;
  const onSignal = (name) => () => {
    signals++;
    log({ event: 'signal', signal: name, count: signals });
    if (signals === 1) { ac.abort(); return; }
    killChildGroups();
    exit(128 + (name === 'SIGINT' ? 2 : 15));
  };
  const onTerm = onSignal('SIGTERM');
  const onInt = onSignal('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  const stateDir = env.TASKFLOW_AGENT_STATE || join(homedir(), '.local', 'state', 'taskflow-agent');
  try {
    const out = await runOnce({
      client: createClient({ url: env.TASKFLOW_MCP_URL, token: env.TASKFLOW_MCP_TOKEN }),
      run, lock: createLock(stateDir), env, log, passEnv,
      command: env.CLAUDE_BIN, invocation: fallback ? buildFallbackInvocation : undefined,
      cwd, signal: ac.signal,
    });
    log({ event: 'run_end', outcome: out.outcome, processed: out.processed.length, reaped: out.reaped.length });
    return EXIT.OK;
  } catch (err) {
    log({ event: 'unexpected_error', error: errText(err) });
    return EXIT.FAILURE;
  } finally {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
