#!/usr/bin/env node
// Stand-in for the claude binary in tests. Mode: FAKE_CLAUDE_MODE
//   ok | needs_info | bad_json | exit1 | max_turns | hang | send
// send: читает --settings из своих аргументов, на каждый вызов из FAKE_CLAUDE_SEND_PLAN (JSON-массив
//   { tool_name, tool_input, agent_id?, agent_type?, tool_use_id?, post?: 'ok'|'fail'|'none', tool_response?, error?, hook_input? })
//   запускает pre-хук; только если он ответил allow, «вызывает» заглушку MCP (файл FAKE_CLAUDE_MCP_OUT), затем post или fail.
//   FAKE_CLAUDE_AFTER=hang: после плана зависнуть (таймаут, abort). Итог: FAKE_CLAUDE_RESULT (JSON {status,text}), по умолчанию review. Хуки исполняются как команды из --settings.
// FAKE_CLAUDE_STDIN_OUT / FAKE_CLAUDE_ENV_OUT / FAKE_CLAUDE_ARGS_OUT / FAKE_CLAUDE_PIDFILE record what it saw.
// FAKE_CLAUDE_IGNORE_TERM=1 makes hang ignore SIGTERM. FAKE_CLAUDE_DELAY_MS delays the answer.
import { writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { stubCall } from './stub-mcp.mjs';

const mode = process.env.FAKE_CLAUDE_MODE || 'ok';
const env = (k) => process.env[k];
if (env('FAKE_CLAUDE_ARGS_OUT')) writeFileSync(env('FAKE_CLAUDE_ARGS_OUT'), JSON.stringify(process.argv.slice(2)));
if (env('FAKE_CLAUDE_ENV_OUT')) {
  writeFileSync(env('FAKE_CLAUDE_ENV_OUT'), JSON.stringify(Object.keys(process.env).filter((k) => /^(TASKFLOW_|AUTONOMOUS_RUN$)/.test(k))));
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
await new Promise((r) => process.stdin.on('end', r));
if (env('FAKE_CLAUDE_STDIN_OUT')) writeFileSync(env('FAKE_CLAUDE_STDIN_OUT'), stdin);

const envelope = (result, extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result, ...extra });
const delay = Number(env('FAKE_CLAUDE_DELAY_MS')) || 0;
if (delay) await new Promise((r) => setTimeout(r, delay));

/** Команда хука из --settings: событие -> строка для sh -c. */
function hookCommands(event) {
  const argv = process.argv.slice(2);
  const raw = argv[argv.indexOf('--settings') + 1];
  return JSON.parse(raw).hooks[event][0].hooks.map((h) => h.command);
}
/** Запускает все хуки события (как claude); решение берётся из первого. */
const runHook = (event, input) => hookCommands(event).map((cmd) => spawnSync('/bin/sh', ['-c', cmd], { input: JSON.stringify(input), encoding: 'utf8', env: process.env }))[0];

function runSendPlan() {
  const plan = JSON.parse(env('FAKE_CLAUDE_SEND_PLAN') || '[]');
  const out = env('FAKE_CLAUDE_MCP_OUT');
  plan.forEach((step, i) => {
    const base = { tool_name: step.tool_name, tool_input: step.tool_input, tool_use_id: step.tool_use_id || `fake-${process.pid}-${i}` };
    if (step.agent_id) { base.agent_id = step.agent_id; base.agent_type = step.agent_type || 'ai-space-comms'; }
    const pre = runHook('PreToolUse', { hook_event_name: 'PreToolUse', ...base, ...(step.hook_input || {}) });
    let allowed = false;
    if (pre.status === 0) {
      try { allowed = JSON.parse(pre.stdout).hookSpecificOutput.permissionDecision === 'allow'; } catch { allowed = false; }
    }
    if (!allowed) return;
    const response = stubCall(out, base);
    if (step.post === 'none') return;
    if (step.post === 'fail') runHook('PostToolUseFailure', { hook_event_name: 'PostToolUseFailure', ...base, error: step.error || 'tool failed' });
    else runHook('PostToolUse', { hook_event_name: 'PostToolUse', ...base, tool_response: step.tool_response ?? response });
  });
}

function hang() {
  if (env('FAKE_CLAUDE_IGNORE_TERM') === '1') process.on('SIGTERM', () => {});
  // Safety net: even if a test forgets to reap, nothing lives longer than two minutes.
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 120000)'], { stdio: 'ignore' });
  setTimeout(() => process.exit(3), 120_000).unref?.();   // same process group
  if (env('FAKE_CLAUDE_PIDFILE')) writeFileSync(env('FAKE_CLAUDE_PIDFILE'), JSON.stringify({ pid: process.pid, grandchild: grandchild.pid }));
  setInterval(() => {}, 1000);
}

switch (mode) {
  case 'send': {
    runSendPlan();
    if (env('FAKE_CLAUDE_AFTER') === 'hang') { hang(); break; }
    const result = env('FAKE_CLAUDE_RESULT') || JSON.stringify({ status: 'review', text: 'Готовый текст результата' });
    console.log(envelope(result));
    break;
  }
  case 'ok': console.log(envelope(JSON.stringify({ status: 'review', text: 'Готовый текст результата' }))); break;
  case 'needs_info': console.log(envelope(JSON.stringify({ status: 'needs_info', text: 'К какому числу нужно?' }))); break;
  case 'bad_json': console.log(envelope('это не JSON')); break;
  case 'max_turns': console.log(envelope('', { subtype: 'error_max_turns', is_error: true })); break;
  case 'exit1': console.error('fake claude failure'); process.exit(1); break;
  case 'hang': hang(); break;
  default: process.exit(2);
}
