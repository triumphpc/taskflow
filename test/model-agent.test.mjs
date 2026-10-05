import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

const { state } = await import('../js/store.js');
const M = await import('../js/model.js');
const { todayStr, addDaysStr } = await import('../js/core.js');
const { agentView, reconcileAgent } = await import('../js/agent.js');

const today = () => todayStr();
beforeEach(() => { store.clear(); state.tasks = []; state.deleted = []; });

const mk = (patch) => M.createTask({ title: 'T', due: today(), ...patch });

test('model: setDelegation(on) works for today tasks without status (AC-001 logic)', () => {
  const t = mk();
  assert.equal(M.setDelegation(t.id, true).agent.status, 'delegated');
  assert.equal(agentView(M.getTask(t.id), today()).checked, true);
});

test('model: setDelegation(on) refuses future, no due, done, inbox, already set (AC-002)', () => {
  assert.equal(M.setDelegation(mk({ due: addDaysStr(today(), 1) }).id, true), null);
  assert.equal(M.setDelegation(M.createTask({ title: 'inbox' }).id, true), null);
  const done = mk(); M.toggleDone(done.id);
  assert.equal(M.setDelegation(done.id, true), null);
  const t = mk(); M.setDelegation(t.id, true);
  assert.equal(M.setDelegation(t.id, true), null);
  assert.equal(M.setDelegation('nope', true), null);
});

test('model: setDelegation(on) works for overdue tasks', () => {
  assert.equal(M.setDelegation(mk({ due: addDaysStr(today(), -3) }).id, true).agent.status, 'delegated');
});

test('model: setDelegation(off) clears any status including in_progress (AC-005)', () => {
  for (const status of ['delegated', 'in_progress', 'review', 'needs_info', 'failed']) {
    const t = mk();
    t.agent = { status, claimedAt: 1, finishedAt: null, claimToken: 'x', at: 5 };
    const r = M.setDelegation(t.id, false);
    assert.equal(r.agent.status, null, status);
    assert.ok(r.agent.at > 5);
    assert.ok('agent' in r, 'key is kept (C5)');
  }
  const none = mk();
  assert.equal(M.setDelegation(none.id, false), M.getTask(none.id));
  assert.ok(!('agent' in none));
});

test('model: closing and reopening clear the status (AC-016)', () => {
  const t = mk(); M.setDelegation(t.id, true);
  M.toggleDone(t.id);
  assert.equal(M.getTask(t.id).done, true);
  assert.equal(M.getTask(t.id).agent.status, null);
  M.toggleDone(t.id);
  assert.equal(M.getTask(t.id).agent.status, null);
});

test('model: closing while in_progress is allowed (FR-011)', () => {
  const t = mk(); t.agent = { status: 'in_progress', claimedAt: 1, finishedAt: null, claimToken: 'x', at: 5 };
  assert.equal(M.toggleDone(t.id).kind, 'done');
  assert.equal(M.getTask(t.id).agent.status, null);
});

test('model: closing a task with review closes it normally (AC-015)', () => {
  const t = mk(); t.agent = { status: 'review', claimedAt: 1, finishedAt: 2, claimToken: null, at: 5 };
  t.agentNotes = [{ at: 2, text: 'Результат агента\nok' }];
  M.toggleDone(t.id);
  assert.equal(M.getTask(t.id).done, true);
  assert.equal(M.getTask(t.id).agentNotes.length, 1);
});

test('model: repeating task goes back to delegated, previous notes stay, due moves (AC-017)', () => {
  const t = mk({ repeat: { freq: 'daily', interval: 1, time: null, anchor: today() } });
  t.agent = { status: 'review', claimedAt: 1, finishedAt: 2, claimToken: null, at: 5 };
  t.agentNotes = [{ at: 2, text: 'prev' }];
  const r = M.toggleDone(t.id);
  assert.equal(r.kind, 'rescheduled');
  const after = M.getTask(t.id);
  assert.equal(after.agent.status, 'delegated');
  assert.equal(after.agent.finishedAt, null);
  assert.deepEqual(after.agentNotes, [{ at: 2, text: 'prev' }]);
  assert.equal(after.due, addDaysStr(today(), 1));
  assert.equal(after.done, false);
});

test('model: moving due to the future or clearing it drops delegation, notes stay (AC-015)', () => {
  const t = mk(); M.setDelegation(t.id, true);
  t.agentNotes = [{ at: 2, text: 'n' }];
  M.scheduleTask(t.id, addDaysStr(today(), 2));
  assert.equal(M.getTask(t.id).agent.status, null);
  assert.equal(M.getTask(t.id).agentNotes.length, 1);
  const u = mk(); M.setDelegation(u.id, true);
  M.updateTask(u.id, { due: null });
  assert.equal(M.getTask(u.id).agent.status, null);
});

test('model: moving due to today or past keeps delegation; editing other fields does too', () => {
  const t = mk(); M.setDelegation(t.id, true);
  M.scheduleTask(t.id, addDaysStr(today(), -1));
  assert.equal(M.getTask(t.id).agent.status, 'delegated');
  M.updateTask(t.id, { title: 'new' });
  assert.equal(M.getTask(t.id).agent.status, 'delegated');
});

test('model: tasks without a block never get an agent key', () => {
  const t = mk();
  M.toggleDone(t.id); M.toggleDone(t.id);
  M.scheduleTask(t.id, addDaysStr(today(), 5));
  M.updateTask(t.id, { due: null });
  assert.ok(!('agent' in M.getTask(t.id)));
});

test('model: every reset equals a direct reconcileAgent call on the same input (single point)', () => {
  const t = mk(); M.setDelegation(t.id, true);
  const snapshot = structuredClone(M.getTask(t.id));
  const realNow = Date.now;
  Date.now = () => 1_900_000_000_000;
  try {
    const expected = reconcileAgent({ ...snapshot, done: true }, 'close', { today: today(), now: Date.now() });
    M.toggleDone(t.id);
    assert.deepEqual(M.getTask(t.id).agent, expected);
  } finally { Date.now = realNow; }
});

test('model: no review filter in VIEWS, no instruction field (FR-010, C16)', () => {
  assert.deepEqual(Object.keys(M.VIEWS), ['today', 'inbox', 'tomorrow', 'upcoming', 'all', 'done']);
  const t = mk(); M.setDelegation(t.id, true);
  assert.ok(!('instruction' in M.getTask(t.id)));
});
