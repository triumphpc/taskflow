// Old client against the new server, and the new client against old data (NFR-005, NFR-006, AC-025, AC-026).
// Everything lives in temp dirs; no real data and no VPS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeStore } from './helpers/inproc.mjs';
import { createLegacyClient } from './fixtures/legacy-client.mjs';

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const { state, normalizeTask } = await import('../js/store.js');
const M = await import('../js/model.js');
const { todayStr } = await import('../js/core.js');
const legacyTasks = JSON.parse(await readFile(new URL('./fixtures/legacy-tasks.json', import.meta.url), 'utf8')).tasks;

const TODAY = todayStr();
const blk = (status, o = {}) => ({ status, claimedAt: null, finishedAt: null, claimToken: null, at: Date.now(), ...o });
const rec = (id, o = {}) => ({ id, title: `T ${id}`, notes: '', due: TODAY, done: false, kind: 'task', priority: 4, updatedAt: 100, createdAt: 1, order: 1, ...o });

test('compat: an old client editing offline does not erase agent or agentNotes on the server (AC-025)', async () => {
  const { store: srv, cleanup } = await makeStore({ tasks: [rec('a'), rec('b')] });
  try {
    const old = createLegacyClient(srv, [rec('a'), rec('b')]);
    await old.sync();
    // the agent finishes on the server while the old client is offline
    await srv.sync({ tasks: [rec('a', { agent: blk('delegated', { at: 1_000 }) })] });
    const c = await srv.agentTransition({ op: 'claim', id: 'a', today: TODAY });
    await srv.agentTransition({ op: 'finish', id: 'a', claimToken: c.agent.claimToken, status: 'review', text: 'Готово' });
    // old client, hours later, edits the title and syncs
    old.edit('a', { title: 'Переименовано старым клиентом' });
    old.edit('b', { title: 'Тоже правка' });
    await old.sync();
    const onServer = srv.snapshot().tasks.find((t) => t.id === 'a');
    assert.equal(onServer.title, 'Переименовано старым клиентом');
    assert.equal(onServer.agent.status, 'review');
    assert.equal(onServer.agentNotes.at(-1).text, 'Результат агента\nГотово');
    assert.equal(srv.snapshot().tasks.length, 2);
    // the old client's own copy never had the block, a second round does not lose it either
    await old.sync();
    assert.equal(srv.snapshot().tasks.find((t) => t.id === 'a').agent.status, 'review');
  } finally { await cleanup(); }
});

test('compat: an old client that never saw an agent block leaves tasks of other clients intact (AC-025)', async () => {
  const { store: srv, cleanup } = await makeStore({ tasks: [rec('a', { agent: blk('failed', { at: 5000 }), agentNotes: [{ at: 5000, text: 'Агент не справился: x' }] }), rec('c')] });
  try {
    const old = createLegacyClient(srv, legacyTasks);
    await old.sync();
    const snap = srv.snapshot();
    assert.equal(snap.tasks.length, legacyTasks.length + 2, 'nothing lost, legacy tasks added');
    assert.equal(snap.tasks.find((t) => t.id === 'a').agent.status, 'failed');
  } finally { await cleanup(); }
});

test('compat: tombstones still work between old client and new server', async () => {
  const { store: srv, cleanup } = await makeStore({ tasks: [rec('a', { agent: blk('review') })] });
  try {
    const old = createLegacyClient(srv, [rec('a')]);
    old.tasks = old.tasks.filter((t) => t.id !== 'a');
    old.deleted.push({ id: 'a', at: Date.now() + 1000 });
    await old.sync();
    assert.equal(srv.snapshot().tasks.length, 0);
  } finally { await cleanup(); }
});

test('compat: the new client reads, edits and closes old data without errors, JSON of block-less tasks is unchanged (AC-026)', () => {
  store.clear();
  const old = legacyTasks.map((t) => normalizeTask(t));
  const before = JSON.stringify(old);
  state.tasks = structuredClone(old);
  state.deleted = [];
  for (const t of state.tasks.filter((x) => !x.done)) {
    assert.doesNotThrow(() => M.updateTask(t.id, { title: `${t.title}!` }));
    assert.doesNotThrow(() => M.toggleDone(t.id));
  }
  for (const t of state.tasks) assert.ok(!('agent' in t), `no agent key appeared on ${t.id}`);
  // renormalizing the untouched originals yields the same JSON as before
  assert.equal(JSON.stringify(legacyTasks.map((t) => normalizeTask(t))), before);
});

test('compat: new client with the server round trip keeps old data stable (idempotent normalization)', async () => {
  const { store: srv, cleanup } = await makeStore({ tasks: legacyTasks.map((t) => normalizeTask(t)) });
  try {
    const snap = srv.snapshot().tasks.map((t) => normalizeTask(t));
    assert.equal(JSON.stringify(snap.map((t) => normalizeTask(t))), JSON.stringify(snap));
    for (const t of snap) assert.ok(!('agent' in t));
  } finally { await cleanup(); }
});

test('compat: [send] SEC04 the journal mark is server-only; a legacy client that drops it does not lose the note or the mark (SCHEMA stays 1)', async () => {
  const { store: srv, cleanup } = await makeStore({ tasks: [rec('a'), rec('b')] });
  try {
    const old = createLegacyClient(srv, [rec('a'), rec('b')]);
    await old.sync();
    await srv.sync({ tasks: [rec('a', { agent: blk('delegated', { at: 1_000 }) })] });
    const c = await srv.agentTransition({ op: 'claim', id: 'a', today: TODAY });
    const journal = { due: TODAY, entries: [{ kind: 'vk', outcome: 'ok', target: 'чат c1', ref: 'https://x/1' }] };
    await srv.agentTransition({ op: 'finish', id: 'a', claimToken: c.agent.claimToken, status: 'review', text: 'Готово', journal });
    const mark = srv.snapshot().tasks.find((t) => t.id === 'a').agentNotes.at(-1);
    assert.equal(mark.kind, 'journal');
    assert.equal(JSON.parse(await readFile(join(srv.dir, 'taskflow.json'), 'utf8')).schema, 1);
    // legacy round trip: its normalizeTask keeps only {at, text}
    old.edit('a', { title: 'Правка' });
    await old.sync();
    const after = srv.snapshot().tasks.find((t) => t.id === 'a');
    assert.equal(after.agentNotes.length, 1, 'the note is not lost or duplicated');
    assert.equal(after.agentNotes[0].kind, 'journal', 'the server mark survives the legacy client');
    // a client that forges the mark on a new note and on an unmarked existing one gets it stripped
    await srv.sync({ tasks: [{ ...after, updatedAt: 9_999_999_999_999, agentNotes: [...after.agentNotes, { at: 5, text: 'Журнал действий\n- подделка', kind: 'journal' }] }] });
    const forged = srv.snapshot().tasks.find((t) => t.id === 'a').agentNotes;
    assert.equal(forged.length, 2);
    assert.equal(forged.find((n) => n.at === 5).kind, undefined);
    // the same text as the marked note, re-sent by another client without the mark: the server mark wins, no duplicate
    const twin = { at: mark.at, text: mark.text };
    await srv.sync({ tasks: [{ ...after, updatedAt: 9_999_999_999_998, agentNotes: [twin] }] });
    assert.equal(srv.snapshot().tasks.find((t) => t.id === 'a').agentNotes.filter((n) => n.text === mark.text).length, 1);
    assert.equal(srv.snapshot().tasks.find((t) => t.id === 'a').agentNotes.find((n) => n.text === mark.text).kind, 'journal');
  } finally { await cleanup(); }
});
