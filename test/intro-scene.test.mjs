import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildIntro, introFrame, scatterPoints, MAX_BALLS, INTRO_TOTAL_MS, READY_MS } from '../js/intro-scene.js';
import { slotCenters, rackRows, NEUTRAL_VAR } from '../js/pyramid.js';
import { railMetrics, railState, RAIL_PAD_Y } from '../js/rail.js';
import { transitionPlan } from '../js/moments-flow.js';

const queueOf = (n, prio = (i) => (i % 4) + 1) => Array.from({ length: n }, (_, i) => ({ priority: prio(i) }));
const WINDOWS = [[360, 640], [375, 667], [390, 844], [667, 375], [1280, 800]];
const railTopOf = (w, h, total) => h - railMetrics(total, w).bandH;

const pyramidBox = (scene) => {
  const s = slotCenters(Math.min(scene.balls.length, MAX_BALLS), scene.d);
  const xs = s.map((c) => scene.origin.x + c.x);
  const ys = s.map((c) => scene.origin.y + c.y);
  return { l: Math.min(...xs) - scene.d / 2, r: Math.max(...xs) + scene.d / 2, t: Math.min(...ys) - scene.d / 2, b: Math.max(...ys) + scene.d / 2 };
};
const overlaps = (a, g) => a.l < g.x + g.w && a.r > g.x && a.t < g.y + g.h && a.b > g.y;

test('scatter and frame: five windows, 20 tasks, nothing overlaps or leaves the screen (AC-031)', () => {
  for (const [w, h] of WINDOWS) {
    const scene = buildIntro(queueOf(20), { w, h });
    const g = scene.greeting;
    const pad = scene.d / 2 + 8;
    assert.ok(g.x >= 0 && g.x + g.w <= w && g.y >= 0, `greeting inside ${w}x${h}`);
    for (const b of scene.balls) {
      const p = b.scatter;
      assert.ok(p.x >= scene.d / 2 && p.x <= w - scene.d / 2 && p.y >= scene.d / 2 && p.y <= scene.railTop - scene.d / 2, `ball ${b.n} inside ${w}x${h}`);
      const inside = p.x > g.x - pad && p.x < g.x + g.w + pad && p.y > g.y - pad && p.y < g.y + g.h + pad;
      assert.ok(!inside, `ball ${b.n} clear of the greeting at ${w}x${h}`);
    }
    const box = pyramidBox(scene);
    assert.ok(!overlaps(box, g), `pyramid vs greeting at ${w}x${h}`);
    assert.ok(box.l >= 0 && box.r <= w && box.t >= 0, `pyramid inside ${w}x${h}`);
    assert.ok(box.b <= scene.railTop, `pyramid above the rail at ${w}x${h}`);
    assert.equal(scene.railTop, railTopOf(w, h, 20));
  }
});

test('introFrame: pyramid diameter depends on window height too, within 28..56 (AC-031)', () => {
  const short = introFrame({ w: 667, h: 375 }, 15, railTopOf(667, 375, 20));
  const tall = introFrame({ w: 667, h: 800 }, 15, railTopOf(667, 800, 20));
  assert.ok(short.d < tall.d);
  for (const f of [short, tall]) assert.ok(f.d >= 28 && f.d <= 56);
  assert.equal(introFrame({ w: 360, h: 640 }, 15, 596).greeting.h, 112);
  assert.equal(introFrame({ w: 1280, h: 800 }, 15, 756).greeting.h, 88);
});

test('scatterPoints: deterministic for the same arguments (AC-004)', () => {
  const area = { x: 0, y: 0, w: 390, h: 800 };
  const avoid = { x: 16, y: 100, w: 358, h: 112 };
  assert.deepEqual(scatterPoints(15, 56, area, avoid), scatterPoints(15, 56, area, avoid));
  assert.deepEqual(buildIntro(queueOf(15), { w: 390, h: 844 }), buildIntro(queueOf(15), { w: 390, h: 844 }));
});

test('buildIntro: 20 tasks give 15 balls numbered 1..15 in queue order with priority colors (AC-004 AC-005)', () => {
  const s = buildIntro(queueOf(20), { w: 390, h: 844 });
  assert.equal(s.balls.length, MAX_BALLS);
  assert.deepEqual(s.balls.map((b) => b.n), Array.from({ length: 15 }, (_, i) => i + 1));
  assert.deepEqual(s.balls.slice(0, 4).map((b) => b.colorVar), ['--p1', '--p2', '--p3', '--p4']);
});

test('buildIntro: 3 tasks give a two-row apex, an entry without priority is neutral (AC-004 AC-005)', () => {
  const s = buildIntro([{ priority: 1 }, { priority: null }, {}], { w: 390, h: 844 });
  assert.equal(s.balls.length, 3);
  assert.deepEqual(rackRows(3), [1, 2]);
  assert.equal(new Set(s.balls.map((b) => b.slot.y)).size, 2);
  assert.deepEqual(s.balls.map((b) => b.colorVar), ['--p1', NEUTRAL_VAR, NEUTRAL_VAR]);
});

test('buildIntro: balls start one after another in queue order in scatter, gather and rail phases (AC-006)', () => {
  for (const n of [2, 3, 7, 15]) {
    const s = buildIntro(queueOf(n), { w: 390, h: 844 });
    for (const phase of ['pop', 'gather', 'rail']) {
      const starts = s.balls.map((b) => b.starts[phase]);
      for (let i = 1; i < starts.length; i++) assert.ok(starts[i] > starts[i - 1], `${phase} n=${n} i=${i}`);
    }
  }
  const one = buildIntro(queueOf(1), { w: 390, h: 844 });
  assert.deepEqual(one.balls[0].starts, { pop: 0, gather: 1000, rail: 1900 });
});

test('buildIntro: total 2600, ready 2500..3000 ms, the last step is not later than total (AC-007)', () => {
  for (const n of [1, 2, 3, 7, 15, 20, 100]) {
    const s = buildIntro(queueOf(n), { w: 390, h: 844 });
    assert.equal(s.total, INTRO_TOTAL_MS);
    assert.equal(s.total, 2600);
    assert.equal(s.readyAt, READY_MS);
    assert.ok(s.readyAt >= 2500 && s.readyAt <= 3000);
    for (const b of s.balls) {
      assert.ok(b.starts.rail + 380 <= s.total, `n=${n} ball ${b.n}`);
      assert.ok(b.keys.at(-1).t <= s.total);
    }
    assert.ok(s.pulse.at + s.pulse.duration <= s.total);
  }
});

test('buildIntro: keys are ordered, first at 0, last at total, upright after the gather phase (AC-004)', () => {
  const s = buildIntro(queueOf(15), { w: 390, h: 844 });
  for (const b of s.balls) {
    assert.equal(b.keys[0].t, 0);
    assert.equal(b.keys.at(-1).t, 2600);
    for (let i = 1; i < b.keys.length; i++) assert.ok(b.keys[i].t >= b.keys[i - 1].t);
    for (const k of b.keys.filter((x) => x.t >= b.starts.gather + 520)) assert.ok(k.rot % 360 === 0, `rot ${k.rot}`);
    const gathered = b.keys.find((x) => x.t === b.starts.gather + 520);
    assert.equal(gathered.x, s.origin.x + b.slot.x);
    assert.equal(gathered.y, s.origin.y + b.slot.y);
  }
});

test('buildIntro: rail slots, counter and extras match railState at index -1 (AC-009)', () => {
  for (const [total, w] of [[20, 390], [13, 390], [20, 1280], [6, 390]]) {
    const s = buildIntro(queueOf(total), { w, h: 844 });
    const m = railMetrics(total, w);
    const st = railState(m, total, -1);
    const y = s.railTop + 8 + m.d / 2;
    s.balls.forEach((b, i) => {
      const last = b.keys.at(-1);
      if (i < st.slots.length) {
        assert.equal(b.fate, 'rail');
        assert.ok(Math.abs(last.x - (st.slots[i].x + m.d / 2)) < 1e-9);
        assert.ok(Math.abs(last.y - y) < 1e-9);
        assert.ok(Math.abs(last.scale - m.d / s.d) < 1e-9);
      } else {
        assert.equal(b.fate, 'counter');
        assert.equal(last.opacity, 0);
      }
    });
    assert.deepEqual(s.extras.map((e) => e.n), st.slots.filter((x) => x.n > 15).map((x) => x.n));
    assert.equal(s.counter?.k ?? null, st.counter?.k ?? null);
  }
  const s13 = buildIntro(queueOf(13), { w: 390, h: 844 });
  assert.deepEqual(s13.balls.filter((b) => b.fate === 'counter').map((b) => b.n), [12, 13]);
  assert.equal(s13.counter.k, 2);
  const wide = buildIntro(queueOf(20), { w: 1280, h: 800 });
  assert.deepEqual(wide.extras.map((e) => e.n), [16, 17, 18]);
  assert.equal(wide.balls.length, 15);
});

test('buildIntro: number fades only while the rail ball is smaller than 36 px (AC-017)', () => {
  assert.equal(buildIntro(queueOf(20), { w: 390, h: 844 }).balls[0].numberFade, true);
  assert.equal(buildIntro(queueOf(3), { w: 390, h: 844 }).balls[0].numberFade, false);
});

test('buildIntro: an empty queue gives no balls, a bad view throws (AC-004)', () => {
  const s = buildIntro([], { w: 390, h: 844 });
  assert.deepEqual(s.balls, []);
  assert.deepEqual(s.extras, []);
  assert.throws(() => buildIntro(queueOf(2), { w: 'x', h: 1 }), TypeError);
  assert.throws(() => buildIntro(queueOf(2), { w: 390 }), TypeError);
});

test('intro-scene.js stays pure: no clock, no randomness, only pyramid.js and rail.js imports (AC-034)', async () => {
  const src = await readFile(new URL('../js/intro-scene.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /Math\.random|Date\.now|new Date|performance\.now/);
  assert.doesNotMatch(src, /dom\.js|store\.js|model\.js/);
  const imports = [...src.matchAll(/^\s*import\s[^;]*from\s+'([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['./pyramid.js', './rail.js']);
});

test('intro-scene: READY_MS is the intro plus the first-ball landing (AC-007)', () => {
  assert.equal(READY_MS, INTRO_TOTAL_MS + transitionPlan('first').total);
});

test('intro-scene: the +K chip sits at the same y as the rail balls, so the handoff does not jump (AC-009)', () => {
  const s = buildIntro(queueOf(20), { w: 390, h: 844 });
  const ballY = s.balls.find((b) => b.fate === 'rail').keys.at(-1).y;
  assert.ok(s.counter);
  assert.equal(s.counter.y, ballY);
  assert.equal(s.counter.y - s.railD / 2, s.railTop + RAIL_PAD_Y);
});
