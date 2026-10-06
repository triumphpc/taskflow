import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEND_TOOLS } from '../agent/lib/policy.mjs';
import { SPECS, describeCall, contentRisk } from '../agent/lib/send-targets.mjs';

const [VK, NOTE, DISC, REPLY, JIRA, CONF] = SEND_TOOLS;

test('send-targets: SPECS keys equal SEND_TOOLS', () => {
  assert.deepEqual(Object.keys(SPECS).sort(), [...SEND_TOOLS].sort());
});

test('send-targets: [send] AC-004 VK Teams: chat_sn is the key, text is required', () => {
  const c = describeCall(VK, { chat_sn: '123@chat.agent', text: 'Привет,\n\n  мир', parse_mode: 'HTML' });
  assert.deepEqual(c, { kind: 'vk', slot: 'vk', list: 'vk_chats', key: '123@chat.agent', target: 'чат 123@chat.agent', snippet: 'Привет, мир' });
  assert.equal(describeCall(VK, { text: 'x' }), null);
  assert.equal(describeCall(VK, { chat_sn: 'a' }), null);
  assert.equal(describeCall(VK, { chat_sn: '', text: 'x' }), null);
  assert.equal(describeCall(VK, { chat_sn: 5, text: 'x' }), null);
  assert.equal(describeCall(VK, { chat_sn: 'a', text: '   ' }), null);
  assert.equal(describeCall(VK, { chat_sn: 'a\nb', text: 'x' }), null, 'control characters in a key field');
});

test('send-targets: [send] AC-005 GitLab note, discussion and reply share the project list and one slot kind', () => {
  const n = describeCall(NOTE, { project_id: 'grp/proj', merge_request_iid: 12, body: 'ок' });
  assert.deepEqual(n, { kind: 'mr_note', slot: 'gitlab_comment', list: 'gitlab_projects', key: 'grp/proj', target: 'grp/proj!12', snippet: 'ок' });
  const d = describeCall(DISC, { project_id: 4242, merge_request_iid: 3, body: 'b', file_path: 'src/a.go', new_line: 40, old_line: 39 });
  assert.equal(d.key, '4242', 'numeric project_id becomes a string');
  assert.equal(d.target, '4242!3 src/a.go:40');
  assert.equal(d.kind, 'mr_discussion');
  const r = describeCall(REPLY, { project_id: 'p', merge_request_iid: 1, discussion_id: 'abc', body: 'b' });
  assert.equal(r.target, 'p!1 (ответ)');
  assert.equal(r.slot, 'gitlab_comment');
});

test('send-targets: GitLab shape errors give null (iid, new_line, missing fields, wrong types)', () => {
  const ok = { project_id: 'p', merge_request_iid: 1, body: 'b' };
  assert.ok(describeCall(NOTE, ok));
  for (const bad of [{ ...ok, merge_request_iid: 0 }, { ...ok, merge_request_iid: '1' }, { ...ok, merge_request_iid: 1.5 }, { ...ok, merge_request_iid: -2 },
    { ...ok, project_id: undefined }, { ...ok, project_id: '' }, { ...ok, project_id: {} }, { ...ok, project_id: 1.5 }, { ...ok, body: '' }, { ...ok, body: 3 }]) {
    assert.equal(describeCall(NOTE, bad), null, JSON.stringify(bad));
  }
  const d = { ...ok, file_path: 'a', new_line: 1 };
  assert.ok(describeCall(DISC, d));
  for (const bad of [{ ...d, new_line: 0 }, { ...d, new_line: '1' }, { ...d, file_path: '' }, { ...d, file_path: undefined }, { ...d, new_line: undefined }]) assert.equal(describeCall(DISC, bad), null);
  assert.equal(describeCall(REPLY, ok), null, 'discussion_id is required');
  assert.equal(describeCall(REPLY, { ...ok, discussion_id: '' }), null);
});

test('send-targets: [send] AC-006 Jira: the key is the project prefix of issueKey', () => {
  const c = describeCall(JIRA, { issueKey: 'VKTAI-123', comment: 'текст' });
  assert.deepEqual(c, { kind: 'jira', slot: 'jira', list: 'jira_projects', key: 'VKTAI', target: 'VKTAI-123', snippet: 'текст' });
  assert.equal(describeCall(JIRA, { issueKey: 'A_B1-7', comment: 'x' }).key, 'A_B1');
  for (const k of ['ops-1', 'OPS', 'OPS-x', 'OPS-', '-1', '1OPS-1', 'OPS-1\nX', ' OPS-1', 'OPS-1 ', 'OPS-1-2', undefined, 5]) {
    assert.equal(describeCall(JIRA, { issueKey: k, comment: 'x' }), null, String(k));
  }
  assert.equal(describeCall(JIRA, { issueKey: 'OPS-1' }), null);
  assert.ok(!/\n/.test(describeCall(JIRA, { issueKey: 'OPS-1', comment: 'a\nb' }).snippet));
});

test('send-targets: [send] AC-007 Confluence: space_key is the key, title is cut to 60 and flattened', () => {
  const c = describeCall(CONF, { space_key: 'DEV', title: `Отчёт\nза ${'я'.repeat(80)}`, body: '<p>Привет   <b>мир</b></p>', parent_id: '5' });
  assert.equal(c.key, 'DEV');
  assert.equal(c.kind, 'confluence');
  assert.equal(c.slot, 'confluence');
  assert.equal(c.list, 'confluence_spaces');
  assert.ok(c.target.startsWith('DEV: Отчёт за '));
  assert.equal(c.target.length, 'DEV: '.length + 60);
  assert.ok(!/\n/.test(c.target));
  assert.equal(c.snippet, 'Привет мир');
  assert.equal(describeCall(CONF, { space_key: 'DEV', title: 'T' }), null);
  assert.equal(describeCall(CONF, { space_key: 'DEV', body: 'b' }), null);
  assert.equal(describeCall(CONF, { title: 'T', body: 'b' }), null);
});

test('send-targets: snippet is the first 100 characters with collapsed whitespace', () => {
  const c = describeCall(VK, { chat_sn: 'c', text: `${'a '.repeat(80)}\n\n\tend` });
  assert.equal(c.snippet.length, 100);
  assert.ok(!/\s\s/.test(c.snippet));
});

test('send-targets: extra fields are ignored, unknown tool and junk input give null without throwing', () => {
  assert.deepEqual(describeCall(VK, { chat_sn: 'c', text: 't', extra: 1, parent_id: 2 }), describeCall(VK, { chat_sn: 'c', text: 't' }));
  for (const input of [null, undefined, 'str', 42, [], [1], () => {}]) assert.equal(describeCall(VK, input), null);
  assert.equal(describeCall('mcp__mcp-jira__jira_get_issue', { issueKey: 'A-1', comment: 'x' }), null);
  assert.equal(describeCall(undefined, {}), null);
  assert.equal(describeCall('toString', { chat_sn: 'c', text: 't' }), null);
  assert.equal(describeCall('__proto__', {}), null);
  const hostile = { get chat_sn() { throw new Error('boom'); }, text: 'x' };
  assert.equal(describeCall(VK, hostile), null);
});

test('send-targets: key is compared exactly, no trimming or case folding', () => {
  assert.equal(describeCall(VK, { chat_sn: ' Ab ', text: 'x' }).key, ' Ab ');
  assert.equal(describeCall(CONF, { space_key: 'dev', title: 't', body: 'b' }).key, 'dev');
});

test('send-targets: [send] SEC01 GitLab quick actions at the start of any line are flagged for note, discussion and reply; no code-block exemption', () => {
  const base = { project_id: 'p', merge_request_iid: 1 };
  const inputs = {
    [NOTE]: base, [DISC]: { ...base, file_path: 'a.go', new_line: 2 }, [REPLY]: { ...base, discussion_id: 'd' },
  };
  for (const [tool, extra] of Object.entries(inputs)) {
    for (const body of ['/merge', '/approve', '  /close', 'текст\n/merge', 'текст\r\n\t/unapprove now', '```\n/merge\n```', '/_hidden', '/MERGE', '\n\n/assign @x']) {
      assert.equal(contentRisk(tool, { ...extra, body }), 'quick_action', `${tool.split('__')[2]}: ${JSON.stringify(body)}`);
    }
    for (const body of ['обычный текст', 'путь a/b/c и 1/2', 'см. https://x/y', 'слеш в конце /', '//comment', '/ 5', '/1']) {
      assert.equal(contentRisk(tool, { ...extra, body }), null, `${tool.split('__')[2]}: ${JSON.stringify(body)}`);
    }
  }
});

test('send-targets: [send] SEC08 VK text with a leading slash is flagged; Confluence html/iframe/include/html-include macros are flagged case-insensitively', () => {
  for (const text of ['/start', '  /help', 'привет\n/cmd', '/ ']) assert.equal(contentRisk(VK, { chat_sn: 'c', text }), 'quick_action', JSON.stringify(text));
  for (const text of ['привет', 'a/b', 'https://x/y']) assert.equal(contentRisk(VK, { chat_sn: 'c', text }), null, text);
  const macro = (name, attr = 'ac:name') => `<p>x</p><ac:structured-macro ${attr}="${name}" ac:schema-version="1"><ac:plain-text-body><![CDATA[<script>]]></ac:plain-text-body></ac:structured-macro>`;
  for (const name of ['html', 'iframe', 'include', 'html-include', 'HTML', 'Html-Include', ' iframe ']) {
    assert.equal(contentRisk(CONF, { space_key: 'D', title: 'T', body: macro(name) }), 'macro', name);
  }
  assert.equal(contentRisk(CONF, { space_key: 'D', title: 'T', body: macro('html', 'name') }), 'macro', 'name without the ac: prefix');
  assert.equal(contentRisk(CONF, { space_key: 'D', title: 'T', body: "<ac:structured-macro ac:name='IFRAME'/>" }), 'macro', 'single quotes');
  for (const name of ['code', 'info', 'toc', 'htmlx', 'my-include']) assert.equal(contentRisk(CONF, { space_key: 'D', title: 'T', body: macro(name) }), null, name);
  assert.equal(contentRisk(CONF, { space_key: 'D', title: 'T', body: '<p>html include iframe</p>' }), null, 'words are not macros');
});

test('send-targets: contentRisk never throws and ignores other tools and bad shapes', () => {
  for (const [t, i] of [['nope', {}], [VK, null], [VK, []], [VK, { text: 5 }], [NOTE, { body: {} }], [CONF, { body: 1 }], [JIRA, { comment: '/merge' }], [undefined, undefined]]) {
    assert.doesNotThrow(() => contentRisk(t, i));
    assert.equal(contentRisk(t, i), null);
  }
});

test('send-targets: [send] SEC11 invisible leading characters (U+200B, U+00AD, NUL, U+0001) do not hide a quick action or a bot command', () => {
  for (const ch of ['\u200B', '\u00AD', '\u0000', '\u0001', '\uFEFF', '\u2060']) {
    const body = `${ch}/merge`;
    for (const tool of [NOTE, DISC, REPLY]) {
      const extra = tool === DISC ? { file_path: 'a.go', new_line: 2 } : tool === REPLY ? { discussion_id: 'd' } : {};
      assert.equal(contentRisk(tool, { project_id: 'p', merge_request_iid: 1, ...extra, body }), 'quick_action', JSON.stringify(body));
      assert.equal(contentRisk(tool, { project_id: 'p', merge_request_iid: 1, ...extra, body: `текст\n${ch}${ch} /approve` }), 'quick_action');
    }
    assert.equal(contentRisk(VK, { chat_sn: 'c', text: `${ch}/start` }), 'quick_action', JSON.stringify(`${ch}/start`));
  }
  assert.equal(contentRisk(NOTE, { project_id: 'p', merge_request_iid: 1, body: '\u200Bобычный текст a/b' }), null);
});

// Замер: одна проверка тела должна укладываться в 200 мс (SEC14, ReDoS: лимит stdin хука 1 МБ, таймаут 10 с).
const timed = (fn) => { const t0 = process.hrtime.bigint(); const r = fn(); return { r, ms: Number(process.hrtime.bigint() - t0) / 1e6 }; };

test('send-targets: [send] SEC14 contentRisk is linear on pathological bodies (each check < 200 ms)', () => {
  const bodies = {
    'newlines x200000': '\n'.repeat(200000),
    'a-newline x300000': 'a\n'.repeat(300000),
    'CR x200000': '\r'.repeat(200000),
    'spaces-newline x100000': ' \n'.repeat(100000),
    'macro starts x40000': '<ac:structured-macro '.repeat(40000),
  };
  const calls = [
    [NOTE, (body) => ({ project_id: 'p', merge_request_iid: 1, body })],
    [VK, (text) => ({ chat_sn: 'c', text })],
    [CONF, (body) => ({ space_key: 'D', title: 'T', body })],
  ];
  for (const [label, body] of Object.entries(bodies)) {
    for (const [tool, mk] of calls) {
      const { r, ms } = timed(() => contentRisk(tool, mk(body)));
      assert.equal(r, null, `${label} / ${tool.split('__')[2]}`);
      assert.ok(ms < 200, `${label} / ${tool.split('__')[2]}: ${ms.toFixed(1)} ms`);
    }
  }
});

test('send-targets: [send] SEC14 padding does not hide a risk: action after a huge prefix, macro after many unclosed tags and long attributes', () => {
  const pad = '\n'.repeat(200000);
  assert.equal(contentRisk(NOTE, { project_id: 'p', merge_request_iid: 1, body: `${pad}/merge` }), 'quick_action');
  assert.equal(contentRisk(VK, { chat_sn: 'c', text: `${pad}/start` }), 'quick_action');
  for (const sep of ['\r\n', '\r', ' ', ' ']) {
    assert.equal(contentRisk(NOTE, { project_id: 'p', merge_request_iid: 1, body: `текст${sep}/merge` }), 'quick_action', JSON.stringify(sep));
    assert.equal(contentRisk(VK, { chat_sn: 'c', text: `текст${sep}/x` }), 'quick_action', JSON.stringify(sep));
  }
  assert.equal(contentRisk(NOTE, { project_id: 'p', merge_request_iid: 1, body: '  /merge' }), 'quick_action', 'NBSP');
  assert.equal(contentRisk(CONF, { space_key: 'D', title: 'T', body: `${'<ac:structured-macro '.repeat(40000)}<ac:structured-macro ac:name="html">` }), 'macro');
  assert.equal(contentRisk(CONF, { space_key: 'D', title: 'T', body: `<ac:structured-macro ac:x="${'y'.repeat(5000)}" ac:name="iframe">` }), 'macro', 'long attributes do not bypass');
  assert.equal(contentRisk(CONF, { space_key: 'D', title: 'T', body: '<ac:structured-macro <ac:structured-macro ac:name="html">' }), 'macro', 'nested start');
  assert.equal(contentRisk(CONF, { space_key: 'D', title: 'T', body: '<ac:structured-macro ac:name="code"><ac:structured-macro ac:name="html"/>' }), 'macro', 'second tag');
  assert.equal(contentRisk(CONF, { space_key: 'D', title: 'T', body: '<ac:structured-macro ac:name="code">name="html"' }), null, 'name outside the tag');
});
