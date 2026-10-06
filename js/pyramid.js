// Раскладка и тайминг анимации «бильярдная пирамида» для входа в Moments.
// Чистый модуль: без DOM, без хранилища и модели, без случайности и часов. Размер
// окна приходит параметром, поэтому всё считается и проверяется в node:test.

export const MAX_BALLS = 15;
export const INTRO_TOTAL_MS = 1500;
export const ROLL_MS = 800;
export const MIN_HOLD_MS = 250;
export const PULSE_MS = 220;
export const NEUTRAL_VAR = '--ball-none';
/** Первый отрезок пути ускоряется, как шар, скатывающийся по столу. */
export const EASE_ROLL = 'cubic-bezier(.4, 0, .9, .6)';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ROW_H = 0.866;

/** Ряды пирамиды сверху вниз: 15 → [1,2,3,4,5], 7 → [1,2,3,1], 3 → [1,2], 0 → []. n режется до 15. */
export function rackRows(n) {
  let left = clamp(Math.floor(Number(n) || 0), 0, MAX_BALLS);
  const rows = [];
  for (let size = 1; left > 0; size++) {
    const take = Math.min(size, left);
    rows.push(take);
    left -= take;
  }
  return rows;
}

/** Диаметр шара по ширине экрана: clamp(floor(w / 6.5), 28, 56). */
export function ballDiameter(viewW) {
  return clamp(Math.floor(viewW / 6.5), 28, 56);
}

/** Центры слотов в px относительно центра пирамиды. Слот i получает шар с номером i + 1. */
export function slotCenters(n, d) {
  const rows = rackRows(n);
  const p = 1.04 * d;
  const rowH = ROW_H * p;
  const top = -((rows.length - 1) * rowH) / 2;
  const out = [];
  rows.forEach((c, r) => {
    for (let k = 0; k < c; k++) out.push({ x: (k - (c - 1) / 2) * p, y: top + r * rowH });
  });
  return out;
}

/** '--p1'..'--p4' по приоритету; null, undefined и всё прочее → '--ball-none'. */
export function ballColorVar(priority) {
  return Number.isInteger(priority) && priority >= 1 && priority <= 4 ? `--p${priority}` : NEUTRAL_VAR;
}

/** Точка старта на краю или за краем окна (px окна); детерминирована от индекса, случайности нет. */
export function startPoint(i, view, d) {
  const lane = (i * 5) % 7;
  return {
    x: i % 2 === 0 ? -d : view.w + d,
    y: view.h * 0.12 + lane * ((view.h * 0.5) / 6),
  };
}

/** Задержка и длительность i-го шара; последняя посадка не позже INTRO_TOTAL_MS - MIN_HOLD_MS. */
export function ballTiming(i, n) {
  const stagger = n > 1 ? Math.floor(Math.min(90, (INTRO_TOTAL_MS - MIN_HOLD_MS - ROLL_MS) / (n - 1))) : 0;
  return { delay: i * stagger, duration: ROLL_MS };
}

/**
 * Описание сцены. Точки пути и start заданы в px окна, slot относительно origin.
 * @param {{priority?: number|null}[]} queue  очередь Moments целиком
 * @param {{w: number, h: number}} view       размер окна
 */
export function buildIntro(queue, view) {
  if (!Number.isFinite(view?.w) || !Number.isFinite(view?.h)) throw new TypeError('view must be {w, h} numbers');
  const n = Math.min(queue.length, MAX_BALLS);
  const d = ballDiameter(view.w);
  const origin = { x: view.w / 2, y: view.h * 0.45 };
  const slots = slotCenters(n, d);
  let landing = 0;
  const balls = [];
  for (let i = 0; i < n; i++) {
    const slot = slots[i];
    const fin = { x: origin.x + slot.x, y: origin.y + slot.y };
    const start = startPoint(i, view, d);
    const dx = fin.x - start.x;
    const dy = fin.y - start.y;
    const len = Math.hypot(dx, dy) || 1;
    const back = { x: fin.x - (dx / len) * 0.18 * d, y: fin.y - (dy / len) * 0.18 * d };
    const spin = start.x < fin.x ? 720 : -720;
    const { delay, duration } = ballTiming(i, n);
    landing = Math.max(landing, delay + duration);
    balls.push({
      n: i + 1,
      colorVar: ballColorVar(queue[i]?.priority),
      slot,
      start,
      path: [
        { x: start.x, y: start.y, rot: 0, offset: 0 },
        { x: fin.x, y: fin.y, rot: spin, offset: 0.82 },
        { x: back.x, y: back.y, rot: spin, offset: 0.92 },
        { x: fin.x, y: fin.y, rot: spin, offset: 1 },
      ],
      delay,
      duration,
    });
  }
  return { d, total: INTRO_TOTAL_MS, origin, pulse: { delay: landing, duration: PULSE_MS }, balls };
}
