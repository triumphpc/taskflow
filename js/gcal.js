// Односторонняя синхронизация с Google Calendar: задача -> событие в отдельном календаре.
// Авторизация — Google Identity Services (implicit token flow), без бэкенда и без секретов.
// Google принимает только https-источники (исключение — http://localhost).

import { state, commit } from './store.js';
import { datePart, timePart, parseDue, toDateStr, fromDateStr } from './util.js';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/calendar';
const API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_KEY = 'taskflow.gtoken';
const GRANTED_KEY = 'taskflow.ggranted';

export const gstatus = {
  available: false,   // GIS загрузился
  connected: false,   // есть действующий токен
  syncing: false,
  lastSync: null,     // timestamp
  lastError: null,    // строка
};

let tokenClient = null;
let gisPromise = null;
let pendingResolve = null;
let pendingReject = null;

export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** Google допускает http только для localhost — иначе OAuth не запустится. */
export function originAllowed() {
  const { protocol, hostname } = location;
  return protocol === 'https:' || hostname === 'localhost' || hostname === '127.0.0.1';
}

export function isConfigured() {
  return !!state.settings.googleClientId && state.settings.gcalEnabled;
}

// ---------- Токен ----------

function readToken() {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw);
    return t.expiresAt > Date.now() + 30_000 ? t : null;
  } catch { return null; }
}

function writeToken(token, expiresInSec) {
  const payload = { token, expiresAt: Date.now() + (expiresInSec || 3600) * 1000 };
  try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify(payload)); } catch { /* ignore */ }
  gstatus.connected = true;
}

function dropToken() {
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  gstatus.connected = false;
}

export function wasGrantedBefore() {
  try { return localStorage.getItem(GRANTED_KEY) === '1'; } catch { return false; }
}

// ---------- Загрузка GIS ----------

function loadGis() {
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Не удалось загрузить Google Identity Services'));
    document.head.append(s);
  }).then(() => { gstatus.available = true; });
  return gisPromise;
}

async function ensureClient() {
  if (!state.settings.googleClientId) throw new Error('Не задан OAuth Client ID');
  if (!originAllowed()) throw new Error('Google требует https (или http://localhost)');
  await loadGis();
  if (tokenClient) return tokenClient;

  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: state.settings.googleClientId,
    scope: SCOPE,
    callback: (resp) => {
      if (resp.error) {
        pendingReject?.(new Error(resp.error_description || resp.error));
      } else {
        writeToken(resp.access_token, Number(resp.expires_in));
        try { localStorage.setItem(GRANTED_KEY, '1'); } catch { /* ignore */ }
        pendingResolve?.(resp.access_token);
      }
      pendingResolve = pendingReject = null;
    },
    error_callback: (err) => {
      pendingReject?.(new Error(err?.message || 'Окно доступа Google закрыто'));
      pendingResolve = pendingReject = null;
    },
  });
  return tokenClient;
}

/**
 * Возвращает access token.
 * interactive=false пытается получить токен молча (работает, если доступ уже выдан
 * и в браузере есть активная сессия Google).
 */
export async function getToken({ interactive = true } = {}) {
  const cached = readToken();
  if (cached) { gstatus.connected = true; return cached.token; }

  const client = await ensureClient();
  return new Promise((resolve, reject) => {
    pendingResolve = resolve;
    pendingReject = reject;
    try {
      client.requestAccessToken({ prompt: interactive ? '' : 'none' });
    } catch (err) {
      pendingResolve = pendingReject = null;
      reject(err);
    }
  });
}

/** Явное подключение из настроек (обязательно из обработчика клика). */
export async function connect() {
  await getToken({ interactive: true });
  gstatus.lastError = null;
  await ensureCalendar();
  commit('gcal:connect');
  return true;
}

export function disconnect() {
  const cached = readToken();
  if (cached && window.google?.accounts?.oauth2) {
    try { window.google.accounts.oauth2.revoke(cached.token, () => {}); } catch { /* ignore */ }
  }
  dropToken();
  try { localStorage.removeItem(GRANTED_KEY); } catch { /* ignore */ }
  gstatus.lastError = null;
  commit('gcal:disconnect');
}

/** Тихая попытка восстановить сессию при старте. */
export async function restoreSession() {
  if (!isConfigured() || !originAllowed() || !wasGrantedBefore()) return false;
  try {
    await getToken({ interactive: false });
    return true;
  } catch {
    return false;
  }
}

// ---------- HTTP ----------

async function api(path, { method = 'GET', body, params, interactive = false } = {}) {
  const token = await getToken({ interactive });
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    dropToken();
    throw Object.assign(new Error('Google отклонил токен — подключитесь заново'), { status: 401 });
  }
  if (res.status === 204) return null;
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const j = await res.json();
      detail = j?.error?.message || detail;
    } catch { /* ignore */ }
    throw Object.assign(new Error(`Google Calendar: ${detail}`), { status: res.status });
  }
  return res.json();
}

// ---------- Календарь задач ----------

export async function listCalendars() {
  const data = await api('/users/me/calendarList', { params: { maxResults: 250 } });
  return data.items || [];
}

/** Находит календарь по имени, при отсутствии — создаёт. Id кладётся в настройки. */
export async function ensureCalendar() {
  const wanted = (state.settings.gcalCalendarName || 'TaskFlow').trim();

  if (state.settings.gcalCalendarId) {
    try {
      await api(`/calendars/${encodeURIComponent(state.settings.gcalCalendarId)}`);
      return state.settings.gcalCalendarId;
    } catch (err) {
      if (err.status !== 404) throw err;
      state.settings.gcalCalendarId = null;
    }
  }

  const existing = (await listCalendars()).find((c) => c.summary === wanted);
  if (existing) {
    state.settings.gcalCalendarId = existing.id;
    commit('gcal:calendar');
    return existing.id;
  }

  const created = await api('/calendars', {
    method: 'POST',
    body: { summary: wanted, description: 'Задачи из TaskFlow', timeZone: TZ },
  });
  state.settings.gcalCalendarId = created.id;
  commit('gcal:calendar');
  return created.id;
}

// ---------- Событие из задачи ----------

const RRULE_FREQ = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY' };
const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function rruleFor(task) {
  if (!task.repeat) return undefined;
  const freq = RRULE_FREQ[task.repeat.freq];
  if (!freq) return undefined;
  const parts = [`FREQ=${freq}`];
  const n = Math.max(1, task.repeat.interval || 1);
  if (n > 1) parts.push(`INTERVAL=${n}`);
  const anchorDate = fromDateStr(task.repeat.anchor || datePart(task.due));
  if (freq === 'WEEKLY') parts.push(`BYDAY=${BYDAY[anchorDate.getDay()]}`);
  if (freq === 'MONTHLY') parts.push(`BYMONTHDAY=${anchorDate.getDate()}`);
  return [`RRULE:${parts.join(';')}`];
}

const PRIO_COLOR = { 1: '11', 2: '6', 3: '9', 4: '8' }; // Tomato / Tangerine / Blueberry / Graphite

function localIso(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
    + `T${p(date.getHours())}:${p(date.getMinutes())}:00`;
}

/** Строит тело события Calendar API для задачи. */
export function buildEvent(task) {
  // Для серии якорем служит первая дата — иначе правка сдвинет всю серию.
  const startDateStr = task.repeat ? (task.repeat.anchor || datePart(task.due)) : datePart(task.due);
  const time = task.repeat ? (task.repeat.time || timePart(task.due)) : timePart(task.due);
  const allDay = !time;

  const descLines = [];
  if (task.notes) descLines.push(task.notes, '');
  if (task.subtasks.length) {
    descLines.push('Подзадачи:');
    for (const s of task.subtasks) descLines.push(`${s.done ? '☑' : '☐'} ${s.title}`);
    descLines.push('');
  }
  descLines.push(`Приоритет: ${['', 'P1 срочно и важно', 'P2 важно, не срочно', 'P3 срочно, не важно', 'P4 не важно, не срочно'][task.priority]}`);
  descLines.push('— TaskFlow');

  // Название задачи может быть многострочным, а summary события — одна строка.
  // Первую строку берём заголовком, остальные не теряем — уводим в описание.
  const [firstLine, ...restLines] = (task.title || 'Без названия').split('\n');
  if (restLines.some((l) => l.trim())) descLines.unshift(...restLines, '');

  const body = {
    summary: (task.priority <= 2 ? `[P${task.priority}] ` : '') + (firstLine.trim() || 'Без названия'),
    description: descLines.join('\n'),
    colorId: PRIO_COLOR[task.priority],
    extendedProperties: { private: { taskflowId: task.id } },
    reminders: { useDefault: false, overrides: allDay ? [{ method: 'popup', minutes: 9 * 60 }] : [{ method: 'popup', minutes: 0 }] },
    transparency: 'transparent',
  };

  if (allDay) {
    const end = fromDateStr(startDateStr);
    end.setDate(end.getDate() + 1);
    body.start = { date: startDateStr };
    body.end = { date: toDateStr(end) };
  } else {
    const start = parseDue(`${startDateStr}T${time}`);
    const end = new Date(start.getTime() + Math.max(5, state.settings.gcalEventMinutes || 30) * 60000);
    body.start = { dateTime: localIso(start), timeZone: TZ };
    body.end = { dateTime: localIso(end), timeZone: TZ };
  }

  const rrule = rruleFor(task);
  if (rrule) body.recurrence = rrule;

  return body;
}

/** Отпечаток задачи: меняется — значит событие пора обновить. */
export function taskHash(task) {
  const ev = buildEvent(task);
  return JSON.stringify([
    ev.summary, ev.description, ev.colorId, ev.start, ev.end, ev.recurrence || null,
    state.settings.gcalCalendarId,
  ]);
}

/** Задачи, которые должны быть представлены событием. */
function syncable() {
  return state.tasks.filter((t) => !t.done && t.due);
}

export function pendingChanges() {
  if (!isConfigured()) return 0;
  let n = state.pendingDeletes.length;
  for (const t of syncable()) {
    if (!t.gcal.eventId || t.gcal.hash !== taskHash(t)) n++;
  }
  return n;
}

// ---------- Синхронизация ----------

async function pushTask(task, calendarId) {
  const body = buildEvent(task);
  const encCal = encodeURIComponent(calendarId);

  if (task.gcal.eventId && task.gcal.calendarId === calendarId) {
    try {
      const ev = await api(`/calendars/${encCal}/events/${encodeURIComponent(task.gcal.eventId)}`, {
        method: 'PUT', body,
      });
      task.gcal = { eventId: ev.id, calendarId, hash: taskHash(task), error: null };
      return 'updated';
    } catch (err) {
      if (err.status !== 404 && err.status !== 410) throw err;
      task.gcal.eventId = null; // событие удалили в Google — создадим заново
    }
  }

  const ev = await api(`/calendars/${encCal}/events`, { method: 'POST', body });
  task.gcal = { eventId: ev.id, calendarId, hash: taskHash(task), error: null };
  return 'created';
}

/**
 * Полная синхронизация: удаляет события снятых задач и заливает изменившиеся.
 * force=true перезаливает всё, игнорируя отпечатки.
 */
export async function syncAll({ force = false, interactive = false } = {}) {
  if (!isConfigured()) return { skipped: 'off' };
  if (!originAllowed()) return { skipped: 'insecure' };
  if (gstatus.syncing) return { skipped: 'busy' };

  gstatus.syncing = true;
  commit('gcal:syncing');

  const result = { created: 0, updated: 0, deleted: 0, failed: 0 };
  try {
    await getToken({ interactive });
    const calendarId = await ensureCalendar();

    // 1. Удаления
    const stillPending = [];
    for (const d of state.pendingDeletes) {
      try {
        await api(`/calendars/${encodeURIComponent(d.calendarId)}/events/${encodeURIComponent(d.eventId)}`, { method: 'DELETE' });
        result.deleted++;
      } catch (err) {
        if (err.status === 404 || err.status === 410) result.deleted++;
        else { stillPending.push(d); result.failed++; }
      }
    }
    state.pendingDeletes = stillPending;

    // 2. Создание и обновление
    for (const task of syncable()) {
      const hash = taskHash(task);
      if (!force && task.gcal.eventId && task.gcal.hash === hash) continue;
      try {
        const what = await pushTask(task, calendarId);
        result[what === 'created' ? 'created' : 'updated']++;
      } catch (err) {
        task.gcal = { ...task.gcal, error: err.message };
        result.failed++;
        if (err.status === 401) throw err;
      }
    }

    gstatus.lastSync = Date.now();
    gstatus.lastError = result.failed ? `Не удалось выгрузить: ${result.failed}` : null;
  } catch (err) {
    gstatus.lastError = err.message;
    result.error = err.message;
  } finally {
    gstatus.syncing = false;
    commit('gcal:synced');
  }
  return result;
}

// ---------- Чтение календарей для раздела «Календари» ----------

/** События всех календарей на ближайшие `days` дней, отсортированные по началу. */
export async function listUpcomingEvents(days = 7) {
  const hidden = new Set(state.settings.hiddenCalendarIds || []);
  const cals = (await listCalendars())
    .filter((c) => c.selected !== false)
    .filter((c) => !hidden.has(c.id));
  const timeMin = new Date();
  timeMin.setHours(0, 0, 0, 0);
  const timeMax = new Date(timeMin.getTime() + days * 86400000);

  const batches = await Promise.all(cals.map(async (c) => {
    try {
      const data = await api(`/calendars/${encodeURIComponent(c.id)}/events`, {
        params: {
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 250,
        },
      });
      return (data.items || [])
        .filter((e) => e.status !== 'cancelled')
        .map((e) => ({ ...e, _cal: c.summary, _color: c.backgroundColor }));
    } catch {
      return [];
    }
  }));

  const startOf = (e) => (e.start.dateTime ? new Date(e.start.dateTime) : fromDateStr(e.start.date));
  return batches.flat().sort((a, b) => startOf(a) - startOf(b));
}

export const eventStart = (e) => (e.start.dateTime ? new Date(e.start.dateTime) : fromDateStr(e.start.date));
export const eventIsAllDay = (e) => !e.start.dateTime;
