// Подставной claude в режиме send: исполняет хуки из --settings и «вызывает» заглушку MCP только после allow (C16).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, chmod, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildClaudeArgs, SEND_TOOLS } from '../agent/lib/policy.mjs';
import { readAudit, buildJournal } from '../agent/lib/audit.mjs';
import { readCalls } from './helpers/stub-mcp.mjs';

const FAKE = fileURLToPath(new URL('./helpers/fake-claude.mjs', import.meta.url));
const GATE = fileURLToPath(new URL('../agent/hooks/send-gate.mjs', import.meta.url));
const [VK, , , , JIRA] = SEND_TOOLS;

async function setup(policy = { vk_chats: ['chat-ok'] }) {
  const root = await mkdtemp(join(tmpdir(), 'tf-fakesend-'));
  const runDir = join(root, 'run');
  await mkdir(join(runDir, 'slots'), { recursive: true, mode: 0o700 });
  const policyPath = join(root, 'send-policy.json');
  await writeFile(policyPath, JSON.stringify({ version: 1, allow: policy }), { mode: 0o600 });
  await chmod(policyPath, 0o600);
  const mcpOut = join(root, 'mcp-calls.jsonl');
  const run = (plan, extraEnv = {}, gate = { nodePath: process.execPath, gatePath: GATE, runDir, policyPath }) => {
    const args = buildClaudeArgs({ send: true, gate, mcpConfigPath: join(root, 'mcp.json') });
    const r = spawnSync(process.execPath, [FAKE, ...args], {
      input: 'prompt', encoding: 'utf8',
      env: { PATH: process.env.PATH, FAKE_CLAUDE_MODE: 'send', FAKE_CLAUDE_SEND_PLAN: JSON.stringify(plan), FAKE_CLAUDE_MCP_OUT: mcpOut, ...extraEnv },
    });
    return r;
  };
  return { root, runDir, mcpOut, run, cleanup: () => rm(root, { recursive: true, force: true }) };
}
const vk = (chat, extra = {}) => ({ tool_name: VK, tool_input: { chat_sn: chat, text: 'привет' }, ...extra });

test('fake-claude send: allow from pre reaches the stub, post writes ok into audit.jsonl', async () => {
  const t = await setup();
  try {
    const r = t.run([vk('chat-ok')]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).type, 'result');
    assert.equal(readCalls(t.mcpOut).length, 1);
    assert.equal(readCalls(t.mcpOut)[0].tool, VK);
    const j = buildJournal(readAudit(t.runDir), {});
    assert.deepEqual(j.entries.map((e) => [e.kind, e.outcome, e.ref]), [['vk', 'ok', 'https://stub.example/1']]);
  } finally { await t.cleanup(); }
});

test('fake-claude send: deny and exit 2 from pre leave the stub untouched (call counter is zero)', async () => {
  const t = await setup();
  try {
    assert.equal(t.run([vk('chat-evil')]).status, 0);
    assert.equal(readCalls(t.mcpOut).length, 0, 'deny');
    assert.deepEqual(buildJournal(readAudit(t.runDir), {}).entries.map((e) => e.outcome), ['blocked']);
    // a hook that falls over: runDir missing -> the gate exits 2, no decision
    const broken = join(t.root, 'no-run-dir');
    const r = t.run([vk('chat-ok')], {}, { nodePath: process.execPath, gatePath: GATE, runDir: broken, policyPath: join(t.root, 'send-policy.json') });
    assert.equal(r.status, 0);
    assert.equal(readCalls(t.mcpOut).length, 0, 'exit 2');
    // a hook command that does not exist: no answer at all
    const none = t.run([vk('chat-ok')], {}, { nodePath: process.execPath, gatePath: join(t.root, 'missing-gate.mjs'), runDir: t.runDir, policyPath: join(t.root, 'send-policy.json') });
    assert.equal(none.status, 0);
    assert.equal(readCalls(t.mcpOut).length, 0, 'no answer: the `|| exit 2` makes it a block');
  } finally { await t.cleanup(); }
});

test('fake-claude send: a sub-agent call (agent_id) goes through the same gate and shares the ceiling', async () => {
  const t = await setup();
  try {
    t.run([vk('chat-ok'), vk('chat-ok', { agent_id: 'a1' }), vk('chat-ok', { agent_id: 'a2' }), vk('chat-ok', { agent_id: 'a3' })]);
    assert.equal(readCalls(t.mcpOut).length, 3, 'ceiling 3 across main and sub-agent calls');
    assert.deepEqual((await readdir(join(t.runDir, 'slots'))).sort(), ['vk-1', 'vk-2', 'vk-3']);
    const recs = readAudit(t.runDir).records;
    assert.ok(recs.some((r) => r.sub === true && r.agent_type === 'ai-space-comms'));
  } finally { await t.cleanup(); }
});

test('fake-claude send: fail and "no post at all" give error and started', async () => {
  const t = await setup({ vk_chats: ['chat-ok'], jira_projects: ['OPS'] });
  try {
    t.run([vk('chat-ok', { post: 'fail', error: 'сервер недоступен' }), { tool_name: JIRA, tool_input: { issueKey: 'OPS-1', comment: 'c' }, post: 'none' }]);
    assert.equal(readCalls(t.mcpOut).length, 2);
    assert.deepEqual(buildJournal(readAudit(t.runDir), {}).entries.map((e) => [e.outcome, e.reason]), [['error', 'сервер недоступен'], ['started', undefined]]);
  } finally { await t.cleanup(); }
});

test('fake-claude send: the final answer defaults to review and can be set; old modes still work', async () => {
  const t = await setup();
  try {
    assert.equal(JSON.parse(JSON.parse(t.run([]).stdout).result).status, 'review');
    assert.equal(JSON.parse(JSON.parse(t.run([], { FAKE_CLAUDE_RESULT: JSON.stringify({ status: 'needs_info', text: 'Q' }) }).stdout).result).status, 'needs_info');
    const ok = spawnSync(process.execPath, [FAKE], { input: '', encoding: 'utf8', env: { PATH: process.env.PATH, FAKE_CLAUDE_MODE: 'ok' } });
    assert.equal(JSON.parse(JSON.parse(ok.stdout).result).text, 'Готовый текст результата');
  } finally { await t.cleanup(); }
});
