// Harness спайков S1..S3 (agent/spike/send/): заглушка MCP, запуск claude, разбор вывода, шаблон заметки.
// Сам прогон делает пользователь; тест не требует PASS и не запускает настоящий claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SEND_TOOLS, CONVERTER_TOOL, SUBAGENTS } from '../agent/lib/policy.mjs';
import { STUB_TOOLS, SERVERS, toolsFor, recordCall, readCalls, serverOf, toolOf } from '../agent/spike/send/stub-mcp.mjs';
import { buildLaunch, FOREIGN_ALLOW, normalizeServer } from '../agent/spike/send/launch-claude.mjs';
import { SEND_MCP_SERVERS } from '../agent/lib/mcp-config.mjs';
import { evaluateS1, evaluateS2, evaluateS3, evaluateK, renderFacts } from '../agent/spike/send/evaluate-send.mjs';
import { hasMcpSdk } from './helpers/serve.mjs';

const D = (f) => fileURLToPath(new URL(`../agent/spike/send/${f}`, import.meta.url));
const NOTE = fileURLToPath(new URL('../openspec/changes/archive/2026-10-06-agent-send-actions/spike-s1-s3.md', import.meta.url));
const FAKE = fileURLToPath(new URL('./helpers/fake-claude.mjs', import.meta.url));
const tmp = () => mkdtemp(join(tmpdir(), 'tf-spikesend-'));

test('spike harness: the stub exposes full names of the six send tools and the converter, grouped by server', () => {
  assert.deepEqual(Object.keys(STUB_TOOLS).sort(), [...SEND_TOOLS, CONVERTER_TOOL].sort());
  assert.deepEqual([...SERVERS].sort(), ['generic_gitlab', 'mcp-confluence', 'mcp-jira', 'mcp-workspace-assistant']);
  for (const full of Object.keys(STUB_TOOLS)) assert.match(full, /^mcp__[a-z_-]+__[A-Za-z_-]+$/);
  for (const s of SERVERS) assert.ok(toolsFor(s).length > 0, s);
  const all = SERVERS.flatMap((s) => toolsFor(s).map((t) => `mcp__${s}__${t.name}`));
  assert.deepEqual(all.sort(), Object.keys(STUB_TOOLS).sort());
  assert.equal(serverOf(SEND_TOOLS[0]), 'mcp-workspace-assistant');
  assert.equal(toolOf(SEND_TOOLS[4]), 'jira_add_comment');
  const vk = toolsFor('mcp-workspace-assistant').find((t) => t.name === 'messenger-send-message');
  assert.deepEqual(vk.inputSchema.required, ['chat_sn', 'text']);
});

test('spike harness: every call is recorded in the calls file and nothing else happens', async () => {
  const d = await tmp();
  try {
    const file = join(d, 'calls.jsonl');
    assert.deepEqual(readCalls(file), []);
    const r = recordCall(file, 'mcp-jira', 'jira_add_comment', { issueKey: 'SPIKE-1', comment: 'x' });
    recordCall(file, 'generic_gitlab', 'add_merge_request_note', { project_id: 'g/p', merge_request_iid: 1, body: 'b' });
    assert.match(r.content[0].text, /^stub ok https:\/\/stub\.example\/mcp-jira\/1$/);
    const calls = readCalls(file);
    assert.deepEqual(calls.map((c) => [c.n, c.server, c.tool]), [[1, 'mcp-jira', 'jira_add_comment'], [2, 'generic_gitlab', 'add_merge_request_note']]);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('spike harness: the stub speaks MCP over stdio and records tools/call', { skip: !(await hasMcpSdk()) && 'MCP SDK is not installed' }, async () => {
  const d = await tmp();
  const file = join(d, 'calls.jsonl');
  const child = spawn(process.execPath, [D('stub-mcp.mjs'), 'mcp-jira'], { env: { PATH: process.env.PATH, STUB_CALLS: file }, stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    const answers = new Map();
    let buf = '';
    child.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) { const m = JSON.parse(l); if (m.id !== undefined) answers.set(m.id, m); } }
    });
    const send = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    const waitFor = async (id) => { for (let i = 0; i < 100 && !answers.has(id); i++) await new Promise((r) => setTimeout(r, 50)); return answers.get(id); };
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    assert.ok(await waitFor(1));
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });
    assert.deepEqual((await waitFor(2)).result.tools.map((t) => t.name), ['jira_add_comment']);
    send({ id: 3, method: 'tools/call', params: { name: 'jira_add_comment', arguments: { issueKey: 'SPIKE-1', comment: 'x' } } });
    assert.match((await waitFor(3)).result.content[0].text, /stub ok/);
    assert.equal(readCalls(file).length, 1);
    send({ id: 4, method: 'tools/call', params: { name: 'jira_delete_issue', arguments: {} } });
    assert.equal((await waitFor(4)).result.isError, true);
    assert.equal(readCalls(file).length, 1, 'an unknown tool is not recorded');
  } finally { child.kill('SIGKILL'); await rm(d, { recursive: true, force: true }); }
});

test('spike harness: launch-claude variants for S1 (k), (l), (m): foreign allow rules over a strict stub config, sender agent/skill, CLAUDE_CONFIG_DIR', async () => {
  const d = await tmp();
  try {
    const base = { work: join(d, 'w'), node: '/usr/bin/node', calls: join(d, 'c.jsonl'), policyPath: join(d, 'p.json') };
    await mkdir(base.work, { recursive: true });
    const k = buildLaunch({ ...base, plugin: true, format: 'stream-json' });
    const ks = JSON.parse(k.args[k.args.indexOf('--settings') + 1]);
    for (const rule of FOREIGN_ALLOW) assert.ok(ks.permissions.allow.includes(rule), rule);
    assert.ok(FOREIGN_ALLOW.includes('mcp__plugin_x_y'));
    assert.ok(k.args[k.args.indexOf('--disallowedTools') + 1].split(',').includes('mcp__plugin_'), 'the deny prefix stays as defense in depth');
    assert.equal(k.args[k.args.indexOf('--output-format') + 1], 'stream-json');
    assert.ok(k.args.includes('--verbose'));
    // the plugin is NOT put into --mcp-config any more: only the four production keys
    const mcpK = JSON.parse(await readFile(join(base.work, 'mcp.json'), 'utf8')).mcpServers;
    assert.ok(!('plugin_x_y' in mcpK) && !JSON.stringify(mcpK).includes('plugin'));
    assert.deepEqual(Object.keys(mcpK), [...SEND_MCP_SERVERS]);
    assert.ok(k.args.includes('--strict-mcp-config'));
    assert.deepEqual(k.env, {});
    const l = buildLaunch({ ...base, senderAgent: true, hookFault: 'fail' });
    assert.match(await readFile(join(base.work, '.claude', 'agents', 'spike-sender.md'), 'utf8'), /tools: mcp__mcp-workspace-assistant__messenger-send-message/);
    assert.match(await readFile(join(base.work, '.claude', 'skills', 'spike-send', 'SKILL.md'), 'utf8'), /allowed-tools: mcp__mcp-workspace-assistant__messenger-send-message/);
    assert.equal(JSON.parse(l.args[l.args.indexOf('--settings') + 1]).hooks.PreToolUse[0].hooks[0].command, 'exit 1');
    const m = buildLaunch({ ...base, configDirAllow: true, hookFault: 'fail' });
    assert.equal(m.env.CLAUDE_CONFIG_DIR, join(base.work, 'cfg'));
    assert.deepEqual(JSON.parse(await readFile(join(base.work, 'cfg', 'settings.json'), 'utf8')).permissions.allow, [SEND_TOOLS[0]]);
    // (m) with a ready directory (run-s1.sh puts symlinks to agents/skills there): settings.json goes into it
    const ready = join(d, 'cfg-m');
    await mkdir(ready);
    const m2 = buildLaunch({ ...base, configDirAllow: true, cfgDir: ready, hookFault: 'fail' });
    assert.equal(m2.env.CLAUDE_CONFIG_DIR, ready);
    assert.deepEqual(JSON.parse(await readFile(join(ready, 'settings.json'), 'utf8')).permissions.allow, [SEND_TOOLS[0]]);
    const plain = buildLaunch({ ...base });
    assert.deepEqual(plain.env, {});
    const ps = JSON.parse(plain.args[plain.args.indexOf('--settings') + 1]);
    assert.equal(ps.permissions, undefined, 'without the k variant there are no allow rules');
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('spike harness: launch-claude builds the daemon argv with stub-only MCP; variants for the three steps', async () => {
  const d = await tmp();
  try {
    const base = { work: join(d, 'w'), node: '/usr/bin/node', calls: join(d, 'c.jsonl'), policyPath: join(d, 'p.json') };
    await mkdir(base.work, { recursive: true });
    const a = buildLaunch({ ...base, dump: true });
    assert.ok(a.args.includes('--strict-mcp-config') && a.args.includes('--mcp-config'));
    assert.equal(a.args[a.args.indexOf('--permission-mode') + 1], 'dontAsk');
    const settings = JSON.parse(a.args[a.args.indexOf('--settings') + 1]);
    for (const ev of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
      assert.equal(settings.hooks[ev][0].hooks.length, 2, `${ev}: gate plus dump`);
      assert.ok(settings.hooks[ev][0].hooks[1].command.includes('dump-hook.mjs'));
    }
    const mcp = JSON.parse(await readFile(join(base.work, 'mcp.json'), 'utf8'));
    // the keys are the production allowlist verbatim ('generic:gitlab' is not renamed); the stub itself serves the normalized name
    assert.deepEqual(Object.keys(mcp.mcpServers), [...SEND_MCP_SERVERS]);
    assert.deepEqual(Object.keys(mcp.mcpServers).map(normalizeServer).sort(), [...SERVERS].sort());
    assert.equal(mcp.mcpServers['generic:gitlab'].args.at(-1), 'generic_gitlab');
    assert.ok(Object.values(mcp.mcpServers).every((s) => s.env.STUB_CALLS === base.calls));
    // built by the production builder: exactly one pair of flags, the path (never the content) is in argv
    assert.equal(a.args.filter((x) => x === '--strict-mcp-config').length, 1);
    assert.equal(a.args.filter((x) => x === '--mcp-config').length, 1);
    assert.equal(a.args[a.args.indexOf('--mcp-config') + 1], join(base.work, 'mcp.json'));
    assert.ok(!a.args.join('\n').includes('STUB_CALLS'));
    // step (c): no gate hook, the dump hook alone, so the tool is denied by dontAsk only
    const c = buildLaunch({ ...base, dump: true, gate: false });
    const cs = JSON.parse(c.args[c.args.indexOf('--settings') + 1]);
    assert.ok(Object.values(cs.hooks).every((h) => h[0].hooks.length === 1 && h[0].hooks[0].command.includes('dump-hook')));
    assert.ok(!c.args.join(' ').includes('send-gate.mjs'));
    // no gate and no dump: no settings at all
    assert.ok(!buildLaunch({ ...base, gate: false }).args.includes('--settings'));
    // S2: narrow agent form and stream-json
    for (const [fault, cmd] of [['sleep', 'sleep 30'], ['fail', 'exit 1']]) {
      const f = buildLaunch({ ...base, hookFault: fault }).args;
      const hooks = JSON.parse(f[f.indexOf('--settings') + 1]).hooks;
      assert.equal(hooks.PreToolUse[0].hooks[0].command, cmd, fault);
      assert.equal(hooks.PreToolUse[0].hooks[0].timeout, 10, 'the sleep exceeds the hook timeout');
    }
    const n = buildLaunch({ ...base, narrowAgent: true, format: 'stream-json' });
    const allowed = n.args[n.args.indexOf('--allowedTools') + 1].split(',');
    assert.ok(!allowed.includes('Agent'));
    for (const s of SUBAGENTS) assert.ok(allowed.includes(`Agent(${s})`));
    assert.equal(n.args[n.args.indexOf('--output-format') + 1], 'stream-json');
    assert.ok(n.args.includes('--verbose'));
    for (const argv of [a.args, c.args, n.args]) { assert.ok(!argv.includes('bypassPermissions')); assert.ok(!argv.includes('--dangerously-skip-permissions')); }
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('spike harness: launch-claude runs end to end on the stand-in claude: hooks fire, the dump hook writes the input shape', async () => {
  const d = await tmp();
  try {
    const bin = join(d, 'claude');
    await writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
    await chmod(bin, 0o755);
    const work = join(d, 'w');
    await mkdir(work, { recursive: true });
    const plan = [{ tool_name: SEND_TOOLS[0], tool_input: { chat_sn: 'spike-chat', text: 'spike a' } }];
    const r = spawnSync(process.execPath, [D('launch-claude.mjs'), '--work', work, '--dump'], {
      input: 'prompt', encoding: 'utf8',
      env: { PATH: process.env.PATH, CLAUDE_BIN: bin, STUB_CALLS: join(d, 'calls.jsonl'), FAKE_CLAUDE_MODE: 'send', FAKE_CLAUDE_SEND_PLAN: JSON.stringify(plan), FAKE_CLAUDE_MCP_OUT: join(d, 'fake-mcp.jsonl') },
    });
    assert.equal(r.status, 0, r.stderr);
    const pre = (await readFile(join(work, 'hook-PreToolUse.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(pre.length, 1);
    assert.equal(pre[0].tool_name, SEND_TOOLS[0]);
    assert.ok(existsSync(join(work, 'hook-PostToolUse.jsonl')));
    // the gate itself ran (policy written by the launcher allows spike-chat): audit has an attempt and an ok
    const audit = (await readFile(join(work, 'run', 'audit.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l).event);
    assert.deepEqual(audit, ['attempt', 'ok']);
  } finally { await rm(d, { recursive: true, force: true }); }
});

async function fixtureDir(files) {
  const d = await tmp();
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(d, rel, '..'), { recursive: true });
    await writeFile(join(d, rel), typeof content === 'string' ? content : `${content.map((x) => JSON.stringify(x)).join('\n')}\n`);
  }
  return d;
}

test('spike harness: evaluateS1 proposes PASS only when (a), (b), (c) hold and records the forms (d), (e)', async () => {
  const vk = { n: 1, server: 'mcp-workspace-assistant', tool: 'messenger-send-message', args: { chat_sn: 'spike-chat', text: 't' } };
  const init = (servers, tools) => [{ type: 'system', subtype: 'init', mcp_servers: servers.map((name) => ({ name, status: 'connected' })), tools }];
  const K_OK = init(['mcp-jira', 'generic:gitlab'], ['Agent', 'mcp__mcp-jira__jira_get_issue', 'mcp__generic_gitlab__get_commits']);
  const gl = { n: 1, server: 'generic_gitlab', tool: 'add_merge_request_note', args: { project_id: 'group/proj', merge_request_iid: 7, body: 'b' } };
  const pre = { hook_event_name: 'PreToolUse', tool_name: SEND_TOOLS[0], tool_input: {}, tool_use_id: 'u1' };
  const good = await fixtureDir({
    'a/calls.jsonl': [vk], 'a/hook-PreToolUse.jsonl': [pre], 'a/hook-PostToolUse.jsonl': [{ ...pre, tool_response: { content: [{ type: 'text', text: 'ok https://x/1' }] } }], 'a/code': '0',
    'b/calls.jsonl': [vk], 'b/hook-PreToolUse.jsonl': [{ ...pre, agent_id: 'sub', agent_type: 'ai-space-comms' }],
    'c/calls.jsonl': '', 'c/hook-PreToolUse.jsonl': [pre], 'c/code': '0',
    'f/calls.jsonl': '', 'f/code': '0', 'g/calls.jsonl': '', 'g/code': '1',
    'k/calls.jsonl': '', 'k/code': '0', 'k/out': K_OK, 'l/calls.jsonl': '', 'l/code': '0', 'l/out': '{}', 'm/calls.jsonl': '', 'm/code': '0', 'm/out': '{}',
    'd/hook-PostToolUse.jsonl': [{ ...pre, tool_response: 'plain text' }], 'e/calls.jsonl': [gl],
  });
  const bad = await fixtureDir({ 'a/calls.jsonl': [vk], 'a/hook-PreToolUse.jsonl': [pre], 'b/hook-PreToolUse.jsonl': [pre], 'c/calls.jsonl': [vk], 'c/code': '0' });
  try {
    const r = evaluateS1(good);
    assert.equal(r.proposed, 'PASS');
    assert.equal(r.facts.a_hook_in_subagent, true);
    assert.deepEqual(r.facts.e_project_id, [{ type: 'string', value: 'group/proj' }]);
    assert.deepEqual(r.facts.e_chat_sn, [{ type: 'string', value: 'spike-chat' }]);
    assert.deepEqual(r.facts.g_sub_pre_fields.includes('agent_id'), true);
    assert.equal(r.facts.d_response_forms[0].response, 'string');
    assert.equal(evaluateS1(bad).proposed, 'FAIL');
    // SEC02: a faulty hook (sleeps past its timeout, exits 1) must still end with the call rejected
    assert.equal(r.facts.f_denied_hook_sleeps, true);
    assert.equal(r.facts.g_denied_hook_exit1, true);
    // SEC12/SEC13: plugin allow, sender agent/skill, CLAUDE_CONFIG_DIR allow
    assert.deepEqual([r.facts.k_strict_mcp_no_foreign, r.facts.l_sender_agent_hook_fail_denied, r.facts.m_config_dir_allow_hook_fail_denied], [true, true, true]);
    assert.deepEqual(r.facts.k_init, { init_seen: true, servers: ['mcp-jira', 'generic:gitlab'], foreign_servers: [], foreign_tool_count: 0, unexpected_servers: [] });
    // (k) is judged by the init event of the stream, not by calls
    const kDir = await fixtureDir({ 'k/out': K_OK });
    const kBad = (servers, tools) => fixtureDir({ 'k/out': init(servers, tools) });
    try {
      assert.equal(evaluateK(join(kDir, 'k/out')).ok, true);
      for (const [servers, tools] of [
        [['mcp-jira', 'plugin:productivity:slack'], []], [['plugin_x_y'], []], [['claude.ai Gmail'], []], [['yadisk'], []], [['telegram'], []],
        [['mcp-jira'], ['mcp__plugin_x_y__ping']], [['mcp-jira'], ['mcp__claude_ai_Gmail__send_message']], [['mcp-jira'], ['mcp__yadisk__x']], [['mcp-jira'], ['mcp__telegram__x']],
      ]) {
        const dd = await kBad(servers, tools);
        try { assert.equal(evaluateK(join(dd, 'k/out')).ok, false, JSON.stringify([servers, tools])); } finally { await rm(dd, { recursive: true, force: true }); }
      }
      assert.equal(evaluateK(join(kDir, 'nothing')).ok, false, 'no init event: not a pass');
      assert.equal(evaluateK(join(kDir, 'nothing')).init_seen, false);
    } finally { await rm(kDir, { recursive: true, force: true }); }
    for (const name of ['k', 'l', 'm']) {
      const leak = await fixtureDir({
        'a/calls.jsonl': [vk], 'a/hook-PreToolUse.jsonl': [pre], 'b/calls.jsonl': [vk], 'b/hook-PreToolUse.jsonl': [{ ...pre, agent_id: 'sub' }],
        'c/calls.jsonl': '', 'c/code': '0', 'f/calls.jsonl': '', 'f/code': '0', 'g/calls.jsonl': '', 'g/code': '1',
        ...Object.fromEntries(['k', 'l', 'm'].flatMap((n) => [[`${n}/calls.jsonl`, n === name ? [vk] : ''], [`${n}/code`, '0'], [`${n}/out`, n === 'k' ? K_OK : '{}']])),
      });
      try { assert.equal(evaluateS1(leak).proposed, 'FAIL', `a call that got through in run ${name} fails S1`); } finally { await rm(leak, { recursive: true, force: true }); }
    }
    const leaky = await fixtureDir({
      'a/calls.jsonl': [vk], 'a/hook-PreToolUse.jsonl': [pre], 'b/calls.jsonl': [vk], 'b/hook-PreToolUse.jsonl': [{ ...pre, agent_id: 'sub' }],
      'c/calls.jsonl': '', 'c/code': '0', 'f/calls.jsonl': [vk], 'f/code': '0', 'g/calls.jsonl': '', 'g/code': '1',
    });
    try { assert.equal(evaluateS1(leaky).proposed, 'FAIL', 'a call that got through a sleeping hook fails S1'); } finally { await rm(leaky, { recursive: true, force: true }); }
    assert.equal(evaluateS1(await tmp()).proposed, 'FAIL', 'nothing ran: FAIL, never PASS by default');
  } finally { await rm(good, { recursive: true, force: true }); await rm(bad, { recursive: true, force: true }); }
});

test('spike harness: evaluateS2 and evaluateS3 read stream-json and the calls file', async () => {
  const stream = (turns, cost, subtype = 'success', agents = []) => [
    { type: 'system', subtype: 'init', mcp_servers: [{ name: 'a', status: 'connected' }, { name: 'b', status: 'pending' }] },
    ...agents.flatMap(([sub, err], i) => [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Agent', input: { subagent_type: sub } }] } }, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, is_error: err }] } }]),
    { type: 'result', subtype, num_turns: turns, total_cost_usd: cost },
  ];
  const d = await fixtureDir({
    'narrow/out': stream(4, 0.1, 'success', [['ai-space-comms', false], ['general-purpose', true]]),
    't1/out': stream(5, 0.2), 't2/out': stream(40, 2.5), 't3/out': stream(12, 0.5),
    's3/calls.jsonl': [{ n: 1, server: 'mcp-workspace-assistant', tool: 'messenger-send-message', args: {} }], 's3/hook-PreToolUse.jsonl': [{ tool_name: 'x' }], 's3/code': '0',
  });
  try {
    const s2 = evaluateS2(d);
    assert.equal(s2.proposed, 'PASS');
    assert.equal(s2.facts.a_agent_named_works, true);
    assert.equal(s2.facts.a_other_names_rejected, true);
    assert.deepEqual(s2.facts.c_mcp_status_counts, { connected: 1, pending: 1 });
    assert.deepEqual(s2.facts.b_tasks.map((t) => t.turns), [5, 40, 12]);
    assert.equal(evaluateS3(d).proposed, 'PASS');
    assert.equal(evaluateS3(await tmp()).proposed, 'FAIL');
    await writeFile(join(d, 't2', 'out'), `${JSON.stringify({ type: 'result', subtype: 'error_max_turns', num_turns: 50, total_cost_usd: 1 })}\n`);
    assert.equal(evaluateS2(d).proposed, 'FAIL');
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('spike harness: the note template parses: verdict lines, all fields of S1 (a..f), S2 (a..c), S3, the FAIL instructions, fact markers', async () => {
  const note = await readFile(NOTE, 'utf8');
  for (const n of ['S1', 'S2', 'S3']) assert.match(note, new RegExp(`^${n}: (PASS|FAIL|PENDING)$`, 'm'), n);
  for (const frag of ['(а)', '(б)', '(в)', '(г)', '(д)', '(е)']) assert.ok(note.includes(frag), `S1 ${frag}`);
  assert.ok(note.split('## S2')[1].includes('(а)') && note.split('## S2')[1].includes('(б)') && note.split('## S2')[1].includes('(в)'));
  assert.ok(note.includes('## S3'));
  assert.match(note, /Если S1 \(б\) не прошёл[^\n]*шлюз MCP[^\n]*\n[^\n]*Автоотката на вариант C нет/);
  assert.ok(note.includes('Если S3 не прошёл') && note.includes('файлы агента не править'));
  for (const n of ['S1', 'S2', 'S3']) assert.ok(note.includes(`<!-- ${n}-facts:begin -->`) && note.includes(`<!-- ${n}-facts:end -->`));
  assert.ok(!/data\/taskflow\.json/.test(note), 'no real data');
  assert.ok(!/(Bearer |sk-[A-Za-z0-9])/.test(note), 'no secrets');
  // writing facts replaces the block only, is repeatable, and never writes a verdict line
  const once = renderFacts(note, { name: 'S1', facts: { a: 1 }, proposed: 'PASS' }, '2026-10-06');
  assert.match(once, /^S1-proposed: PASS/m);
  const verdictLine = (t) => (/^S1: .*$/m.exec(t) || [''])[0];
  assert.equal(verdictLine(once), verdictLine(note), 'the verdict stays with the user');
  assert.equal(renderFacts(once, { name: 'S1', facts: { a: 1 }, proposed: 'PASS' }, '2026-10-06'), once);
  assert.throws(() => renderFacts('no markers', { name: 'S1', facts: {}, proposed: 'FAIL' }));
});

test('spike harness: scripts are valid shell, clean up in a trap, use stubs only and never touch real data or the user policy', async () => {
  for (const f of ['run-s1.sh', 'run-s2.sh', 'run-s3.sh', 'common.sh']) {
    const r = spawnSync('sh', ['-n', D(f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    const src = await readFile(D(f), 'utf8');
    assert.ok(!/data\/taskflow\.json/.test(src), f);
    assert.ok(!/\.config\/taskflow-agent\/send-policy/.test(src), `${f}: the user's policy file is not created`);
    assert.ok(!/launchctl\s+bootstrap[^\n]*LaunchAgents/.test(src), `${f}: no permanent plist`);
  }
  const common = await readFile(D('common.sh'), 'utf8');
  assert.match(common, /trap cleanup EXIT INT TERM/);
  assert.match(common, /launchctl bootout/);
  assert.match(common, /rm -rf "\$T"/);
  const s1 = await readFile(D('run-s1.sh'), 'utf8');
  assert.match(s1, /ln -s "\$HOME\/\.claude\/\$d" "\$CFG_M\/\$d"/, '(m): symlinks to ~/.claude/agents and skills');
  assert.ok(s1.includes('agents skills'));
  assert.ok(!/\b(cp|rsync|mv)\b[^\n]*\.claude/.test(s1), 'nothing is copied out of ~/.claude');
  assert.ok(s1.includes('--cfg "$CFG_M"') && s1.includes('--format stream-json'), 'the k run is stream-json, the m run uses the prepared directory');
  const launch = await readFile(D('launch-claude.mjs'), 'utf8');
  assert.ok(!launch.includes("push('--mcp-config'"), 'the MCP flags come from the production builder, not from the spike');
  assert.ok(launch.includes('--strict-mcp-config'), 'only stub MCP servers are visible to claude');
  for (const [f, name] of [['run-s1.sh', 's1'], ['run-s2.sh', 's2'], ['run-s3.sh', 's3']]) assert.ok((await readFile(D(f), 'utf8')).includes(`evaluate-send.mjs" ${name}`), f);
});
