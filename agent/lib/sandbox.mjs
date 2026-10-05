// Рабочий каталог ребёнка (SEC01): пустая песочница, не $HOME и не репозиторий.
// Даже если инструмент чтения ФС окажется доступен, внутри только пустой каталог 0700.
// Чужой каталог мы не «чиним»: симлинк, чужие права, чужой владелец, предок home, непустой каталог без
// нашего маркера дают SandboxError (runner завершается с кодом 78). chmod — только для созданного нами.

import { homedir } from 'node:os';
import { join, resolve, dirname, basename, sep, relative, isAbsolute } from 'node:path';
import { mkdirSync, chmodSync, lstatSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';

export const defaultSandboxDir = (home = homedir()) => join(home, '.local', 'state', 'taskflow-agent', 'work');

/** Файл-метка: «этот каталог создан песочницей taskflow». Только при ней допустим непустой каталог. */
export const SANDBOX_MARKER = '.taskflow-sandbox';

export class SandboxError extends Error {}

const lstatOrNull = (p) => { try { return lstatSync(p); } catch (err) { if (err.code === 'ENOENT') return null; throw err; } };
/** realpath ближайшего существующего предка + несуществующий хвост (путь ещё может не существовать). */
function realOr(p) {
  const tail = [];
  let cur = resolve(p);
  for (;;) {
    try { return join(realpathSync(cur), ...tail.reverse()); } catch { /* поднимаемся выше */ }
    const up = dirname(cur);
    if (up === cur) return resolve(p);
    tail.push(basename(cur));
    cur = up;
  }
}
const uidOk = (st) => typeof process.getuid !== 'function' || st.uid === process.getuid();

/** Каталог не должен лежать «выше» home или совпадать с ним: иначе песочница содержит home. */
function assertNotHomeOrAncestor(dir, home) {
  const rh = realOr(home);
  const rd = realOr(dir);
  const rel = relative(rd, rh);                 // '' — тот же каталог; без '..' и не абсолютный — rh внутри rd
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new SandboxError('рабочий каталог не может быть домашним каталогом или его предком');
  }
}

/** Ни сам каталог, ни его компоненты ниже home (и при отсутствии home в пути — сам каталог) не симлинки. */
function assertNoSymlinks(dir, home) {
  const underHome = [resolve(home), realOr(home)].map((h) => relative(h, dir)).find((r) => r !== '' && !r.startsWith('..') && !isAbsolute(r));
  const base = underHome === undefined ? dirname(dir) : resolve(home);
  const parts = underHome === undefined ? [basename(dir)] : underHome.split(sep);
  let cur = base;
  for (const part of parts) {
    cur = join(cur, part);
    const st = lstatOrNull(cur);
    if (st === null) return;                    // дальше компонентов нет — создадим сами
    if (st.isSymbolicLink()) throw new SandboxError(`рабочий каталог или его родитель — символическая ссылка: ${cur}`);
  }
}

/** Возвращает путь к песочнице: создаёт новую (0700 + маркер) или принимает ранее созданную нами. */
export function ensureSandbox({ override, home = homedir() } = {}) {
  const dir = resolve(override || defaultSandboxDir(home));
  assertNotHomeOrAncestor(dir, home);
  assertNoSymlinks(dir, home);

  const existing = lstatOrNull(dir);
  if (existing === null) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory() || !uidOk(st)) throw new SandboxError('рабочий каталог подменён во время создания');
    chmodSync(dir, 0o700);                      // только что созданный нами каталог: umask мог урезать режим
    writeFileSync(join(dir, SANDBOX_MARKER), 'taskflow-agent sandbox\n', { flag: 'wx', mode: 0o600 });
    return dir;
  }

  if (existing.isSymbolicLink()) throw new SandboxError('рабочий каталог — символическая ссылка');
  if (!existing.isDirectory()) throw new SandboxError('рабочий каталог не является каталогом');
  if (!uidOk(existing)) throw new SandboxError('рабочий каталог принадлежит другому пользователю');
  if ((existing.mode & 0o777) !== 0o700) throw new SandboxError('у существующего рабочего каталога должны быть права 0700 (мы их не меняем)');

  const marker = lstatOrNull(join(dir, SANDBOX_MARKER));
  if (marker !== null) {
    if (!marker.isFile() || !uidOk(marker)) throw new SandboxError('маркер песочницы недействителен');
    return dir;
  }
  if (readdirSync(dir).length > 0) throw new SandboxError('существующий непустой каталог не является песочницей taskflow (нет маркера)');
  writeFileSync(join(dir, SANDBOX_MARKER), 'taskflow-agent sandbox\n', { flag: 'wx', mode: 0o600 });
  return dir;
}
