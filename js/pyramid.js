// Примитивы «бильярдной пирамиды»: ряды, диаметр шара, слоты и цвет по приоритету.
// Сцена интро (тайминг, россыпь, лоток) живёт в intro-scene.js. Чистый модуль: без DOM,
// хранилища и модели, без случайности и часов; всё считается и проверяется в node:test.

export const MAX_BALLS = 15;
export const NEUTRAL_VAR = '--ball-none';

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
