// Сцена интро Moments: где стоит приветствие, пирамида и лоток, куда рассыпаются шары
// и когда каждый из них катится. Чистый модуль: размер окна и измеренный верх лотка
// приходят аргументами, случайности и часов нет, поэтому всё проверяется в node:test.

import { MAX_BALLS, rackRows, slotCenters, ballColorVar } from './pyramid.js';
import { railMetrics, railState, showsNumber, RAIL_PAD_Y } from './rail.js';

export { MAX_BALLS };
export const INTRO_TOTAL_MS = 2600;
export const READY_MS = 2860; // INTRO_TOTAL_MS + посадка первого шара (260 мс)

const GREETING_FADE_IN = [0, 250];
const GREETING_FADE_OUT = [1500, 1800];
const POP_MS = 240;
const GATHER_AT = 1000;
const GATHER_MS = 520;
const PULSE_AT = 1700;
const PULSE_MS = 200;
const RAIL_AT = 1900;
const RAIL_MS = 380;
const EXTRAS_FADE = [2400, 2600];
const GAP = 16;
const ROW_H = 0.866;
const PITCH = 1.04;
const EASE_POP = 'ease-out';
const EASE_ROLL = 'cubic-bezier(.4, 0, .2, 1)';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const checkView = (view) => {
  if (!Number.isFinite(view?.w) || !Number.isFinite(view?.h)) throw new TypeError('view must be {w, h} numbers');
};

/** Верх полосы лотка, если его не измерили в DOM. */
const fallbackRailTop = (view, total) => view.h - railMetrics(Math.max(1, total), view.w).bandH;

/** Кадр: прямоугольник приветствия, центр пирамиды и диаметр шара пирамиды. */
export function introFrame(view, n, railTop) {
  checkView(view);
  const rows = Math.max(1, rackRows(n).length);
  const w = Math.min(view.w - 32, 520);
  const h = view.w < 480 ? 112 : 88;
  const free = railTop - 2 * GAP;
  const span = (rows - 1) * ROW_H * PITCH + 1;
  const d = clamp(Math.min(Math.floor(view.w / 6.5), Math.floor((free - h - GAP) / span)), 28, 56);
  const groupH = h + GAP + span * d;
  const top = GAP + (free - groupH) / 2;
  return {
    d,
    greeting: { x: (view.w - w) / 2, y: top, w, h },
    origin: { x: view.w / 2, y: top + h + GAP + (span * d) / 2 },
    rows,
  };
}

/** Точка последовательности Хальтона, индекс от 1. */
function halton(i, base) {
  let f = 1;
  let r = 0;
  for (let k = i; k > 0; k = Math.floor(k / base)) {
    f /= base;
    r += f * (k % base);
  }
  return r;
}

/** Детерминированная россыпь: n центров внутри area с полем d/2 + 8, вне прямоугольника avoid с тем же запасом. */
export function scatterPoints(n, d, area, avoid) {
  const pad = d / 2 + 8;
  const x0 = area.x + pad;
  const x1 = area.x + area.w - pad;
  const y0 = area.y + pad;
  const y1 = area.y + area.h - pad;
  const inAvoid = (x, y) => x > avoid.x - pad && x < avoid.x + avoid.w + pad && y > avoid.y - pad && y < avoid.y + avoid.h + pad;
  const out = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    let placed = null;
    for (let round = 0; round < 3 && !placed; round++) {
      const gap = 0.9 * d * 0.8 ** round;
      for (let tries = 0; tries < 300 && !placed; tries++) {
        k++;
        const x = x0 + halton(k, 2) * Math.max(0, x1 - x0);
        const y = y0 + halton(k, 3) * Math.max(0, y1 - y0);
        if (inAvoid(x, y)) continue;
        if (out.some((p) => Math.hypot(p.x - x, p.y - y) < gap)) continue;
        placed = { x, y };
      }
    }
    out.push(placed ?? { x: x0, y: y0 });
  }
  return out;
}

const step = (budget, n, cap) => (n > 1 ? Math.floor(Math.min(cap, budget / (n - 1))) : 0);

/** Сцена интро. queue: очередь целиком; view: {w, h, railTop?}. Координаты в px окна, центры шаров. */
export function buildIntro(queue, view) {
  checkView(view);
  const total = queue.length;
  const n = Math.min(total, MAX_BALLS);
  const m = railMetrics(Math.max(1, total), view.w);
  const railTop = Number.isFinite(view.railTop) ? view.railTop : fallbackRailTop(view, total);
  const frame = introFrame(view, n, railTop);
  const { d, origin } = frame;
  const base = {
    d, railD: m.d, total: INTRO_TOTAL_MS, readyAt: READY_MS,
    greeting: { ...frame.greeting, fadeIn: [...GREETING_FADE_IN], fadeOut: [...GREETING_FADE_OUT] },
    origin, pulse: { at: PULSE_AT, duration: PULSE_MS }, railMetrics: m, railTop,
    extrasFade: [...EXTRAS_FADE],
  };
  if (!n) return { ...base, balls: [], extras: [], counter: null };

  const state = railState(m, total, -1);
  const railY = railTop + RAIL_PAD_Y + m.d / 2;
  const slots = slotCenters(n, d);
  const scatter = scatterPoints(n, d, { x: 0, y: 0, w: view.w, h: railTop }, frame.greeting);
  const sPop = step(160, n, 20);
  const sGather = step(180, n, 40);
  const sRail = step(320, n, 60);
  const railScale = m.d / d;
  const numberFade = !showsNumber(m.d);
  const counterSpot = state.counter ? { x: state.counter.x + m.d / 2, y: railY } : null;

  const balls = slots.map((slot, i) => {
    const sc = scatter[i];
    const fin = { x: origin.x + slot.x, y: origin.y + slot.y };
    const toRail = i < state.slots.length;
    const dest = toRail ? { x: state.slots[i].x + m.d / 2, y: railY } : counterSpot;
    const spin = sc.x < fin.x ? 720 : -720;
    const turn = spin + (dest.x > fin.x ? 360 : -360);
    const popAt = i * sPop;
    const gatherAt = GATHER_AT + i * sGather;
    const railAt = RAIL_AT + i * sRail;
    const at = (t, p, rot, scale, opacity, ease) => ({ t, x: p.x, y: p.y, rot, scale, opacity, ease });
    const keys = [at(0, sc, 0, 0, 0, 'linear')];
    if (popAt > 0) keys.push(at(popAt, sc, 0, 0, 0, EASE_POP));
    keys.push(
      at(popAt + POP_MS, sc, 0, 1, 1, 'linear'),
      at(gatherAt, sc, 0, 1, 1, EASE_ROLL),
      at(gatherAt + GATHER_MS, fin, spin, 1, 1, 'linear'),
      at(railAt, fin, spin, 1, 1, EASE_ROLL),
      toRail
        ? at(railAt + RAIL_MS, dest, turn, railScale, 1, 'linear')
        : at(railAt + RAIL_MS, dest, turn, 0.3, 0, 'linear'),
      at(INTRO_TOTAL_MS, dest, turn, toRail ? railScale : 0.3, toRail ? 1 : 0, 'linear'),
    );
    return {
      n: i + 1,
      colorVar: ballColorVar(queue[i]?.priority),
      slot: { x: slot.x, y: slot.y },
      scatter: sc,
      fate: toRail ? 'rail' : 'counter',
      numberFade,
      starts: { pop: popAt, gather: gatherAt, rail: railAt },
      keys,
    };
  });

  const extras = state.slots
    .filter((s) => s.n > MAX_BALLS)
    .map((s) => ({ n: s.n, colorVar: ballColorVar(queue[s.n - 1]?.priority), x: s.x + m.d / 2, y: railY }));

  return { ...base, balls, extras, counter: counterSpot ? { k: state.counter.k, ...counterSpot } : null };
}
