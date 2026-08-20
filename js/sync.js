// Синхронизация задач с собственным сервером (см. sync.mjs и serve.mjs).
// Локальное хранилище остаётся первичным: приложение работает офлайн, а обмен
// с сервером — это слияние, а не загрузка «сверху вниз».

import { state, commit, normalizeTask, gcTombstones } from './store.js';

// Токен лежит отдельно от settings: настройки синхронизируются, а токен —
// это ключ доступа конкретного устройства, и его синхронизировать нельзя.
const TOKEN_KEY = 'taskflow.sync.token';

/** Наблюдаемое состояние обмена — его рисует индикатор в шапке. */
export const syncState = {
  available: null,   // есть ли вообще сервер синхронизации: null — ещё не проверяли
  syncing: false,
  lastSync: 0,
  lastError: null,
};

const listeners = new Set();
export function onSyncChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const notify = () => { for (const fn of listeners) { try { fn(syncState); } catch { /* не мешаем обмену */ } } };

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token.trim());
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* приватный режим */ }
  notify();
}

export const isConfigured = () => !!getToken();

/**
 * Пока идёт применение ответа сервера, локальные commit'ы не должны
 * планировать новый обмен — иначе получится бесконечный цикл.
 */
let applying = false;

/** Счётчик правок: если во время запроса что-то поменялось, повторяем обмен. */
let revisionCounter = 0;
export const markDirty = () => { if (!applying) revisionCounter++; };

async function call(path, { method = 'GET', body = null, token = getToken() } = {}) {
  const res = await fetch(`api${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* сервер ответил не JSON */ }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

/** Есть ли на этом адресе сервер синхронизации (а не только статика). */
export async function probe() {
  try {
    const res = await call('/ping');
    syncState.available = res?.app === 'taskflow';
  } catch {
    syncState.available = false;
  }
  notify();
  return syncState.available;
}

/** Проверяет токен, не меняя данных. */
export async function checkToken(token) {
  await call('/state', { token });
  return true;
}

/** Заменяет локальное состояние результатом слияния. */
function applyMerged(data) {
  applying = true;
  try {
    state.tasks = (data.tasks || []).map(normalizeTask);
    state.deleted = (data.deleted || []).filter((d) => d && d.id);
    state.rev = data.rev || 0;
    gcTombstones();
    commit('sync:applied');
  } finally {
    applying = false;
  }
}

/**
 * Один обмен: отправляем всё локальное состояние, получаем слитое и применяем.
 * Отправлять целиком — сознательное решение: личный список задач весит десятки
 * килобайт, а дельта-протокол принёс бы отдельный класс ошибок рассинхрона.
 */
export async function syncNow({ silent = true } = {}) {
  if (!isConfigured()) return { skipped: 'no-token' };
  if (syncState.syncing) return { skipped: 'busy' };
  if (!navigator.onLine) {
    syncState.lastError = 'Нет сети';
    notify();
    return { skipped: 'offline' };
  }

  syncState.syncing = true;
  syncState.lastError = null;
  notify();

  const startedAt = revisionCounter;
  try {
    const data = await call('/sync', {
      method: 'POST',
      body: { tasks: state.tasks, deleted: state.deleted },
    });
    applyMerged(data);
    syncState.available = true;
    syncState.lastSync = Date.now();
    syncState.lastError = null;

    // Пока запрос был в пути, пользователь мог что-то поправить —
    // догоняем ещё одним обменом, иначе правка уедет только в следующий раз.
    if (revisionCounter !== startedAt) queuePush(300);
    return { ok: true, rev: data.rev };
  } catch (err) {
    syncState.lastError = String(err.message || err);
    if (!silent) throw err;
    return { error: syncState.lastError };
  } finally {
    syncState.syncing = false;
    notify();
  }
}

let pushTimer = null;
/** Откладывает обмен: серия правок подряд должна дать один запрос, а не десять. */
export function queuePush(delay = 1200) {
  if (!isConfigured()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { syncNow(); }, delay);
}

/** Отмечает локальную правку и планирует отправку (сохранение делает commit). */
export function localChange() {
  if (applying) return;
  markDirty();
  queuePush();
}
