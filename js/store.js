// Состояние приложения и его сохранение в localStorage.
// Бэкенда нет: всё живёт в браузере, перенос между устройствами — экспорт/импорт JSON.

import { uid } from './core.js';

const KEY = 'taskflow.state.v1';
const SCHEMA = 1;

export const DEFAULT_SETTINGS = {
  theme: 'auto',                 // auto | light | dark
  dayParts: { morning: '09:00', noon: '12:00', afternoon: '15:00', evening: '19:00' },
  notifications: false,          // локальные напоминания, пока вкладка открыта
  sortMode: 'auto',              // auto — по времени и приоритету; manual — ручной порядок (drag & drop)
  hideCompletedInLists: true,
  dismissedBanners: [],
};

export const state = {
  schema: SCHEMA,
  tasks: [],
  /**
   * Надгробия удалённых задач: [{ id, at }]. Нужны для синхронизации — без них
   * слияние с другого устройства вернуло бы удалённую задачу обратно.
   */
  deleted: [],
  /** Ревизия, полученная от сервера синхронизации. 0 — обмена ещё не было. */
  rev: 0,
  settings: { ...DEFAULT_SETTINGS },
};

/** Сколько храним надгробия. Дольше — незачем: все устройства давно догнали. */
export const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;

/** Отмечает задачу удалённой, чтобы синхронизация не воскресила её. */
export function tombstone(id, at = Date.now()) {
  const i = state.deleted.findIndex((d) => d.id === id);
  if (i >= 0) state.deleted[i].at = at;
  else state.deleted.push({ id, at });
}

/** Выбрасывает надгробия старше TTL. */
export function gcTombstones(now = Date.now()) {
  state.deleted = state.deleted.filter((d) => now - d.at < TOMBSTONE_TTL_MS);
}

const listeners = new Set();

/** Подписка на изменения состояния. Возвращает функцию отписки. */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(reason = 'change') {
  for (const fn of listeners) {
    try { fn(reason); } catch (err) { console.error('[store] listener failed', err); }
  }
}

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      schema: SCHEMA,
      tasks: state.tasks,
      deleted: state.deleted,
      rev: state.rev,
      settings: state.settings,
    }));
  } catch (err) {
    console.error('[store] сохранение не удалось', err);
  }
}

/** Сохранить и уведомить подписчиков. */
export function commit(reason = 'change') {
  save();
  emit(reason);
}

export function load() {
  let raw = null;
  try { raw = localStorage.getItem(KEY); } catch { /* приватный режим */ }
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    state.tasks = Array.isArray(parsed.tasks) ? parsed.tasks.map(normalizeTask) : [];
    state.deleted = Array.isArray(parsed.deleted) ? parsed.deleted.filter((d) => d && d.id) : [];
    state.rev = Number(parsed.rev) || 0;
    state.settings = {
      ...DEFAULT_SETTINGS,
      ...(parsed.settings || {}),
      dayParts: { ...DEFAULT_SETTINGS.dayParts, ...((parsed.settings || {}).dayParts || {}) },
    };
  } catch (err) {
    console.error('[store] состояние повреждено, начинаем с чистого', err);
  }
  gcTombstones();
}

/** Приводит задачу из хранилища к текущей форме — на случай старых записей. */
export function normalizeTask(t) {
  return {
    id: t.id || uid(),
    title: t.title || '',
    notes: t.notes || '',
    subtasks: Array.isArray(t.subtasks) ? t.subtasks.map((s) => ({
      id: s.id || uid(), title: s.title || '', done: !!s.done,
    })) : [],
    done: !!t.done,
    completedAt: t.completedAt || null,
    due: t.due || null,
    priority: [1, 2, 3, 4].includes(t.priority) ? t.priority : 4,
    repeat: t.repeat ? {
      freq: t.repeat.freq,                      // daily | weekly | monthly
      interval: Math.max(1, t.repeat.interval || 1),
      time: t.repeat.time || null,              // 'HH:mm' | null
      anchor: t.repeat.anchor || null,          // 'YYYY-MM-DD' — начало серии
    } : null,
    notifiedFor: t.notifiedFor || null,
    completions: Array.isArray(t.completions) ? t.completions : [],
    createdAt: t.createdAt || Date.now(),
    updatedAt: t.updatedAt || Date.now(),
    order: typeof t.order === 'number' ? t.order : Date.now(),
  };
}

export function setSetting(key, value) {
  state.settings[key] = value;
  commit('settings');
}

export function patchSettings(patch) {
  Object.assign(state.settings, patch);
  commit('settings');
}

// ---------- Экспорт / импорт ----------

export function exportJson() {
  return JSON.stringify({
    app: 'taskflow',
    schema: SCHEMA,
    exportedAt: new Date().toISOString(),
    tasks: state.tasks,
    settings: { ...state.settings },
  }, null, 2);
}

/**
 * Импорт из JSON-выгрузки.
 * mode 'merge'  — добавить недостающие и обновить более свежие (по updatedAt);
 * mode 'replace' — полностью заменить список задач.
 * Возвращает {added, updated, total}.
 */
export function importJson(text, mode = 'merge') {
  const parsed = JSON.parse(text);
  const incoming = (Array.isArray(parsed) ? parsed : parsed.tasks) || [];
  if (!Array.isArray(incoming)) throw new Error('В файле нет списка задач');

  const clean = incoming.map(normalizeTask);
  let added = 0, updated = 0;

  if (mode === 'replace') {
    // Старые задачи именно удаляются, а не «теряются»: без надгробий
    // синхронизация вернула бы их с другого устройства.
    const at = Date.now();
    const keep = new Set(clean.map((t) => t.id));
    for (const t of state.tasks) if (!keep.has(t.id)) tombstone(t.id, at);
    state.tasks = clean;
    added = clean.length;
  } else {
    const byId = new Map(state.tasks.map((t) => [t.id, t]));
    for (const t of clean) {
      const cur = byId.get(t.id);
      if (!cur) { state.tasks.push(t); byId.set(t.id, t); added++; }
      else if ((t.updatedAt || 0) > (cur.updatedAt || 0)) { Object.assign(cur, t); updated++; }
    }
  }

  if (parsed.settings && mode === 'replace') {
    state.settings = {
      ...DEFAULT_SETTINGS,
      ...parsed.settings,
      dayParts: { ...DEFAULT_SETTINGS.dayParts, ...(parsed.settings.dayParts || {}) },
    };
  }

  commit('import');
  return { added, updated, total: state.tasks.length };
}

export function wipeAll() {
  const at = Date.now();
  for (const t of state.tasks) tombstone(t.id, at);
  state.tasks = [];
  commit('wipe');
}
