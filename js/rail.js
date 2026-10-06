// Раскладка лотка Moments: диаметр шаров под ширину экрана и очередь, какие шары
// лежат в лотке на шаге index. Чистый модуль без импортов, часов и случайности.

export const D_MIN = 28;
export const D_MAX = 56;
export const NUM_MIN_D = 36;
export const RAIL_PAD_X = 16;
export const RAIL_PAD_Y = 8;
export const RAIL_MAX_W = 560;
export const PITCH_K = 1.04;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const capFor = (d, rowW) => Math.floor((rowW + (PITCH_K - 1) * d) / (PITCH_K * d) + 1e-9);

/** Номер на шаре виден только от 36 px. */
export const showsNumber = (d) => d >= NUM_MIN_D;

/** Геометрия лотка; считается один раз на сессию. */
export function railMetrics(total, viewW) {
  if (!Number.isFinite(total) || total < 1 || !Number.isFinite(viewW)) throw new TypeError('railMetrics needs total >= 1 and a numeric width');
  const rowW = Math.min(viewW - 2 * RAIL_PAD_X, RAIL_MAX_W);
  const rowX = (viewW - rowW) / 2;
  let d = D_MIN;
  for (let c = D_MAX; c >= D_MIN; c--) {
    if (capFor(c, rowW) >= total) { d = c; break; }
  }
  return { d, pitch: PITCH_K * d, rowW, rowX, cap: Math.max(0, capFor(d, rowW)), bandH: d + 2 * RAIL_PAD_Y };
}

/** Состояние лотка на шаге index: -1 после интро, 0..total-1 карточка, total «День распланирован». */
export function railState(m, total, index) {
  const remaining = clamp(total - index - 1, 0, total);
  const hasCounter = remaining > m.cap;
  const shown = hasCounter ? Math.max(0, m.cap - 1) : remaining;
  const slots = [];
  for (let j = 0; j < shown; j++) slots.push({ n: index + 2 + j, x: m.rowX + j * m.pitch });
  const extra = remaining - shown;
  return {
    index,
    remaining,
    slots,
    counter: hasCounter ? { k: extra, x: m.rowX + shown * m.pitch } : null,
    extra: hasCounter ? extra : 0,
  };
}

/** Что изменилось между двумя соседними состояниями: для анимации. */
export function railDiff(prev, next) {
  const before = new Map(prev.slots.map((s) => [s.n, s]));
  const after = new Set(next.slots.map((s) => s.n));
  const moved = [];
  const entering = [];
  for (const s of next.slots) {
    const was = before.get(s.n);
    if (was) moved.push({ n: s.n, fromX: was.x, toX: s.x });
    else entering.push({ n: s.n, x: s.x });
  }
  const gone = prev.slots.find((s) => !after.has(s.n));
  const c = next.counter ?? prev.counter;
  return {
    leaving: gone ? gone.n : null,
    moved,
    entering,
    counter: c ? { from: prev.counter?.k ?? 0, to: next.counter?.k ?? 0, x: c.x } : null,
  };
}

/** Перелёт шара из from в to: перенос центров и масштаб. */
export function flightDelta(from, to) {
  return { dx: to.cx - from.cx, dy: to.cy - from.cy, scale: to.d / from.d };
}
