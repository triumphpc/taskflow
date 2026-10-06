import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsTimeStep, timeAfterDayPick, todayStr, addDaysStr } from '../js/core.js';

const T = '2026-10-06';

test('needsTimeStep: today needs the time step (AC-005)', () => {
  assert.equal(needsTimeStep(T, T), true);
  assert.equal(needsTimeStep(todayStr()), true);
});

test('needsTimeStep: tomorrow, yesterday and null do not (AC-006 AC-008 AC-009 AC-010 AC-011)', () => {
  assert.equal(needsTimeStep('2026-10-07', T), false);
  assert.equal(needsTimeStep('2026-10-05', T), false);
  assert.equal(needsTimeStep(null, T), false);
  assert.equal(needsTimeStep(undefined, T), false);
  assert.equal(needsTimeStep(addDaysStr(todayStr(), 1)), false);
});

test('needsTimeStep: an invalid date string is simply not today (AC-011)', () => {
  assert.equal(needsTimeStep('not-a-date', T), false);
});

test('needsTimeStep: today is evaluated on every call, midnight rollover included (AC-005 AC-011)', () => {
  assert.equal(needsTimeStep('2026-10-07', '2026-10-06'), false);
  assert.equal(needsTimeStep('2026-10-07', '2026-10-07'), true);
  assert.equal(needsTimeStep('2026-10-06', '2026-10-07'), false);
});

test('timeAfterDayPick: today keeps the time, today without time gives null (AC-012 AC-013)', () => {
  assert.equal(timeAfterDayPick(T, '18:30', T), '18:30');
  assert.equal(timeAfterDayPick(T, null, T), null);
  assert.equal(timeAfterDayPick(T, undefined, T), null);
});

test('timeAfterDayPick: another day or no date resets the time (AC-012 AC-013)', () => {
  assert.equal(timeAfterDayPick('2026-10-07', '18:30', T), null);
  assert.equal(timeAfterDayPick('2026-10-05', '09:00', T), null);
  assert.equal(timeAfterDayPick(null, '18:30', T), null);
});
