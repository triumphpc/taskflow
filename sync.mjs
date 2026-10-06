// Хранилище задач на сервере и слияние с клиентами.
// Один файл JSON, без зависимостей и без БД: личный список задач — это
// несколько сотен записей, ради которых поднимать СУБД незачем.

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyAgentTransition, mergeTaskRecord, normalizeAgent, mergeAgentNotes, extractJournals, normalizeJournal, AGENT_STATUSES, NOTE_TEXT_MAX, NOTE_KIND_JOURNAL } from './js/agent.js';

const SCHEMA = 1;

/** Столько живут надгробия. Совпадает с TOMBSTONE_TTL_MS на клиенте. */
const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;

/** Больше этого тело запроса не читаем — защита от случайного OOM. */
const MAX_BODY = 8 * 1024 * 1024;

/** Метка из будущего дальше суток не принимается (SEC08, I04): иначе блок «навсегда» побеждает любую запись. Не клампим, а игнорируем. */
const AGENT_AT_FUTURE_MS = 24 * 3600 * 1000;
/** Не более стольких заметок агента на задачу; сверх лимита НОВЫЕ не принимаем, существующие не трогаем. */
const AGENT_NOTES_MAX = 200;

const noteKey = (at, text) => `${Number(at) || 0}\u0000${text}`;

/**
 * Приводит блок agent и agentNotes входящей записи к допустимому виду. Не мутирует вход;
 * записи без этих ключей остаются как есть (SRC-34: данные не теряются, «ключа нет» = «не знаю»).
 * Недопустимый блок agent (не объект, неизвестный статус, метка из будущего) убирается целиком:
 * побеждает серверный блок. Заметки:
 *  - совпавшие по (at, text) с уже известными на сервере пропускаются как есть (не усекаются и не считаются);
 *  - новые длиннее NOTE_TEXT_MAX или с меткой из будущего отбрасываются целиком;
 *  - лимит AGENT_NOTES_MAX применяется к новым заметкам и только если задача уже есть на сервере
 *    (при cur === undefined это восстановление или новое устройство: данные пользователя принимаются все).
 */
export function sanitizeIncomingTask(t, cur, now = Date.now()) {
  const out = { ...t };
  if ('agent' in out) {
    const raw = out.agent;
    const a = normalizeAgent(raw);
    const validStatus = a !== undefined && (raw.status === null || AGENT_STATUSES.includes(raw.status));
    if (!validStatus || a.at > now + AGENT_AT_FUTURE_MS) delete out.agent;
    else out.agent = a;
  }
  if ('agentNotes' in out) {
    if (!Array.isArray(out.agentNotes)) delete out.agentNotes;
    else {
      const curNotes = Array.isArray(cur?.agentNotes) ? cur.agentNotes : [];
      const known = new Set(curNotes.map((n) => noteKey(n?.at, n?.text)));
      // SEC04: метка журнала переживает только у заметок, которые сервер уже хранит с ней; остальное снимается.
      const journalKeys = new Set(curNotes.filter((n) => n?.kind === NOTE_KIND_JOURNAL).map((n) => noteKey(n.at, n.text)));
      let room = cur ? Math.max(0, AGENT_NOTES_MAX - known.size) : Infinity;
      const kept = [];
      for (const { kind: _drop, ...plain } of mergeAgentNotes([], out.agentNotes)) {
        const n = journalKeys.has(noteKey(plain.at, plain.text)) ? { ...plain, kind: NOTE_KIND_JOURNAL } : plain;
        if (known.has(noteKey(n.at, n.text))) { kept.push(n); continue; }
        if (n.text.length > NOTE_TEXT_MAX || n.at > now + AGENT_AT_FUTURE_MS) continue;
        if (room > 0) { room--; kept.push(n); }
      }
      out.agentNotes = kept;
    }
  }
  return out;
}

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
    const b = Buffer.from(this.token || '');
    return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
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
    const run = this.queue.then(() => this.#merge(incoming));
    this.queue = run.catch(() => {});   // ошибка записи не должна навсегда ломать очередь
    return run;
  }

  /**
   * Условный переход делегирования (claim | finish | reap). Идёт в той же цепочке записи,
   * что и sync(): что раньше дошло до очереди, то и победило (C7).
   * req = {op, id, today?, claimToken?, status?, text?, journal?} -> {ok:true, agent, rev, task, journals?, journalStored?} | {ok:false, reason}
   * claim добавляет journals (блоки журнала прежних попыток с тем же сроком), finish/reap с journal добавляют journalStored.
   */
  agentTransition(req) {
    const run = this.queue.then(() => this.#transition(req));
    this.queue = run.catch(() => {});
    return run;
  }

  async #transition(req) {
    const now = Date.now();
    const id = req && typeof req.id === 'string' ? req.id : null;
    const cur = id ? this.state.tasks.find((t) => t.id === id) : undefined;
    if (!id && req?.op !== undefined) return { ok: false, reason: 'bad_request' };
    const r = applyAgentTransition(cur, { ...req, token: req?.op === 'claim' ? randomUUID() : undefined, ttlMs: undefined }, now);
    if (!r.ok) return r;
    const next = {
      schema: SCHEMA,
      rev: this.state.rev + 1,
      updatedAt: now,
      tasks: this.state.tasks.map((t) => (t.id === id ? r.task : t)),
      deleted: this.state.deleted,
    };
    await this.#write(next);
    const { title, notes, due } = r.task;
    const out = { ok: true, agent: r.task.agent, rev: next.rev, task: { id, title, notes, due } };
    if (req.op === 'claim') out.journals = extractJournals(cur.agentNotes, { due: typeof cur.due === 'string' ? cur.due.slice(0, 10) : null });
    else if (req.journal !== undefined) out.journalStored = normalizeJournal(req.journal) !== null;
    return out;
  }

  async #merge(incoming) {
    const now = Date.now();
    const tasks = new Map(this.state.tasks.map((t) => [t.id, t]));
    const tombs = new Map(this.state.deleted.map((d) => [d.id, d.at]));

    let applied = 0;
    for (const t of incoming.tasks || []) {
      if (!t || typeof t.id !== 'string') continue;
      const cur = tasks.get(t.id);
      // Пользовательские поля по updatedAt, блок agent и agentNotes отдельно (ADR-001):
      // запись старого клиента без них не стирает серверные.
      const merged = mergeTaskRecord(cur, sanitizeIncomingTask(t, cur, now));
      if (!cur || JSON.stringify(merged) !== JSON.stringify(cur)) { tasks.set(t.id, merged); applied++; }
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
