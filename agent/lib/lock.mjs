// Замок одного прогона демона: каталог lock.d с файлом pid. Замок мёртвого процесса отбирается,
// release вызывается в finally. Нужен против ручных запусков: launchd второй экземпляр не стартует.

import { mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FRESH_MS = 5000;

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

export function createLock(stateDir, { pid = process.pid } = {}) {
  const dir = join(stateDir, 'lock.d');
  const pidFile = join(dir, 'pid');
  let held = false;

  function holderAlive() {
    try {
      return alive(Number(readFileSync(pidFile, 'utf8').trim()));
    } catch {
      // pid ещё не записан: свежий каталог считаем занятым, старый — брошенным.
      try { return Date.now() - statSync(dir).mtimeMs < FRESH_MS; } catch { return false; }
    }
  }

  return {
    acquire() {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          mkdirSync(dir, { mode: 0o700 });
          writeFileSync(pidFile, `${pid}\n`, { mode: 0o600 });
          held = true;
          return true;
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
          if (holderAlive()) return false;
          rmSync(dir, { recursive: true, force: true });
        }
      }
      return false;
    },
    release() {
      if (!held) return;
      held = false;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
