import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SEND_TOOLS } from '../agent/lib/policy.mjs';
import { readAudit, buildJournal } from '../agent/lib/audit.mjs';
import { decidePre, recordPost, main } from '../agent/hooks/send-gate.mjs';

const GATE = fileURLToPath(new URL('../agent/hooks/send-gate.mjs', import.meta.url));
const [VK, NOTE, DISC, REPLY, JIRA, CONF] = SEND_TOOLS;

async function fixture(allow = { vk_chats: ['chat-ok'], jira_projects: ['OPS'], gitlab_projects: ['g/p'], confluence_spaces: ['DEV'] }, limits) {
  const root = await mkdtemp(join(tmpdir(), 'tf-gate-'));
  const runDir = join(root, 'run');
  await mkdir(join(runDir, 'slots'), { recursive: true, mode: 0o700 });
  const policyPath = join(root, 'send-policy.json');
  await writeFile(policyPath, JSON.stringify({ version: 1, allow, ...(limits ? { limits } : {}) }), { mode: 0o600 });
  await chmod(policyPath, 0o600);
  return { root, runDir, policyPath, cleanup: () => rm(root, { recursive: true, force: true }) };
}
let seq = 0;
const vk = (chat, extra = {}) => ({ hook_event_name: 'PreToolUse', tool_name: VK, tool_use_id: `u${++seq}`, tool_input: { chat_sn: chat, text: 'привет' }, ...extra });
const slots = async (f) => (await readdir(join(f.runDir, 'slots'))).sort();
const pre = (f, input) => decidePre({ input, runDir: f.runDir, policyPath: f.policyPath });

const VALID_INPUTS = {
  [VK]: { chat_sn: 'chat-ok', text: 't' },
  [NOTE]: { project_id: 'g/p', merge_request_iid: 1, body: 'b' },
  [DISC]: { project_id: 'g/p', merge_request_iid: 1, body: 'b', file_path: 'a.go', new_line: 3 },
  [REPLY]: { project_id: 'g/p', merge_request_iid: 1, discussion_id: 'd', body: 'b' },
  [JIRA]: { issueKey: 'OPS-1', comment: 'c' },
  [CONF]: { space_key: 'DEV', title: 'T', body: '<p>b</p>' },
};

test('gate: [send] AC-001 a chat from the list with a free slot is allowed, slot taken, attempt written', async () => {
  const f = await fixture();
  try {
    const r = pre(f, vk('chat-ok'));
    assert.equal(r.decision, 'allow');
    assert.equal(r.reason, null);
    assert.deepEqual(await slots(f), ['vk-1']);
    const { records } = readAudit(f.runDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].event, 'attempt');
    assert.equal(records[0].kind, 'vk');
    assert.equal(records[0].target, 'чат chat-ok');
  } finally { await f.cleanup(); }
});

test('gate: all six tools are allowed for listed targets', async () => {
  const f = await fixture();
  try {
    for (const t of SEND_TOOLS) assert.equal(pre(f, { tool_name: t, tool_use_id: `x-${t}`, tool_input: VALID_INPUTS[t] }).decision, 'allow', t);
    assert.deepEqual(await slots(f), ['confluence-1', 'gitlab_comment-1', 'gitlab_comment-2', 'gitlab_comment-3', 'jira-1', 'vk-1']);
  } finally { await f.cleanup(); }
});

test('gate: [send] AC-012 AC-022 not in list, missing target, broken file, bad mode, absent file: deny with the right reason, slot untouched', async () => {
  const f = await fixture();
  try {
    assert.deepEqual([pre(f, vk('other-chat'))].map((r) => [r.decision, r.reason]), [['deny', 'not_allowed']]);
    assert.deepEqual([pre(f, { tool_name: VK, tool_use_id: 'n', tool_input: { text: 'x' } })].map((r) => [r.decision, r.reason]), [['deny', 'target_missing']]);
    assert.equal(pre(f, { tool_name: JIRA, tool_use_id: 'j', tool_input: { issueKey: 'OTHER-1', comment: 'c' } }).reason, 'not_allowed');
    assert.equal(pre(f, { tool_name: NOTE, tool_use_id: 'm', tool_input: { project_id: 'g/other', merge_request_iid: 1, body: 'b' } }).reason, 'not_allowed');
    assert.equal(pre(f, { tool_name: CONF, tool_use_id: 'c', tool_input: { space_key: 'dev', title: 'T', body: 'b' } }).reason, 'not_allowed', 'exact match, case matters');
    assert.deepEqual(await slots(f), [], 'blocks on steps 1-3 do not spend slots');
    // broken JSON
    await writeFile(f.policyPath, '{bad', { mode: 0o600 });
    assert.equal(pre(f, vk('chat-ok')).reason, 'policy');
    // bad mode
    await writeFile(f.policyPath, JSON.stringify({ version: 1, allow: { vk_chats: ['chat-ok'] } }));
    await chmod(f.policyPath, 0o644);
    assert.equal(pre(f, vk('chat-ok')).reason, 'policy');
    // absent file
    assert.equal(decidePre({ input: vk('chat-ok'), runDir: f.runDir, policyPath: join(f.root, 'nope.json') }).reason, 'policy');
    // foreign owner
    await chmod(f.policyPath, 0o600);
    assert.equal(decidePre({ input: vk('chat-ok'), runDir: f.runDir, policyPath: f.policyPath, uid: process.getuid() + 1 }).reason, 'policy');
    assert.deepEqual(await slots(f), []);
    const blocked = readAudit(f.runDir).records.filter((r) => r.event === 'blocked');
    assert.equal(blocked.length, 9);
    assert.ok(blocked.every((r) => r.tool_use_id));
  } finally { await f.cleanup(); }
});

test('gate: [send] AC-033 with send enabled and empty lists every one of the six tools is blocked and recorded', async () => {
  for (const policy of [{}, { vk_chats: [], jira_projects: [], gitlab_projects: [], confluence_spaces: [] }]) {
    const f = await fixture(policy);
    try {
      for (const t of SEND_TOOLS) {
        const r = pre(f, { tool_name: t, tool_use_id: `e-${t}`, tool_input: VALID_INPUTS[t] });
        assert.equal(r.decision, 'deny', t);
        assert.equal(r.reason, 'not_allowed', t);
      }
      const read = readAudit(f.runDir);
      assert.equal(read.records.filter((r) => r.event === 'blocked' && r.reason === 'not_allowed').length, 6);
      assert.equal(buildJournal(read, {}).entries.every((e) => e.outcome === 'blocked'), true);
      assert.deepEqual(await slots(f), []);
    } finally { await f.cleanup(); }
  }
});

test('gate: [send] AC-010 AC-011 ceiling 3 on vk: the 4th is deny(limit), the earlier attempts stay recorded', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 3; i++) assert.equal(pre(f, vk('chat-ok')).decision, 'allow');
    const fourth = pre(f, vk('chat-ok'));
    assert.deepEqual([fourth.decision, fourth.reason], ['deny', 'limit']);
    assert.equal(pre(f, vk('chat-ok')).reason, 'limit');
    assert.deepEqual(await slots(f), ['vk-1', 'vk-2', 'vk-3']);
    const ev = readAudit(f.runDir).records.map((r) => r.event);
    assert.deepEqual(ev, ['attempt', 'attempt', 'attempt', 'blocked', 'blocked']);
    // other kinds keep their own slots
    assert.equal(pre(f, { tool_name: JIRA, tool_use_id: 'j', tool_input: VALID_INPUTS[JIRA] }).decision, 'allow');
  } finally { await f.cleanup(); }
});

test('gate: a policy limit below the default is honoured and one above it is not', async () => {
  const lo = await fixture({ vk_chats: ['chat-ok'] }, { vk: 1 });
  const hi = await fixture({ vk_chats: ['chat-ok'] }, { vk: 50 });
  try {
    assert.equal(pre(lo, vk('chat-ok')).decision, 'allow');
    assert.equal(pre(lo, vk('chat-ok')).reason, 'limit');
    for (let i = 0; i < 3; i++) assert.equal(pre(hi, vk('chat-ok')).decision, 'allow');
    assert.equal(pre(hi, vk('chat-ok')).reason, 'limit');
  } finally { await lo.cleanup(); await hi.cleanup(); }
});

test('gate: [send] AC-023 the ceiling is shared by calls with and without agent_id; sub-agent marks are recorded', async () => {
  const f = await fixture();
  try {
    assert.equal(pre(f, vk('chat-ok')).decision, 'allow');
    assert.equal(pre(f, vk('chat-ok', { agent_id: 'sub-1', agent_type: 'ai-space-comms' })).decision, 'allow');
    assert.equal(pre(f, vk('chat-ok', { agent_id: 'sub-2', agent_type: 'ai-space-comms' })).decision, 'allow');
    assert.equal(pre(f, vk('chat-ok')).reason, 'limit');
    assert.equal(pre(f, vk('chat-ok', { agent_id: 'sub-3' })).reason, 'limit');
    const rec = readAudit(f.runDir).records;
    assert.deepEqual(rec.filter((r) => r.event === 'attempt').map((r) => r.sub ?? false), [false, true, true]);
    assert.equal(rec[1].agent_type, 'ai-space-comms');
  } finally { await f.cleanup(); }
});

test('gate: [send] AC-014 the pre answer has no updatedInput and the input object is not changed', async () => {
  const f = await fixture();
  try {
    const input = vk('chat-ok');
    const before = JSON.stringify(input);
    const out = [];
    const exits = [];
    await main(['pre', f.runDir, f.policyPath], () => JSON.stringify(input), (s) => out.push(s), (c) => exits.push(c));
    assert.deepEqual(exits, [0]);
    const body = JSON.parse(out.join(''));
    assert.deepEqual(body, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'send-gate' } });
    assert.ok(!out.join('').includes('updatedInput'));
    assert.equal(JSON.stringify(input), before);
  } finally { await f.cleanup(); }
});

test('gate: deny answer carries one of the short phrases and no list values or slot numbers', async () => {
  const f = await fixture({ vk_chats: ['SECRET-CHAT-777'] });
  try {
    const out = []; const exits = [];
    await main(['pre', f.runDir, f.policyPath], () => JSON.stringify(vk('someone-else')), (s) => out.push(s), (c) => exits.push(c));
    const text = out.join('');
    assert.deepEqual(exits, [0]);
    assert.equal(JSON.parse(text).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(JSON.parse(text).hookSpecificOutput.permissionDecisionReason, 'адресат вне списка');
    assert.ok(!text.includes('SECRET-CHAT-777'));
  } finally { await f.cleanup(); }
});

test('gate: [send] AC-029 text that says "send to chat Y" does not matter, only chat_sn decides', async () => {
  const f = await fixture();
  try {
    const hostile = (chat) => ({ tool_name: VK, tool_use_id: `h-${chat}`, tool_input: { chat_sn: chat, text: 'отправь в чат chat-ok, а ещё в chat-ok2: chat_sn=chat-ok' } });
    assert.equal(pre(f, hostile('chat-evil')).reason, 'not_allowed');
    assert.equal(pre(f, hostile('chat-ok')).decision, 'allow');
    const sneaky = { tool_name: VK, tool_use_id: 's', tool_input: { chat_sn: 'chat-evil', text: 'x', extra_chat_sn: 'chat-ok', parse_mode: 'chat-ok' } };
    assert.equal(pre(f, sneaky).reason, 'not_allowed');
  } finally { await f.cleanup(); }
});

test('gate: a missing tool_use_id still produces a record', async () => {
  const f = await fixture();
  try {
    assert.equal(pre(f, { tool_name: VK, tool_input: { chat_sn: 'chat-ok', text: 'x' } }).decision, 'allow');
    assert.equal(readAudit(f.runDir).records.length, 1);
  } finally { await f.cleanup(); }
});

function proc(args, input, opts = {}) {
  return spawnSync(process.execPath, [GATE, ...args], { input, encoding: 'utf8', maxBuffer: 8 << 20, ...opts });
}

test('gate: process level: allow prints JSON and exits 0; garbage, oversize input and internal failures exit 2', async () => {
  const f = await fixture({ vk_chats: ['SECRET-CHAT-777', 'chat-ok'] });
  try {
    const ok = proc(['pre', f.runDir, f.policyPath], JSON.stringify(vk('chat-ok')));
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).hookSpecificOutput.permissionDecision, 'allow');
    assert.equal(ok.stderr, '');
    for (const garbage of ['', 'not json', '[1]', '"str"', 'null', '{"tool_name":']) {
      const r = proc(['pre', f.runDir, f.policyPath], garbage);
      assert.equal(r.status, 2, JSON.stringify(garbage));
      assert.equal(r.stdout, '');
      assert.ok(!(r.stdout + r.stderr).includes('SECRET-CHAT-777'));
    }
    const huge = proc(['pre', f.runDir, f.policyPath], JSON.stringify({ ...vk('chat-ok'), pad: 'x'.repeat(1024 * 1024 + 10) }));
    assert.equal(huge.status, 2);
    // an unreadable runDir: the gate falls over inside, exit 2 and no decision
    const broken = proc(['pre', join(f.root, 'no-such-run-dir'), f.policyPath], JSON.stringify(vk('chat-ok')));
    assert.equal(broken.status, 2);
    assert.equal(broken.stdout, '');
    assert.ok(!(broken.stdout + broken.stderr).includes('SECRET-CHAT-777'));
    // usage errors
    assert.equal(proc(['pre'], JSON.stringify(vk('chat-ok'))).status, 2);
    assert.equal(proc(['dance', f.runDir], '{}').status, 2);
    assert.equal(proc([], '{}').status, 2);
  } finally { await f.cleanup(); }
});

test('gate: process level: a broken policy still exits 0 with deny (a decision), not an allow', async () => {
  const f = await fixture();
  try {
    await writeFile(f.policyPath, '{broken', { mode: 0o600 });
    const r = proc(['pre', f.runDir, f.policyPath], JSON.stringify(vk('chat-ok')));
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, 'политика отправки не прочитана');
  } finally { await f.cleanup(); }
});

test('gate: post and fail append ok (with a reference) and error (reason up to 80 chars); the glued journal shows them', async () => {
  const f = await fixture();
  try {
    const a = vk('chat-ok');
    assert.equal(pre(f, a).decision, 'allow');
    recordPost({ input: { ...a, tool_response: { content: [{ type: 'text', text: 'ok https://vk.example/m/9' }] } }, runDir: f.runDir, event: 'ok' });
    const b = vk('chat-ok');
    assert.equal(pre(f, b).decision, 'allow');
    recordPost({ input: { ...b, error: `Ошибка\n${'x'.repeat(200)}` }, runDir: f.runDir, event: 'error' });
    const c = vk('chat-ok');
    pre(f, c);                                        // attempt without a final record
    const entries = buildJournal(readAudit(f.runDir), {}).entries;
    assert.deepEqual(entries.map((e) => e.outcome), ['ok', 'error', 'started']);
    assert.equal(entries[0].ref, 'https://vk.example/m/9');
    assert.equal(entries[1].reason.length, 80);
    assert.ok(!entries[1].reason.includes('\n'));
    assert.equal(entries[0].target, 'чат chat-ok');
  } finally { await f.cleanup(); }
});

test('gate: process level post/fail: exit 0 and no output, even on garbage input or an unwritable run dir', async () => {
  const f = await fixture();
  try {
    const a = vk('chat-ok');
    assert.equal(proc(['pre', f.runDir, f.policyPath], JSON.stringify(a)).status, 0);
    const ok = proc(['post', f.runDir], JSON.stringify({ ...a, tool_response: 'https://x.example/1' }));
    assert.deepEqual([ok.status, ok.stdout, ok.stderr], [0, '', '']);
    const fl = proc(['fail', f.runDir], JSON.stringify({ ...vk('chat-ok'), error: 'boom' }));
    assert.deepEqual([fl.status, fl.stdout, fl.stderr], [0, '', '']);
    for (const args of [['post', f.runDir], ['fail', f.runDir], ['post', join(f.root, 'gone')], ['fail']]) {
      for (const input of ['garbage', '', JSON.stringify(a)]) {
        const r = proc(args, input);
        assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], `${args.join(' ')} <${input.slice(0, 10)}>`);
      }
    }
    const recs = readAudit(f.runDir).records;
    assert.ok(recs.some((r) => r.event === 'ok' && r.ref === 'https://x.example/1'));
    assert.ok(recs.some((r) => r.event === 'error' && r.reason === 'boom'));
  } finally { await f.cleanup(); }
});

test('gate: post failure to write leaves attempt without a final record ("started")', async () => {
  const f = await fixture();
  try {
    const a = vk('chat-ok');
    assert.equal(pre(f, a).decision, 'allow');
    const r = proc(['post', join(f.root, 'gone')], JSON.stringify(a));
    assert.equal(r.status, 0);
    assert.deepEqual(buildJournal(readAudit(f.runDir), {}).entries.map((e) => e.outcome), ['started']);
  } finally { await f.cleanup(); }
});

test('gate: nothing is written outside runDir', async () => {
  const f = await fixture();
  try {
    pre(f, vk('chat-ok')); pre(f, vk('nobody'));
    assert.deepEqual((await readdir(f.root)).sort(), ['run', 'send-policy.json']);
  } finally { await f.cleanup(); }
});

test('gate: [send] SEC01 SEC08 content risks are denied with a fixed reason, the slot is not spent, no snippet is recorded (SEC09)', async () => {
  const f = await fixture();
  try {
    const cases = [
      [{ tool_name: NOTE, tool_input: { project_id: 'g/p', merge_request_iid: 1, body: 'ок\n/merge' } }, 'quick_action', 'mr_note'],
      [{ tool_name: DISC, tool_input: { project_id: 'g/p', merge_request_iid: 1, body: '/approve', file_path: 'a.go', new_line: 3 } }, 'quick_action', 'mr_discussion'],
      [{ tool_name: REPLY, tool_input: { project_id: 'g/p', merge_request_iid: 1, discussion_id: 'd', body: '/close' } }, 'quick_action', 'mr_reply'],
      [{ tool_name: VK, tool_input: { chat_sn: 'chat-ok', text: '/start СЕКРЕТНЫЙ-ТЕКСТ' } }, 'quick_action', 'vk'],
      [{ tool_name: CONF, tool_input: { space_key: 'DEV', title: 'T', body: '<ac:structured-macro ac:name="HTML"><ac:plain-text-body>СЕКРЕТНЫЙ-ТЕКСТ</ac:plain-text-body></ac:structured-macro>' } }, 'macro', 'confluence'],
    ];
    for (const [input, reason, kind] of cases) {
      const r = pre(f, { ...input, tool_use_id: `r${++seq}` });
      assert.deepEqual([r.decision, r.reason], ['deny', reason], kind);
      assert.equal(r.record.snippet, undefined, 'blocked record has no snippet');
    }
    assert.deepEqual(await slots(f), [], 'a risky body does not spend a slot');
    const { records } = readAudit(f.runDir);
    assert.equal(records.length, cases.length);
    assert.ok(records.every((r) => r.event === 'blocked' && r.snippet === undefined && r.target));
    assert.ok(!JSON.stringify(records).includes('СЕКРЕТНЫЙ-ТЕКСТ'));
    // a normal body to the same target still goes through
    assert.equal(pre(f, { tool_name: NOTE, tool_use_id: 'ok1', tool_input: { project_id: 'g/p', merge_request_iid: 1, body: 'обычный текст' } }).decision, 'allow');
    // a risky body to a chat outside the list stays not_allowed (the list check goes first)
    assert.equal(pre(f, { tool_name: VK, tool_use_id: 'ok2', tool_input: { chat_sn: 'other', text: '/start' } }).reason, 'not_allowed');
  } finally { await f.cleanup(); }
});

test('gate: [send] I01 audit.jsonl cannot be appended (a directory): attempt fails, deny gate_error, exit 2, empty stdout, slot stays taken', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.runDir, 'audit.jsonl'));
    const r = pre(f, vk('chat-ok'));
    assert.deepEqual([r.decision, r.reason], ['deny', 'gate_error']);
    assert.deepEqual(await slots(f), ['vk-1'], 'the slot is not given back');
    const p = proc(['pre', f.runDir, f.policyPath], JSON.stringify(vk('chat-ok')));
    assert.equal(p.status, 2, p.stderr);
    assert.equal(p.stdout, '', 'no verdict on stdout');
    assert.ok(!p.stdout.includes('allow'));
    assert.deepEqual(await slots(f), ['vk-1', 'vk-2']);
  } finally { await f.cleanup(); }
});

test('gate: [send] I01 audit.jsonl is read-only: the attempt cannot be written, so the call is not allowed (exit 2, empty stdout)', { skip: process.getuid?.() === 0 && 'root ignores file modes' }, async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.runDir, 'audit.jsonl'), '', { mode: 0o400 });
    await chmod(join(f.runDir, 'audit.jsonl'), 0o400);
    const p = proc(['pre', f.runDir, f.policyPath], JSON.stringify(vk('chat-ok')));
    assert.equal(p.status, 2);
    assert.equal(p.stdout, '');
  } finally { await chmod(join(f.runDir, 'audit.jsonl'), 0o600).catch(() => {}); await f.cleanup(); }
});

test('gate: [send] I04 garbage stdin: exit 2 and stderr is a fixed phrase that does not quote the input', async () => {
  const f = await fixture();
  try {
    for (const garbage of ['СЕКРЕТНЫЙ-ВХОД-12345 not json', '{"chat_sn":"СЕКРЕТНЫЙ-ВХОД-12345"', 'СЕКРЕТНЫЙ-ВХОД-12345']) {
      const r = proc(['pre', f.runDir, f.policyPath], garbage);
      assert.equal(r.status, 2);
      assert.equal(r.stdout, '');
      assert.ok(!r.stderr.includes('СЕКРЕТНЫЙ-ВХОД-12345'), r.stderr);
      assert.ok(!r.stderr.includes('Unexpected token'), r.stderr);
      assert.match(r.stderr, /^send-gate: input is not json\n$/);
    }
  } finally { await f.cleanup(); }
});
