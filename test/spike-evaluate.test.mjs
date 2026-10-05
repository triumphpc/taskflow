// Spike helpers (SEC01 U5 item, SEC04): evaluate.mjs verdicts and run-spike.sh safety checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EVAL = fileURLToPath(new URL('../agent/spike/evaluate.mjs', import.meta.url));
const RUN = fileURLToPath(new URL('../agent/spike/run-spike.sh', import.meta.url));
const ev = (o) => JSON.stringify(o);

async function evaluate(files, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tf-eval-'));
  try {
    for (const [n, c] of Object.entries(files)) await writeFile(join(dir, n), c);
    const r = spawnSync(process.execPath, [EVAL, dir], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
    assert.equal(r.status, 0, r.stderr);
    return { sum: JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8')), mode: (await stat(join(dir, 'summary.json'))).mode & 0o777 };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

const initEv = ev({ type: 'system', subtype: 'init', tools: ['Skill', 'Agent'], mcp_servers: [], permissionMode: 'dontAsk', skills: [], agents: [] });
const use = (id, name, sub) => ev({ type: 'assistant', parent_tool_use_id: sub ? 'p1' : null, message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
const res = (id, isError, text = '') => ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] } });

test('spike evaluate: Read rejected in the main agent and in a sub-agent -> U5 deny items true (SEC01)', async () => {
  const out = [initEv, use('a', 'Read', false), res('a', true, 'denied'), use('b', 'Agent', false), use('c', 'Grep', true), res('c', true, 'denied')].join('\n');
  const { sum, mode } = await evaluate({ 'allowed.txt': 'Skill,Agent', 'denied.txt': 'Read,Grep', 'r4.code': '0', 'r4.out': out, 'r4.err': '', 'canary.id': 'CANARY-X' });
  assert.equal(sum.r4.u5_read_outside_sandbox_rejected, true);
  assert.equal(sum.r4.u5_subagent_inherits_deny, true);
  assert.equal(sum.r4.u5_canary_leaked, false);
  assert.equal(sum.r4.u5_agent_calls, 1);
  assert.equal(mode, 0o600);
});

test('spike evaluate: a successful Read in a sub-agent and a leaked canary are flagged (SEC01)', async () => {
  const out = [initEv, use('c', 'Read', true), res('c', false, 'CANARY-X')].join('\n');
  const { sum } = await evaluate({ 'allowed.txt': '', 'denied.txt': '', 'r4.code': '0', 'r4.out': out, 'r4.err': '', 'canary.id': 'CANARY-X' });
  assert.equal(sum.r4.u5_read_outside_sandbox_rejected, false);
  assert.equal(sum.r4.u5_subagent_inherits_deny, false);
  assert.equal(sum.r4.u5_canary_leaked, true);
});

test('spike evaluate: stderr goes through the daemon redaction, headers and env values (SEC04)', async () => {
  const err = 'boom Authorization: ZZZ-secret-header\nvalue SECRET-FROM-ENV-123 end';
  const { sum } = await evaluate({ 'allowed.txt': '', 'denied.txt': '', 'r2.code': '1', 'r2.out': '', 'r2.err': err }, { SPIKE_SECRET: 'SECRET-FROM-ENV-123' });
  const tail = sum.r2.stderr_tail;
  assert.ok(!tail.includes('ZZZ-secret-header') && !tail.includes('SECRET-FROM-ENV-123'), tail);
  assert.ok(tail.includes('<redacted>'));
});

test('spike run-spike.sh: refuses to start without SPIKE_OUT, exit 78 (SEC04, I13)', () => {
  const r = spawnSync('sh', [RUN], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpdir() } });
  assert.equal(r.status, 78);
  assert.match(r.stderr, /SPIKE_OUT is required/);
});

test('spike run-spike.sh: umask 077 and 0700 output directory (SEC04)', async () => {
  const src = await readFile(RUN, 'utf8');
  assert.match(src, /^umask 077$/m);
  assert.match(src, /mkdir -p -m 700 "\$OUT"/);
  assert.match(src, /chmod 700 "\$OUT"/);
  assert.match(src, /prompt-u5\.txt/);
});
