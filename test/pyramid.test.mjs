import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as pyramid from '../js/pyramid.js';
import { rackRows, ballDiameter, slotCenters, ballColorVar, MAX_BALLS, NEUTRAL_VAR } from '../js/pyramid.js';

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

test('pyramid.js keeps only the primitives, the intro scene lives in intro-scene.js (AC-034)', () => {
  assert.equal(MAX_BALLS, 15);
  assert.deepEqual(Object.keys(pyramid).sort(), ['MAX_BALLS', 'NEUTRAL_VAR', 'ballColorVar', 'ballDiameter', 'rackRows', 'slotCenters']);
});

test('pyramid.js stays pure: no Math.random, no Date, no app imports (AC-021 AC-034)', async () => {
  const src = await readFile(new URL('../js/pyramid.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /Math\.random|\bDate\b|performance\.now/);
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.doesNotMatch(src, /dom\.js|store\.js|model\.js/);
});
