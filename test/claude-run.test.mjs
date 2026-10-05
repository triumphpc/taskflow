import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaude, childEnv, redactStderr } from '../agent/lib/claude-run.mjs';
import { reapPidfile } from './helpers/reap.mjs';

const FAKE = fileURLToPath(new URL('./helpers/fake-claude.mjs', import.meta.url));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function tmp() { const d = await mkdtemp(join(tmpdir(), 'tf-run-')); return { d, done: async () => { reapPidfile(join(d, 'pids.json')); await rm(d, { recursive: true, force: true }); } }; }
const base = (env, o = {}) => ({ command: process.execPath, args: [FAKE], input: 'prompt', env: { PATH: process.env.PATH, ...env }, timeoutMs: 5000, pollMs: 0, killGraceMs: 300, passEnv: [/^FAKE_CLAUDE_/], ...o });

test('claude-run: normal exit returns stdout and code, prompt goes through stdin', async () => {
  const { d, done } = await tmp();
  try {
    const r = await runClaude(base({ FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_STDIN_OUT: join(d, 'in.txt') }, { input: 'Привет, задача' }));
    assert.equal(r.kind, 'exit');
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).result.includes('Готовый'), true);
    assert.equal(await readFile(join(d, 'in.txt'), 'utf8'), 'Привет, задача');
  } finally { await done(); }
});

test('claude-run: non-zero exit is reported as exit with the code', async () => {
  const r = await runClaude(base({ FAKE_CLAUDE_MODE: 'exit1' }));
  assert.deepEqual([r.kind, r.code], ['exit', 1]);
});

test('claude-run: hang is killed on timeout and the whole group is dead (AC-022)', async () => {
  const { d, done } = await tmp();
  try {
    const r = await runClaude(base({ FAKE_CLAUDE_MODE: 'hang', FAKE_CLAUDE_PIDFILE: join(d, 'pids.json') }, { timeoutMs: 600 }));
    assert.equal(r.kind, 'timeout');
    const { pid, grandchild } = JSON.parse(await readFile(join(d, 'pids.json'), 'utf8'));
    assert.equal(alive(pid), false);
    assert.equal(alive(grandchild), false);
  } finally { await done(); }
});

test('claude-run: SIGTERM-ignoring process is SIGKILLed after the grace period', async () => {
  const { d, done } = await tmp();
  try {
    const t0 = Date.now();
    const r = await runClaude(base({ FAKE_CLAUDE_MODE: 'hang', FAKE_CLAUDE_IGNORE_TERM: '1', FAKE_CLAUDE_PIDFILE: join(d, 'pids.json') }, { timeoutMs: 500, killGraceMs: 400 }));
    assert.equal(r.kind, 'timeout');
    assert.ok(Date.now() - t0 >= 800);
    assert.equal(alive(JSON.parse(await readFile(join(d, 'pids.json'), 'utf8')).pid), false);
  } finally { await done(); }
});

test('claude-run: shouldAbort stops the process and returns aborted', async () => {
  const { d, done } = await tmp();
  try {
    let calls = 0;
    const r = await runClaude(base({ FAKE_CLAUDE_MODE: 'hang', FAKE_CLAUDE_PIDFILE: join(d, 'pids.json') }, { pollMs: 50, shouldAbort: async () => ++calls >= 3 }));
    assert.equal(r.kind, 'aborted');
    assert.ok(calls >= 3);
    const { pid, grandchild } = JSON.parse(await readFile(join(d, 'pids.json'), 'utf8'));
    assert.equal(alive(pid) || alive(grandchild), false);
  } finally { await done(); }
});

test('claude-run: exception in shouldAbort is logged and does not stop the run', async () => {
  const logs = [];
  const r = await runClaude(base({ FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_DELAY_MS: '300' }, { pollMs: 40, shouldAbort: async () => { throw new Error('network down'); }, log: (e) => logs.push(e) }));
  assert.equal(r.kind, 'exit');
  assert.ok(logs.some((e) => e.event === 'abort_check_failed'));
});

test('claude-run: child does not receive TASKFLOW_MCP_* or TASKFLOW_AGENT_* (C9)', async () => {
  const { d, done } = await tmp();
  try {
    const env = { FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_ENV_OUT: join(d, 'env.json'), TASKFLOW_MCP_URL: 'http://x', TASKFLOW_MCP_TOKEN: 'secret', TASKFLOW_AGENT_CWD: '/x', TASKFLOW_OTHER: 'kept' };
    await runClaude(base(env));
    assert.deepEqual(JSON.parse(await readFile(join(d, 'env.json'), 'utf8')), []);   // белый список: TASKFLOW_* не проходят никогда
    assert.deepEqual(Object.keys(childEnv({ TASKFLOW_MCP_TOKEN: 'a', TASKFLOW_AGENT_X: 'b', HOME: '/h' })), ['HOME']);
  } finally { await done(); }
});

test('claude-run: spawn failure returns spawn_error without throwing', async () => {
  const r = await runClaude(base({}, { command: '/nonexistent/claude-binary' }));
  assert.equal(r.kind, 'spawn_error');
  assert.ok(r.error);
  const r2 = await runClaude(base({}, { spawnImpl: () => { throw new Error('sync boom'); } }));
  assert.equal(r2.kind, 'spawn_error');
});

test('claude-run: stdout is capped, stderr goes to the log only as length, sha256 and a redacted tail', async () => {
  const logs = [];
  const big = ['-e', `process.stdout.write('x'.repeat(5000)); process.stderr.write('E'.repeat(9000));`];
  const r = await runClaude({ command: process.execPath, args: big, input: '', env: { PATH: process.env.PATH }, timeoutMs: 5000, pollMs: 0, stdoutCapBytes: 1000, log: (e) => logs.push(e) });
  assert.equal(r.stdout.length, 1000);
  const ev = logs.find((e) => e.event === 'claude_stderr_tail');
  assert.equal(ev.length, 4096);
  assert.match(ev.sha256, /^[0-9a-f]{64}$/);
  assert.ok(ev.tail.length <= 4096);
  assert.ok(!('stderr' in r));
});

test('claude-run: secrets from the child env and auth headers never reach the log (C15)', async () => {
  const logs = [];
  const secret = 'sk-very-secret-value-123';
  const hdr = 'X-Proxy-Token: header-secret-456';
  const script = `process.stderr.write(${JSON.stringify(`boom ${secret} and Authorization: Bearer abc.def.ghi\nX-Proxy-Token: other-789\nplain ${hdr.split(': ')[1]} end`)});`;
  await runClaude({
    command: process.execPath, args: ['-e', script], input: '', timeoutMs: 5000, pollMs: 0, log: (e) => logs.push(e),
    env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: secret, ANTHROPIC_CUSTOM_HEADERS: hdr },
  });
  const ev = logs.find((e) => e.event === 'claude_stderr_tail');
  const text = JSON.stringify(ev);
  for (const leak of [secret, 'abc.def.ghi', 'other-789', 'header-secret-456']) assert.ok(!text.includes(leak), leak);
  assert.ok(ev.tail.includes('<redacted>'));
  assert.ok(ev.tail.includes('boom'));
});

test('claude-run: redactStderr leaves short values and plain text alone', () => {
  assert.equal(redactStderr('error: file not found', { A: 'x', B: '1' }), 'error: file not found');
  assert.equal(redactStderr('tok=abcdef123', { T: 'abcdef123' }), 'tok=<redacted>');
});

test('claude-run: a normal exit also cleans leftovers of the group', async () => {
  const { d, done } = await tmp();
  try {
    const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(join(d, 'gc'))},String(c.pid));`;
    await runClaude({ command: process.execPath, args: ['-e', script], input: '', env: { PATH: process.env.PATH }, timeoutMs: 5000, pollMs: 0 });
    await wait(200);
    assert.equal(alive(Number(await readFile(join(d, 'gc'), 'utf8'))), false);
  } finally { await done(); }
});

// ---------- security review: SEC07, SEC05 ----------

test('claude-run: child env is a whitelist, TASKFLOW_* and foreign secrets are dropped (SEC07)', () => {
  const env = childEnv({
    PATH: '/bin', HOME: '/h', USER: 'u', LOGNAME: 'u', LANG: 'en_US.UTF-8', LC_ALL: 'C', TMPDIR: '/t', TERM: 'xterm',
    ANTHROPIC_BASE_URL: 'b', AI_LAUNCHER_PAIW_DISABLED_ITEMS: 'd', https_proxy: 'p', HTTP_PROXY: 'p', NO_PROXY: 'n',
    CLAUDE_CODE_FOO: '1', CLAUDE_BIN: '/bin/claude', TASKFLOW_MCP_TOKEN: 's', TASKFLOW_TOKEN: 's', TASKFLOW_DATA: '/d',
    AWS_SECRET_ACCESS_KEY: 'x', GITLAB_TOKEN: 'y', SSH_AUTH_SOCK: '/s',
  });
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_BASE_URL', 'AI_LAUNCHER_PAIW_DISABLED_ITEMS', 'CLAUDE_CODE_FOO', 'HOME', 'HTTP_PROXY',
    'LANG', 'LC_ALL', 'LOGNAME', 'NO_PROXY', 'PATH', 'TERM', 'TMPDIR', 'USER', 'https_proxy'].sort());
});

test('claude-run: a secret cut by the 4096-char tail boundary is still redacted (SEC05)', async () => {
  const secret = 'S3cr3t-Token-ABCDEFGHIJKLMNOP';
  for (const cut of [1, 6, 10, 15, 20, secret.length - 1]) {       // cut = secret chars that fall inside the last 4096
    const logs = [];
    const filler = 'xxxxxxxxx\n'.repeat(500).slice(0, 4095 - cut);
    const text = `${'a'.repeat(100)}\n${secret}\n${filler}`;
    await runClaude({ command: process.execPath, args: ['-e', `process.stderr.write(${JSON.stringify(text)})`], input: '', timeoutMs: 5000, pollMs: 0,
      log: (e) => logs.push(e), env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: secret } });
    const ev = logs.find((e) => e.event === 'claude_stderr_tail');
    assert.equal(ev.length, 4096);
    for (let n = 6; n <= secret.length; n++) {
      for (let i = 0; i + n <= secret.length; i++) assert.ok(!ev.tail.includes(secret.slice(i, i + n)), `fragment ${secret.slice(i, i + n)} (cut ${cut})`);
    }
    assert.ok(ev.tail.length <= 4096);
    assert.ok(ev.tail.startsWith('xxxxxxxxx') || ev.tail.startsWith('<redacted>'), 'no partial first line');
  }
});

test('claude-run: secrets of the daemon env (TASKFLOW_MCP_TOKEN) are redacted although the child does not get them (SEC05)', async () => {
  const logs = [];
  const tok = 'daemon-only-token-987654';
  await runClaude({ command: process.execPath, args: ['-e', `process.stderr.write('leak ${tok} end')`], input: '', timeoutMs: 5000, pollMs: 0, log: (e) => logs.push(e), env: { PATH: process.env.PATH, TASKFLOW_MCP_TOKEN: tok } });
  const ev = logs.find((e) => e.event === 'claude_stderr_tail');
  assert.ok(!ev.tail.includes(tok));
  assert.ok(ev.tail.includes('<redacted>'));
});
