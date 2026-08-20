// Хранилище задач на сервере и слияние с клиентами.
// Один файл JSON, без зависимостей и без БД: личный список задач — это
// несколько сотен записей, ради которых поднимать СУБД незачем.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SCHEMA = 1;

/** Столько живут надгробия. Совпадает с TOMBSTONE_TTL_MS на клиенте. */
const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;

/** Больше этого тело запроса не читаем — защита от случайного OOM. */
const MAX_BODY = 8 * 1024 * 1024;

const EMPTY = { schema: SCHEMA, rev: 0, updatedAt: 0, tasks: [], deleted: [] };

export class SyncStore {
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, 'taskflow.json');
    this.tokenFile = join(dir, 'token.txt');
    this.state = null;
    this.token = null;
    // Запись идёт цепочкой промисов: два одновременных POST не должны
    // затирать друг друга, читая состояние до чужой записи.
    this.queue = Promise.resolve();
  }

  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    this.state = await this.#read();
    this.token = await this.#loadToken();
    return this;
  }

  async #read() {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      return {
        schema: SCHEMA,
        rev: Number(parsed.rev) || 0,
        updatedAt: Number(parsed.updatedAt) || 0,
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        deleted: Array.isArray(parsed.deleted) ? parsed.deleted : [],
      };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Портить единственную копию данных нельзя: падаем громко.
        throw new Error(`Файл состояния повреждён (${this.file}): ${err.message}`);
      }
      return { ...EMPTY, tasks: [], deleted: [] };
    }
  }

  /** Атомарная запись: сначала во временный файл, потом переименование. */
  async #write(next) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
    await rename(tmp, this.file);
    this.state = next;
  }

  async #loadToken() {
    const fromEnv = (process.env.TASKFLOW_TOKEN || '').trim();
    if (fromEnv) return fromEnv;
    try {
      const saved = (await readFile(this.tokenFile, 'utf8')).trim();
      if (saved) return saved;
    } catch { /* нет файла — создадим ниже */ }
    const token = randomBytes(24).toString('base64url');
    await writeFile(this.tokenFile, token + '\n', { mode: 0o600 });
    return token;
  }

  /** Сравнение в постоянное время — чтобы по времени ответа не подбирали токен. */
  checkToken(header) {
    const given = /^Bearer\s+(.+)$/i.exec(header || '')?.[1]?.trim() || '';
    const a = Buffer.from(given);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  snapshot() {
    return { rev: this.state.rev, updatedAt: this.state.updatedAt, tasks: this.state.tasks, deleted: this.state.deleted };
  }

  /**
   * Сливает присланное клиентом состояние с серверным и возвращает результат.
   * Побеждает более свежая запись — у задач сравнивается updatedAt,
   * у пары «правка против удаления» — updatedAt против времени надгробия.
   */
  sync(incoming) {
    this.queue = this.queue.then(() => this.#merge(incoming));
    return this.queue;
  }

  async #merge(incoming) {
    const now = Date.now();
    const tasks = new Map(this.state.tasks.map((t) => [t.id, t]));
    const tombs = new Map(this.state.deleted.map((d) => [d.id, d.at]));

    let applied = 0;
    for (const t of incoming.tasks || []) {
      if (!t || typeof t.id !== 'string') continue;
      const cur = tasks.get(t.id);
      if (!cur || (t.updatedAt || 0) > (cur.updatedAt || 0)) { tasks.set(t.id, t); applied++; }
    }

    for (const d of incoming.deleted || []) {
      if (!d || typeof d.id !== 'string') continue;
      const at = Number(d.at) || 0;
      if (at > (tombs.get(d.id) || 0)) tombs.set(d.id, at);
    }

    for (const [id, at] of tombs) {
      const t = tasks.get(id);
      // Правка новее удаления — значит задачу вернули осознанно, надгробие снимаем.
      if (t && (t.updatedAt || 0) > at) tombs.delete(id);
      else tasks.delete(id);
    }

    for (const [id, at] of tombs) if (now - at >= TOMBSTONE_TTL_MS) tombs.delete(id);

    const next = {
      schema: SCHEMA,
      rev: this.state.rev + 1,
      updatedAt: now,
      tasks: [...tasks.values()],
      deleted: [...tombs].map(([id, at]) => ({ id, at })),
    };
    await this.#write(next);
    return { ...this.snapshot(), applied };
  }
}

/** Читает тело запроса с ограничением по размеру. */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Тело запроса слишком большое')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
