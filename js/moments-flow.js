// Чистая логика входа в Moments: тексты приветствия и заголовка, защита ввода
// и план перехода между карточками. Без DOM, хранилища, модели, часов и случайности:
// дату передаёт вызывающий, поэтому всё проверяется в node:test.

import { WEEKDAYS_FULL, MONTHS_GEN, plural } from './core.js';

/** '1 задача', '3 задачи', '12 задач', '21 задача'. */
export function taskCountLabel(n) {
  return `${n} ${plural(n, 'задача', 'задачи', 'задач')}`;
}

const dayLabel = (now) => `${WEEKDAYS_FULL[now.getDay()]}, ${now.getDate()} ${MONTHS_GEN[now.getMonth()]}`;

/** Приветствие: {date, count, full}. now: Date входа, count: длина очереди целиком. */
export function greetingParts(now, count) {
  const day = dayLabel(now);
  const date = day.charAt(0).toUpperCase() + day.slice(1);
  const tail = `${taskCountLabel(count)} на планирование`;
  return { date, count: tail, full: `${date} · ${tail}` };
}

/** Заголовок шторки: 'Moments · вторник, 6 октября · 12 задач'. */
export function sheetTitle(now, count) {
  return `Moments · ${dayLabel(now)} · ${taskCountLabel(count)}`;
}

const span = (at, dur) => ({ at, dur });

// Смещения и длительности (мс) — единственное место правды для кода и тестов.
const PLANS = {
  next: { exit: span(0, 200), ghostBall: span(80, 120), ball: span(120, 230), shift: span(120, 230), pull: span(250, 100), enter: span(150, 200) },
  last: { exit: span(0, 200), ghostBall: span(80, 120), ball: null, shift: null, pull: null, enter: null },
  first: { exit: null, ghostBall: null, ball: span(0, 260), shift: span(0, 260), pull: span(160, 100), enter: null },
};

/** План перехода. kind: 'next' | 'last' | 'first'. */
export function transitionPlan(kind) {
  const p = Object.hasOwn(PLANS, kind) ? PLANS[kind] : null;
  if (!p) throw new TypeError(`unknown transition kind: ${kind}`);
  const total = Math.max(...Object.values(p).filter(Boolean).map((s) => s.at + s.dur));
  return { ...p, total };
}

/** Защита ввода: 'idle' | 'locked' | 'closed'. */
export function createGate() {
  let state = 'idle';
  return {
    get state() { return state; },
    lock(act) {
      if (state !== 'idle') return false;
      state = 'locked';
      try { act?.(); } catch (e) { if (state === 'locked') state = 'idle'; throw e; }
      return true;
    },
    ifIdle(act) {
      if (state !== 'idle') return false;
      act();
      return true;
    },
    unlock() { if (state === 'locked') state = 'idle'; },
    close() { state = 'closed'; },
  };
}
