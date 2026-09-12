// Точка входа: загрузка состояния, маршрутизация по разделам, горячие клавиши,
// напоминания и синхронизация между устройствами.

import { oneLine } from './core.js';
import { $, debounce } from './dom.js';
import { state, load, subscribe } from './store.js';
import * as M from './model.js';
import * as S from './sync.js';
import { ctx, render, applyTheme, openEditor, openSettings, openComposer, toggleSortMode, syncDevicesNow } from './ui.js';
import { openMoments } from './moments.js';

const VALID_VIEWS = Object.keys(M.VIEWS);

function viewFromHash() {
  const id = location.hash.replace(/^#\/?/, '');
  return VALID_VIEWS.includes(id) ? id : 'today';
}

// Какой раздел уже нарисован. Смена хеша приходит отдельным событием, позже
// самой смены ctx.view, — а список к тому моменту могли отрисовать вручную
// (так делает «+», чтобы навести фокус тем же жестом). Повторная отрисовка
// пересобрала бы DOM и сбросила фокус: на iPhone клавиатура поднималась и
// сразу опускалась.
let renderedView = null;

function renderView() { renderedView = ctx.view; render(); }

ctx.setView = (id) => {
  if (!VALID_VIEWS.includes(id)) return;
  ctx.view = id;
  if (location.hash !== `#/${id}`) location.hash = `#/${id}`;
  else renderView();
};

ctx.refresh = () => renderView();

// ---------- Напоминания ----------

function tickReminders() {
  if (!state.settings.notifications) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  for (const task of M.dueReminders()) {
    try {
      const n = new Notification(oneLine(task.title) || 'Задача', {
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

  if (e.key === 'n') { e.preventDefault(); openComposer(); }
  else if (e.key === 'm') { e.preventDefault(); openMoments(); }
  else if (e.key === ',') { e.preventDefault(); openSettings(); }
  else if (e.key === '1') ctx.setView('today');
  else if (e.key === '2') ctx.setView('tomorrow');
  else if (e.key === '3') ctx.setView('upcoming');
  else if (e.key === '4') ctx.setView('all');
  else if (e.key === '5') ctx.setView('inbox');
  else if (e.key === '6') ctx.setView('done');
  else if (e.key === 's') { e.preventDefault(); toggleSortMode(); }
}

// ---------- Старт ----------

function init() {
  load();
  applyTheme();

  ctx.view = viewFromHash();
  if (!location.hash) location.hash = `#/${ctx.view}`;

  window.addEventListener('hashchange', () => {
    ctx.view = viewFromHash();
    if (renderedView !== ctx.view) renderView();
  });

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
  // Окно открывается поверх любого раздела, включая «Выполнено», — переключать
  // ничего не нужно. Фокус ставится внутри openComposer синхронно, в этом же
  // жесте: иначе iOS не поднимет клавиатуру.
  $('#btn-fab').addEventListener('click', openComposer);

  document.addEventListener('keydown', onKeydown);

  renderView();

  // Ищем сервер синхронизации и сразу подтягиваем общий список.
  S.probe().then((ok) => {
    if (ok && S.isConfigured()) S.syncNow();
    render();
  });

  // Связь появилась — догоняем накопленные правки.
  window.addEventListener('online', () => S.syncNow());

  // Пересинхронизация при возврате на вкладку.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    tickDayChange();
    render();
    // Вкладку могли не трогать час — на другом устройстве список уже уехал вперёд.
    S.syncNow();
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
