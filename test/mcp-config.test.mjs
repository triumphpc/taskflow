// Strict MCP в режиме с отправкой: конфиг из четырёх серверов, файл с секретами живёт только вокруг запуска claude.
// Только временные HOME и CLAUDE_CONFIG_DIR с синтетическим .claude.json и подставной claude; настоящий ~/.claude.json не читается.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, stat, access, chmod } from 'node:fs/promises';
import { existsSync, statSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEND_MCP_SERVERS, buildSendMcpConfig, writeMcpConfig, removeMcpConfig, removeAllMcpConfigs, McpConfigError } from '../agent/lib/mcp-config.mjs';
import { createRunDir, pruneRunDirs, sweepMcpConfigs, RUN_KEEP_MS } from '../agent/lib/run-dir.mjs';
import { runClaude } from '../agent/lib/claude-run.mjs';
import { runOnce, main, EXIT } from '../agent/delegation-runner.mjs';
import { createLock } from '../agent/lib/lock.mjs';
import { LIMITS_RUN } from '../agent/lib/policy.mjs';
import { toDateStr } from '../js/core.js';
import { makeStore } from './helpers/inproc.mjs';
import { fakeTaskflow } from './helpers/fake-taskflow.mjs';
import { reapPidfile } from './helpers/reap.mjs';
import { FAKE_VALUES, userClaudeJson, writeUserClaudeJson } from './helpers/mcp-home.mjs';

const FAKE = fileURLToPath(new URL('./helpers/fake-claude.mjs', import.meta.url));
const TODAY = toDateStr(new Date());
const tmp = () => mkdtemp(join(tmpdir(), 'tf-mcpcfg-'));
const rec = (id) => ({ id, title: `Заголовок ${id}`, notes: '', due: TODAY, done: false, kind: 'task', priority: 4, updatedAt: 100, createdAt: 1, order: 1, agent: { status: 'delegated', claimedAt: null, finishedAt: null, claimToken: null, at: 10 } });
const LIM = { ...LIMITS_RUN, POLL_MS: 50, TASK_TIMEOUT_MS: 1500, KILL_GRACE_MS: 300 };
const exists = (p) => existsSync(p);
const leaks = (text) => Object.values(FAKE_VALUES).filter((v) => String(text).includes(v));
const reason = (fn) => { try { fn(); } catch (err) { return err; } assert.fail('expected an error'); };

// ---------- buildSendMcpConfig ----------

test('mcp-config: copies ONLY the allowlist, verbatim; the key generic:gitlab is not renamed', async () => {
  const home = await tmp();
  try {
    const doc = userClaudeJson();
    await writeUserClaudeJson(home, doc);
    const cfg = buildSendMcpConfig({ home });
    assert.deepEqual(SEND_MCP_SERVERS, ['mcp-workspace-assistant', 'mcp-jira', 'mcp-confluence', 'generic:gitlab']);
    assert.deepEqual(Object.keys(cfg.config.mcpServers), [...SEND_MCP_SERVERS]);
    for (const k of SEND_MCP_SERVERS) assert.deepEqual(cfg.config.mcpServers[k], doc.mcpServers[k], k);
    assert.ok(!('telegram' in cfg.config.mcpServers) && !('mcp-kubernetes' in cfg.config.mcpServers));
    assert.deepEqual(cfg.found, [...SEND_MCP_SERVERS]);
    assert.deepEqual(cfg.missing, []);
    assert.deepEqual(Object.keys(cfg.config), ['mcpServers'], 'nothing but mcpServers is copied (no oauthAccount, projects, ...)');
    // secrets: env and headers values, args (>= 6) and url of the copied servers only
    assert.deepEqual([...cfg.secrets].sort(), [FAKE_VALUES.jira, FAKE_VALUES.confluence, FAKE_VALUES.gitlab, FAKE_VALUES.header, '--serve', '--stdio', 'https://ws.example/mcp'].sort());
    assert.ok(!cfg.secrets.includes(FAKE_VALUES.foreign), 'values of servers outside the allowlist are not read');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('mcp-config: the file is read from CLAUDE_CONFIG_DIR when set, otherwise from HOME', async () => {
  const home = await tmp(); const cfgDir = await tmp();
  try {
    await writeUserClaudeJson(home, { mcpServers: { 'mcp-jira': { type: 'stdio', command: 'from-home' } } });
    await writeUserClaudeJson(cfgDir, { mcpServers: { 'mcp-jira': { type: 'stdio', command: 'from-cfg' } } });
    assert.equal(buildSendMcpConfig({ home }).config.mcpServers['mcp-jira'].command, 'from-home');
    assert.equal(buildSendMcpConfig({ home, configDir: cfgDir }).config.mcpServers['mcp-jira'].command, 'from-cfg');
    assert.equal(buildSendMcpConfig({ home, configDir: '' }).config.mcpServers['mcp-jira'].command, 'from-home', 'empty CLAUDE_CONFIG_DIR means unset');
    assert.equal(reason(() => buildSendMcpConfig({ home: join(home, 'nope'), configDir: join(home, 'nope') })).reason, 'missing_file', 'a missing CLAUDE_CONFIG_DIR file is an error, not a fallback to HOME');
  } finally { await rm(home, { recursive: true, force: true }); await rm(cfgDir, { recursive: true, force: true }); }
});

test('mcp-config: missing file, broken JSON, no mcpServers, nothing from the allowlist: config_error with a fixed reason and no file content', async () => {
  const home = await tmp();
  try {
    const e1 = reason(() => buildSendMcpConfig({ home }));
    assert.ok(e1 instanceof McpConfigError);
    assert.deepEqual([e1.code, e1.reason], ['config_error', 'missing_file']);
    await writeUserClaudeJson(home, `{ "mcpServers": { "mcp-jira": { "env": { "T": "${FAKE_VALUES.jira}"`);
    const e2 = reason(() => buildSendMcpConfig({ home }));
    assert.equal(e2.reason, 'invalid');
    assert.ok(!e2.message.includes(FAKE_VALUES.jira) && !String(e2.stack).includes(FAKE_VALUES.jira), 'the broken text does not reach the error');
    await writeUserClaudeJson(home, { numStartups: 1 });
    assert.equal(reason(() => buildSendMcpConfig({ home })).reason, 'no_servers');
    await writeUserClaudeJson(home, { mcpServers: [] });
    assert.equal(reason(() => buildSendMcpConfig({ home })).reason, 'invalid');
    await writeUserClaudeJson(home, { mcpServers: { telegram: { type: 'stdio', command: 'x' } } });
    assert.equal(reason(() => buildSendMcpConfig({ home })).reason, 'no_servers', 'servers exist but none from the allowlist');
    await writeUserClaudeJson(home, { mcpServers: { 'mcp-jira': 'not-an-object' } });
    assert.equal(reason(() => buildSendMcpConfig({ home })).reason, 'no_servers');
    await rm(join(home, '.claude.json'));
    await mkdir(join(home, '.claude.json'));                               // a directory instead of a file: unreadable
    assert.equal(reason(() => buildSendMcpConfig({ home })).reason, 'unreadable');
    assert.equal(reason(() => buildSendMcpConfig({})).reason, 'no_home');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('mcp-config: a server missing from the file is skipped and reported by NAME only', async () => {
  const home = await tmp();
  try {
    const doc = userClaudeJson();
    delete doc.mcpServers['mcp-confluence'];
    delete doc.mcpServers['generic:gitlab'];
    await writeUserClaudeJson(home, doc);
    const cfg = buildSendMcpConfig({ home });
    assert.deepEqual(cfg.found, ['mcp-workspace-assistant', 'mcp-jira']);
    assert.deepEqual(cfg.missing, ['mcp-confluence', 'generic:gitlab']);
    assert.ok(!JSON.stringify(cfg.missing).includes(FAKE_VALUES.confluence));
  } finally { await rm(home, { recursive: true, force: true }); }
});

// ---------- writeMcpConfig ----------

test('mcp-config: mcp.json is written with flag wx and mode 0600, verbatim, and removed without error twice', async () => {
  const home = await tmp(); const runDir = await tmp();
  try {
    await writeUserClaudeJson(home);
    const cfg = buildSendMcpConfig({ home });
    const path = writeMcpConfig(runDir, cfg);
    assert.equal(path, join(runDir, 'mcp.json'));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), cfg.config);
    assert.throws(() => writeMcpConfig(runDir, cfg), (e) => e.code === 'EEXIST', 'wx: an existing file is never overwritten');
    removeMcpConfig(path);
    removeMcpConfig(path);
    assert.ok(!exists(path));
    // tracked paths go away together (second signal / process exit)
    const p2 = writeMcpConfig(runDir, cfg);
    removeAllMcpConfigs();
    assert.ok(!exists(p2));
  } finally { await rm(home, { recursive: true, force: true }); await rm(runDir, { recursive: true, force: true }); }
});

// ---------- sweep ----------

test('run-dir: sweepMcpConfigs and pruneRunDirs remove leftover mcp.json from run dirs, young ones included; the dirs stay', async () => {
  const state = await tmp();
  try {
    const young = createRunDir({ stateDir: state, taskId: 'y', now: Date.now() }).dir;
    const old = createRunDir({ stateDir: state, taskId: 'o', now: Date.now() - RUN_KEEP_MS - 1000 }).dir;
    const other = createRunDir({ stateDir: state, taskId: 'z', now: Date.now() - 1000 }).dir;
    for (const d of [young, old, other]) writeFileSync(join(d, 'mcp.json'), '{"secret":1}', { mode: 0o600 });
    assert.equal(sweepMcpConfigs({ stateDir: state }), 3);
    for (const d of [young, old, other]) assert.ok(exists(d) && !exists(join(d, 'mcp.json')) && exists(join(d, 'meta.json')));
    for (const d of [young, other]) writeFileSync(join(d, 'mcp.json'), '{"secret":1}', { mode: 0o600 });
    const removed = pruneRunDirs({ stateDir: state });
    assert.equal(removed, 1, 'only the old dir is pruned');
    assert.ok(exists(young) && exists(other) && !exists(old));
    assert.ok(!exists(join(young, 'mcp.json')) && !exists(join(other, 'mcp.json')), 'prune also strips mcp.json from dirs that stay');
    assert.equal(sweepMcpConfigs({ stateDir: join(state, 'none') }), 0);
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('run-dir: sweep ignores symlinked dirs and files that are not named mcp.json', async () => {
  const state = await tmp(); const target = await tmp();
  try {
    mkdirSync(join(state, 'runs'), { recursive: true });
    writeFileSync(join(target, 'mcp.json'), 'keep');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(target, join(state, 'runs', 'link-1'));
    const d = createRunDir({ stateDir: state, taskId: 'a' }).dir;
    writeFileSync(join(d, 'meta2.json'), 'keep');
    assert.equal(sweepMcpConfigs({ stateDir: state }), 0);
    assert.equal(await readFile(join(target, 'mcp.json'), 'utf8'), 'keep');
    assert.ok(exists(join(d, 'meta2.json')));
  } finally { await rm(state, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); }
});

// ---------- runClaude: extra secrets in stderr ----------

test('claude-run: extraSecrets (values from mcp.json) are redacted in the stderr tail, the child env does not carry them', async () => {
  const d = await tmp();
  try {
    await writeFile(join(d, 'err.txt'), `boom ${FAKE_VALUES.jira} and ${FAKE_VALUES.header}`);
    const go = async (extraSecrets) => {
      const logs = [];
      const r = await runClaude({
        command: process.execPath, args: [FAKE], env: { PATH: process.env.PATH, FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_STDERR_FILE: join(d, 'err.txt') },
        passEnv: [/^FAKE_CLAUDE_/], timeoutMs: 5000, pollMs: 0, log: (e) => logs.push(e), extraSecrets,
      });
      assert.equal(r.kind, 'exit');
      return logs.find((e) => e.event === 'claude_stderr_tail');
    };
    assert.ok((await go([])).tail.includes(FAKE_VALUES.jira), 'control: without extraSecrets the value is not known to the redactor');
    const ev = await go([FAKE_VALUES.jira, FAKE_VALUES.header]);
    assert.ok(ev.tail.includes('boom <redacted> and <redacted>'), ev.tail);
    assert.deepEqual(leaks(JSON.stringify(ev)), []);
  } finally { await rm(d, { recursive: true, force: true }); }
});

// ---------- runOnce: file lifecycle on every path ----------

async function sendSetup(tasks, { fakeEnv = {}, limits = LIM, doc } = {}) {
  const { store, cleanup } = await makeStore({ tasks });
  const dir = await mkdtemp(join(tmpdir(), 'tf-mcprun-'));
  await writeUserClaudeJson(dir, doc);
  const logs = [];
  const client = fakeTaskflow(store);
  const env = { PATH: process.env.PATH, HOME: dir, TASKFLOW_AGENT_SEND: 'on', TASKFLOW_AGENT_SEND_POLICY: join(dir, 'send-policy.json'),
    TASKFLOW_MCP_TOKEN: 'runner-secret-token', FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_ARGS_OUT: join(dir, 'args.json'),
    FAKE_CLAUDE_MCP_SNAPSHOT_OUT: join(dir, 'snap.json'), FAKE_CLAUDE_PIDFILE: join(dir, 'pids.json'), ...fakeEnv };
  const lock = createLock(join(dir, 'state'));
  const stateDir = join(dir, 'state');
  const go = (o = {}) => runOnce({ client, lock, env, log: (e) => logs.push(e), command: process.execPath, argsPrefix: [FAKE], limits, passEnv: [/^FAKE_CLAUDE_/], stateDir, ...o });
  const mcpFiles = async () => {
    let names = [];
    try { names = await readdir(join(stateDir, 'runs')); } catch { return []; }
    return names.map((n) => join(stateDir, 'runs', n, 'mcp.json')).filter(exists);
  };
  const runDirs = async () => (await readdir(join(stateDir, 'runs'))).map((n) => join(stateDir, 'runs', n));
  return { store, client, dir, logs, go, env, stateDir, mcpFiles, runDirs, snap: async () => JSON.parse(await readFile(join(dir, 'snap.json'), 'utf8')),
    cleanup: async () => { reapPidfile(join(dir, 'pids.json')); await cleanup(); await rm(dir, { recursive: true, force: true }); } };
}
const taskOf = (store, id) => store.snapshot().tasks.find((t) => t.id === id);

test('runner: [mcp] normal exit: claude gets --strict-mcp-config and the PATH of mcp.json (0600, the four servers), argv has no content, the file is gone afterwards', async () => {
  const t = await sendSetup([rec('a')]);
  try {
    const r = await t.go();
    assert.deepEqual(r.processed, [{ id: 'a', status: 'review' }]);
    const args = JSON.parse(await readFile(join(t.dir, 'args.json'), 'utf8'));
    const i = args.indexOf('--mcp-config');
    assert.ok(args.includes('--strict-mcp-config') && i > 0);
    const snap = await t.snap();
    assert.equal(snap.present, true);
    assert.equal(snap.strict, true);
    assert.equal(snap.path, args[i + 1]);
    assert.equal(snap.mode, 0o600, 'the file claude read was 0600');
    assert.deepEqual(Object.keys(JSON.parse(snap.text).mcpServers), [...SEND_MCP_SERVERS]);
    assert.deepEqual(JSON.parse(snap.text).mcpServers['generic:gitlab'].env, { GITLAB_VAR: FAKE_VALUES.gitlab });
    assert.deepEqual(leaks(args.join('\n')), [], 'the content is never passed in argv (visible in ps)');
    assert.ok(!args.join('\n').includes('"mcpServers"'));
    assert.match(args[i + 1], /\/runs\/a-\d+\/mcp\.json$/);
    assert.deepEqual(await t.mcpFiles(), [], 'removed after the run');
    assert.deepEqual(leaks(JSON.stringify(t.logs)), [], 'no value from mcp.json in the log');
    const ev = t.logs.find((e) => e.event === 'mcp_config');
    assert.deepEqual(ev.servers, [...SEND_MCP_SERVERS]);
  } finally { await t.cleanup(); }
});

test('runner: [mcp] read-only mode (TASKFLOW_AGENT_SEND off): no mcp.json, no MCP flags, ~/.claude.json is not even read', async () => {
  const t = await sendSetup([rec('a')], { fakeEnv: { TASKFLOW_AGENT_SEND: 'off' }, doc: '{ broken' });
  try {
    await t.go();
    const args = JSON.parse(await readFile(join(t.dir, 'args.json'), 'utf8'));
    assert.ok(!args.includes('--strict-mcp-config') && !args.includes('--mcp-config'));
    assert.equal((await t.snap()).present, false);
    assert.ok(!t.logs.some((e) => /mcp_config/.test(e.event)));
  } finally { await t.cleanup(); }
});

test('runner: [mcp] timeout: the file is removed after the process group is dead', async () => {
  const t = await sendSetup([rec('a')], { fakeEnv: { FAKE_CLAUDE_MODE: 'hang' }, limits: { ...LIM, TASK_TIMEOUT_MS: 700, POLL_MS: 0 } });
  try {
    await t.go();
    assert.equal(taskOf(t.store, 'a').agent.status, 'failed');
    assert.equal((await t.snap()).present, true, 'it existed while claude was running');
    assert.deepEqual(await t.mcpFiles(), []);
  } finally { await t.cleanup(); }
});

test('runner: [mcp] abort when the task is closed: the file is removed', async () => {
  const t = await sendSetup([rec('a')], { fakeEnv: { FAKE_CLAUDE_MODE: 'hang' } });
  try {
    const running = t.go();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await t.mcpFiles()).length, 1, 'present while claude runs');
    const cur = taskOf(t.store, 'a');
    await t.store.sync({ tasks: [{ ...cur, done: true, completedAt: Date.now(), updatedAt: Date.now() + 1, agent: { ...cur.agent, status: null, claimToken: null, at: Date.now() + 100_000 } }] });
    const r = await running;
    assert.deepEqual(r.processed, [{ id: 'a', status: 'aborted' }]);
    assert.deepEqual(await t.mcpFiles(), []);
  } finally { await t.cleanup(); }
});

test('runner: [mcp] abort signal (the first SIGTERM of the daemon): the file is removed and the next task does not start', async () => {
  const t = await sendSetup([rec('a')], { fakeEnv: { FAKE_CLAUDE_MODE: 'hang' }, limits: { ...LIM, POLL_MS: 0, TASK_TIMEOUT_MS: 20_000 } });
  try {
    const ac = new AbortController();
    const running = t.go({ signal: ac.signal });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await t.mcpFiles()).length, 1);
    ac.abort();
    assert.deepEqual((await running).processed, [{ id: 'a', status: 'aborted' }]);
    assert.deepEqual(await t.mcpFiles(), []);
  } finally { await t.cleanup(); }
});

test('runner: [mcp] spawn_error and an exception thrown by run(): the file is removed', async () => {
  let t = await sendSetup([rec('a')]);
  try {
    await t.go({ command: '/nonexistent/claude', argsPrefix: [] });
    assert.equal(taskOf(t.store, 'a').agent.status, 'failed');
    assert.deepEqual(await t.mcpFiles(), []);
  } finally { await t.cleanup(); }
  t = await sendSetup([rec('a')]);
  try {
    await assert.rejects(t.go({ run: async () => { throw new Error('boom'); } }), /boom/);
    assert.deepEqual(await t.mcpFiles(), [], 'finally runs even when the spawn code throws');
  } finally { await t.cleanup(); }
});

test('runner: [mcp] a failure to prepare the config fails the task before claude starts; nothing leaks into the log', async () => {
  let spawned = 0;
  const t = await sendSetup([rec('a')], { doc: `{ "mcpServers": { "mcp-jira": { "env": { "T": "${FAKE_VALUES.jira}"` });
  try {
    const r = await t.go({ run: async () => { spawned++; } });
    assert.equal(spawned, 0);
    assert.deepEqual(r.processed, [{ id: 'a', status: 'failed' }]);
    assert.equal(taskOf(t.store, 'a').agentNotes.at(-1).text, 'Агент не справился: Не удалось подготовить MCP-конфиг');
    assert.deepEqual(t.logs.filter((e) => e.event === 'mcp_config_failed').map((e) => e.reason), ['invalid']);
    assert.deepEqual(leaks(JSON.stringify(t.logs)), []);
    assert.deepEqual(await t.mcpFiles(), []);
  } finally { await t.cleanup(); }
});

test('runner: [mcp] a missing server from the allowlist is logged by name; the run goes on with the rest', async () => {
  const doc = userClaudeJson();
  delete doc.mcpServers['mcp-confluence'];
  const t = await sendSetup([rec('a')], { doc });
  try {
    await t.go();
    assert.equal(taskOf(t.store, 'a').agent.status, 'review');
    const ev = t.logs.find((e) => e.event === 'mcp_config');
    assert.deepEqual([ev.servers, ev.missing], [['mcp-workspace-assistant', 'mcp-jira', 'generic:gitlab'], ['mcp-confluence']]);
    assert.deepEqual(Object.keys(JSON.parse((await t.snap()).text).mcpServers), ['mcp-workspace-assistant', 'mcp-jira', 'generic:gitlab']);
    assert.deepEqual(leaks(JSON.stringify(t.logs)), []);
  } finally { await t.cleanup(); }
});

test('runner: [mcp] values from mcp.json that claude prints to stderr are redacted in the log', async () => {
  const t = await sendSetup([rec('a')]);
  try {
    await writeFile(join(t.dir, 'err.txt'), `auth failed: token=${FAKE_VALUES.gitlab} header=${FAKE_VALUES.header}`);
    t.env.FAKE_CLAUDE_STDERR_FILE = join(t.dir, 'err.txt');
    await t.go();
    const ev = t.logs.find((e) => e.event === 'claude_stderr_tail');
    assert.ok(ev, 'stderr was logged');
    assert.ok(ev.tail.includes('auth failed: token=<redacted> header=<redacted>'), ev.tail);
    assert.deepEqual(leaks(JSON.stringify(t.logs)), []);
  } finally { await t.cleanup(); }
});

test('runner: [mcp] start of a send-mode run sweeps mcp.json left by a killed daemon (SIGKILL), keeps the dirs', async () => {
  const t = await sendSetup([]);                       // empty queue: only the start-up part runs
  try {
    const left = createRunDir({ stateDir: t.stateDir, taskId: 'dead', now: Date.now() - 3600_000 }).dir;
    writeFileSync(join(left, 'mcp.json'), JSON.stringify({ mcpServers: { x: { env: { T: FAKE_VALUES.jira } } } }), { mode: 0o600 });
    const r = await t.go();
    assert.equal(r.outcome, 'empty');
    assert.ok(exists(left) && !exists(join(left, 'mcp.json')));
    assert.deepEqual(t.logs.find((e) => e.event === 'mcp_config_swept'), { event: 'mcp_config_swept', count: 1 });
  } finally { await t.cleanup(); }
});

// ---------- main(): preflight, SIGTERM, second signal ----------

const fullEnv = (dir, extra = {}) => ({ HOME: dir, TASKFLOW_MCP_URL: 'http://x/mcp', TASKFLOW_MCP_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'u',
  ANTHROPIC_CUSTOM_HEADERS: 'h', AI_LAUNCHER_PAIW_DISABLED_ITEMS: 'd', CLAUDE_BIN: process.execPath, TASKFLOW_AGENT_STATE: join(dir, 'state'),
  TASKFLOW_AGENT_SEND_POLICY: join(dir, 'send-policy.json'), TASKFLOW_AGENT_SEND: 'on', ...extra });
const emptyClient = { queue: async () => ({ queue: [], stale: [] }) };

test('runner: [mcp] main(): no readable .claude.json / broken / no allowlist server in send mode -> exit 78 before any task, no values in the log', async () => {
  for (const [label, prep, why] of [
    ['missing', async () => {}, 'missing_file'],
    ['broken', async (d) => writeUserClaudeJson(d, `{ "mcpServers": { "mcp-jira": { "env": { "T": "${FAKE_VALUES.jira}"`), 'invalid'],
    ['empty', async (d) => writeUserClaudeJson(d, { mcpServers: { telegram: { type: 'stdio', command: 'x' } } }), 'no_servers'],
  ]) {
    const dir = await tmp();
    try {
      await prep(dir);
      const logs = [];
      const code = await main(fullEnv(dir), { log: (e) => logs.push(e), run: async () => { throw new Error('must not run'); }, createClient: () => { throw new Error('must not connect'); } });
      assert.equal(code, EXIT.CONFIG, label);
      assert.deepEqual(logs.filter((e) => e.event === 'config_error').map((e) => [e.problem, e.reason]), [['mcp_config', why]], label);
      assert.deepEqual(leaks(JSON.stringify(logs)), [], label);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('runner: [mcp] main(): CLAUDE_CONFIG_DIR is the root of .claude.json (same as for claude); a missing server is logged by name; read-only mode needs no file', async () => {
  const dir = await tmp(); const cfg = join(dir, 'cfg');
  try {
    await mkdir(cfg);
    const doc = userClaudeJson();
    delete doc.mcpServers['generic:gitlab'];
    await writeUserClaudeJson(cfg, doc);                        // HOME has no .claude.json at all
    const logs = [];
    assert.equal(await main(fullEnv(dir, { CLAUDE_CONFIG_DIR: cfg }), { log: (e) => logs.push(e), run: async () => {}, createClient: () => emptyClient }), EXIT.OK);
    assert.deepEqual(logs.find((e) => e.event === 'mcp_servers_missing'), { event: 'mcp_servers_missing', servers: ['generic:gitlab'] });
    assert.deepEqual(leaks(JSON.stringify(logs)), []);
    const ro = [];
    assert.equal(await main(fullEnv(dir, { TASKFLOW_AGENT_SEND: 'off' }), { log: (e) => ro.push(e), run: async () => {}, createClient: () => emptyClient }), EXIT.OK);
    assert.ok(!ro.some((e) => e.event === 'config_error'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function mainWithHangingClaude(extraSignals) {
  const { store, cleanup } = await makeStore({ tasks: [rec('a')] });
  const dir = await tmp();
  await writeUserClaudeJson(dir);
  const state = join(dir, 'state');
  const files = async () => { try { return (await readdir(join(state, 'runs'))).map((n) => join(state, 'runs', n, 'mcp.json')).filter(exists); } catch { return []; } };
  const env = fullEnv(dir, { TASKFLOW_AGENT_CWD: join(dir, 'work'), FAKE_CLAUDE_MODE: 'hang', FAKE_CLAUDE_PIDFILE: join(dir, 'pids.json') });
  const logs = [];
  const run = (o) => runClaude({ ...o, command: process.execPath, args: [FAKE, ...o.args], timeoutMs: 20_000, pollMs: 0, passEnv: [/^FAKE_CLAUDE_/] });
  try {
    return await extraSignals({ env, logs, run, client: fakeTaskflow(store), files, dir });
  } finally { reapPidfile(join(dir, 'pids.json')); await cleanup(); await rm(dir, { recursive: true, force: true }); }
}

test('runner: [mcp] main(): the first SIGTERM stops claude and removes mcp.json', async () => {
  await mainWithHangingClaude(async ({ env, logs, run, client, files }) => {
    const running = main(env, { log: (e) => logs.push(e), run, createClient: () => client });
    for (let i = 0; i < 40 && (await files()).length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal((await files()).length, 1, 'the file exists while claude runs');
    process.emit('SIGTERM');
    assert.equal(await running, EXIT.OK);
    assert.deepEqual(await files(), []);
    assert.ok(logs.some((e) => e.event === 'signal' && e.signal === 'SIGTERM'));
  });
});

test('runner: [mcp] main(): the second SIGTERM kills the group and removes mcp.json BEFORE exit() (finally would not run)', async () => {
  await mainWithHangingClaude(async ({ env, logs, run, client, files }) => {
    // claude ignores SIGTERM, so the first signal alone would leave the run waiting for the kill grace
    env.FAKE_CLAUDE_IGNORE_TERM = '1';
    const seen = [];
    let killed = 0;
    const running = main(env, {
      log: (e) => logs.push(e), run, createClient: () => client, killChildGroups: () => { killed++; },
      exit: (c) => { seen.push({ code: c, filesAtExit: existsSyncAll() }); },
    });
    const existsSyncAll = () => { const dir = join(env.TASKFLOW_AGENT_STATE, 'runs'); try { return readdirSync(dir).map((n) => join(dir, n, 'mcp.json')).filter(exists); } catch { return []; } };
    for (let i = 0; i < 40 && (await files()).length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal((await files()).length, 1);
    process.emit('SIGTERM');
    process.emit('SIGTERM');
    assert.equal(killed, 1);
    assert.deepEqual(seen.map((x) => [x.code, x.filesAtExit]), [[143, []]], 'exit() sees no mcp.json');
    assert.deepEqual(await files(), []);
    reapPidfile(env.FAKE_CLAUDE_PIDFILE);              // the faked exit() did not stop anything: end the hung claude by hand
    await running;
  });
});

// ---------- SEC01-SEC03 + exit handler ----------

test('runner: [mcp] SEC01 send=off: runOnce sweeps a leftover mcp.json under the lock; argv/prompt of read-only mode are untouched', async () => {
  const t = await sendSetup([rec('a')], { fakeEnv: { TASKFLOW_AGENT_SEND: 'off' } });
  try {
    const left = createRunDir({ stateDir: t.stateDir, taskId: 'dead', now: Date.now() - 60_000 }).dir;
    writeFileSync(join(left, 'mcp.json'), '{"secret":1}', { mode: 0o600 });
    const r = await t.go();
    assert.deepEqual(r.processed, [{ id: 'a', status: 'review' }]);
    assert.ok(!exists(join(left, 'mcp.json')), 'leftover removed in read-only mode');
    assert.ok(exists(left), 'the dir stays');
    assert.deepEqual(t.logs.find((e) => e.event === 'mcp_config_swept'), { event: 'mcp_config_swept', count: 1 });
    const args = JSON.parse(await readFile(join(t.dir, 'args.json'), 'utf8'));
    assert.ok(!args.includes('--strict-mcp-config') && !args.includes('--mcp-config'), 'read-only argv has no mcp flags');
    // under the lock: a held lock means no sweep
    const left2 = createRunDir({ stateDir: t.stateDir, taskId: 'dead2', now: Date.now() - 50_000 }).dir;
    writeFileSync(join(left2, 'mcp.json'), '{"secret":2}', { mode: 0o600 });
    const other = createLock(t.stateDir);
    assert.ok(other.acquire());
    try { assert.equal((await t.go()).outcome, 'locked'); assert.ok(exists(join(left2, 'mcp.json')), 'locked: not touched'); } finally { other.release(); }
  } finally { await t.cleanup(); }
});

test('mcp-config: SEC02 mcpSecrets also covers args (>= 6 chars), url and url query values', async () => {
  const { mcpSecrets } = await import('../agent/lib/mcp-config.mjs');
  const s = mcpSecrets({
    a: { command: 'x', args: ['--serve', 'tok-in-args-123', 'abc'], env: { K: 'envval' } },
    b: { type: 'http', url: 'https://h.example/mcp?token=qtok-9876&x=&y=short1' },
  });
  for (const v of ['tok-in-args-123', '--serve', 'envval', 'https://h.example/mcp?token=qtok-9876&x=&y=short1', 'qtok-9876']) assert.ok(s.includes(v), v);
  assert.ok(!s.includes('abc') && !s.includes(''), 'short args and empty values are not secrets');
  // end to end: the markers in args and url?token= are redacted in the stderr tail
  const d = await tmp();
  try {
    const doc = userClaudeJson();
    doc.mcpServers['mcp-jira'].args = ['--serve', 'ARGS-MARKER-4242'];
    doc.mcpServers['mcp-workspace-assistant'].url = 'https://ws.example/mcp?token=URLTOKEN-7777';
    await writeUserClaudeJson(d, doc);
    const cfg = buildSendMcpConfig({ home: d });
    await writeFile(join(d, 'err.txt'), 'boom ARGS-MARKER-4242 and URLTOKEN-7777 end');
    const logs = [];
    const r = await runClaude({
      command: process.execPath, args: [FAKE], env: { PATH: process.env.PATH, FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_STDERR_FILE: join(d, 'err.txt') },
      passEnv: [/^FAKE_CLAUDE_/], timeoutMs: 5000, pollMs: 0, log: (e) => logs.push(e), extraSecrets: cfg.secrets,
    });
    assert.equal(r.kind, 'exit');
    const tail = logs.find((e) => e.event === 'claude_stderr_tail').tail;
    assert.ok(tail.includes('boom <redacted> and <redacted> end'), tail);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('mcp-config: SEC03 removeMcpConfig keeps the path in LIVE when rm fails (EACCES), drops it on success or ENOENT; exit handler retries', async () => {
  const runDir = await tmp(); const home = await tmp();
  try {
    await writeUserClaudeJson(home);
    const path = writeMcpConfig(runDir, buildSendMcpConfig({ home }));
    const eacces = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    assert.throws(() => removeMcpConfig(path, { rm: eacces }), (e) => e.code === 'EACCES');
    assert.ok(exists(path));
    removeAllMcpConfigs();                                       // the path was kept in LIVE: the exit handler deletes it
    assert.ok(!exists(path), 'retry removed the file');
    // ENOENT from rm is success: the path leaves LIVE (a later file at the same path must survive removeAll)
    const p2 = writeMcpConfig(runDir, buildSendMcpConfig({ home }));
    const enoent = () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
    removeMcpConfig(p2, { rm: enoent });
    writeFileSync(join(runDir, 'mcp.json'), 'foreign', { flag: 'w' });
    removeAllMcpConfigs();
    assert.ok(exists(join(runDir, 'mcp.json')), 'ENOENT dropped the path from LIVE');
    // real failure: read-only directory (skipped when running as root)
    if (process.getuid?.() !== 0) {
      rmSync_(join(runDir, 'mcp.json'));
      const p3 = writeMcpConfig(runDir, buildSendMcpConfig({ home }));
      await chmod(runDir, 0o500);
      try { assert.throws(() => removeMcpConfig(p3), (e) => e.code === 'EACCES'); assert.ok(exists(p3)); } finally { await chmod(runDir, 0o700); }
      removeAllMcpConfigs();
      assert.ok(!exists(p3));
    }
  } finally { await chmod(runDir, 0o700).catch(() => {}); await rm(runDir, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); }
});
const rmSync_ = (p) => rmSync(p, { force: true });

test('runner: [mcp] process.on(exit, removeAllMcpConfigs) deletes mcp.json on process.exit(3) and on an uncaught exception (child process)', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = await tmp();
  try {
    await writeUserClaudeJson(dir);
    const runnerUrl = new URL('../agent/delegation-runner.mjs', import.meta.url).href;
    const script = join(dir, 'child.mjs');
    await writeFile(script, `
import { main } from ${JSON.stringify(runnerUrl)};
import { existsSync } from 'node:fs';
const how = process.env.HOW;
const task = { id: 'a', title: 't', notes: '', due: null, kind: 'task', priority: 4 };
const client = { queue: async () => ({ queue: [task], stale: [] }), claim: async () => ({ claimToken: 'tok', task, journals: [] }),
  finish: async () => ({ journalStored: true }), reap: async () => {} };
const run = async (o) => {
  const i = o.args.indexOf('--mcp-config');
  console.log('MCP_PATH=' + o.args[i + 1] + ' EXISTS=' + existsSync(o.args[i + 1]));
  if (how === 'exit') process.exit(3);
  setTimeout(() => { throw new Error('boom'); }, 0);
  await new Promise(() => {});
};
await main(process.env, { log: () => {}, run, createClient: () => client });
`);
    const env = fullEnv(dir, { TASKFLOW_AGENT_CWD: join(dir, 'work'), PATH: process.env.PATH });
    for (const [how, code] of [['exit', 3], ['throw', 1]]) {
      const r = spawnSync(process.execPath, [script], { env: { ...env, HOW: how }, encoding: 'utf8', timeout: 20_000 });
      assert.equal(r.status, code, `${how}: ${r.stderr}`);
      const m = /MCP_PATH=(\S+) EXISTS=(\w+)/.exec(r.stdout);
      assert.ok(m && m[2] === 'true', `${how}: the file existed while the run was live: ${r.stdout}`);
      assert.ok(!exists(m[1]), `${how}: mcp.json removed by the exit handler`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
