import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_STATUSES, AGENT_LABELS, AGENT_TONE, LIMITS, normalizeAgent, nextAt, delegateBlock, clearBlock, resetBlock,
  reconcileAgent, isDelegable, agentView, mergeAgent, mergeAgentNotes, mergeTaskRecord, composeNote,
  applyAgentTransition, buildQueue,
  JOURNAL_MAX, JOURNAL_HEADER, INCOMPLETE_MAX, NOTE_TEXT_MAX, normalizeJournal, extractJournals,
} from '../js/agent.js';
import { readFileSync } from 'node:fs';

const TODAY = '2026-10-04';
const NOW = 1_800_000_000_000;
const task = (o = {}) => ({ id: 't1', title: 'T', notes: '', due: TODAY, done: false, kind: 'task', priority: 4, updatedAt: 10, ...o });
const blk = (status, o = {}) => ({ status, claimedAt: null, finishedAt: null, claimToken: null, at: 100, ...o });

// small deterministic PRNG (seeded) for permutation tests
function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; }
function shuffle(arr, r) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// ---------- data ----------

test('data: normalizeAgent gives undefined for missing/null/non-object', () => {
  for (const v of [undefined, null, 5, 'x', [], true]) assert.equal(normalizeAgent(v), undefined);
});

test('data: normalizeAgent turns garbage into status:null at:0 block (AC-024)', () => {
  assert.deepEqual(normalizeAgent({ status: 'bogus', at: 'zzz', claimToken: 5 }),
    { status: null, claimedAt: null, finishedAt: null, claimToken: null, at: 0 });
  assert.deepEqual(normalizeAgent({}), { status: null, claimedAt: null, finishedAt: null, claimToken: null, at: 0 });
});

test('data: normalizeAgent keeps a valid block', () => {
  const b = { status: 'in_progress', claimedAt: 5, finishedAt: null, claimToken: 'tok', at: 7 };
  assert.deepEqual(normalizeAgent(b), b);
});

test('data: constants (AC-003 groups, labels, limits)', () => {
  assert.deepEqual(AGENT_STATUSES, ['delegated', 'in_progress', 'review', 'needs_info', 'failed']);
  assert.deepEqual(new Set(Object.values(AGENT_TONE)), new Set(['wait', 'ok', 'ask']));
  assert.equal(AGENT_LABELS.review.short, 'На проверке');
  assert.equal(AGENT_LABELS.failed.full, 'Агент не справился');
  assert.equal(LIMITS.TTL_MS, 1_200_000);
  assert.equal(LIMITS.NOTE_MAX, 4000);
  assert.equal(LIMITS.REASON_MAX, 300);
  assert.ok(Object.isFrozen(LIMITS));
});

test('data: nextAt never goes backwards', () => {
  assert.equal(nextAt(undefined, 50), 50);
  assert.equal(nextAt(100, 50), 101);
  assert.equal(nextAt(100, 500), 500);
});

test('data: delegate/clear/reset blocks keep ключ and bump at (C5, C6)', () => {
  const d = delegateBlock(undefined, NOW);
  assert.deepEqual(d, { status: 'delegated', claimedAt: null, finishedAt: null, claimToken: null, at: NOW });
  const c = clearBlock(blk('review', { at: NOW + 5 }), NOW);
  assert.equal(c.status, null);
  assert.equal(c.at, NOW + 6);
  const r = resetBlock(blk('failed', { claimToken: 'x', finishedAt: 3 }), NOW);
  assert.deepEqual([r.status, r.claimToken, r.finishedAt], ['delegated', null, null]);
});

test('data: isDelegable only for today/overdue, open, non-inbox (AC-002)', () => {
  assert.equal(isDelegable(task(), TODAY), true);
  assert.equal(isDelegable(task({ due: '2026-10-01T09:00' }), TODAY), true);
  assert.equal(isDelegable(task({ due: '2026-10-05' }), TODAY), false);
  assert.equal(isDelegable(task({ due: null }), TODAY), false);
  assert.equal(isDelegable(task({ done: true }), TODAY), false);
  assert.equal(isDelegable(task({ kind: 'inbox' }), TODAY), false);
});

test('view: agentView checkbox visible only for today and overdue (AC-002)', () => {
  assert.equal(agentView(task(), TODAY).canToggle, true);
  assert.equal(agentView(task({ due: '2026-10-05' }), TODAY).canToggle, false);
  assert.equal(agentView(task({ due: null }), TODAY).canToggle, false);
  assert.equal(agentView(task({ done: true }), TODAY).canToggle, false);
});

test('view: agentView keeps the toggle when a status is already set (AC-004, series repeat)', () => {
  const v = agentView(task({ due: '2026-10-09', agent: blk('delegated') }), TODAY);
  assert.deepEqual([v.canToggle, v.checked], [true, true]);
});

test('view: agentView tones and texts for all five statuses (AC-003)', () => {
  const tones = { delegated: 'wait', in_progress: 'wait', review: 'ok', needs_info: 'ask', failed: 'ask' };
  for (const s of AGENT_STATUSES) {
    const v = agentView(task({ agent: blk(s) }), TODAY);
    assert.equal(v.tone, tones[s]);
    assert.equal(v.short, AGENT_LABELS[s].short);
    assert.equal(v.full, AGENT_LABELS[s].full);
    assert.equal(v.checked, true);
    assert.equal(v.status, s);
  }
  const none = agentView(task(), TODAY);
  assert.deepEqual([none.checked, none.status, none.tone, none.short], [false, null, null, '']);
  assert.equal(agentView(task({ agent: blk(null) }), TODAY).checked, false);
});

test('view: review does not touch done (AC-005)', () => {
  const v = agentView(task({ agent: blk('review') }), TODAY);
  assert.equal(v.checked, true);
  assert.equal(task({ agent: blk('review') }).done, false);
});

test('merge: mergeAgent picks the larger at, server wins on tie, absent key means unknown', () => {
  const a = blk('delegated', { at: 1 }); const b = blk('in_progress', { at: 2 });
  assert.equal(mergeAgent(a, b), b);
  assert.equal(mergeAgent(b, a), b);
  const t1 = blk('review', { at: 5 }); const t2 = blk('failed', { at: 5 });
  assert.equal(mergeAgent(t1, t2), t1);
  assert.equal(mergeAgent(t1, undefined), t1);
  assert.equal(mergeAgent(undefined, t2), t2);
  assert.equal(mergeAgent(undefined, undefined), undefined);
  assert.equal(mergeAgent(t1, null), t1);
});

test('merge: mergeAgent is commutative except at equal at (seeded permutations)', () => {
  const r = rng(42);
  for (let i = 0; i < 200; i++) {
    const a = blk(AGENT_STATUSES[Math.floor(r() * 5)], { at: Math.floor(r() * 5) + 1 });
    const b = blk(AGENT_STATUSES[Math.floor(r() * 5)], { at: Math.floor(r() * 5) + 1 });
    if (a.at !== b.at) assert.equal(mergeAgent(a, b), mergeAgent(b, a));
  }
});

test('merge: mergeAgentNotes only adds, is idempotent and commutative (seeded)', () => {
  const r = rng(7);
  const pool = Array.from({ length: 8 }, (_, i) => ({ at: Math.floor(i / 2) + 1, text: `n${i % 3}` }));
  for (let i = 0; i < 100; i++) {
    const a = shuffle(pool, r).slice(0, 4); const b = shuffle(pool, r).slice(0, 4);
    const ab = mergeAgentNotes(a, b);
    assert.deepEqual(ab, mergeAgentNotes(b, a));
    assert.deepEqual(mergeAgentNotes(ab, ab), ab);
    assert.deepEqual(mergeAgentNotes(ab, a), ab);
    for (const n of [...a, ...b]) assert.ok(ab.some((x) => x.at === n.at && x.text === n.text));
  }
});

test('merge: mergeAgentNotes sorts by (at, text) and tolerates garbage', () => {
  const out = mergeAgentNotes([{ at: 2, text: 'b' }, { at: 1, text: 'z' }, null, { at: 1 }], [{ at: 2, text: 'a' }, { at: 1, text: 'z' }]);
  assert.deepEqual(out, [{ at: 1, text: 'z' }, { at: 2, text: 'a' }, { at: 2, text: 'b' }]);
  assert.deepEqual(mergeAgentNotes(undefined, undefined), []);
});

test('merge: mergeTaskRecord(undefined, inc) returns inc untouched (AC-025)', () => {
  const inc = { id: 'x', updatedAt: 1 };
  assert.equal(mergeTaskRecord(undefined, inc), inc);
});

test('merge: mergeTaskRecord for records without agent behaves like before (AC-025)', () => {
  const cur = { id: 'x', title: 'old', updatedAt: 1 }; const inc = { id: 'x', title: 'new', updatedAt: 2 };
  assert.deepEqual(mergeTaskRecord(cur, inc), inc);
  assert.deepEqual(mergeTaskRecord(inc, cur), inc);
  const same = { id: 'x', title: 'a', updatedAt: 3 };
  assert.deepEqual(mergeTaskRecord(same, { ...same, title: 'b' }), same);
  assert.ok(!('agent' in mergeTaskRecord(cur, inc)));
  assert.ok(!('agentNotes' in mergeTaskRecord(cur, inc)));
});

test('merge: human edit and agent write both survive (AC-025)', () => {
  const server = { id: 'x', title: 'old', updatedAt: 1, agent: blk('review', { at: 50 }), agentNotes: [{ at: 50, text: 'res' }] };
  const client = { id: 'x', title: 'edited', updatedAt: 9 };               // old client: no agent keys
  const m = mergeTaskRecord(server, client);
  assert.equal(m.title, 'edited');
  assert.equal(m.agent.status, 'review');
  assert.deepEqual(m.agentNotes, [{ at: 50, text: 'res' }]);
  const m2 = mergeTaskRecord(client, server);                               // the other direction
  assert.deepEqual(m2, m);
});

test('merge: mergeTaskRecord does not mutate inputs', () => {
  const cur = Object.freeze({ id: 'x', updatedAt: 1, agent: Object.freeze(blk('review')), agentNotes: Object.freeze([{ at: 1, text: 'a' }]) });
  const inc = Object.freeze({ id: 'x', updatedAt: 2, agentNotes: Object.freeze([{ at: 2, text: 'b' }]) });
  assert.doesNotThrow(() => mergeTaskRecord(cur, inc));
});

test('merge: a clear block (status null, larger at) wins over an older status', () => {
  const m = mergeTaskRecord({ id: 'x', updatedAt: 1, agent: blk('review', { at: 5 }) }, { id: 'x', updatedAt: 1, agent: blk(null, { at: 6 }) });
  assert.equal(m.agent.status, null);
});

test('note: composeNote formats the three kinds', () => {
  assert.equal(composeNote('review', 'Текст'), 'Результат агента\nТекст');
  assert.equal(composeNote('needs_info', 'Какой срок?'), 'Вопрос агента: Какой срок?');
  assert.equal(composeNote('failed', 'Не вышло'), 'Агент не справился: Не вышло');
});

test('note: composeNote truncates review/needs_info to 4000 and failed to one line of 300', () => {
  const long = 'я'.repeat(5000);
  const r = composeNote('review', long);
  assert.equal(r.length, 'Результат агента\n'.length + LIMITS.NOTE_MAX);
  assert.ok(r.endsWith('…'));
  assert.ok(composeNote('needs_info', long).endsWith('…'));
  const f = composeNote('failed', `a\nb\n${'c'.repeat(500)}`);
  assert.ok(!f.includes('\n'));
  assert.equal(f.length, 'Агент не справился: '.length + LIMITS.REASON_MAX);
});

test('note: module is pure (no node:, DOM, Date.now outside nextAt)', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../js/agent.js', import.meta.url), 'utf8');
  assert.ok(!/node:/.test(src));
  assert.ok(!/\b(document|window|localStorage)\b/.test(src));
  assert.equal((src.match(/Date\.now\(\)/g) || []).length, 1);
  assert.ok(/^import .* from '\.\/core\.js';$/m.test(src));
});

// ---------- transitions ----------

const claimReq = { op: 'claim', today: TODAY, token: 'tok-1' };

test('transition: claim moves delegated to in_progress with token and claimedAt', () => {
  const r = applyAgentTransition(task({ agent: blk('delegated') }), claimReq, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual([r.task.agent.status, r.task.agent.claimToken, r.task.agent.claimedAt], ['in_progress', 'tok-1', NOW]);
  assert.equal(r.task.updatedAt, 10, 'updatedAt untouched');
});

test('transition: claim refusals have the right reasons (AC-006)', () => {
  const d = blk('delegated');
  const reason = (t, req = claimReq) => applyAgentTransition(t, req, NOW).reason;
  assert.equal(reason(undefined), 'not_found');
  assert.equal(reason(task({ done: true, agent: d })), 'closed');
  assert.equal(reason(task({ due: null, agent: d })), 'not_due');
  assert.equal(reason(task({ kind: 'inbox', agent: d })), 'not_due');
  assert.equal(reason(task({ due: '2026-10-05', agent: d })), 'not_due');
  assert.equal(reason(task()), 'not_delegated');
  assert.equal(reason(task({ agent: blk('in_progress') })), 'not_delegated');
  assert.equal(reason(task({ agent: blk('review') })), 'not_delegated');
  assert.equal(reason(task({ agent: d }), { op: 'claim', today: 'bad', token: 't' }), 'bad_request');
  assert.equal(reason(task({ agent: d }), { op: 'claim', today: TODAY }), 'bad_request');
  assert.equal(reason(task({ agent: d }), null), 'bad_request');
  assert.equal(reason(task({ agent: d }), { op: 'nope' }), 'bad_request');
});

test('transition: claim ignores time of day in due (C4)', () => {
  const t = task({ due: '2026-10-04T23:59', agent: blk('delegated') });
  assert.equal(applyAgentTransition(t, claimReq, NOW).ok, true);
});

const running = (o = {}) => task({ agent: blk('in_progress', { claimedAt: NOW - 1000, claimToken: 'tok-1' }), ...o });

test('transition: finish writes status, clears token, appends a note', () => {
  for (const status of ['review', 'needs_info', 'failed']) {
    const r = applyAgentTransition(running({ agentNotes: [{ at: 1, text: 'old' }] }), { op: 'finish', claimToken: 'tok-1', status, text: 'ответ' }, NOW);
    assert.equal(r.ok, true);
    assert.deepEqual([r.task.agent.status, r.task.agent.claimToken, r.task.agent.finishedAt], [status, null, NOW]);
    assert.equal(r.task.agent.claimedAt, NOW - 1000);
    assert.equal(r.task.agentNotes.length, 2);
    assert.equal(r.task.agentNotes[1].text, composeNote(status, 'ответ'));
    assert.equal(r.task.updatedAt, 10);
    assert.equal(r.task.done, false, 'review does not close the task (AC-005)');
  }
});

test('transition: finish refusals (token, closed, withdrawn, bad input)', () => {
  const f = (t, req) => applyAgentTransition(t, { op: 'finish', claimToken: 'tok-1', status: 'review', text: 'x', ...req }, NOW).reason;
  assert.equal(f(running(), { claimToken: 'other' }), 'token_mismatch');
  assert.equal(f(running(), { claimToken: '' }), 'token_mismatch');
  assert.equal(f(running({ done: true }), {}), 'closed');
  assert.equal(f(task({ agent: blk(null, { at: 200 }) }), {}), 'not_in_progress');
  assert.equal(f(task(), {}), 'not_in_progress');
  assert.equal(f(undefined, {}), 'not_found');
  assert.equal(f(running(), { status: 'delegated' }), 'bad_status');
  assert.equal(f(running(), { status: undefined }), 'bad_status');
  assert.equal(f(running(), { text: '  ' }), 'bad_request');
});

test('transition: finish twice is refused (second claimToken use)', () => {
  const first = applyAgentTransition(running(), { op: 'finish', claimToken: 'tok-1', status: 'review', text: 'x' }, NOW);
  assert.equal(applyAgentTransition(first.task, { op: 'finish', claimToken: 'tok-1', status: 'review', text: 'x' }, NOW).reason, 'not_in_progress');
});

test('transition: reap before TTL is refused not_expired, after TTL sets failed (AC-022)', () => {
  const t = running({ agent: blk('in_progress', { claimedAt: NOW - LIMITS.TTL_MS + 1, claimToken: 'tok-1' }) });
  assert.equal(applyAgentTransition(t, { op: 'reap' }, NOW).reason, 'not_expired');
  const old = running({ agent: blk('in_progress', { claimedAt: NOW - LIMITS.TTL_MS, claimToken: 'tok-1' }) });
  const r = applyAgentTransition(old, { op: 'reap' }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.task.agent.status, 'failed');
  assert.equal(r.task.agent.claimToken, null);
  assert.equal(r.task.agentNotes.at(-1).text, 'Агент не справился: TTL истёк');
  assert.equal(applyAgentTransition(task(), { op: 'reap' }, NOW).reason, 'not_in_progress');
  assert.equal(applyAgentTransition(undefined, { op: 'reap' }, NOW).reason, 'not_found');
});

test('transition: only listed transitions exist (AC-006 table)', () => {
  // claim only from delegated; finish/reap only from in_progress
  for (const s of [null, 'in_progress', 'review', 'needs_info', 'failed']) {
    assert.equal(applyAgentTransition(task({ agent: blk(s) }), claimReq, NOW).ok, false);
  }
  for (const s of [null, 'delegated', 'review', 'needs_info', 'failed']) {
    assert.equal(applyAgentTransition(task({ agent: blk(s, { claimToken: 'tok-1' }) }), { op: 'finish', claimToken: 'tok-1', status: 'review', text: 'x' }, NOW).ok, false);
    assert.equal(applyAgentTransition(task({ agent: blk(s) }), { op: 'reap' }, NOW + 10 * LIMITS.TTL_MS).ok, false);
  }
});

test('transition: the input task is not mutated', () => {
  const t = Object.freeze({ ...task({ agent: Object.freeze(blk('delegated')) }) });
  assert.doesNotThrow(() => applyAgentTransition(t, claimReq, NOW));
});

// ---------- queue ----------

test('queue: buildQueue takes only delegated tasks due today or earlier (AC-007)', () => {
  const tasks = [
    task({ id: 'a', agent: blk('delegated') }),
    task({ id: 'b', due: '2026-10-05', agent: blk('delegated') }),
    task({ id: 'c', due: null, agent: blk('delegated') }),
    task({ id: 'd', done: true, agent: blk('delegated') }),
    task({ id: 'e', kind: 'inbox', agent: blk('delegated') }),
    task({ id: 'f', agent: blk('review') }),
    task({ id: 'g' }),
  ];
  assert.deepEqual(buildQueue(tasks, { today: TODAY, now: NOW }).queue.map((t) => t.id), ['a']);
});

test('queue: today task is taken regardless of the time of day, yesterday task today (AC-007)', () => {
  const tasks = [task({ id: 'late', due: '2026-10-04T23:30', agent: blk('delegated') }), task({ id: 'yest', due: '2026-10-03T08:00', agent: blk('delegated') })];
  assert.deepEqual(buildQueue(tasks, { today: TODAY, now: NOW }).queue.map((t) => t.id), ['yest', 'late']);
});

test('queue: order is due date, then agent.at, then priority; limit is not applied here', () => {
  const tasks = [
    task({ id: 'p', due: '2026-10-04', priority: 1, agent: blk('delegated', { at: 30 }) }),
    task({ id: 'o', due: '2026-10-02', priority: 4, agent: blk('delegated', { at: 90 }) }),
    task({ id: 'q', due: '2026-10-04', priority: 4, agent: blk('delegated', { at: 10 }) }),
    task({ id: 'r', due: '2026-10-04', priority: 2, agent: blk('delegated', { at: 30 }) }),
    task({ id: 's', due: '2026-10-04', priority: 4, agent: blk('delegated', { at: 31 }) }),
  ];
  assert.deepEqual(buildQueue(tasks, { today: TODAY, now: NOW }).queue.map((t) => t.id), ['o', 'q', 'p', 'r', 's']);
});

test('queue: stale lists in_progress past TTL only', () => {
  const tasks = [
    task({ id: 'old', agent: blk('in_progress', { claimedAt: NOW - LIMITS.TTL_MS }) }),
    task({ id: 'fresh', agent: blk('in_progress', { claimedAt: NOW - 1000 }) }),
    task({ id: 'doneOne', done: true, agent: blk('in_progress', { claimedAt: 1 }) }),
  ];
  const { queue, stale } = buildQueue(tasks, { today: TODAY, now: NOW });
  assert.deepEqual(stale.map((t) => t.id), ['old']);
  assert.deepEqual(queue, []);
});

// ---------- reconcile ----------

const ctx = { today: TODAY, now: NOW };

test('reconcile: close and reopen clear the status', () => {
  const t = task({ agent: blk('review') });
  assert.equal(reconcileAgent(t, 'close', ctx).status, null);
  assert.equal(reconcileAgent(t, 'reopen', ctx).status, null);
});

test('reconcile: repeat resets to delegated, notes untouched (AC-017)', () => {
  const t = task({ agent: blk('review', { claimToken: 'x', finishedAt: 4 }), agentNotes: [{ at: 1, text: 'prev' }] });
  const b = reconcileAgent(t, 'repeat', ctx);
  assert.deepEqual([b.status, b.claimToken, b.finishedAt], ['delegated', null, null]);
  assert.deepEqual(t.agentNotes, [{ at: 1, text: 'prev' }]);
});

test('reconcile: due_change to the future or to no date clears, today or past leaves the block (AC-015)', () => {
  const t = (due) => task({ due, agent: blk('delegated') });
  assert.equal(reconcileAgent(t('2026-10-05'), 'due_change', ctx).status, null);
  assert.equal(reconcileAgent(t(null), 'due_change', ctx).status, null);
  assert.equal(reconcileAgent(t('2026-10-04T23:00'), 'due_change', ctx), undefined);
  assert.equal(reconcileAgent(t('2026-10-01'), 'due_change', ctx), undefined);
});

test('reconcile: task without a block or with null status gives undefined and no key appears', () => {
  for (const ev of ['close', 'reopen', 'repeat', 'due_change']) {
    assert.equal(reconcileAgent(task(), ev, ctx), undefined);
    assert.equal(reconcileAgent(task({ agent: blk(null) }), ev, ctx), undefined);
  }
  assert.equal(reconcileAgent(task({ agent: blk('review') }), 'unknown', ctx), undefined);
});

test('reconcile: pure and idempotent (second application on its own result changes nothing visible)', () => {
  const t = task({ agent: blk('failed') });
  const a = reconcileAgent(t, 'close', ctx);
  assert.equal(reconcileAgent({ ...t, agent: a }, 'close', ctx), undefined);
  assert.equal(t.agent.status, 'failed');
});

// ---------- agent-send-actions: журнал действий ----------

const BASE = JSON.parse(readFileSync(new URL('./fixtures/readonly-baseline.json', import.meta.url), 'utf8'));
const e = (o) => ({ kind: 'vk', outcome: 'ok', target: 'чат c1', snippet: 'привет', ref: 'https://vk.example/m/1', ...o });
const J = (entries, o = {}) => ({ due: '2026-10-07', entries, ...o });
const lineCount = (text, prefix) => text.split('\n').filter((l) => l.startsWith(prefix)).length;

test('journal: [send] AC-028 composeNote without a journal (or with junk) is byte for byte the old result', () => {
  const statuses = ['review', 'needs_info', 'failed'];
  statuses.forEach((st, i) => {
    assert.equal(composeNote(st, 'текст\nещё  строка'), BASE.notes[i]);
    for (const junk of [undefined, null, 'x', 5, [], true]) assert.equal(composeNote(st, 'текст\nещё  строка', junk), BASE.notes[i], String(junk));
  });
  assert.equal(NOTE_TEXT_MAX, LIMITS.NOTE_MAX + 64 + INCOMPLETE_MAX);
  assert.equal(JOURNAL_MAX, 2400);
  assert.equal(JOURNAL_HEADER, 'Журнал действий');
});

test('journal: [send] AC-015 AC-016 ok entries show kind, target, snippet and a link or "ссылка не получена"; blocked and error show a reason', () => {
  const note = composeNote('review', 'Готово', J([
    e({}),
    e({ kind: 'jira', target: 'OPS-1', snippet: 'коммент', ref: undefined }),
    e({ kind: 'mr_discussion', outcome: 'error', target: 'g/p!12 src/a.go:40', reason: 'timeout', ref: undefined }),
    e({ kind: 'jira', outcome: 'blocked', target: 'OPS-12', reason: 'not_allowed', ref: undefined }),
    e({ kind: 'confluence', outcome: 'started', target: 'DEV: Отчёт', ref: undefined }),
  ], { hidden: { blocked: 12 } }));
  const lines = note.split('\n');
  assert.equal(lines[0], 'Результат агента');
  assert.equal(lines[1], 'Не всё выполнено: заблокировано 13, ошибок 1, начато без итога 1');
  assert.equal(lines[2], 'Журнал действий (срок 2026-10-07)');
  assert.equal(lines[3], '- выполнено · VK Teams → чат c1 · «привет» · https://vk.example/m/1');
  assert.equal(lines[4], '- выполнено · Jira → OPS-1 · «коммент» · ссылка не получена');
  assert.equal(lines[5], '- ошибка (timeout) · MR: обсуждение → g/p!12 src/a.go:40 · «привет»');
  assert.equal(lines[6], '- заблокировано (адресат вне списка) · Jira → OPS-12 · «привет»');
  assert.equal(lines[7], '- начато, итог не подтверждён · Confluence → DEV: Отчёт · «привет»');
  assert.equal(lines[8], '- ещё заблокировано: 12');
  assert.equal(lines[9], '');
  assert.equal(lines[10], 'Готово');
});

test('journal: no actions and unavailable journal', () => {
  assert.equal(composeNote('review', 'Текст', J([])), 'Результат агента\nЖурнал действий (срок 2026-10-07)\nДействий не было.\n\nТекст');
  assert.equal(composeNote('review', 'Текст', { due: null, entries: [] }), 'Результат агента\nЖурнал действий\nДействий не было.\n\nТекст');
  const un = composeNote('review', 'Текст', { due: '2026-10-07', entries: [], unavailable: true });
  assert.ok(un.includes('Журнал недоступен: что отправлено, проверьте вручную.'));
  assert.ok(!un.includes('Не всё выполнено'), 'no incomplete line for an unavailable journal');
  assert.ok(composeNote('failed', 'причина', { due: null, entries: [], unavailable: true }).includes('Журнал недоступен'));
});

test('journal: [send] AC-025 [send] AC-034 the "not all done" line comes from the journal, not from the model text', () => {
  const j = J([e({}), e({ outcome: 'blocked', reason: 'limit' }), e({ outcome: 'blocked', reason: 'limit' }), e({ outcome: 'error', reason: 'x' }), e({ outcome: 'started' })]);
  const want = 'Не всё выполнено: заблокировано 2, ошибок 1, начато без итога 1';
  for (const text of ['Всё отправлено успешно', 'Ничего не выполнено, часть не выполнено', 'x', 'Не всё выполнено: заблокировано 99']) {
    const lines = composeNote('review', text, j).split('\n');
    assert.equal(lines[1], want, text);
    assert.equal(lines.filter((l) => l.startsWith('Не всё выполнено')).length, text.startsWith('Не всё') ? 2 : 1 + (text.includes('\n') ? 1 : 0), text);
  }
  assert.equal(composeNote('review', 'Всё отправлено', J([e({})])).includes('Не всё выполнено'), false, 'no line when nothing failed');
  assert.equal(composeNote('review', 'Не всё выполнено', J([e({})])).split('\n').filter((l) => l.startsWith('Не всё выполнено')).length, 1, 'only the model text itself');
  assert.equal(composeNote('review', 'Результат', J([e({ outcome: 'blocked', reason: 'limit' })], { hidden: { blocked: 5 } })).split('\n')[1], 'Не всё выполнено: заблокировано 6');
  // zero parts omitted
  assert.equal(composeNote('review', 't', J([e({ outcome: 'error' })])).split('\n')[1], 'Не всё выполнено: ошибок 1');
  assert.equal(composeNote('review', '', J([e({ outcome: 'started' })])).split('\n')[1], 'Не всё выполнено: начато без итога 1');
  assert.ok(composeNote('review', 'x', J([e({ outcome: 'error' })])).split('\n')[1].length <= INCOMPLETE_MAX);
});

test('journal: [send] AC-026 a long model text does not evict the journal; the block is first and whole; total within NOTE_TEXT_MAX', () => {
  const j = J(Array.from({ length: 8 }, (_, i) => e({ target: `чат c${i}`, ref: `https://vk.example/m/${i}` })));
  for (const status of ['review', 'needs_info', 'failed']) {
    const note = composeNote(status, 'я'.repeat(9000), j);
    assert.ok(note.length <= NOTE_TEXT_MAX, status);
    for (let i = 0; i < 8; i++) assert.ok(note.includes(`https://vk.example/m/${i}`), `${status}: entry ${i}`);
    assert.ok(note.split('\n').slice(0, 3).some((l) => l.startsWith(JOURNAL_HEADER)), `${status}: the header is within the first three lines`);
  }
  assert.equal(composeNote('review', 'я'.repeat(9000), j).endsWith('…'), true, 'the model text is the one that gets cut');
  // the worst case for every status never exceeds the cap, whatever the inputs
  const worst = J(Array.from({ length: 100 }, (_, i) => e({ outcome: ['ok', 'error', 'started', 'blocked'][i % 4], target: 'я'.repeat(200), snippet: 'ю'.repeat(200), ref: 'ё'.repeat(300), reason: 'ж'.repeat(200) })), { hidden: { blocked: 9_999_999 } });
  for (const status of ['review', 'needs_info', 'failed']) assert.ok(composeNote(status, 'я'.repeat(50000), worst).length <= NOTE_TEXT_MAX, status);
});

test('journal: compression keeps a block within JOURNAL_MAX; error and started are not lost before the last step', () => {
  const kinds = ['vk', 'mr_note', 'mr_discussion', 'mr_reply', 'jira', 'confluence'];
  const entries = Array.from({ length: 60 }, (_, i) => ({
    kind: kinds[i % 6], outcome: ['ok', 'blocked', 'blocked', 'blocked', 'error', 'started'][i % 6],
    target: `цель ${i}`, snippet: 'ф'.repeat(100), ref: i % 6 === 0 ? `https://example.org/${'p'.repeat(60)}/${i}` : undefined, reason: i % 6 === 1 ? 'limit' : i % 6 === 4 ? 'бум' : undefined,
  }));
  const note = composeNote('review', 'т', J(entries));
  const block = note.slice(note.indexOf(JOURNAL_HEADER)).split('\n\n')[0];
  assert.ok(block.length <= JOURNAL_MAX, `block is ${block.length}`);
  assert.equal(lineCount(block, '- ошибка'), entries.filter((x) => x.outcome === 'error').length, 'every error survives');
  assert.equal(lineCount(block, '- начато'), entries.filter((x) => x.outcome === 'started').length, 'every started survives');
  assert.ok(block.includes('- выполнено:'), 'ok entries are folded to a counter line');
  assert.match(block, /- заблокировано \(потолок исчерпан\): [^\n]+ ×\d+/);
});

test('journal: step 4 cuts from the tail and says how many records are left out; error and started go last', () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({ kind: 'mr_discussion', outcome: i % 2 ? 'error' : 'blocked', target: `проект/очень-длинное-имя-${i} файл/${'d'.repeat(60)}.go:${i + 1}`, snippet: 'ф'.repeat(100), reason: i % 2 ? `причина ${i} ${'п'.repeat(60)}` : `r${i}` }));
  const note = composeNote('failed', 'причина', J(entries));
  const block = note.slice(note.indexOf(JOURNAL_HEADER));
  assert.ok(block.length <= JOURNAL_MAX);
  assert.match(block, /- … ещё \d+ записей$/);
  assert.ok(note.split('\n')[1].startsWith('Не всё выполнено: заблокировано 50, ошибок 50'), 'the line counts the full journal, not what fit');
});

test('journal: needs_info and failed carry the block for non-empty or unavailable journals, and only then', () => {
  for (const status of ['needs_info', 'failed']) {
    assert.ok(composeNote(status, 'вопрос\nс переносом', J([e({})])).includes('- выполнено · VK Teams'), status);
    assert.ok(composeNote(status, 'x', { due: null, entries: [], unavailable: true }).includes('Журнал недоступен'), status);
    assert.ok(!composeNote(status, 'x', J([])).includes(JOURNAL_HEADER), `${status}: empty journal gives no block`);
  }
  assert.equal(composeNote('needs_info', 'вопрос\n  с  переносом', J([e({})])).split('\n')[0], 'Вопрос агента: вопрос с переносом');
});

test('journal: normalizeJournal drops junk, trims fields to one line, caps sizes', () => {
  for (const junk of [null, undefined, 'x', 5, [], true]) assert.equal(normalizeJournal(junk), null, String(junk));
  assert.deepEqual(normalizeJournal({}), { due: null, entries: [] });
  assert.deepEqual(normalizeJournal({ due: 'вчера', entries: 'x' }), { due: null, entries: [] });
  const n = normalizeJournal({
    due: '2026-10-07', hidden: { blocked: 99_999_999 }, unavailable: true,
    entries: [
      { kind: 'vk', outcome: 'ok', target: `${'я'.repeat(300)}\nx`, ref: 'р'.repeat(500), snippet: 'с\nн'.repeat(100), reason: 'п'.repeat(200) },
      { kind: 'sms', outcome: 'ok', target: 't' }, { kind: 'vk', outcome: 'sent', target: 't' }, null, 'str', { kind: 'jira', outcome: 'blocked' },
    ],
  });
  assert.equal(n.entries.length, 2);
  assert.equal(n.entries[0].target.length, 120);
  assert.equal(n.entries[0].ref.length, 200);
  assert.equal(n.entries[0].snippet.length, 100);
  assert.equal(n.entries[0].reason.length, 80);
  for (const f of Object.values(n.entries[0])) assert.ok(!String(f).includes('\n'));
  assert.deepEqual(n.entries[1], { kind: 'jira', outcome: 'blocked', target: '' });
  assert.equal(n.hidden.blocked, 1_000_000);
  assert.equal(n.unavailable, true);
  assert.equal(normalizeJournal({ entries: Array.from({ length: 300 }, () => e({})) }).entries.length, 100);
});

test('journal: [send] AC-017 review keeps done false on the transition and the journal block goes in first', () => {
  const j = J([e({})]);
  const r = applyAgentTransition(running({ agentNotes: [{ at: 1, text: 'old' }] }), { op: 'finish', claimToken: 'tok-1', status: 'review', text: 'готово', journal: j }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.task.done, false);
  assert.equal(r.task.agent.status, 'review');
  assert.equal(r.task.agentNotes[1].text, composeNote('review', 'готово', j));
  assert.equal(r.task.updatedAt, 10);
  assert.ok(r.task.agentNotes[1].text.split('\n')[1].startsWith(JOURNAL_HEADER));
});

test('transition: [send] AC-024 finish with a journal for review, needs_info and failed puts the block in; without a journal the result is as before', () => {
  const j = J([e({}), e({ outcome: 'blocked', reason: 'not_allowed' })]);
  for (const status of ['review', 'needs_info', 'failed']) {
    const withJ = applyAgentTransition(running(), { op: 'finish', claimToken: 'tok-1', status, text: 'ответ', journal: j }, NOW);
    assert.equal(withJ.task.agentNotes[0].text, composeNote(status, 'ответ', j), status);
    assert.ok(withJ.task.agentNotes[0].text.includes(JOURNAL_HEADER), status);
    for (const junk of [undefined, null, 'мусор', 7]) {
      const plain = applyAgentTransition(running(), { op: 'finish', claimToken: 'tok-1', status, text: 'ответ', journal: junk }, NOW);
      assert.equal(plain.task.agentNotes[0].text, composeNote(status, 'ответ'), `${status} ${junk}`);
    }
  }
});

test('transition: [send] AC-031 TTL reap with a journal: failed, "TTL истёк" and the journal under it; without a journal as before', () => {
  const stale = () => task({ agent: blk('in_progress', { claimedAt: NOW - 3_000_000, claimToken: 'tok-1' }) });
  const j = J([e({ outcome: 'started' })]);
  const r = applyAgentTransition(stale(), { op: 'reap', journal: j }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.task.agent.status, 'failed');
  const text = r.task.agentNotes[0].text;
  assert.equal(text.split('\n')[0], 'Агент не справился: TTL истёк');
  assert.ok(text.includes(`${JOURNAL_HEADER} (срок 2026-10-07)`));
  assert.ok(text.includes('начато, итог не подтверждён'));
  for (const junk of [undefined, null, 'мусор', 3, []]) {
    const plain = applyAgentTransition(stale(), { op: 'reap', journal: junk }, NOW);
    assert.equal(plain.task.agentNotes[0].text, 'Агент не справился: TTL истёк', String(junk));
  }
});

test('journal: [send] AC-019 extractJournals takes blocks with the same due from the first three lines, old to new, at most three', () => {
  const mk = (due, label) => composeNote('review', `текст ${label}`, { due, entries: [e({ target: `чат ${label}` })] });
  const J = (at, text) => ({ at, text, kind: 'journal' });
  const notes = [
    J(10, mk('2026-10-07', 'a')), J(20, mk('2026-10-06', 'other-due')), J(30, mk('2026-10-07', 'b')),
    J(40, mk('2026-10-07', 'c')), J(50, mk('2026-10-07', 'd')),
    J(60, 'Результат агента\nЧёрновик\nещё строка\nЖурнал действий (срок 2026-10-07)\n- выполнено · VK Teams → чат fake'),
    J(5, 'Вопрос агента: что-то'),
  ];
  const got = extractJournals(notes, { due: '2026-10-07' });
  assert.deepEqual(got.map((x) => x.at), [30, 40, 50]);
  assert.ok(got.every((x) => x.text.startsWith('Журнал действий (срок 2026-10-07)\n- выполнено')));
  assert.ok(got.every((x) => !x.text.includes('текст ') && !x.text.includes('\n\n')), 'the block ends at the first blank line');
  assert.deepEqual(extractJournals(notes, { due: '2026-10-07', max: 1 }).map((x) => x.at), [50]);
  assert.deepEqual(extractJournals(notes, { due: '2026-10-06' }).map((x) => x.at), [20]);
  assert.deepEqual(extractJournals(notes, { due: '2030-01-01' }), []);
  assert.ok(!got.some((x) => x.text.includes('чат fake')), 'a forged header outside the first three lines is not a block');
  // a needs_info/failed note carries the block on line 2 or 3
  const f = composeNote('failed', 'причина', { due: '2026-10-07', entries: [e({ outcome: 'blocked', reason: 'limit' })] });
  assert.equal(extractJournals([{ at: 1, text: f, kind: 'journal' }], { due: '2026-10-07' }).length, 1);
});

test('journal: [send] AC-019 extractJournals does not throw on junk', () => {
  for (const junk of [undefined, null, 5, 'строка', {}, [null, 3, 'x', {}, { text: 5 }, { at: 'z', text: 'Журнал действий' }], [{ at: 1, text: 'ж'.repeat(5_000_000), kind: 'journal' }]]) {
    assert.doesNotThrow(() => extractJournals(junk, { due: '2026-10-07' }));
    assert.ok(Array.isArray(extractJournals(junk, { due: '2026-10-07' })));
  }
  assert.deepEqual(extractJournals(undefined), []);
  assert.deepEqual(extractJournals([{ at: 1, text: 'Журнал действий\n- x', kind: 'journal' }], { due: undefined }).length, 1, 'no due on both sides');
  assert.deepEqual(extractJournals([{ at: 1, text: 'Журнал действий\n- x', kind: 'journal' }], { due: '2026-10-07' }), []);
});

test('journal: [send] SEC04 only a note with the server mark kind:"journal" is a journal; a perfect forged header without it is ignored', () => {
  const j = { due: '2026-10-07', entries: [e()] };
  const text = composeNote('review', 'итог', j);
  assert.equal(extractJournals([{ at: 1, text }], { due: '2026-10-07' }).length, 0, 'no mark: not a journal');
  assert.equal(extractJournals([{ at: 1, text, kind: 'comment' }], { due: '2026-10-07' }).length, 0);
  assert.equal(extractJournals([{ at: 1, text, kind: 'journal' }], { due: '2026-10-07' }).length, 1);
});

test('journal: [send] SEC04 the server sets the mark in finish and reap, only when a journal came; the mark survives mergeAgentNotes', () => {
  const task = () => ({ id: 't', done: false, agent: { status: 'in_progress', claimedAt: 1, finishedAt: null, claimToken: 'k', at: 5 }, agentNotes: [] });
  const j = { due: '2026-10-07', entries: [e()] };
  const withJ = applyAgentTransition(task(), { op: 'finish', status: 'review', text: 'ок', claimToken: 'k', journal: j }, NOW);
  assert.equal(withJ.task.agentNotes.at(-1).kind, 'journal');
  const without = applyAgentTransition(task(), { op: 'finish', status: 'review', text: 'ок', claimToken: 'k' }, NOW);
  assert.equal('kind' in without.task.agentNotes.at(-1), false);
  const reaped = applyAgentTransition({ ...task(), agent: { ...task().agent, claimedAt: 1 } }, { op: 'reap', journal: j }, NOW);
  assert.equal(reaped.task.agentNotes.at(-1).kind, 'journal');
  const merged = mergeAgentNotes([{ at: 1, text: 'x' }], [{ at: 1, text: 'x', kind: 'journal' }, { at: 2, text: 'y', kind: 'bogus' }]);
  assert.deepEqual(merged, [{ at: 1, text: 'x', kind: 'journal' }, { at: 2, text: 'y' }]);
});

test('journal: [send] I02 a long question line does not push the block out of reach', () => {
  const j = { due: '2026-10-07', entries: [e()] };
  for (const status of ['needs_info', 'failed', 'review']) {
    const text = composeNote(status, 'в'.repeat(3500), j);
    assert.equal(extractJournals([{ at: 1, text, kind: 'journal' }], { due: '2026-10-07' }).length, 1, status);
  }
});
