import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { railMetrics, railState, railDiff, showsNumber, flightDelta, D_MIN, D_MAX } from '../js/rail.js';

const visible = (total, w) => {
  const m = railMetrics(total, w);
  return railState(m, total, -1);
};

test('railMetrics at 390 px: 6, 7, 12, 13, 20, 100 tasks (AC-015)', () => {
  const rows = [[6, 56, 6, 6, 0], [7, 49, 7, 7, 0], [12, 28, 12, 12, 0], [13, 28, 12, 11, 2], [20, 28, 12, 11, 9], [100, 28, 12, 11, 89]];
  for (const [total, d, cap, shown, k] of rows) {
    const m = railMetrics(total, 390);
    assert.equal(m.d, d, `d for ${total}`);
    assert.equal(m.cap, cap, `cap for ${total}`);
    const s = railState(m, total, -1);
    assert.equal(s.slots.length, shown, `visible for ${total}`);
    assert.equal(s.extra, k, `K for ${total}`);
    assert.equal(m.bandH, d + 16);
  }
});

test('railMetrics at 1280 px for 20 tasks: d=28, cap=19, 18 visible, K=2 (AC-015)', () => {
  const m = railMetrics(20, 1280);
  assert.equal(m.d, 28);
  assert.equal(m.cap, 19);
  assert.equal(m.rowW, 560);
  const s = railState(m, 20, -1);
  assert.equal(s.slots.length, 18);
  assert.equal(s.extra, 2);
});

test('railMetrics: any total and width keep d in 28..56, the row within 560 px, no slot beyond the row (AC-015)', () => {
  for (let total = 1; total <= 100; total++) {
    for (let w = 320; w <= 1600; w += 40) {
      const m = railMetrics(total, w);
      assert.ok(m.d >= D_MIN && m.d <= D_MAX, `d ${total}/${w}`);
      assert.ok(m.rowW <= 560, `rowW ${total}/${w}`);
      const s = railState(m, total, -1);
      for (const slot of s.slots) assert.ok(slot.x + m.d <= m.rowX + m.rowW + 1e-6, `slot ${total}/${w}`);
      if (s.counter) assert.ok(s.counter.x + m.d <= m.rowX + m.rowW + 1e-6, `counter ${total}/${w}`);
    }
  }
});

test('railMetrics: bad input throws TypeError (AC-015)', () => {
  assert.throws(() => railMetrics(0, 390), TypeError);
  assert.throws(() => railMetrics(5, 'x'), TypeError);
  assert.throws(() => railMetrics(5, NaN), TypeError);
});

test('showsNumber: hidden below 36 px, shown from 36 px (AC-017)', () => {
  assert.equal(showsNumber(35), false);
  assert.equal(showsNumber(36), true);
  assert.equal(showsNumber(28), false);
});

test('railState: the sum of slots, counter, current card and done stays equal to total (AC-016)', () => {
  for (const total of [1, 6, 7, 12, 13, 20, 100]) {
    for (const w of [360, 390, 1280]) {
      const m = railMetrics(total, w);
      for (let index = -1; index <= total; index++) {
        const s = railState(m, total, index);
        const sum = s.slots.length + s.extra + (index >= 0 && index < total ? 1 : 0) + Math.max(index, 0);
        assert.equal(sum, total, `total=${total} w=${w} index=${index}`);
      }
    }
  }
});

test('railState: slot numbers run consecutively from index + 2, the current ball is not in the rail (AC-014)', () => {
  const m = railMetrics(20, 390);
  const s = railState(m, 20, 3);
  assert.deepEqual(s.slots.map((x) => x.n), Array.from({ length: s.slots.length }, (_, j) => 5 + j));
  assert.ok(!s.slots.some((x) => x.n === 4), 'ball of the card (n = index + 1) is not in the rail');
  assert.equal(s.slots[0].x, m.rowX);
  assert.ok(Math.abs(s.slots[1].x - s.slots[0].x - m.pitch) < 1e-9);
});

test('railState: a one-task queue has an empty rail once the ball has landed (AC-016)', () => {
  const m = railMetrics(1, 390);
  const s = railState(m, 1, 0);
  assert.deepEqual(s.slots, []);
  assert.equal(s.counter, null);
  assert.equal(s.extra, 0);
});

test('railDiff: one leaving, the rest moved one pitch left, the counter shrinks by one (AC-016)', () => {
  const total = 20;
  const m = railMetrics(total, 390);
  for (let index = -1; index < total - 1; index++) {
    const prev = railState(m, total, index);
    const next = railState(m, total, index + 1);
    const diff = railDiff(prev, next);
    assert.equal(diff.leaving, index + 2, `leaving at ${index}`);
    for (const mv of diff.moved) assert.ok(Math.abs(mv.fromX - mv.toX - m.pitch) < 1e-9, `moved at ${index}`);
    assert.equal(diff.moved.length, next.slots.length - diff.entering.length);
    if (next.counter) {
      assert.equal(diff.entering.length, 1, `entering at ${index}`);
      assert.equal(diff.counter.to, diff.counter.from - 1);
    } else if (prev.counter) {
      assert.equal(diff.counter.to, 0, 'the counter disappears');
      assert.ok(diff.entering.length >= 1);
    } else {
      assert.equal(diff.entering.length, 0);
      assert.equal(diff.counter, null);
    }
  }
});

test('railDiff: nothing leaves once the rail is empty (AC-016)', () => {
  const m = railMetrics(3, 390);
  const diff = railDiff(railState(m, 3, 2), railState(m, 3, 3));
  assert.equal(diff.leaving, null);
  assert.deepEqual(diff.moved, []);
  assert.deepEqual(diff.entering, []);
});

test('flightDelta: transfer between centers and scale to.d / from.d (AC-017)', () => {
  const r = flightDelta({ cx: 10, cy: 700, d: 28 }, { cx: 330, cy: 200, d: 56 });
  assert.deepEqual(r, { dx: 320, dy: -500, scale: 2 });
});

test('rail.js stays pure: no imports, no clock, no randomness (AC-034)', async () => {
  const src = await readFile(new URL('../js/rail.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.doesNotMatch(src, /Math\.random|Date\.now|new Date|performance\.now/);
  assert.doesNotMatch(src, /dom\.js|store\.js|model\.js/);
});
