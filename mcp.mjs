#!/usr/bin/env node
// MCP-сервер TaskFlow: даёт агенту те же операции над задачами, что есть в приложении.
//   node mcp.mjs
// Переменные окружения:
//   PORT               — порт (по умолчанию 8788); слушаем только 127.0.0.1
//   TASKFLOW_API       — адрес основного сервера (по умолчанию http://127.0.0.1:8787)
//   TASKFLOW_DATA      — каталог с данными (по умолчанию ./data)
//   TASKFLOW_MCP_TOKEN — токен доступа к MCP; иначе data/mcp-token.txt, иначе генерируется
//   TASKFLOW_TOKEN     — токен синхронизации для /api; иначе data/token.txt
//   TASKFLOW_MCP_ORIGINS — дополнительные допустимые Origin через запятую
//
// Файлом данных владеет только serve.mjs: здесь все чтения идут через GET /api/state,
// все записи — через POST /api/sync. Двух хозяев у read-modify-rename быть не должно.

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readBody } from './sync.mjs';
import {
  uid, todayStr, addDaysStr, nextMondayStr, fromDateStr, toDateStr,
  datePart, timePart, combineDue, isAllDay, isOverdue, nextOccurrence,
  fmtDue, oneLine, plural,
} from './js/core.js';

// Пакет ставится отдельно: приложение и serve.mjs работают без npm install,
// зависимость нужна только этому файлу — поэтому импорт динамический.
let McpServerCore, StreamableHTTPServerTransport, ListToolsRequestSchema, CallToolRequestSchema;
try {
  ({ Server: McpServerCore } = await import('@modelcontextprotocol/sdk/server/index.js'));
  ({ StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js'));
  ({ ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js'));
} catch (err) {
  console.error('Не найден пакет @modelcontextprotocol/sdk.');
  console.error('Выполните `npm install` в каталоге проекта и запустите снова.');
  console.error(`Подробность: ${err.message}`);
  process.exit(1);
}

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 8788);
const HOST = '127.0.0.1';
const DATA_DIR = resolve(process.env.TASKFLOW_DATA || join(ROOT, 'data'));
const MCP_TOKEN_FILE = join(DATA_DIR, 'mcp-token.txt');
const SYNC_TOKEN_FILE = join(DATA_DIR, 'token.txt');
const API_BASE = (process.env.TASKFLOW_API || 'http://127.0.0.1:8787').replace(/\/+$/, '');

// ---------- Токены ----------

async function loadMcpToken() {
  const fromEnv = (process.env.TASKFLOW_MCP_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const saved = (await readFile(MCP_TOKEN_FILE, 'utf8')).trim();
    if (saved) return saved;
  } catch { /* нет файла — создадим ниже */ }
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const token = randomBytes(24).toString('base64url');
  await writeFile(MCP_TOKEN_FILE, token + '\n', { mode: 0o600 });
  return token;
}

/** Токен синхронизации создаёт serve.mjs, поэтому читаем лениво: он мог ещё не стартовать. */
let syncTokenCache = null;
async function syncToken() {
  if (syncTokenCache) return syncTokenCache;
  const fromEnv = (process.env.TASKFLOW_TOKEN || '').trim();
  if (fromEnv) return (syncTokenCache = fromEnv);
  try {
    const saved = (await readFile(SYNC_TOKEN_FILE, 'utf8')).trim();
    if (saved) return (syncTokenCache = saved);
  } catch { /* сообщим вызывающему */ }
  return null;
}

const MCP_TOKEN = await loadMcpToken();

/** Сравнение в постоянное время — чтобы по времени ответа не подбирали токен. */
function checkToken(header) {
  const given = /^Bearer\s+(.+)$/i.exec(header || '')?.[1]?.trim() || '';
  const a = Buffer.from(given);
  const b = Buffer.from(MCP_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const EXTRA_ORIGINS = (process.env.TASKFLOW_MCP_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Проверка Origin — защита от перепривязки DNS: сторонняя страница в браузере
 * не должна ходить в локальный порт. Клиенты из командной строки заголовок
 * не шлют вовсе, поэтому его отсутствие допустимо.
 */
function originAllowed(origin) {
  if (!origin) return true;
  if (EXTRA_ORIGINS.includes(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}

// ---------- Клиент основного API ----------

/** Ошибка, которую показываем агенту текстом, без стектрейса. */
class ToolError extends Error {}

async function api(path, init = {}) {
  const token = await syncToken();
  if (!token) {
    throw new ToolError(
      'Не найден токен синхронизации. Задайте TASKFLOW_TOKEN или запустите serve.mjs — '
      + `он создаст ${SYNC_TOKEN_FILE}.`,
    );
  }
  let res;
  try {
    res = await fetch(API_BASE + path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
  } catch (err) {
    const code = err?.cause?.code || err.message;
    throw new ToolError(
      `Сервер синхронизации ${API_BASE} не отвечает (${code}). Проверьте, запущен ли serve.mjs.`,
    );
  }
  if (res.status === 401) {
    syncTokenCache = null;
    throw new ToolError(`Сервер синхронизации ${API_BASE} отклонил токен. Проверьте TASKFLOW_TOKEN или ${SYNC_TOKEN_FILE}.`);
  }
  if (!res.ok) {
    throw new ToolError(`Сервер синхронизации ответил ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

const fetchTasks = async () => (await api('/api/state')).tasks.map(normalizeTask);
const pushTasks = (tasks, deleted = []) => api('/api/sync', { method: 'POST', body: JSON.stringify({ tasks, deleted }) });

// ---------- Форма задачи ----------

/** Та же форма, что у приложения (js/store.js): старые записи дотягиваем до неё. */
function normalizeTask(t) {
  return {
    id: t.id || uid(),
    title: t.title || '',
    notes: t.notes || '',
    subtasks: Array.isArray(t.subtasks)
      ? t.subtasks.map((s) => ({ id: s.id || uid(), title: s.title || '', done: !!s.done }))
      : [],
    done: !!t.done,
    completedAt: t.completedAt || null,
    due: t.due || null,
    priority: [1, 2, 3, 4].includes(t.priority) ? t.priority : 4,
    repeat: t.repeat ? {
      freq: t.repeat.freq,
      interval: Math.max(1, t.repeat.interval || 1),
      time: t.repeat.time || null,
      anchor: t.repeat.anchor || null,
    } : null,
    notifiedFor: t.notifiedFor || null,
    completions: Array.isArray(t.completions) ? t.completions : [],
    createdAt: t.createdAt || Date.now(),
    updatedAt: t.updatedAt || Date.now(),
    order: typeof t.order === 'number' ? t.order : Date.now(),
  };
}

const REPEAT_LABELS = { daily: 'ежедневно', weekly: 'еженедельно', monthly: 'ежемесячно' };

function repeatLabel(repeat) {
  if (!repeat) return '';
  const n = repeat.interval || 1;
  if (n === 1) return REPEAT_LABELS[repeat.freq] || 'повтор';
  const unit = repeat.freq === 'daily' ? 'дн.' : repeat.freq === 'weekly' ? 'нед.' : 'мес.';
  return `каждые ${n} ${unit}`;
}

/** Повтор из аргументов инструмента. `none` снимает повтор. */
function buildRepeat(freq, every, due, current) {
  if (freq === undefined && every === undefined) return undefined;
  const nextFreq = freq === undefined ? current?.freq : freq;
  if (!nextFreq || nextFreq === 'none') return null;
  if (!['daily', 'weekly', 'monthly'].includes(nextFreq)) {
    throw new ToolError(`Не понимаю повтор «${nextFreq}». Допустимо: daily, weekly, monthly, none.`);
  }
  return {
    freq: nextFreq,
    interval: Math.max(1, Number(every ?? current?.interval ?? 1) || 1),
    time: timePart(due) || current?.time || null,
    anchor: datePart(due) || current?.anchor || null,
  };
}

// ---------- Разбор срока ----------

const DUE_WORDS = {
  'сегодня': () => todayStr(),
  'today': () => todayStr(),
  'завтра': () => addDaysStr(todayStr(), 1),
  'tomorrow': () => addDaysStr(todayStr(), 1),
  'послезавтра': () => addDaysStr(todayStr(), 2),
  'понедельник': () => nextMondayStr(),
  'monday': () => nextMondayStr(),
  'следующая неделя': () => nextMondayStr(),
  'next-week': () => nextMondayStr(),
};

/**
 * Текст срока -> наивная локальная строка, как её хранит приложение.
 * Понимает 'YYYY-MM-DD', 'YYYY-MM-DDTHH:mm', слова из DUE_WORDS и '+N' (дней вперёд),
 * с необязательным временем в конце: «завтра 18:30».
 */
function resolveDue(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  let text = raw;
  let time = null;
  const tm = /(?:^|[\sT])(\d{1,2}):(\d{2})$/.exec(text);
  if (tm) {
    const hh = Number(tm[1]);
    const mm = Number(tm[2]);
    if (hh > 23 || mm > 59) throw new ToolError(`Не понимаю время «${tm[1]}:${tm[2]}».`);
    time = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    text = text.slice(0, tm.index).trim();
  }

  if (!text) return combineDue(todayStr(), time);

  const word = DUE_WORDS[text.toLowerCase()];
  if (word) return combineDue(word(), time);

  const plus = /^\+(\d{1,3})\s*(?:d|д|дн|дней|день|дня)?$/i.exec(text);
  if (plus) return combineDue(addDaysStr(todayStr(), Number(plus[1])), time);

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    // Пересобираем через Date: так отсекаются 2026-02-31 и прочие несуществующие дни.
    if (toDateStr(fromDateStr(text)) !== text) throw new ToolError(`Такой даты нет: «${text}».`);
    return combineDue(text, time);
  }

  throw new ToolError(
    `Не понимаю срок «${raw}». Ожидается YYYY-MM-DD, YYYY-MM-DDTHH:mm, `
    + '«сегодня», «завтра», «послезавтра», «понедельник» или «+3» — с временем или без.',
  );
}

// ---------- Разделы и порядок ----------

const SECTIONS = ['today', 'tomorrow', 'upcoming', 'someday', 'all', 'done', 'overdue'];

const SECTION_TITLES = {
  today: 'Сегодня', tomorrow: 'Завтра', upcoming: 'Ближайшие',
  someday: 'Без даты', all: 'Все задачи', done: 'Выполнено', overdue: 'Просрочено',
};

function inSection(t, section, today, tomorrow) {
  if (section === 'done') return t.done;
  if (t.done) return false;
  const d = datePart(t.due);
  if (section === 'today') return !!d && d <= today;      // «Сегодня» в приложении включает просроченное
  if (section === 'tomorrow') return d === tomorrow;
  if (section === 'upcoming') return !!d && d > today;
  if (section === 'someday') return !d;
  if (section === 'overdue') return isOverdue(t.due);
  return true;                                            // all
}

// Тот же порядок, что в приложении: сначала дата, потом время внутри дня, потом
// приоритет. Задачи без даты идут в конец — в приложении это отдельная группа
// «Без даты», и она последняя.
const byTimeThenPriority = (a, b) => {
  const da = datePart(a.due), db = datePart(b.due);
  if (!da !== !db) return da ? -1 : 1;
  if (da && db && da !== db) return da < db ? -1 : 1;
  const ta = timePart(a.due), tb = timePart(b.due);
  if (ta && tb && ta !== tb) return ta < tb ? -1 : 1;
  if (ta && !tb) return -1;
  if (!ta && tb) return 1;
  return a.priority - b.priority;
};

const byPriorityThenTime = (a, b) => {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return (a.order || 0) - (b.order || 0);
};

// ---------- Вывод ----------

const shortId = (id) => String(id).slice(0, 8);

function taskLine(t) {
  const mark = t.done ? '✓' : '☐';
  const parts = [`${shortId(t.id)}  ${mark} P${t.priority}  ${oneLine(t.title)}`];
  const meta = [];
  if (t.due) meta.push(fmtDue(t.due) + (!t.done && isOverdue(t.due) ? ' · просрочено' : ''));
  else meta.push('без даты');
  if (t.repeat) meta.push(repeatLabel(t.repeat));
  const subs = t.subtasks.length;
  if (subs) meta.push(`подзадачи ${t.subtasks.filter((s) => s.done).length}/${subs}`);
  if (t.notes) meta.push('есть заметка');
  parts.push(`— ${meta.join(' · ')}`);
  return parts.join(' ');
}

function taskDetails(t) {
  const out = [taskLine(t), `id: ${t.id}`];
  if (t.notes) out.push('Заметки:', ...String(t.notes).split('\n').map((l) => '  ' + l));
  if (t.subtasks.length) {
    out.push('Подзадачи:');
    for (const s of t.subtasks) out.push(`  ${shortId(s.id)}  ${s.done ? '✓' : '☐'} ${s.title}`);
  }
  if (t.completions?.length) out.push(`Выполнений в серии: ${t.completions.length}`);
  return out.join('\n');
}

const listText = (tasks, verbose) => (verbose
  ? tasks.map(taskDetails).join('\n\n')
  : tasks.map(taskLine).join('\n'));

// ---------- Адресация задачи ----------

/**
 * Находит одну задачу по началу id или фрагменту названия.
 * Несколько совпадений — возвращаем кандидатов и ничего не меняем; ноль — внятная ошибка.
 */
function findTask(tasks, query) {
  const q = String(query ?? '').trim();
  if (!q) throw new ToolError('Не указана задача: передайте начало id или фрагмент названия.');
  const lower = q.toLowerCase();

  const byId = tasks.filter((t) => t.id.toLowerCase().startsWith(lower));
  const pool = byId.length ? byId : tasks.filter((t) => oneLine(t.title).toLowerCase().includes(lower));

  if (pool.length === 1) return pool[0];
  if (pool.length === 0) {
    throw new ToolError(`По «${q}» ничего не нашлось. Посмотрите список через tasks_list.`);
  }
  const n = pool.length;
  throw new ToolError(
    `По «${q}» подходит ${n} ${plural(n, 'задача', 'задачи', 'задач')} — уточните, ничего не изменено:\n`
    + pool.map(taskLine).join('\n'),
  );
}

function findSubtask(task, query) {
  const q = String(query ?? '').trim();
  if (!q) throw new ToolError('Не указана подзадача: передайте начало id или фрагмент названия.');
  const lower = q.toLowerCase();
  const byId = task.subtasks.filter((s) => s.id.toLowerCase().startsWith(lower));
  const pool = byId.length ? byId : task.subtasks.filter((s) => s.title.toLowerCase().includes(lower));
  if (pool.length === 1) return pool[0];
  if (pool.length === 0) throw new ToolError(`В задаче «${oneLine(task.title)}» нет подзадачи по «${q}».`);
  throw new ToolError(
    `По «${q}» подходит несколько подзадач — уточните, ничего не изменено:\n`
    + pool.map((s) => `  ${shortId(s.id)}  ${s.done ? '✓' : '☐'} ${s.title}`).join('\n'),
  );
}

const touch = (t) => { t.updatedAt = Date.now(); return t; };

/** Отправляет изменённую задачу на сервер и возвращает её же. */
async function saveTask(t) {
  await pushTasks([touch(t)]);
  return t;
}

// ---------- Инструменты ----------

const taskArg = {
  type: 'string',
  description: 'Задача: начало id или фрагмент названия. Несколько совпадений — вернётся список кандидатов.',
};
const dueArg = {
  type: 'string',
  description: 'Срок: YYYY-MM-DD, YYYY-MM-DDTHH:mm, «сегодня», «завтра», «послезавтра», «понедельник», «+3»; можно с временем: «завтра 18:30».',
};
const priorityArg = {
  type: 'integer', enum: [1, 2, 3, 4],
  description: 'Приоритет по матрице Эйзенхауэра: 1 срочно и важно, 2 важно, 3 срочно, 4 остальное (по умолчанию 4).',
};
const repeatArg = {
  type: 'string', enum: ['daily', 'weekly', 'monthly', 'none'],
  description: 'Повтор. none снимает повтор.',
};
const everyArg = { type: 'integer', minimum: 1, description: 'Интервал повтора: каждые N дней/недель/месяцев.' };

const TOOLS = [
  {
    name: 'tasks_list',
    description: 'Список задач раздела: today, tomorrow, upcoming, someday, all, done, overdue.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: SECTIONS, description: 'Раздел, по умолчанию today.' },
        verbose: { type: 'boolean', description: 'Показать заметки и подзадачи.' },
      },
    },
    async run({ section = 'today', verbose = false }) {
      if (!SECTIONS.includes(section)) {
        throw new ToolError(`Нет раздела «${section}». Доступны: ${SECTIONS.join(', ')}.`);
      }
      const all = await fetchTasks();
      const today = todayStr();
      const tomorrow = addDaysStr(today, 1);
      const list = all.filter((t) => inSection(t, section, today, tomorrow));
      if (section === 'done') list.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
      else if (section === 'someday') list.sort(byPriorityThenTime);
      else list.sort(byTimeThenPriority);

      const head = `${SECTION_TITLES[section]}: ${list.length} ${plural(list.length, 'задача', 'задачи', 'задач')}`;
      return list.length ? `${head}\n${listText(list, verbose)}` : `${head} — пусто.`;
    },
  },
  {
    name: 'task_get',
    description: 'Одна задача целиком: заметки, подзадачи, повтор.',
    inputSchema: { type: 'object', properties: { task: taskArg }, required: ['task'] },
    async run({ task }) {
      return taskDetails(findTask(await fetchTasks(), task));
    },
  },
  {
    name: 'task_add',
    description: 'Создать задачу целиком за один вызов.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Название задачи.' },
        notes: { type: 'string', description: 'Заметки.' },
        due: dueArg,
        priority: priorityArg,
        subtasks: { type: 'array', items: { type: 'string' }, description: 'Названия подзадач.' },
        repeat: repeatArg,
        every: everyArg,
      },
      required: ['title'],
    },
    async run({ title, notes, due, priority, subtasks, repeat, every }) {
      const clean = String(title ?? '').trim();
      if (!clean) throw new ToolError('Пустое название задачи.');
      const dueStr = resolveDue(due);
      const now = Date.now();
      const t = normalizeTask({
        id: uid(),
        title: clean,
        notes: notes || '',
        due: dueStr,
        priority: priority ?? 4,
        subtasks: (subtasks || []).map((s) => ({ id: uid(), title: String(s).trim(), done: false }))
          .filter((s) => s.title),
        repeat: dueStr ? (buildRepeat(repeat, every, dueStr, null) ?? null) : null,
        createdAt: now,
        updatedAt: now,
        order: now,
      });
      if (repeat && repeat !== 'none' && !dueStr) {
        throw new ToolError('Повтор без даты бессмыслен: задайте due.');
      }
      await pushTasks([t]);
      return `Создана задача:\n${taskLine(t)}`;
    },
  },
  {
    name: 'task_edit',
    description: 'Изменить поля задачи. clear_due снимает срок вместе с повтором.',
    inputSchema: {
      type: 'object',
      properties: {
        task: taskArg,
        title: { type: 'string' },
        notes: { type: 'string' },
        due: dueArg,
        clear_due: { type: 'boolean', description: 'Снять срок и повтор.' },
        priority: priorityArg,
        repeat: repeatArg,
        every: everyArg,
      },
      required: ['task'],
    },
    async run({ task, title, notes, due, clear_due: clearDue, priority, repeat, every }) {
      const all = await fetchTasks();
      const t = findTask(all, task);

      if (title !== undefined) {
        const clean = String(title).trim();
        if (!clean) throw new ToolError('Пустое название задачи.');
        t.title = clean;
      }
      if (notes !== undefined) t.notes = String(notes);
      if (priority !== undefined) t.priority = priority;
      if (clearDue) { t.due = null; t.repeat = null; }
      else if (due !== undefined) t.due = resolveDue(due);

      const nextRepeat = buildRepeat(repeat, every, t.due, t.repeat);
      if (nextRepeat !== undefined) t.repeat = nextRepeat;
      // Повтор без даты бессмыслен — снимаем его, как это делает приложение.
      if (t.repeat && !t.due) t.repeat = null;
      if (t.repeat && !t.repeat.anchor) t.repeat.anchor = datePart(t.due);

      await saveTask(t);
      return `Изменено:\n${taskLine(t)}`;
    },
  },
  {
    name: 'task_snooze',
    description: 'Перенести срок. Время суток сохраняется, задача на весь день остаётся на весь день.',
    inputSchema: {
      type: 'object',
      properties: { task: taskArg, due: dueArg },
      required: ['task', 'due'],
    },
    async run({ task, due }) {
      const t = findTask(await fetchTasks(), task);
      const target = resolveDue(due);
      if (!target) throw new ToolError('Не указана новая дата.');
      // Явно заданное время побеждает; иначе сохраняем прежнее (у «весь день» его нет).
      t.due = combineDue(datePart(target), timePart(target) || timePart(t.due));
      if (t.repeat) t.repeat.time = timePart(t.due);
      await saveTask(t);
      return `Перенесено на ${fmtDue(t.due)}${isAllDay(t.due) ? ' (весь день)' : ''}:\n${taskLine(t)}`;
    },
  },
  {
    name: 'task_done',
    description: 'Отметить выполненной; undo возвращает в работу. Повторяющаяся задача переносится на следующую дату серии.',
    inputSchema: {
      type: 'object',
      properties: { task: taskArg, undo: { type: 'boolean', description: 'Вернуть в работу.' } },
      required: ['task'],
    },
    async run({ task, undo = false }) {
      const t = findTask(await fetchTasks(), task);

      if (undo) {
        if (!t.done) return `Задача и так в работе:\n${taskLine(t)}`;
        t.done = false;
        t.completedAt = null;
        await saveTask(t);
        return `Вернул в работу:\n${taskLine(t)}`;
      }

      if (t.repeat && t.due) {
        const base = datePart(t.due);
        const today = todayStr();
        const nextDate = nextOccurrence(base, t.repeat, today > base ? today : base);
        t.completions = [...(t.completions || []), { at: Date.now(), due: t.due }].slice(-50);
        t.due = combineDue(nextDate, t.repeat.time || timePart(t.due));
        t.subtasks = t.subtasks.map((s) => ({ ...s, done: false }));
        t.notifiedFor = null;
        await saveTask(t);
        return `Повтор: следующий раз ${fmtDue(t.due)}\n${taskLine(t)}`;
      }

      if (t.done) return `Задача уже выполнена:\n${taskLine(t)}`;
      t.done = true;
      t.completedAt = Date.now();
      await saveTask(t);
      return `Выполнено:\n${taskLine(t)}`;
    },
  },
  {
    name: 'subtask_add',
    description: 'Добавить подзадачу.',
    inputSchema: {
      type: 'object',
      properties: { task: taskArg, title: { type: 'string', description: 'Название подзадачи.' } },
      required: ['task', 'title'],
    },
    async run({ task, title }) {
      const clean = String(title ?? '').trim();
      if (!clean) throw new ToolError('Пустое название подзадачи.');
      const t = findTask(await fetchTasks(), task);
      t.subtasks.push({ id: uid(), title: clean, done: false });
      await saveTask(t);
      return `Добавлена подзадача «${clean}»:\n${taskDetails(t)}`;
    },
  },
  {
    name: 'subtask_toggle',
    description: 'Переключить готовность подзадачи; done задаёт состояние явно.',
    inputSchema: {
      type: 'object',
      properties: {
        task: taskArg,
        subtask: { type: 'string', description: 'Подзадача: начало id или фрагмент названия.' },
        done: { type: 'boolean', description: 'Явное состояние вместо переключения.' },
      },
      required: ['task', 'subtask'],
    },
    async run({ task, subtask, done }) {
      const t = findTask(await fetchTasks(), task);
      const s = findSubtask(t, subtask);
      s.done = done === undefined ? !s.done : !!done;
      await saveTask(t);
      return `Подзадача «${s.title}»: ${s.done ? 'выполнена' : 'в работе'}\n${taskDetails(t)}`;
    },
  },
  {
    name: 'task_delete',
    description: 'Удалить задачу. Без confirm: true ничего не удаляет, а показывает, что нашлось.',
    inputSchema: {
      type: 'object',
      properties: { task: taskArg, confirm: { type: 'boolean', description: 'Подтверждение удаления.' } },
      required: ['task'],
    },
    async run({ task, confirm = false }) {
      const t = findTask(await fetchTasks(), task);
      if (confirm !== true) {
        throw new ToolError(
          `Удаление не подтверждено. Под удаление попадает «${oneLine(t.title)}» (${shortId(t.id)}). `
          + 'Повторите вызов с confirm: true, если это действительно нужно.',
        );
      }
      await pushTasks([], [{ id: t.id, at: Date.now() }]);
      return `Удалена задача «${oneLine(t.title)}» (${shortId(t.id)}).`;
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ---------- Сервер ----------

function buildServer() {
  const server = new McpServerCore(
    { name: 'taskflow', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOL_BY_NAME.get(req.params.name);
    if (!tool) return { content: [{ type: 'text', text: `Нет инструмента «${req.params.name}».` }], isError: true };
    try {
      const text = await tool.run(req.params.arguments || {});
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      // Наружу уходит текст, а не стектрейс: агенту нужно понятное объяснение.
      if (!(err instanceof ToolError)) console.error(`[mcp] ${tool.name}:`, err);
      return {
        content: [{ type: 'text', text: err instanceof ToolError ? err.message : `Внутренняя ошибка: ${err.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

const sendJson = (res, code, payload) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    .end(JSON.stringify(payload));
};

const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    if (url.pathname !== '/mcp') {
      sendJson(res, 404, { error: 'Нет такого маршрута. MCP живёт на POST /mcp.' });
      return;
    }

    // Поток от сервера к клиенту не нужен: ответы отдаём обычным JSON,
    // поэтому GET и DELETE не поддерживаются осознанно.
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json; charset=utf-8' })
        .end(JSON.stringify({ error: 'Метод не поддерживается: MCP работает через POST /mcp.' }));
      return;
    }

    if (!originAllowed(req.headers.origin)) {
      sendJson(res, 403, { error: 'Недопустимый Origin.' });
      return;
    }

    if (!checkToken(req.headers.authorization)) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Bearer',
        'Content-Type': 'application/json; charset=utf-8',
      }).end(JSON.stringify({ error: 'Неверный токен' }));
      return;
    }

    let body;
    try {
      body = JSON.parse(await readBody(req) || '{}');
    } catch (err) {
      sendJson(res, 400, { error: `Некорректный JSON: ${err.message}` });
      return;
    }

    // Сервер без сессий: на каждый запрос свой транспорт, состояния между
    // запросами нет — так проще и переживает перезапуск агента.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error('[mcp]', err);
    if (res.headersSent) return;
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(`TaskFlow MCP → http://${HOST}:${PORT}/mcp`);
  console.log(`Основной сервер: ${API_BASE}`);
  console.log(`Токен MCP: ${MCP_TOKEN}`);
  console.log(`Подключение: claude mcp add --transport http taskflow http://${HOST}:${PORT}/mcp --header "Authorization: Bearer ${MCP_TOKEN}"`);
});
