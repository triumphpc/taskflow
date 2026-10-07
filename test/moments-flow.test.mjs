import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { taskCountLabel, greetingParts, sheetTitle, createGate, transitionPlan } from '../js/moments-flow.js';

const TUE = new Date(2026, 9, 6, 10, 0); // вторник, 6 октября 2026

test('moments-flow: greeting and sheet title for 12 tasks on Tuesday 6 October (AC-001)', () => {
  const g = greetingParts(TUE, 12);
  assert.equal(g.date, 'Вторник, 6 октября');
  assert.equal(g.count, '12 задач на планирование');
  assert.equal(g.full, 'Вторник, 6 октября · 12 задач на планирование');
  assert.equal(sheetTitle(TUE, 12), 'Moments · вторник, 6 октября · 12 задач');
});

test('moments-flow: plural forms 1, 3, 11, 12, 21 and the 20-task queue (AC-001 AC-002)', () => {
  const label = (n) => taskCountLabel(n);
  assert.equal(label(1), '1 задача');
  assert.equal(label(3), '3 задачи');
  assert.equal(label(11), '11 задач');
  assert.equal(label(12), '12 задач');
  assert.equal(label(21), '21 задача');
  assert.equal(greetingParts(TUE, 20).count, '20 задач на планирование');
  assert.match(sheetTitle(TUE, 20), /· 20 задач$/);
  assert.equal(greetingParts(TUE, 1).count, '1 задача на планирование');
});

test('moments-flow: the title is built from the passed date, not the clock (AC-013)', () => {
  assert.equal(sheetTitle(new Date(2026, 0, 1), 3), 'Moments · четверг, 1 января · 3 задачи');
  assert.equal(sheetTitle(new Date(2026, 11, 31), 21), 'Moments · четверг, 31 декабря · 21 задача');
});

test('transitionPlan: the whole table (AC-023 AC-007)', () => {
  const sp = (at, dur) => ({ at, dur });
  assert.deepEqual(transitionPlan('next'), { exit: sp(0, 200), ghostBall: sp(80, 120), ball: sp(120, 230), shift: sp(120, 230), pull: sp(250, 100), enter: sp(150, 200), total: 350 });
  assert.deepEqual(transitionPlan('last'), { exit: sp(0, 200), ghostBall: sp(80, 120), ball: null, shift: null, pull: null, enter: null, total: 200 });
  assert.deepEqual(transitionPlan('first'), { exit: null, ghostBall: null, ball: sp(0, 260), shift: sp(0, 260), pull: sp(160, 100), enter: null, total: 260 });
});

test('moments-flow stays pure: no clock, no randomness, no app imports (AC-034)', async () => {
  const src = await readFile(new URL('../js/moments-flow.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /Math\.random|Date\.now|new Date|performance\.now/);
  assert.doesNotMatch(src, /dom\.js|store\.js|model\.js/);
  const imports = [...src.matchAll(/^\s*import\s[^;]*from\s+'([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./core.js']);
});

test('createGate: a second lock while locked does not run act, act runs exactly once (AC-025)', () => {
  const g = createGate();
  let calls = 0;
  assert.equal(g.state, 'idle');
  assert.equal(g.lock(() => { calls++; }), true);
  assert.equal(g.state, 'locked');
  assert.equal(g.lock(() => { calls++; }), false);
  assert.equal(calls, 1);
});

test('createGate: ifIdle runs only in idle and never changes the state (AC-025)', () => {
  const g = createGate();
  let calls = 0;
  assert.equal(g.ifIdle(() => { calls++; }), true);
  assert.equal(g.state, 'idle');
  g.lock();
  assert.equal(g.ifIdle(() => { calls++; }), false);
  g.close();
  assert.equal(g.ifIdle(() => { calls++; }), false);
  assert.equal(calls, 1);
});

test('createGate: a throwing act rolls back to idle, unlock after close is a no-op, close is idempotent (AC-025 AC-026)', () => {
  const g = createGate();
  assert.throws(() => g.lock(() => { throw new Error('boom'); }), /boom/);
  assert.equal(g.state, 'idle');
  g.lock();
  g.unlock();
  assert.equal(g.state, 'idle');
  g.unlock();
  assert.equal(g.state, 'idle');
  g.lock();
  g.close();
  g.close();
  assert.equal(g.state, 'closed');
  g.unlock();
  assert.equal(g.state, 'closed');
  let called = false;
  assert.equal(g.lock(() => { called = true; }), false);
  assert.equal(called, false);
});

test('transitionPlan: next is 350 ms (300..400), last has no entering parts, first is 260 (AC-023 AC-007)', () => {
  const next = transitionPlan('next');
  assert.equal(next.total, 350);
  assert.ok(next.total >= 300 && next.total <= 400);
  assert.deepEqual(next.exit, { at: 0, dur: 200 });
  assert.deepEqual(next.enter, { at: 150, dur: 200 });
  const last = transitionPlan('last');
  assert.equal(last.total, 200);
  for (const k of ['enter', 'ball', 'shift', 'pull']) assert.equal(last[k], null, k);
  const first = transitionPlan('first');
  assert.equal(first.total, 260);
  assert.equal(first.exit, null);
  assert.equal(first.enter, null);
});

test('transitionPlan: total is the max of at + dur over non-empty spans; bad kind throws (AC-023)', () => {
  for (const kind of ['next', 'last', 'first']) {
    const p = transitionPlan(kind);
    const ends = Object.entries(p).filter(([k, v]) => k !== 'total' && v).map(([, v]) => v.at + v.dur);
    assert.equal(p.total, Math.max(...ends), kind);
  }
  assert.throws(() => transitionPlan('bad'), TypeError);
});
