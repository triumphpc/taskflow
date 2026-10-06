import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { rackRows, ballDiameter, slotCenters, ballColorVar, buildIntro, startPoint,
  MAX_BALLS, INTRO_TOTAL_MS, NEUTRAL_VAR } from '../js/pyramid.js';

const VIEW = { w: 390, h: 844 };
const queueOf = (n, prio = (i) => (i % 4) + 1) => Array.from({ length: n }, (_, i) => ({ priority: prio(i) }));

test('rackRows: 0, 1, 3, 7, 15 and 20 balls (AC-015)', () => {
  assert.deepEqual(rackRows(0), []);
  assert.deepEqual(rackRows(1), [1]);
  assert.deepEqual(rackRows(3), [1, 2]);
  assert.deepEqual(rackRows(7), [1, 2, 3, 1]);
  assert.deepEqual(rackRows(15), [1, 2, 3, 4, 5]);
  assert.deepEqual(rackRows(20), [1, 2, 3, 4, 5]);
});

test('slotCenters: count, mirror symmetry of full rows, apex on top (AC-015)', () => {
  for (const n of [1, 3, 7, 15]) assert.equal(slotCenters(n, 40).length, n);
  const s = slotCenters(15, 40);
  assert.equal(s[0].x, 0);
  assert.ok(s.every((c) => c.y >= s[0].y) && s.slice(1).every((c) => c.y > s[0].y));
  let at = 0;
  for (const c of rackRows(15)) {
    const row = s.slice(at, at + c);
    at += c;
    for (let k = 0; k < c; k++) assert.ok(Math.abs(row[k].x + row[c - 1 - k].x) < 1e-9);
    assert.ok(row.every((r) => r.y === row[0].y));
  }
  const p7 = slotCenters(7, 40);
  assert.equal(p7[6].x, 0, 'a lone ball in the last row is centered');
});

test('ballColorVar: priorities 1..4 map to tokens, anything else to the neutral one (AC-019)', () => {
  assert.deepEqual([1, 2, 3, 4].map(ballColorVar), ['--p1', '--p2', '--p3', '--p4']);
  for (const v of [null, undefined, 9, 0, '1', NaN]) assert.equal(ballColorVar(v), NEUTRAL_VAR);
});

test('ballDiameter: floor(w / 6.5) clamped to 28..56 (AC-021)', () => {
  assert.equal(ballDiameter(150), 28);
  assert.equal(ballDiameter(390), 56);
  assert.equal(ballDiameter(260), 40);
});

test('buildIntro: 20 tasks give 15 balls numbered 1..15 in queue order (AC-015)', () => {
  const intro = buildIntro(queueOf(20), VIEW);
  assert.equal(intro.balls.length, MAX_BALLS);
  assert.deepEqual(intro.balls.map((b) => b.n), Array.from({ length: 15 }, (_, i) => i + 1));
  assert.deepEqual(intro.balls.slice(0, 4).map((b) => b.colorVar), ['--p1', '--p2', '--p3', '--p4']);
});

test('buildIntro: 3 tasks give a two-row apex, inbox without priority is neutral (AC-015 AC-019)', () => {
  const intro = buildIntro([{ priority: 1 }, { priority: null }, {}], VIEW);
  assert.equal(intro.balls.length, 3);
  const ys = new Set(intro.balls.map((b) => b.slot.y));
  assert.equal(ys.size, 2);
  assert.deepEqual(intro.balls.map((b) => b.colorVar), ['--p1', NEUTRAL_VAR, NEUTRAL_VAR]);
});

test('buildIntro: deterministic, same input gives the same scene (AC-021)', () => {
  assert.deepEqual(buildIntro(queueOf(9), VIEW), buildIntro(queueOf(9), VIEW));
});

test('buildIntro: every landing is within total minus hold, total in 1.2..1.8 s (AC-021)', () => {
  for (const n of [1, 2, 3, 7, 15, 20, 100]) {
    const intro = buildIntro(queueOf(n), VIEW);
    assert.equal(intro.total, INTRO_TOTAL_MS);
    assert.ok(intro.total >= 1200 && intro.total <= 1800);
    for (const b of intro.balls) assert.ok(b.delay + b.duration <= 1250, `n=${n} ball ${b.n}`);
    assert.ok(intro.pulse.delay + intro.pulse.duration <= intro.total);
  }
});

test('buildIntro: the path ends in the slot, whole turns, starts outside the window (AC-014 AC-015)', () => {
  const intro = buildIntro(queueOf(15), VIEW);
  for (const b of intro.balls) {
    const last = b.path.at(-1);
    assert.equal(last.x, intro.origin.x + b.slot.x);
    assert.equal(last.y, intro.origin.y + b.slot.y);
    assert.equal(last.offset, 1);
    assert.ok(b.path.every((p) => p.rot % 360 === 0));
    assert.deepEqual(b.path.map((p) => p.offset), [0, 0.82, 0.92, 1]);
    assert.ok(b.start.x <= 0 || b.start.x >= VIEW.w, 'start is at or beyond a side edge');
  }
});

test('buildIntro: an empty queue gives no balls, bad view throws (AC-018)', () => {
  assert.deepEqual(buildIntro([], VIEW).balls, []);
  assert.throws(() => buildIntro(queueOf(2), { w: 'x', h: 1 }), TypeError);
  assert.ok(startPoint(0, VIEW, 40));
});

test('pyramid.js stays pure: no Math.random, no Date, no app imports (AC-021)', async () => {
  const src = await readFile(new URL('../js/pyramid.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /Math\.random|\bDate\b|performance\.now/);
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.doesNotMatch(src, /dom\.js|store\.js|model\.js/);
});
