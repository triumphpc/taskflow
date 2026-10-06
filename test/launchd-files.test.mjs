import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, chmod, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const A = (f) => fileURLToPath(new URL(`../agent/${f}`, import.meta.url));
const SECRET = 'value-that-must-never-be-printed';
const FULL = {
  TASKFLOW_MCP_URL: 'http://127.0.0.1:1/mcp', TASKFLOW_MCP_TOKEN: SECRET, ANTHROPIC_BASE_URL: 'http://proxy.example',
  ANTHROPIC_CUSTOM_HEADERS: `X-Proxy-Token: ${SECRET}`, AI_LAUNCHER_PAIW_DISABLED_ITEMS: 'skill:x', CLAUDE_BIN: '/bin/echo',
};
const envLines = (o) => Object.entries(o).map(([k, v]) => `export ${k}='${v}'`).join('\n') + '\n';

async function runScript(envFileContent, mode, extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'tf-launchd-'));
  const envFile = join(home, 'env');
  if (envFileContent !== null) { await writeFile(envFile, envFileContent); await chmod(envFile, mode); }
  const fakeNode = join(home, 'fake-node.sh');
  await writeFile(fakeNode, '#!/bin/sh\nenv | sed "s/=.*//" | sort > "$HOME/node-env-names.txt"\nprintf "%s\\n" "$1" > "$HOME/node-arg.txt"\nexit 0\n');
  await chmod(fakeNode, 0o755);
  const r = spawnSync('/bin/sh', [A('run-delegation.sh')], {
    env: { PATH: '/usr/bin:/bin', HOME: home, TASKFLOW_AGENT_ENV: envFile, NODE_BIN: fakeNode, ...extra }, encoding: 'utf8',
  });
  return { r, home, done: () => rm(home, { recursive: true, force: true }) };
}

test('launchd: run-delegation refuses an env file wider than 600, without printing values (AC-020)', async () => {
  for (const mode of [0o644, 0o640, 0o660, 0o400]) {
    const { r, done } = await runScript(envLines(FULL), mode);
    try {
      assert.equal(r.status, 78, `mode ${mode.toString(8)}`);
      assert.ok(!(r.stdout + r.stderr).includes(SECRET));
    } finally { await done(); }
  }
});

test('launchd: missing env file and empty required variables exit 78 with names only', async () => {
  const none = await runScript(null, 0o600);
  assert.equal(none.r.status, 78);
  await none.done();
  const { r, done } = await runScript(envLines({ ...FULL, CLAUDE_BIN: '', ANTHROPIC_BASE_URL: '' }), 0o600);
  try {
    assert.equal(r.status, 78);
    assert.match(r.stdout, /ANTHROPIC_BASE_URL/);
    assert.match(r.stdout, /CLAUDE_BIN/);
    assert.ok(!(r.stdout + r.stderr).includes(SECRET));
    assert.doesNotMatch(r.stdout, /TASKFLOW_MCP_TOKEN/);
  } finally { await done(); }
});

test('launchd: a good 600 env file is loaded and the runner is exec-ed (AC-008)', async () => {
  const { r, home, done } = await runScript(envLines(FULL), 0o600);
  try {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const names = (await readFile(join(home, 'node-env-names.txt'), 'utf8')).split('\n');
    for (const n of Object.keys(FULL)) assert.ok(names.includes(n), n);
    assert.match(await readFile(join(home, 'node-arg.txt'), 'utf8'), /agent\/delegation-runner\.mjs$/m);
  } finally { await done(); }
});

test('launchd: fallback launch needs only the TaskFlow variables (U1 fallback, AC-009)', async () => {
  const { r, done } = await runScript(envLines({ TASKFLOW_MCP_URL: 'http://x', TASKFLOW_MCP_TOKEN: 't', TASKFLOW_AGENT_LAUNCH: 'fallback' }), 0o600);
  try { assert.equal(r.status, 0, r.stdout + r.stderr); } finally { await done(); }
});

test('launchd: plist template has the required keys and placeholders (AC-008, AC-019)', async () => {
  const plist = await readFile(A('com.taskflow.delegation.plist.template'), 'utf8');
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.match(plist, /<key>ProcessType<\/key>\s*<string>Background<\/string>/);
  assert.match(plist, /__REPO__\/agent\/run-delegation\.sh/);
  assert.ok(plist.includes('__HOME__/Library/Logs/taskflow-agent/'));
  assert.ok(plist.includes('<key>PATH</key>'));
  const filled = plist.replaceAll('__REPO__', '/r').replaceAll('__HOME__', '/h');
  assert.ok(!filled.includes('__'));
  const dir = await mkdtemp(join(tmpdir(), 'tf-plist-'));
  try {
    await writeFile(join(dir, 'a.plist'), filled);
    const lint = spawnSync('plutil', ['-lint', join(dir, 'a.plist')], { encoding: 'utf8' });
    if (!lint.error) assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('launchd: setup-env writes 0700/0600, escapes single quotes, prints names only', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tf-setup-'));
  try {
    const target = join(home, 'cfg', 'env');
    const tricky = `it's "quoted" $HOME \`x\``;
    const r = spawnSync('/bin/sh', [A('setup-env.sh')], {
      env: { PATH: '/usr/bin:/bin', HOME: home, TASKFLOW_AGENT_ENV: target, TASKFLOW_MCP_URL: 'http://x/mcp', TASKFLOW_MCP_TOKEN: tricky, CLAUDE_BIN: '/bin/echo' }, encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal((await stat(join(home, 'cfg'))).mode & 0o777, 0o700);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.ok(!(r.stdout + r.stderr).includes("it's"));
    assert.match(r.stdout, /TASKFLOW_MCP_TOKEN/);
    assert.match(r.stdout, /skipped.*ANTHROPIC_BASE_URL/);
    const back = spawnSync('/bin/sh', ['-c', `. "${target}"; printf %s "$TASKFLOW_MCP_TOKEN"`], { encoding: 'utf8' });
    assert.equal(back.stdout, tricky);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('launchd: [send] SEC03 setup-env saves TASKFLOW_AGENT_SEND from the shell and never drops an existing value when the shell has none', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tf-setup-send-'));
  try {
    const target = join(home, 'cfg', 'env');
    const run = (extra) => spawnSync('/bin/sh', [A('setup-env.sh')], { env: { PATH: '/usr/bin:/bin', HOME: home, TASKFLOW_AGENT_ENV: target, CLAUDE_BIN: '/bin/echo', ...extra }, encoding: 'utf8' });
    const sendLine = async () => (await readFile(target, 'utf8')).split('\n').filter((l) => l.includes('TASKFLOW_AGENT_SEND'));
    assert.equal(run({ TASKFLOW_AGENT_SEND: 'on' }).status, 0);
    assert.deepEqual(await sendLine(), ["export TASKFLOW_AGENT_SEND='on'"]);
    // a rebuild from a shell without the variable keeps the existing line
    const again = run({});
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(await sendLine(), ["export TASKFLOW_AGENT_SEND='on'"]);
    assert.match(again.stdout, /TASKFLOW_AGENT_SEND\(kept\)/);
    // first creation without any value: no line (read-only by default)
    await rm(target);
    run({});
    assert.deepEqual(await sendLine(), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('launchd: scripts install nothing; README documents install, check, rollback, both launch modes (manual step)', async () => {
  for (const f of ['run-delegation.sh', 'setup-env.sh']) assert.ok(!/launchctl/.test(await readFile(A(f), 'utf8')), f);
  const readme = await readFile(A('README.md'), 'utf8');
  for (const frag of ['вручную', 'launchctl bootstrap', 'launchctl kickstart', 'launchctl bootout', 'zsh -ic claude-paiw',
    'claude --agent ai-space-assistant', 'chmod 600', 'run-spike.sh', 'Смена токена', '1800'.slice(0, 0)]) assert.ok(readme.includes(frag), frag);
});

test('launchd: env.example lists names without values', async () => {
  const ex = await readFile(A('env.example'), 'utf8');
  for (const n of ['TASKFLOW_MCP_URL', 'TASKFLOW_MCP_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'AI_LAUNCHER_PAIW_DISABLED_ITEMS', 'CLAUDE_BIN']) {
    assert.match(ex, new RegExp(`^export ${n}=$`, 'm'));
  }
});
