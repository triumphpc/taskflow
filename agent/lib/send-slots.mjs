// Слоты потолков отправки (M4): <runDir>/slots/<вид>-<n>, создаются флагом wx. Первый успех и есть слот.
// Слот не возвращается ни при каком исходе вызова (ADR-006): потолок считает попытки, а не успехи.

import { closeSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @returns {{ ok: true, n: number } | { ok: false }} ok:false — потолок исчерпан
 * @throws любая ошибка, кроме EEXIST (gate превращает её в deny gate_error)
 */
export function takeSlot(runDir, slot, limit, toolUseId) {
  if (!/^[a-z_]+$/.test(String(slot))) throw new TypeError('bad slot kind');
  const max = Number(limit);
  if (!Number.isSafeInteger(max) || max < 0) throw new TypeError('bad limit');
  for (let n = 1; n <= max; n++) {
    let fd;
    try {
      fd = openSync(join(runDir, 'slots', `${slot}-${n}`), 'wx', 0o600);
    } catch (err) {
      if (err?.code === 'EEXIST') continue;
      throw err;
    }
    try { writeSync(fd, String(toolUseId ?? '')); } finally { closeSync(fd); }
    return { ok: true, n };
  }
  return { ok: false };
}
