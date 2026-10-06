import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, appendFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AUDIT_BLOCKED_MAX, AUDIT_FILE, AUDIT_LINE_MAX, JOURNAL_ENTRIES_MAX, appendAudit, readAudit, buildJournal, extractRef,
} from '../agent/lib/audit.mjs';

const MOD = fileURLToPath(new URL('../agent/lib/audit.mjs', import.meta.url));
const tmp = () => mkdtemp(join(tmpdir(), 'tf-audit-'));
const rec = (o) => ({ ts: 1000, tool_use_id: 't1', kind: 'vk', target: 'чат c1', snippet: 'привет', ...o });

test('audit: [send] AC-015 AC-016 the three outcomes and a lone blocked are glued by tool_use_id', async () => {
  const d = await tmp();
  try {
    appendAudit(d, rec({ event: 'attempt', ts: 1, tool_use_id: 'a' }));
    appendAudit(d, rec({ event: 'ok', ts: 2, tool_use_id: 'a', ref: 'https://x/1' }));
    appendAudit(d, rec({ event: 'attempt', ts: 3, tool_use_id: 'b', kind: 'jira', target: 'OPS-1' }));
    appendAudit(d, rec({ event: 'error', ts: 4, tool_use_id: 'b', kind: 'jira', target: 'OPS-1', reason: 'boom' }));
    appendAudit(d, rec({ event: 'attempt', ts: 5, tool_use_id: 'c', kind: 'confluence', target: 'DEV: Отчёт' }));
    appendAudit(d, rec({ event: 'blocked', ts: 6, tool_use_id: 'e', reason: 'not_allowed' }));
    const j = buildJournal(readAudit(d), { due: '2026-10-07' });
    assert.equal(j.due, '2026-10-07');
    assert.deepEqual(j.entries, [
      { kind: 'vk', outcome: 'ok', target: 'чат c1', ref: 'https://x/1', snippet: 'привет' },
      { kind: 'jira', outcome: 'error', target: 'OPS-1', snippet: 'привет', reason: 'boom' },
      { kind: 'confluence', outcome: 'started', target: 'DEV: Отчёт', snippet: 'привет' },
      { kind: 'vk', outcome: 'blocked', target: 'чат c1', reason: 'not_allowed' },
    ]);
    assert.equal(j.hidden, undefined);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('audit: ok without a preceding attempt record still gives an ok entry (the final record carries kind and target)', async () => {
  const d = await tmp();
  try {
    appendAudit(d, rec({ event: 'ok', tool_use_id: 'z', ref: 'id 7' }));
    assert.deepEqual(buildJournal(readAudit(d), {}).entries.map((e) => e.outcome), ['ok']);
    assert.equal(buildJournal(readAudit(d), {}).due, null);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('audit: [send] AC-025 the journal is built from the file only', async () => {
  const d = await tmp();
  try {
    assert.deepEqual(buildJournal(readAudit(d), { due: null }), { due: null, entries: [] }, 'no file: no actions');
    appendAudit(d, rec({ event: 'attempt', tool_use_id: 'a' }));
    const j = buildJournal(readAudit(d), { due: 'x' });
    assert.equal(j.entries.length, 1);
    assert.equal(j.entries[0].outcome, 'started');
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('audit: a flood of 250 blocks: 200 lines in the file, journal keeps 100 entries, rest in hidden.blocked, ok/error/started are not displaced', async () => {
  const d = await tmp();
  try {
    appendAudit(d, rec({ event: 'attempt', ts: 1, tool_use_id: 'ok1' }));
    appendAudit(d, rec({ event: 'ok', ts: 2, tool_use_id: 'ok1', ref: 'r' }));
    appendAudit(d, rec({ event: 'attempt', ts: 3, tool_use_id: 'st1' }));
    for (let i = 0; i < 250; i++) appendAudit(d, rec({ event: 'blocked', ts: 10 + i, tool_use_id: `b${i}`, reason: 'limit' }));
    appendAudit(d, rec({ event: 'attempt', ts: 5000, tool_use_id: 'late' }));
    appendAudit(d, rec({ event: 'error', ts: 5001, tool_use_id: 'late', reason: 'e' }));
    const lines = (await readFile(join(d, AUDIT_FILE), 'utf8')).trim().split('\n');
    assert.equal(lines.filter((l) => l.includes('"event":"blocked"')).length, AUDIT_BLOCKED_MAX);
    assert.equal((await stat(join(d, 'audit.overflow'))).size, 50);
    const r = readAudit(d);
    assert.equal(r.blockedOverflow, 50);
    const j = buildJournal(r, { due: null });
    assert.equal(j.entries.length, JOURNAL_ENTRIES_MAX);
    const by = (o) => j.entries.filter((e) => e.outcome === o).length;
    assert.equal(by('ok'), 1); assert.equal(by('error'), 1); assert.equal(by('started'), 1);
    assert.equal(by('blocked'), 97);
    assert.equal(j.hidden.blocked, 200 - 97 + 50);
    assert.equal(j.entries.at(-1).outcome, 'error', 'ordered by time');
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('audit: broken and truncated lines do not throw, badLines counts them', async () => {
  const d = await tmp();
  try {
    appendAudit(d, rec({ event: 'attempt', tool_use_id: 'a' }));
    await appendFile(join(d, AUDIT_FILE), '{broken\n\n[1,2]\n{"event":"nope","tool_use_id":"x"}\n{"event":"ok"}\n{"event":"ok","tool_use_id":"tr","ki');
    appendAudit(d, rec({ event: 'ok', tool_use_id: 'a' }));
    const r = readAudit(d);
    assert.equal(r.badLines, 5);
    assert.equal(r.records.length, 1 + 0, 'the truncated tail swallowed the second append: only one valid line remains');
    assert.ok(buildJournal(r, {}).entries.length >= 1);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('audit: a line is shorter than 4 KiB: long fields are cut before the write; one line per call', async () => {
  const d = await tmp();
  try {
    appendAudit(d, { event: 'attempt', tool_use_id: 'x'.repeat(5000), kind: 'vk', target: 'я'.repeat(5000), snippet: 'я'.repeat(5000), ref: 'я'.repeat(5000), reason: 'я'.repeat(5000), agent_type: 'я'.repeat(5000) });
    const text = await readFile(join(d, AUDIT_FILE), 'utf8');
    const lines = text.split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.ok(Buffer.byteLength(lines[0]) < AUDIT_LINE_MAX);
    assert.equal(JSON.parse(lines[0]).event, 'attempt');
    assert.throws(() => appendAudit(d, { event: 'weird' }), TypeError);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('audit: parallel appends from several processes never interleave lines', async () => {
  const d = await tmp();
  try {
    const code = `import { appendAudit } from ${JSON.stringify(MOD)}; for (let i = 0; i < 40; i++) appendAudit(${JSON.stringify(d)}, { event: 'attempt', ts: i, tool_use_id: process.pid + '-' + i, kind: 'vk', target: 'чат ' + 'я'.repeat(100), snippet: 'z'.repeat(90) });`;
    await Promise.all(Array.from({ length: 6 }, () => new Promise((res, rej) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });
      c.on('error', rej); c.on('close', res);
    })));
    const r = readAudit(d);
    assert.equal(r.badLines, 0);
    assert.equal(r.records.length, 240);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('audit: sub-agent marks are kept and the file is 0600', async () => {
  const d = await tmp();
  try {
    appendAudit(d, rec({ event: 'attempt', agent_type: 'ai-space-comms', sub: true }));
    const r = readAudit(d).records[0];
    assert.equal(r.sub, true);
    assert.equal(r.agent_type, 'ai-space-comms');
    assert.equal((await stat(join(d, AUDIT_FILE))).mode & 0o777, 0o600);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('audit: [send] AC-015 extractRef on a string, an object, an array of blocks and an empty response', () => {
  assert.equal(extractRef('Отправлено: https://vk.example/m/123.'), 'https://vk.example/m/123');
  assert.equal(extractRef({ content: [{ type: 'text', text: 'ok https://gitlab.example/g/p/-/merge_requests/1#note_5)' }] }), 'https://gitlab.example/g/p/-/merge_requests/1#note_5');
  assert.equal(extractRef([{ type: 'text', text: 'нет ссылки' }, { type: 'text', text: '{"web_url":"/browse/OPS-1"}' }]), '/browse/OPS-1');
  assert.equal(extractRef({ content: [{ type: 'text', text: '{"id":"456","title":"x"}' }] }), 'id 456');
  assert.equal(extractRef({ content: [{ type: 'text', text: '{"result":{"key":"OPS-9"}}' }] }), 'id OPS-9');
  assert.equal(extractRef({ id: 77 }), 'id 77');
  assert.equal(extractRef('https://a.example/' + 'x'.repeat(400)).length, 200);
  for (const empty of [null, undefined, '', '   ', {}, [], { content: [] }, { content: [{ type: 'text', text: '' }] }, 'сообщение отправлено', 5]) {
    assert.equal(extractRef(empty), null, JSON.stringify(empty));
  }
  const cyc = {}; cyc.self = cyc;
  assert.doesNotThrow(() => extractRef(cyc));
});

test('audit: [send] SEC09 a blocked record never stores the snippet, even if the caller passes one', async () => {
  const d = await tmp();
  try {
    appendAudit(d, rec({ event: 'blocked', tool_use_id: 'q', reason: 'quick_action', snippet: 'СЕКРЕТНЫЙ-ТЕКСТ' }));
    appendAudit(d, rec({ event: 'attempt', tool_use_id: 'r', snippet: 'видимый' }));
    const raw = await readFile(join(d, 'audit.jsonl'), 'utf8');
    assert.ok(!raw.includes('СЕКРЕТНЫЙ-ТЕКСТ'));
    assert.ok(raw.includes('видимый'), 'non-blocked records keep the snippet');
  } finally { await rm(d, { recursive: true, force: true }); }
});
