// Точка входа: загрузка состояния, маршрутизация по разделам, горячие клавиши,
// напоминания и восстановление сессии Google.

import { $, debounce } from './util.js';
import { state, load, subscribe } from './store.js';
import * as M from './model.js';
import * as G from './gcal.js';
import * as S from './sync.js';
import { ctx, render, applyTheme, openEditor, openSettings, focusComposer, toast, scheduleSync, toggleSortMode, syncDevicesNow } from './ui.js';
import { openMoments } from './moments.js';

const VALID_VIEWS = Object.keys(M.VIEWS);

function viewFromHash() {
  const id = location.hash.replace(/^#\/?/, '');
  return VALID_VIEWS.includes(id) ? id : 'today';
}

ctx.setView = (id) => {
  if (!VALID_VIEWS.includes(id)) return;
  ctx.view = id;
  if (location.hash !== `#/${id}`) location.hash = `#/${id}`;
  else render();
};

ctx.refresh = () => render();

// ---------- Напоминания ----------

function tickReminders() {
  if (!state.settings.notifications) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  for (const task of M.dueReminders()) {
    try {
      const n = new Notification(task.title || 'Задача', {
        body: [M.PRIORITIES[task.priority].code, task.notes?.slice(0, 80)].filter(Boolean).join(' · '),
        tag: 'taskflow-' + task.id,
        icon: 'icons/apple-touch-icon.png',
      });
      n.onclick = () => { window.focus(); openEditor(task.id); };
    } catch { /* некоторые браузеры требуют service worker */ }
    M.markNotified(task.id);
  }
}

// ---------- Смена суток ----------

let lastDay = new Date().toDateString();
function tickDayChange() {
  const now = new Date().toDateString();
  if (now !== lastDay) { lastDay = now; render(); }
}

// ---------- Горячие клавиши ----------

function onKeydown(e) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === 'n') { e.preventDefault(); if (!focusComposer()) { ctx.setView('today'); setTimeout(focusComposer, 60); } }
  else if (e.key === 'm') { e.preventDefault(); openMoments(); }
  else if (e.key === ',') { e.preventDefault(); openSettings(); }
  else if (e.key === '1') ctx.setView('today');
  else if (e.key === '2') ctx.setView('tomorrow');
  else if (e.key === '3') ctx.setView('upcoming');
  else if (e.key === '4') ctx.setView('all');
  else if (e.key === '5') ctx.setView('calendar');
  else if (e.key === 's') { e.preventDefault(); toggleSortMode(); }
}

// ---------- Старт ----------

function init() {
  load();
  applyTheme();

  ctx.view = viewFromHash();
  if (!location.hash) location.hash = `#/${ctx.view}`;

  window.addEventListener('hashchange', () => { ctx.view = viewFromHash(); render(); });

  // Перерисовка на изменения состояния — с небольшим сглаживанием,
  // чтобы серия правок не дёргала список.
  const rerender = debounce(() => render(), 60);
  subscribe((reason) => {
    rerender();
    // Применение ответа сервера — не повод слать его же обратно.
    if (reason !== 'sync:applied') S.localChange();
  });
  S.onSyncChange(() => rerender());

  $('#btn-moments').addEventListener('click', openMoments);
  $('#btn-moments-side').addEventListener('click', openMoments);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-sort').addEventListener('click', toggleSortMode);
  $('#btn-cloud').addEventListener('click', syncDevicesNow);
  $('#btn-fab').addEventListener('click', () => {
    if (ctx.view === 'calendar' || ctx.view === 'done') ctx.setView('today');
    setTimeout(() => { if (!focusComposer()) return; }, 60);
  });

  $('#btn-sync').addEventListener('click', async () => {
    if (!G.isConfigured()) { openSettings(); return; }
    const res = await G.syncAll({ interactive: true, force: false });
    if (res?.error) toast(res.error, { error: true });
    else if (res?.skipped === 'insecure') toast('Google требует HTTPS', { error: true });
    else if (res) toast(`Создано: ${res.created}, обновлено: ${res.updated}, удалено: ${res.deleted}`);
  });

  document.addEventListener('keydown', onKeydown);

  render();

  // Ищем сервер синхронизации и сразу подтягиваем общий список.
  S.probe().then((ok) => {
    if (ok && S.isConfigured()) S.syncNow();
    render();
  });

  // Связь появилась — догоняем накопленные правки.
  window.addEventListener('online', () => S.syncNow());

  // Тихо восстанавливаем доступ Google и подчищаем очередь выгрузки.
  G.restoreSession().then((ok) => {
    render();
    if (ok) scheduleSync();
  });

  // Пересинхронизация при возврате на вкладку.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    tickDayChange();
    render();
    // Вкладку могли не трогать час — на другом устройстве список уже уехал вперёд.
    S.syncNow();
    if (G.isConfigured() && state.settings.gcalAutoSync) scheduleSync();
  });

  setInterval(tickReminders, 30_000);
  setInterval(tickDayChange, 60_000);
  // Фоновый обмен: ловит правки, сделанные на другом устройстве.
  setInterval(() => { if (document.visibilityState === 'visible') S.syncNow(); }, 60_000);
  setTimeout(tickReminders, 3_000);

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* офлайн-режим просто не включится */ });
  }
}

init();
