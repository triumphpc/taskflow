#!/usr/bin/env node
// Stand-in for the claude binary in tests. Mode: FAKE_CLAUDE_MODE
//   ok | needs_info | bad_json | exit1 | max_turns | hang
// FAKE_CLAUDE_STDIN_OUT / FAKE_CLAUDE_ENV_OUT / FAKE_CLAUDE_ARGS_OUT / FAKE_CLAUDE_PIDFILE record what it saw.
// FAKE_CLAUDE_IGNORE_TERM=1 makes hang ignore SIGTERM. FAKE_CLAUDE_DELAY_MS delays the answer.
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const mode = process.env.FAKE_CLAUDE_MODE || 'ok';
const env = (k) => process.env[k];
if (env('FAKE_CLAUDE_ARGS_OUT')) writeFileSync(env('FAKE_CLAUDE_ARGS_OUT'), JSON.stringify(process.argv.slice(2)));
if (env('FAKE_CLAUDE_ENV_OUT')) {
  writeFileSync(env('FAKE_CLAUDE_ENV_OUT'), JSON.stringify(Object.keys(process.env).filter((k) => /^TASKFLOW_/.test(k))));
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
await new Promise((r) => process.stdin.on('end', r));
if (env('FAKE_CLAUDE_STDIN_OUT')) writeFileSync(env('FAKE_CLAUDE_STDIN_OUT'), stdin);

const envelope = (result, extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result, ...extra });
const delay = Number(env('FAKE_CLAUDE_DELAY_MS')) || 0;
if (delay) await new Promise((r) => setTimeout(r, delay));

switch (mode) {
  case 'ok': console.log(envelope(JSON.stringify({ status: 'review', text: 'Готовый текст результата' }))); break;
  case 'needs_info': console.log(envelope(JSON.stringify({ status: 'needs_info', text: 'К какому числу нужно?' }))); break;
  case 'bad_json': console.log(envelope('это не JSON')); break;
  case 'max_turns': console.log(envelope('', { subtype: 'error_max_turns', is_error: true })); break;
  case 'exit1': console.error('fake claude failure'); process.exit(1); break;
  case 'hang': {
    if (env('FAKE_CLAUDE_IGNORE_TERM') === '1') process.on('SIGTERM', () => {});
    // Safety net: even if a test forgets to reap, nothing lives longer than two minutes.
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 120000)'], { stdio: 'ignore' });
    setTimeout(() => process.exit(3), 120_000).unref?.();   // same process group
    if (env('FAKE_CLAUDE_PIDFILE')) writeFileSync(env('FAKE_CLAUDE_PIDFILE'), JSON.stringify({ pid: process.pid, grandchild: grandchild.pid }));
    setInterval(() => {}, 1000);
    break;
  }
  default: process.exit(2);
}
