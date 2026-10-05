import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeStore } from './helpers/inproc.mjs';
import { LIMITS } from '../js/agent.js';

const TODAY = '2026-10-04';
const base = (o = {}) => ({ id: 't1', title: 'T', notes: '', due: TODAY, done: false, kind: 'task', priority: 4, updatedAt: 100, createdAt: 1, ...o });
const blk = (status, o = {}) => ({ status, claimedAt: null, finishedAt: null, claimToken: null, at: 100, ...o });
const get = (store, id = 't1') => store.snapshot().tasks.find((t) => t.id === id);
const withTask = (t, extra = {}) => makeStore({ tasks: [t], ...extra });

test('sync merge: record without agent/agentNotes does not erase them on the server (AC-025)', async () => {
  const { store, cleanup } = await withTask(base({ agent: blk('review', { at: 500 }), agentNotes: [{ at: 500, text: 'res' }] }));
  await store.sync({ tasks: [base({ title: 'edited', updatedAt: 900 })] });
  const t = get(store);
  assert.equal(t.title, 'edited');
  assert.equal(t.agent.status, 'review');
  assert.deepEqual(t.agentNotes, [{ at: 500, text: 'res' }]);
  await cleanup();
});

test('sync merge: concurrent human edit and agent write keep both, no task lost (AC-025)', async () => {
  const { store, cleanup } = await withTask(base());
  await Promise.all([
    store.sync({ tasks: [base({ title: 'human', updatedAt: 200 })] }),
    store.sync({ tasks: [base({ updatedAt: 50, agent: blk('review', { at: 300 }), agentNotes: [{ at: 300, text: 'agent' }] })] }),
  ]);
  const t = get(store);
  assert.equal(t.title, 'human');
  assert.equal(t.agent.status, 'review');
  assert.equal(t.agentNotes.length, 1);
  assert.equal(store.snapshot().tasks.length, 1);
  await cleanup();
});

test('sync merge: records without agent behave as before (whole task by updatedAt)', async () => {
  const { store, cleanup } = await withTask(base({ title: 'old' }));
  const r1 = await store.sync({ tasks: [base({ title: 'older', updatedAt: 50 })] });
  assert.equal(r1.applied, 0);
  assert.equal(get(store).title, 'old');
  const r2 = await store.sync({ tasks: [base({ title: 'newer', updatedAt: 200 })] });
  assert.equal(r2.applied, 1);
  assert.deepEqual(get(store), base({ title: 'newer', updatedAt: 200 }));
  const r3 = await store.sync({ tasks: [base({ id: 'new1', updatedAt: 1 })] });
  assert.equal(r3.applied, 1);
  assert.equal(store.snapshot().tasks.length, 2);
  await cleanup();
});

test('sync merge: applied counts by fact, identical resend applies nothing', async () => {
  const rec = base({ agent: blk('delegated', { at: 10 }) });
  const { store, cleanup } = await withTask(rec);
  assert.equal((await store.sync({ tasks: [rec] })).applied, 0);
  assert.equal((await store.sync({ tasks: [{ ...rec, agent: blk('delegated', { at: 11 }) }] })).applied, 1);
  await cleanup();
});

test('sync merge: a clear block with a newer at removes the status but keeps the key (C5)', async () => {
  const { store, cleanup } = await withTask(base({ agent: blk('review', { at: 100 }) }));
  await store.sync({ tasks: [base({ updatedAt: 150, agent: blk(null, { at: 200 }) })] });
  assert.deepEqual(get(store).agent, blk(null, { at: 200 }));
  // an older "review" arriving later does not resurrect the old status
  await store.sync({ tasks: [base({ updatedAt: 120, agent: blk('review', { at: 100 }) })] });
  assert.equal(get(store).agent.status, null);
  await cleanup();
});

test('sync merge: tombstone versus edit is resolved as before', async () => {
  const now = Date.now();
  const { store, cleanup } = await withTask(base({ updatedAt: now - 5000 }));
  await store.sync({ tasks: [], deleted: [{ id: 't1', at: now - 1000 }] });
  assert.equal(get(store), undefined);
  await store.sync({ tasks: [base({ updatedAt: now - 2000, agent: blk('review', { at: now }) })] });
  assert.equal(get(store), undefined, 'older edit loses to tombstone');
  await store.sync({ tasks: [base({ updatedAt: now + 100 })] });
  assert.ok(get(store), 'newer edit revives');
  assert.equal(store.snapshot().deleted.length, 0);
  await cleanup();
});

test('sync merge: works in a temp dir only (file lives under the temp data dir)', async () => {
  const { store, dir, cleanup } = await withTask(base());
  await store.sync({ tasks: [base({ updatedAt: 999 })] });
  assert.ok(JSON.parse(await readFile(join(dir, 'taskflow.json'), 'utf8')).tasks.length === 1);
  assert.ok(dir.includes('taskflow-test-'));
  await cleanup();
});

// ---------- agentTransition ----------

const delegated = (o = {}) => base({ agent: blk('delegated', { at: 10 }), ...o });

test('transition: claim from delegated works, second claim is refused (AC-022)', async () => {
  const { store, cleanup } = await withTask(delegated());
  const a = await store.agentTransition({ op: 'claim', id: 't1', today: TODAY });
  assert.equal(a.ok, true);
  assert.equal(a.agent.status, 'in_progress');
  assert.ok(a.agent.claimToken);
  assert.deepEqual(a.task, { id: 't1', title: 'T', notes: '', due: TODAY });
  const b = await store.agentTransition({ op: 'claim', id: 't1', today: TODAY });
  assert.deepEqual(b, { ok: false, reason: 'not_delegated' });
  await cleanup();
});

test('transition: claim does not change updatedAt or user fields and bumps rev', async () => {
  const { store, cleanup } = await withTask(delegated(), { rev: 7 });
  const before = get(store);
  const r = await store.agentTransition({ op: 'claim', id: 't1', today: TODAY });
  const after = get(store);
  assert.equal(after.updatedAt, before.updatedAt);
  assert.equal(after.title, before.title);
  assert.equal(r.rev, 8);
  assert.equal(store.snapshot().rev, 8);
  await cleanup();
});

test('transition: refused transition does not write the file or bump rev', async () => {
  const { store, cleanup } = await withTask(delegated({ due: '2026-10-09' }), { rev: 3 });
  const r = await store.agentTransition({ op: 'claim', id: 't1', today: TODAY });
  assert.deepEqual(r, { ok: false, reason: 'not_due' });
  assert.equal(store.snapshot().rev, 3);
  await cleanup();
});

test('transition: unknown id, bad request', async () => {
  const { store, cleanup } = await withTask(delegated());
  assert.equal((await store.agentTransition({ op: 'claim', id: 'zz', today: TODAY })).reason, 'not_found');
  assert.equal((await store.agentTransition({ op: 'claim', today: TODAY })).reason, 'bad_request');
  assert.equal((await store.agentTransition({ op: 'dance', id: 't1' })).reason, 'bad_request');
  await cleanup();
});

test('transition: finish with the right token writes status and note; wrong token and double finish refused', async () => {
  const { store, cleanup } = await withTask(delegated());
  const { agent } = await store.agentTransition({ op: 'claim', id: 't1', today: TODAY });
  const bad = await store.agentTransition({ op: 'finish', id: 't1', claimToken: 'zzz', status: 'review', text: 'x' });
  assert.equal(bad.reason, 'token_mismatch');
  const ok = await store.agentTransition({ op: 'finish', id: 't1', claimToken: agent.claimToken, status: 'review', text: 'Готово' });
  assert.equal(ok.ok, true);
  assert.equal(get(store).agent.status, 'review');
  assert.equal(get(store).agentNotes.at(-1).text, 'Результат агента\nГотово');
  assert.equal((await store.agentTransition({ op: 'finish', id: 't1', claimToken: agent.claimToken, status: 'review', text: 'x' })).reason, 'not_in_progress');
  await cleanup();
});

test('transition: finish after the user closed the task is refused (AC-016)', async () => {
  const { store, cleanup } = await withTask(delegated());
  const { agent } = await store.agentTransition({ op: 'claim', id: 't1', today: TODAY });
  await store.sync({ tasks: [{ ...get(store), done: true, completedAt: 1, updatedAt: 5000, agent: blk(null, { at: Date.now() + 60000 }) }] });
  const r = await store.agentTransition({ op: 'finish', id: 't1', claimToken: agent.claimToken, status: 'review', text: 'x' });
  assert.equal(r.ok, false);
  assert.ok(['closed', 'not_in_progress'].includes(r.reason));
  assert.equal(get(store).done, true);
  await cleanup();
});

test('transition: finish after the user withdrew delegation is refused', async () => {
  const { store, cleanup } = await withTask(delegated());
  const { agent } = await store.agentTransition({ op: 'claim', id: 't1', today: TODAY });
  await store.sync({ tasks: [{ ...get(store), updatedAt: 5000, agent: blk(null, { at: Date.now() + 60000 }) }] });
  const r = await store.agentTransition({ op: 'finish', id: 't1', claimToken: agent.claimToken, status: 'review', text: 'x' });
  assert.equal(r.reason, 'not_in_progress');
  await cleanup();
});

test('transition: reap before TTL refused, after TTL sets failed (AC-022)', async () => {
  const stale = delegated({ agent: blk('in_progress', { claimedAt: Date.now() - LIMITS.TTL_MS - 1000, claimToken: 'tok', at: 10 }) });
  const fresh = base({ id: 't2', agent: blk('in_progress', { claimedAt: Date.now() - 1000, claimToken: 'tok2', at: 10 }) });
  const { store, cleanup } = await makeStore({ tasks: [stale, fresh] });
  assert.equal((await store.agentTransition({ op: 'reap', id: 't2', ttlMs: 0 })).reason, 'not_expired', 'client cannot shorten the TTL');
  const r = await store.agentTransition({ op: 'reap', id: 't1' });
  assert.equal(r.ok, true);
  assert.equal(get(store).agent.status, 'failed');
  assert.match(get(store).agentNotes.at(-1).text, /TTL/);
  await cleanup();
});

test('transition: runs in the same queue as sync (order of arrival wins)', async () => {
  const { store, cleanup } = await withTask(delegated());
  const closing = store.sync({ tasks: [{ ...get(store), done: true, updatedAt: 9000, agent: blk(null, { at: Date.now() + 60000 }) }] });
  const claim = store.agentTransition({ op: 'claim', id: 't1', today: TODAY });
  await closing;
  assert.equal((await claim).reason, 'closed');
  await cleanup();
});

test('transition: one valid claimToken at a time under concurrent claims', async () => {
  const { store, cleanup } = await withTask(delegated());
  const rs = await Promise.all(Array.from({ length: 5 }, () => store.agentTransition({ op: 'claim', id: 't1', today: TODAY })));
  assert.equal(rs.filter((r) => r.ok).length, 1);
  await cleanup();
});

test('sync: a failed write rejects that call but the queue recovers for the next one (review I06)', async () => {
  const { store, dir, cleanup } = await withTask(base());
  const { mkdir, rmdir } = await import('node:fs/promises');
  const blocker = join(dir, `taskflow.json.${process.pid}.tmp`);
  await mkdir(blocker);                                   // writeFile to a directory path fails
  await assert.rejects(store.sync({ tasks: [base({ title: 'lost', updatedAt: 200 })] }));
  await rmdir(blocker);
  await store.sync({ tasks: [base({ title: 'after', updatedAt: 300 })] });
  assert.equal(get(store).title, 'after');
  await cleanup();
});
