// Security review fixes: SEC08 (server-side sanitising of agent data), SEC09 (empty token), SEC03 (no links in agent notes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeStore } from './helpers/inproc.mjs';
import { LIMITS, NOTE_TEXT_MAX, composeNote } from '../js/agent.js';
import { createLegacyClient } from './fixtures/legacy-client.mjs';
import { sanitizeIncomingTask } from '../sync.mjs';

const base = (o = {}) => ({ id: 't1', title: 'T', notes: '', due: '2026-10-04', done: false, kind: 'task', priority: 4, updatedAt: 100, createdAt: 1, ...o });
const blk = (status, o = {}) => ({ status, claimedAt: null, finishedAt: null, claimToken: null, at: 100, ...o });
const get = (store, id = 't1') => store.snapshot().tasks.find((t) => t.id === id);
const DAY = 24 * 3600 * 1000;

test('sec08/I05: an agent block with an unknown status is dropped (server block stays), not turned into null', async () => {
  const { store, cleanup } = await makeStore({ tasks: [] });
  try {
    await store.sync({ tasks: [base({ agent: { status: 'hacked', claimedAt: 'x', claimToken: 42, at: 5, extra: 'evil' } })] });
    assert.ok(!('agent' in get(store)), 'nothing to keep on a clean server');
    // the server already has a valid block: a garbage one must not touch it
    await store.sync({ tasks: [base({ id: 't2', agent: blk('review', { at: 50 }) })] });
    const r = await store.sync({ tasks: [base({ id: 't2', agent: { status: 'bogus', at: 9e12 } }), base({ id: 't3', agent: { at: 7 } })] });
    assert.equal(get(store, 't2').agent.status, 'review');
    assert.equal(get(store, 't2').agent.at, 50);
    assert.ok(!('agent' in get(store, 't3')), 'a block without a status is malformed too');
    assert.equal(r.applied, 1, 'only t3 was new');
    // explicit clear (status null) is a legitimate block and is cleaned of foreign fields
    await store.sync({ tasks: [base({ id: 't4', agent: { status: null, claimedAt: 'x', at: 5, extra: 'evil' } })] });
    assert.deepEqual(get(store, 't4').agent, { status: null, claimedAt: null, finishedAt: null, claimToken: null, at: 5 });
  } finally { await cleanup(); }
});

test('sec08/I04: agent.at and note.at more than a day ahead are ignored (not clamped); push is idempotent', async () => {
  const { store, cleanup } = await makeStore({ tasks: [base({ agent: blk('review', { at: 100 }), agentNotes: [{ at: 100, text: 'Результат агента\nok' }] })] });
  try {
    const far = Date.now() + 2 * DAY;
    const r1 = await store.sync({ tasks: [base({ agent: blk(null, { at: far }), agentNotes: [{ at: far, text: 'from the future' }] })] });
    assert.equal(get(store).agent.status, 'review', 'server block kept');
    assert.equal(get(store).agent.at, 100);
    assert.deepEqual(get(store).agentNotes.map((n) => n.text), ['Результат агента\nok']);
    assert.equal(r1.applied, 0);
    const r2 = await store.sync({ tasks: [base({ agent: blk(null, { at: far }), agentNotes: [{ at: far, text: 'from the future' }] })] });
    assert.equal(r2.applied, 0);
    // a following legitimate record still wins
    await store.sync({ tasks: [base({ agent: blk(null, { at: Date.now() + 5000 }) })] });
    assert.equal(get(store).agent.status, null);
    // within one day ahead is accepted as is, and a repeated push changes nothing
    const near = Date.now() + DAY - 60_000;
    const rec2 = base({ id: 't2', agent: blk('review', { at: near }), agentNotes: [{ at: near, text: 'near' }] });
    assert.equal((await store.sync({ tasks: [rec2] })).applied, 1);
    assert.equal(get(store, 't2').agent.at, near);
    assert.equal((await store.sync({ tasks: [rec2] })).applied, 0);
  } finally { await cleanup(); }
});

test('sec08/I01+I03: oversized NEW notes are dropped whole, the cap of 200 applies to new notes only, existing ones stay', async () => {
  const existing = Array.from({ length: 198 }, (_, i) => ({ at: i + 1, text: `old ${i}` }));
  const { store, cleanup } = await makeStore({ tasks: [base({ agentNotes: existing })] });
  try {
    const incoming = [{ at: 1000, text: 'x'.repeat(NOTE_TEXT_MAX + 1) }, { at: 1001, text: 'second' }, { at: 1002, text: 'third' }, { at: 1003, text: 'fourth' }];
    await store.sync({ tasks: [base({ agentNotes: incoming })] });
    const notes = get(store).agentNotes;
    assert.equal(notes.length, 200);
    assert.equal(notes.filter((n) => n.text.startsWith('old')).length, 198, 'existing notes are kept');
    assert.ok(notes.every((n) => n.text.length <= NOTE_TEXT_MAX));
    assert.ok(!notes.some((n) => n.text.startsWith('xxx')), 'oversized new note is dropped, not truncated');
    assert.ok(notes.some((n) => n.text === 'second') && notes.some((n) => n.text === 'third') && !notes.some((n) => n.text === 'fourth'));
  } finally { await cleanup(); }
  // cur already holds 250 (over the cap): existing ones are intact, one more new note is not accepted
  const big = Array.from({ length: 250 }, (_, i) => ({ at: i + 1, text: `n${i}` }));
  const { store: s2, cleanup: c2 } = await makeStore({ tasks: [base({ agentNotes: big })] });
  try {
    await s2.sync({ tasks: [base({ agentNotes: [...big, { at: 9999, text: 'new' }] })] });
    assert.equal(get(s2).agentNotes.length, 250);
    assert.ok(!get(s2).agentNotes.some((n) => n.text === 'new'));
    await s2.sync({ tasks: [base({ updatedAt: 200, title: 'renamed', agentNotes: big })] });
    assert.equal(get(s2).agentNotes.length, 250);
    assert.equal(get(s2).title, 'renamed');
  } finally { await c2(); }
});

test('sec08/I03: a task unknown to the server (restore / new device) keeps ALL incoming notes, newest included', async () => {
  const { store, cleanup } = await makeStore({ tasks: [] });
  try {
    const notes = Array.from({ length: 250 }, (_, i) => ({ at: i + 1, text: `n${i}` }));
    await store.sync({ tasks: [base({ agentNotes: notes })] });
    assert.equal(get(store).agentNotes.length, 250);
    assert.equal(get(store).agentNotes.at(-1).text, 'n249');
    assert.equal((await store.sync({ tasks: [base({ agentNotes: notes })] })).applied, 0);
  } finally { await cleanup(); }
});

test('I01: composeNote never exceeds NOTE_TEXT_MAX for any status', () => {
  const huge = 'я'.repeat(9000);
  for (const status of ['review', 'needs_info', 'failed']) {
    assert.ok(composeNote(status, huge).length <= NOTE_TEXT_MAX, status);
  }
  assert.equal(composeNote('review', 'x'.repeat(5000)).length, 'Результат агента\n'.length + LIMITS.NOTE_MAX);
  assert.ok(NOTE_TEXT_MAX >= composeNote('review', huge).length && NOTE_TEXT_MAX >= composeNote('needs_info', huge).length);
});

for (const [status, op] of [['review', 'Результат агента\n'], ['needs_info', 'Вопрос агента: ']]) {
  test(`I01: roundtrip of a 5000-char ${status} note (server finish -> client / legacy client sync) yields exactly one note`, async () => {
    const { store, cleanup } = await makeStore({ tasks: [base({ due: '2026-10-04', agent: blk('delegated', { at: 10 }) })] });
    try {
      const c = await store.agentTransition({ op: 'claim', id: 't1', today: '2026-10-05' });
      assert.equal(c.ok, true);
      const f = await store.agentTransition({ op: 'finish', id: 't1', claimToken: c.agent.claimToken, status, text: 'я'.repeat(5000) });
      assert.equal(f.ok, true);
      const serverNotes = get(store).agentNotes;
      assert.equal(serverNotes.length, 1);
      assert.equal(serverNotes[0].text.length, op.length + LIMITS.NOTE_MAX);
      const before = JSON.stringify(get(store));

      // new client: pushes the same state it pulled
      const r1 = await store.sync({ tasks: [JSON.parse(before)] });
      assert.equal(r1.applied, 0);
      assert.equal(get(store).agentNotes.length, 1);
      assert.equal(JSON.stringify(get(store)), before, 'nothing changed');
      assert.equal((await store.sync({ tasks: [JSON.parse(before)] })).applied, 0, 'repeat push');

      // new client with a fresh user edit that carries the notes along
      await store.sync({ tasks: [{ ...JSON.parse(before), title: 'edited', updatedAt: Date.now() + 1 }] });
      assert.equal(get(store).title, 'edited');
      assert.equal(get(store).agentNotes.length, 1);
      assert.equal(get(store).agentNotes[0].text, serverNotes[0].text);

      // legacy client: never had the keys, edits and syncs
      const old = createLegacyClient(store, [base({ updatedAt: 100 })]);
      old.edit('t1', { title: 'legacy edit' });
      await old.sync();
      assert.equal(get(store).agentNotes.length, 1);
      assert.equal(get(store).agentNotes[0].text, serverNotes[0].text);
      await old.sync();
      assert.equal(get(store).agentNotes.length, 1);
    } finally { await cleanup(); }
  });
}

test('sec08: records without agent keys are untouched (no data loss, SRC-34)', () => {
  const t = base({ title: 'plain' });
  assert.deepEqual(sanitizeIncomingTask(t, undefined), t);
  const out = sanitizeIncomingTask(base({ agent: 'junk', agentNotes: 'junk' }), undefined);
  assert.ok(!('agent' in out) && !('agentNotes' in out));
});

test('sec09: an empty expected token never matches (SyncStore and MCP)', async () => {
  const { store, cleanup } = await makeStore({ tasks: [] });
  try {
    assert.equal(store.checkToken('Bearer test-sync-token'), true);
    store.token = '';
    assert.equal(store.checkToken(''), false);
    assert.equal(store.checkToken('Bearer '), false);
    assert.equal(store.checkToken('Bearer x'), false);
    store.token = null;
    assert.equal(store.checkToken(undefined), false);
  } finally { await cleanup(); }
  process.env.TASKFLOW_API = 'http://127.0.0.1:1'; process.env.TASKFLOW_TOKEN = 't';
  const { checkToken, setMcpTokenForTest } = await import('../mcp.mjs');
  setMcpTokenForTest('');
  assert.equal(checkToken(undefined), false);
  assert.equal(checkToken('Bearer '), false);
  assert.equal(checkToken('Bearer anything'), false);
  setMcpTokenForTest('abc123');
  assert.equal(checkToken('Bearer abc123'), true);
  assert.equal(checkToken('Bearer abc124'), false);
  setMcpTokenForTest('');
});

test('sec03: agent notes are rendered as plain text, not linkified; user text still is', async () => {
  const src = await readFile(new URL('../js/ui.js', import.meta.url), 'utf8');
  const feed = src.slice(src.indexOf('export function agentFeed'), src.indexOf('Окно разбора входящего'));
  assert.ok(feed.includes('String(n.text)'));
  assert.ok(!/linkify/.test(feed), 'agentFeed must not call linkify');
  assert.ok(/linkify\(task\.notes\)/.test(src), 'human notes keep links');
});
