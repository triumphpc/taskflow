// Отрисовка интерфейса: навигация, списки, редактор задачи, настройки, календарь.

import { $, h, clear, append, todayStr, addDaysStr, fmtDue, fmtDayLabel, fmtTime, datePart, timePart,
  combineDue, plural, debounce } from './util.js';
import { state, patchSettings, setSetting, exportJson, importJson, wipeAll } from './store.js';
import * as S from './sync.js';
import * as M from './model.js';
import * as G from './gcal.js';

/** Заполняется из app.js: {view, setView, refresh}. */
export const ctx = { view: 'today', setView: () => {}, refresh: () => {} };

// ---------- Тосты ----------

export function toast(message, { action, actionLabel, error = false, ms = 4000 } = {}) {
  const root = $('#toast-root');
  const el = h('div', { class: `toast${error ? ' err' : ''}` }, message);
  if (action && actionLabel) {
    el.append(h('button', { onclick: () => { el.remove(); action(); } }, actionLabel));
  }
  root.append(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

// ---------- Модальные шторки ----------

let openSheets = 0;

export function openSheet({ title, bodyNodes, footNodes, onClose, wide = false }) {
  const overlay = h('div', { class: 'overlay' });
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '' });

  const close = () => {
    overlay.remove();
    openSheets--;
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape' && openSheets) { e.stopPropagation(); close(); } };

  const head = h('div', { class: 'sheet-head' },
    h('h2', null, title || ''),
    h('span', { class: 'spacer' }),
    h('button', { class: 'icon-btn', 'aria-label': 'Закрыть', onclick: close }, '✕'));

  const body = h('div', { class: 'sheet-body' });
  if (bodyNodes) body.append(...[bodyNodes].flat().filter(Boolean));

  sheet.append(head, body);
  if (footNodes) sheet.append(h('div', { class: 'sheet-foot' }, ...[footNodes].flat().filter(Boolean)));
  if (wide) sheet.style.width = 'min(760px, 100%)';

  overlay.append(sheet);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  $('#modal-root').append(overlay);
  openSheets++;
  document.addEventListener('keydown', onKey);

  return { overlay, sheet, body, close };
}

export function confirmSheet({ title, text, okLabel = 'Да', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const done = (v) => { answered = true; ui.close(); resolve(v); };
    const ui = openSheet({
      title,
      bodyNodes: h('p', { class: 'muted', style: { fontSize: '14px', lineHeight: '1.5' } }, text),
      footNodes: [
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-ghost', onclick: () => done(false) }, 'Отмена'),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => done(true) }, okLabel),
      ],
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

// ---------- Навигация ----------

const NAV_ITEMS = ['today', 'tomorrow', 'upcoming', 'someday', 'all', 'calendar', 'done'];
const NAV_MOBILE = ['today', 'upcoming', 'all', 'calendar', 'done'];

function navButton(id, counts) {
  const v = M.VIEWS[id];
  const n = counts[id];
  return h('button', {
    class: 'nav-item',
    'aria-current': ctx.view === id ? 'page' : null,
    onclick: () => ctx.setView(id),
  },
    h('span', { class: 'ico', 'aria-hidden': 'true' }, v.icon),
    h('span', { class: 'lbl' }, v.title),
    n ? h('span', { class: 'count' }, String(n)) : null);
}

function renderNav() {
  const counts = M.counts();
  const desktop = $('#nav-desktop');
  clear(desktop);
  desktop.append(...NAV_ITEMS.map((id) => navButton(id, counts)));

  const mobile = $('#nav-mobile');
  clear(mobile);
  mobile.append(...NAV_MOBILE.map((id) => navButton(id, counts)));
}

// ---------- Заголовок и подзаголовок ----------

function subtitleFor(view) {
  const c = M.counts();
  if (view === 'today') {
    const d = new Date();
    const label = fmtDayLabel(todayStr()).toLowerCase();
    const date = `${d.getDate()} ${['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'][d.getMonth()]}`;
    return c.today
      ? `${date} · ${c.today} ${plural(c.today, 'задача', 'задачи', 'задач')}`
      : `${date} · ${label === 'сегодня' ? 'на сегодня пусто' : ''}`.trim();
  }
  if (view === 'tomorrow') return c.tomorrow ? `${c.tomorrow} ${plural(c.tomorrow, 'задача', 'задачи', 'задач')}` : 'Пока ничего не запланировано';
  if (view === 'upcoming') return c.upcoming ? `${c.upcoming} ${plural(c.upcoming, 'задача', 'задачи', 'задач')} с датой` : 'Нет задач с датой';
  if (view === 'someday') return 'Задачи без даты — их подхватит Moments';
  if (view === 'all') return `${c.all} активных · ${c.done} выполнено`;
  if (view === 'done') return c.done ? `${c.done} ${plural(c.done, 'задача', 'задачи', 'задач')}` : 'Пока пусто';
  if (view === 'calendar') return 'Google Calendar';
  return '';
}

// ---------- Строка задачи ----------

function taskRow(task) {
  const dueStr = task.due ? fmtDue(task.due) : '';
  const overdue = !task.done && M.isOverdue(task.due);
  const isToday = !task.done && task.due && datePart(task.due) === todayStr() && !overdue;
  const subDone = task.subtasks.filter((s) => s.done).length;

  const meta = [];
  if (dueStr) {
    meta.push(h('span', { class: `due${overdue ? ' is-overdue' : isToday ? ' is-today' : ''}` },
      (overdue ? '⚠ ' : '') + dueStr));
  }
  if (task.repeat) meta.push(h('span', { class: 'rep' }, '↻ ' + M.repeatLabel(task.repeat)));
  if (task.subtasks.length) meta.push(h('span', null, `☑ ${subDone}/${task.subtasks.length}`));
  if (task.notes) meta.push(h('span', { title: task.notes }, '✎'));
  if (task.priority <= 3) meta.unshift(h('span', { class: 'chip-p' }, M.PRIORITIES[task.priority].code));
  if (task.gcal?.error) meta.push(h('span', { class: 'syncerr', title: task.gcal.error }, '⚠ Google'));
  else if (task.gcal?.eventId) meta.push(h('span', { class: 'synced', title: 'В Google Calendar' }, '◉'));

  return h('li', {
    class: `task${task.done ? ' done' : ''}`,
    dataset: { id: task.id, p: String(task.priority) },
  },
    h('button', {
      class: 'check',
      'aria-label': task.done ? 'Вернуть в работу' : 'Отметить выполненной',
      onclick: (e) => { e.stopPropagation(); handleToggle(task.id); },
    }),
    h('div', { class: 'task-body' },
      h('div', { class: 'task-title' }, task.title || 'Без названия'),
      meta.length ? h('div', { class: 'task-meta' }, ...meta) : null),
    h('button', { class: 'task-open', 'aria-label': `Открыть: ${task.title}`, onclick: () => openEditor(task.id) }, 'открыть'),
    dragHandle(task));
}

function handleToggle(id) {
  const res = M.toggleDone(id);
  if (res?.kind === 'rescheduled') {
    toast(`Повтор: перенесено на ${fmtDue(res.nextDue).toLowerCase()}`);
  }
  scheduleSync();
}

// ---------- Перетаскивание задач ----------

/**
 * Своя реализация вместо HTML5 drag-and-drop: на тач-экранах он не работает,
 * а приложение ставится как PWA. Тянем на Pointer Events, оригинальная строка
 * остаётся в потоке как метка места вставки, за пальцем/курсором летит копия.
 */

let drag = null;            // активная сессия перетаскивания
let focusHandle = null;     // задача, чью ручку вернуть в фокус после перерисовки

const DRAG_START_PX = 5;    // порог, после которого считаем это перетаскиванием
const EDGE_PX = 70;         // зона автопрокрутки у краёв списка
const EDGE_SPEED = 14;      // максимальная скорость автопрокрутки, px/кадр

const listIds = (list) => Array.from(list.children).map((el) => el.dataset.id).filter(Boolean);

function dragHandle(task) {
  const btn = h('button', {
    class: 'drag-handle',
    'aria-label': `Переместить: ${task.title || 'без названия'}`,
    title: 'Тяните, чтобы изменить порядок или дату (↑/↓ с клавиатуры)',
  }, '⠿');
  btn.addEventListener('pointerdown', (e) => onHandleDown(e, btn));
  btn.addEventListener('keydown', (e) => onHandleKey(e, btn));
  return btn;
}

function onHandleDown(e, handle) {
  if (drag || (e.button ?? 0) > 0) return;
  const li = handle.closest('li.task');
  const list = li?.parentElement;
  if (!li || !list || list.dataset.noDrag) return;

  // Слушаем окно, а не саму ручку: pointer capture в Chromium слетает,
  // как только захвативший элемент перестаёт отрисовываться.
  e.preventDefault();
  const start = { x: e.clientX, y: e.clientY, id: e.pointerId };
  let started = false;

  const move = (ev) => {
    if (ev.pointerId !== start.id) return;
    if (!started) {
      if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < DRAG_START_PX) return;
      started = true;
      beginDrag(li, ev);
    }
    ev.preventDefault();
    moveDrag(ev);
  };
  const stop = (commitDrop) => (ev) => {
    if (ev.pointerId !== start.id) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    if (started) endDrag(commitDrop);
  };
  const up = stop(true);
  const cancel = stop(false);

  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}

function beginDrag(li, ev) {
  const rect = li.getBoundingClientRect();
  const ghost = li.cloneNode(true);
  ghost.classList.add('drag-ghost');
  Object.assign(ghost.style, { width: `${rect.width}px`, left: `${rect.left}px`, top: `${rect.top}px` });
  document.body.append(ghost);

  li.classList.add('drag-src');
  document.body.classList.add('is-dragging');

  drag = {
    li, ghost,
    fromList: li.parentElement,
    startNext: li.nextElementSibling,
    dx: ev.clientX - rect.left,
    dy: ev.clientY - rect.top,
    x: ev.clientX, y: ev.clientY,
    scrollBy: 0,
  };
  requestAnimationFrame(scrollTick);
}

function moveDrag(ev) {
  if (!drag) return;
  drag.x = ev.clientX;
  drag.y = ev.clientY;
  drag.ghost.style.left = `${ev.clientX - drag.dx}px`;
  drag.ghost.style.top = `${ev.clientY - drag.dy}px`;

  const box = $('#content').getBoundingClientRect();
  const over = box.top + EDGE_PX - ev.clientY;
  const under = ev.clientY - (box.bottom - EDGE_PX);
  drag.scrollBy = over > 0 ? -Math.min(EDGE_SPEED, over / 4)
    : under > 0 ? Math.min(EDGE_SPEED, under / 4) : 0;

  placeGhost(ev.clientX, ev.clientY);
}

/** Автопрокрутка у краёв: держим палец у границы — список едет сам. */
function scrollTick() {
  if (!drag) return;
  if (drag.scrollBy) {
    const box = $('#content');
    const before = box.scrollTop;
    box.scrollTop += drag.scrollBy;
    if (box.scrollTop !== before) placeGhost(drag.x, drag.y);
  }
  requestAnimationFrame(scrollTick);
}

/** Куда встанет задача: ищем строку под курсором и вставляем метку до/после неё. */
function placeGhost(x, y) {
  const under = document.elementFromPoint(x, y);
  if (!under?.closest) return;
  const row = under.closest('li.task');
  const list = row?.parentElement || under.closest('ul.task-list');
  if (!list || !list.classList.contains('task-list')) return;
  if (list.dataset.noDrag) return;
  if (list !== drag.fromList && list.dataset.drop === 'none') return;

  if (!row) { list.append(drag.li); return; }
  if (row === drag.li) return;
  const r = row.getBoundingClientRect();
  list.insertBefore(drag.li, y < r.top + r.height / 2 ? row : row.nextSibling);
}

function endDrag(commitDrop) {
  const d = drag;
  drag = null;
  d.ghost.remove();
  d.li.classList.remove('drag-src');
  document.body.classList.remove('is-dragging');

  const toList = d.li.parentElement;
  const moved = toList !== d.fromList || d.li.nextElementSibling !== d.startNext;
  if (!commitDrop || !moved) { render(); return; }

  applyDrop(d.li.dataset.id, d.fromList, toList);
}

/** Переносит изменения из DOM в модель: сначала дата, затем ручной порядок. */
function applyDrop(taskId, fromList, toList) {
  const lists = toList === fromList ? [listIds(toList)] : [listIds(toList), listIds(fromList)];
  let rescheduled = false;

  if (toList !== fromList) {
    const drop = toList.dataset.drop;
    const dropDue = drop === 'clear' ? null : drop;
    if (M.moveToGroupDate(taskId, dropDue)) {
      rescheduled = true;
      toast(dropDue === null ? 'Дата снята' : `Перенесено: ${fmtDayLabel(dropDue).toLowerCase()}`);
    }
  }

  // Смена даты сама по себе не должна отключать автоматическую сортировку —
  // ручной порядок включаем только когда пользователь именно переставляет задачи.
  if (!rescheduled || M.isManualSort()) {
    const wasAuto = !M.isManualSort();
    M.applyManualOrder(lists);
    if (wasAuto) {
      toast('Порядок задач теперь ручной', {
        actionLabel: 'Вернуть авто',
        action: () => { M.toggleSortMode(); render(); },
      });
    }
  }

  focusHandle = taskId;
  scheduleSync();
  render();
}

/** Клавиатурная альтернатива: ↑/↓ на ручке двигают задачу внутри группы. */
function onHandleKey(e, handle) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  const li = handle.closest('li.task');
  const list = li?.parentElement;
  if (!list || list.dataset.noDrag) return;
  const up = e.key === 'ArrowUp';
  const sib = up ? li.previousElementSibling : li.nextElementSibling;
  if (!sib) return;

  e.preventDefault();
  list.insertBefore(li, up ? sib : sib.nextSibling);
  focusHandle = li.dataset.id;
  M.applyManualOrder([listIds(list)]);
  render();
}

/** Возвращает фокус на ручку после перерисовки — иначе ↑/↓ подряд не нажать. */
function restoreHandleFocus() {
  if (!focusHandle) return;
  const btn = $(`#content .task[data-id="${CSS.escape(focusHandle)}"] .drag-handle`);
  btn?.focus({ preventScroll: true });
  clearTimeout(restoreHandleFocus.timer);
  restoreHandleFocus.timer = setTimeout(() => { focusHandle = null; }, 400);
}

// ---------- Поле быстрого добавления ----------

/** Разбирает «Купить молоко завтра 18:30 !1» -> {title, due, priority}. */
export function parseQuickInput(raw, defaultDate) {
  let text = ' ' + raw.trim() + ' ';
  let date = defaultDate ?? null;
  let time = null;
  let priority = 4;

  const take = (re, fn) => {
    const m = text.match(re);
    if (m) { fn(m); text = text.replace(m[0], ' '); return true; }
    return false;
  };

  take(/\s![1-4]\s/, (m) => { priority = Number(m[0].trim().slice(1)); });
  take(/\s(\d{1,2}):(\d{2})\s/, (m) => {
    const hh = Number(m[1]), mm = Number(m[2]);
    if (hh < 24 && mm < 60) time = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  });
  const today = todayStr();
  if (!take(/\sсегодня\s/i, () => { date = today; })) {
    if (!take(/\sзавтра\s/i, () => { date = addDaysStr(today, 1); })) {
      take(/\sпослезавтра\s/i, () => { date = addDaysStr(today, 2); });
    }
  }
  if (time && !date) date = today;

  return { title: text.trim().replace(/\s{2,}/g, ' '), due: combineDue(date, time), priority };
}

function defaultDateForView(view) {
  if (view === 'today') return todayStr();
  if (view === 'tomorrow') return addDaysStr(todayStr(), 1);
  return null;
}

function composer() {
  const input = h('input', {
    type: 'text',
    placeholder: 'Новая задача…  («завтра 18:30 !1» тоже понимается)',
    'aria-label': 'Новая задача',
    autocomplete: 'off',
  });

  const submit = () => {
    const value = input.value.trim();
    if (!value) return;
    const parsed = parseQuickInput(value, defaultDateForView(ctx.view));
    if (!parsed.title) return;
    const task = M.createTask(parsed);
    input.value = '';
    scheduleSync();
    toast('Задача добавлена', { actionLabel: 'Открыть', action: () => openEditor(task.id) });
  };

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });

  return h('div', { class: 'composer' },
    h('button', { class: 'plus', 'aria-label': 'Добавить', onclick: submit }, '+'),
    input,
    h('span', { class: 'composer-hint' }, 'Enter — добавить'));
}

export function focusComposer() {
  const input = $('.composer input');
  if (input) { input.focus(); return true; }
  return false;
}

// ---------- Разделы со списками ----------

function emptyState(view) {
  const texts = {
    today: ['☀︎', 'На сегодня всё чисто', 'Добавьте задачу выше или запустите Moments — он разложит по времени всё, что висит.'],
    tomorrow: ['→', 'На завтра пусто', 'Хорошая возможность заранее разгрузить сегодня.'],
    upcoming: ['▤', 'Впереди свободно', 'Задачи с датой появятся здесь, сгруппированные по дням.'],
    someday: ['◇', 'Нет задач без даты', 'Сюда попадает всё, чему вы ещё не назначили день.'],
    all: ['≡', 'Задач нет', 'Начните с первой — поле ввода сверху.'],
    done: ['✓', 'Выполненного пока нет', 'Отмечайте задачи — они соберутся здесь.'],
  };
  const [icon, title, hint] = texts[view] || ['◇', 'Пусто', ''];
  return h('div', { class: 'empty' },
    h('div', { class: 'big' }, icon),
    h('p', { style: { fontWeight: '600', color: 'var(--text-dim)', marginBottom: '4px' } }, title),
    h('p', null, hint));
}

function renderListView(root, view) {
  if (view !== 'done') root.append(composer());

  const groups = M.groupsForView(view);
  const total = groups.reduce((n, g) => n + g.tasks.length, 0);

  if (!total) { root.append(emptyState(view)); return; }

  for (const g of groups) {
    if (!g.tasks.length) continue;
    const title = g.isDay ? fmtDayLabel(g.title) : g.title;
    // drop: куда «переедет» задача, если её бросить в эту группу из другой.
    // 'none' — только перестановка внутри, 'clear' — снять дату, иначе дата дня.
    const drop = !('dropDue' in g) ? 'none' : g.dropDue === null ? 'clear' : g.dropDue;
    root.append(h('section', { class: 'group' },
      h('div', { class: `group-head${g.tone === 'overdue' ? ' overdue' : ''}` },
        h('span', null, title),
        h('span', { class: 'n' }, String(g.tasks.length))),
      h('ul', {
        class: 'task-list',
        dataset: { group: g.key, drop, ...(g.noDrag ? { noDrag: '1' } : {}) },
      }, ...g.tasks.map(taskRow))));
  }

  if (view === 'done' && total) {
    root.append(h('div', { style: { marginTop: '4px' } },
      h('button', {
        class: 'btn btn-danger',
        onclick: async () => {
          const snapshot = state.tasks.filter((t) => t.done).map((t) => ({ ...t }));
          const ok = await confirmSheet({
            title: 'Очистить выполненные',
            text: `Будет удалено ${snapshot.length} ${plural(snapshot.length, 'задача', 'задачи', 'задач')}. Связанные события в Google Calendar тоже удалятся.`,
            okLabel: 'Очистить', danger: true,
          });
          if (!ok) return;
          const n = M.clearCompleted();
          scheduleSync();
          toast(`Удалено: ${n}`, {
            actionLabel: 'Вернуть',
            action: () => { snapshot.forEach((t) => M.createTask({ ...t, gcal: { eventId: null, calendarId: null, hash: null, error: null } })); },
          });
        },
      }, 'Очистить выполненные')));
  }
}

// ---------- Автосинхронизация ----------

const runSync = debounce(async () => {
  if (!G.isConfigured() || !state.settings.gcalAutoSync) return;
  if (!G.gstatus.connected && !G.wasGrantedBefore()) return;
  const res = await G.syncAll({ interactive: false });
  if (res?.error) console.warn('[gcal]', res.error);
}, 2500);

export function scheduleSync() { runSync(); }

// ---------- Редактор задачи ----------

export function openEditor(taskId) {
  const task = M.getTask(taskId);
  if (!task) return;

  const apply = (patch) => { M.updateTask(task.id, patch); ctx.refresh(); scheduleSync(); };
  const applyQuiet = debounce((patch) => apply(patch), 400);

  // --- Заголовок и заметки
  const titleInput = h('input', { class: 'input input-title', value: task.title, placeholder: 'Название задачи', 'aria-label': 'Название' });
  titleInput.addEventListener('input', () => applyQuiet({ title: titleInput.value }));

  const notesInput = h('textarea', { class: 'textarea', placeholder: 'Заметки…', 'aria-label': 'Заметки' });
  notesInput.value = task.notes;
  notesInput.addEventListener('input', () => applyQuiet({ notes: notesInput.value }));

  // --- Приоритет
  const prioWrap = h('div', { class: 'prio-grid' });
  const renderPrio = () => {
    clear(prioWrap);
    for (const p of Object.values(M.PRIORITIES)) {
      prioWrap.append(h('button', {
        class: 'prio-btn',
        style: { '--c': `var(${p.varName})` },
        'aria-pressed': task.priority === p.id ? 'true' : 'false',
        onclick: () => { apply({ priority: p.id }); renderPrio(); },
      },
        h('span', { class: 'dot' }),
        h('div', null,
          h('div', { class: 'lbl' }, `${p.code} · ${p.name}`),
          h('div', { class: 'sub' }, p.hint))));
    }
  };
  renderPrio();

  // --- Дата и время
  const dateInput = h('input', { class: 'input', type: 'date', value: datePart(task.due) || '' });
  const timeInput = h('input', { class: 'input', type: 'time', value: timePart(task.due) || '' });
  const quickWrap = h('div', { class: 'chips', style: { marginBottom: '8px' } });

  const syncDateInputs = () => {
    dateInput.value = datePart(task.due) || '';
    timeInput.value = timePart(task.due) || '';
    renderRepeat();
  };
  const setDue = (date, time) => { apply({ due: combineDue(date, time) }); syncDateInputs(); };

  const quick = [
    ['Сегодня', () => M.QUICK_DATES.today()],
    ['Завтра', () => M.QUICK_DATES.tomorrow()],
    ['Через 2 дня', () => M.QUICK_DATES.in2days()],
    ['Следующая неделя', () => M.QUICK_DATES.nextWeek()],
  ];
  for (const [label, fn] of quick) {
    quickWrap.append(h('button', { class: 'chip', onclick: () => setDue(fn(), timePart(task.due)) }, label));
  }
  quickWrap.append(h('button', {
    class: 'chip chip-clear',
    onclick: () => { apply({ due: null, repeat: null }); syncDateInputs(); },
  }, '✕ Убрать дату'));

  dateInput.addEventListener('change', () => setDue(dateInput.value || null, timeInput.value || null));
  timeInput.addEventListener('change', () => {
    const date = dateInput.value || todayStr();
    setDue(date, timeInput.value || null);
  });

  // --- Повтор
  const repeatWrap = h('div');
  function renderRepeat() {
    clear(repeatWrap);
    const freqSelect = h('select', { class: 'select', 'aria-label': 'Повтор' },
      h('option', { value: '' }, 'Не повторять'),
      h('option', { value: 'daily' }, 'Ежедневно'),
      h('option', { value: 'weekly' }, 'Еженедельно'),
      h('option', { value: 'monthly' }, 'Ежемесячно'));
    freqSelect.value = task.repeat?.freq || '';

    const intervalInput = h('input', {
      class: 'input', type: 'number', min: '1', max: '99',
      value: String(task.repeat?.interval || 1), 'aria-label': 'Интервал повтора',
    });
    const repeatTime = h('input', {
      class: 'input', type: 'time',
      value: task.repeat?.time || timePart(task.due) || '', 'aria-label': 'Время повтора',
    });

    const push = () => {
      if (!freqSelect.value) { apply({ repeat: null }); renderRepeat(); return; }
      if (!task.due) {
        apply({ due: todayStr() });
        syncDateInputs();
      }
      apply({
        repeat: {
          freq: freqSelect.value,
          interval: Math.max(1, Number(intervalInput.value) || 1),
          time: repeatTime.value || null,
          anchor: task.repeat?.anchor || datePart(task.due) || todayStr(),
        },
        due: combineDue(datePart(task.due) || todayStr(), repeatTime.value || timePart(task.due)),
      });
      dateInput.value = datePart(task.due) || '';
      timeInput.value = timePart(task.due) || '';
      renderRepeat();
    };

    freqSelect.addEventListener('change', push);
    intervalInput.addEventListener('change', push);
    repeatTime.addEventListener('change', push);

    repeatWrap.append(h('div', { class: 'row' },
      freqSelect,
      task.repeat ? intervalInput : null,
      task.repeat ? repeatTime : null));

    if (task.repeat) {
      const next = M.nextOccurrence(datePart(task.due), task.repeat, datePart(task.due));
      repeatWrap.append(h('p', { class: 'hint' },
        `${M.repeatLabel(task.repeat)}. После отметки «сделано» задача сама переедет на ${fmtDayLabel(next).toLowerCase()}.`));
    }
  }
  renderRepeat();

  // --- Подзадачи
  const subWrap = h('div', { class: 'subtasks' });
  function renderSubs() {
    clear(subWrap);
    for (const s of task.subtasks) {
      const title = h('input', { class: 'st-title', value: s.title, 'aria-label': 'Подзадача' });
      title.addEventListener('change', () => { M.renameSubtask(task.id, s.id, title.value); scheduleSync(); });
      subWrap.append(h('div', { class: `subtask${s.done ? ' done' : ''}` },
        h('button', {
          class: 'check', 'aria-label': 'Отметить подзадачу',
          onclick: () => { M.toggleSubtask(task.id, s.id); renderSubs(); ctx.refresh(); scheduleSync(); },
        }),
        title,
        h('button', {
          class: 'rm', 'aria-label': 'Удалить подзадачу',
          onclick: () => { M.removeSubtask(task.id, s.id); renderSubs(); ctx.refresh(); scheduleSync(); },
        }, '✕')));
    }
    const add = h('input', { placeholder: 'Добавить подзадачу…', 'aria-label': 'Новая подзадача' });
    add.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !add.value.trim()) return;
      e.preventDefault();
      M.addSubtask(task.id, add.value);
      add.value = '';
      renderSubs();
      ctx.refresh();
      scheduleSync();
      subWrap.querySelector('.subtask-add input')?.focus();
    });
    subWrap.append(h('div', { class: 'subtask-add' }, h('span', null, '+'), add));
  }
  renderSubs();

  // --- Статус Google
  const gcalLine = () => {
    if (!G.isConfigured()) return null;
    if (task.gcal?.error) return h('p', { class: 'hint', style: { color: 'var(--danger)' } }, `Google: ${task.gcal.error}`);
    if (task.gcal?.eventId) return h('p', { class: 'hint' }, '◉ Событие создано в календаре «' + state.settings.gcalCalendarName + '»');
    if (task.due) return h('p', { class: 'hint' }, 'Будет выгружено в Google Calendar при следующей синхронизации');
    return h('p', { class: 'hint' }, 'Без даты задача в календарь не попадает');
  };

  const sheet = openSheet({
    title: 'Задача',
    bodyNodes: [
      h('div', { class: 'field' }, titleInput),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Заметки'), notesInput),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Подзадачи'), subWrap),
      h('div', { class: 'field' },
        h('span', { class: 'field-label' }, 'Когда'),
        quickWrap,
        h('div', { class: 'row' }, dateInput, timeInput)),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Повтор'), repeatWrap),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Приоритет'), prioWrap),
      gcalLine(),
    ],
    footNodes: [
      h('button', {
        class: 'btn btn-danger',
        onclick: async () => {
          const ok = await confirmSheet({ title: 'Удалить задачу', text: `«${task.title}» будет удалена без возможности отмены.`, okLabel: 'Удалить', danger: true });
          if (!ok) return;
          M.deleteTask(task.id);
          sheet.close();
          ctx.refresh();
          scheduleSync();
          toast('Задача удалена');
        },
      }, 'Удалить'),
      h('span', { class: 'spacer' }),
      h('button', {
        class: 'btn',
        onclick: () => { handleToggle(task.id); sheet.close(); ctx.refresh(); },
      }, task.done ? 'Вернуть в работу' : 'Выполнено'),
      h('button', { class: 'btn btn-primary', onclick: () => sheet.close() }, 'Готово'),
    ],
    onClose: () => ctx.refresh(),
  });

  setTimeout(() => { if (!task.title) titleInput.focus(); }, 40);
  return sheet;
}

// ---------- Раздел «Календари» ----------

let calTab = 'list';

function renderCalendarView(root) {
  const tabs = h('div', { class: 'cal-tabs' },
    h('button', { class: `chip${calTab === 'list' ? ' active' : ''}`, onclick: () => { calTab = 'list'; ctx.refresh(); } }, 'Ближайшие события'),
    h('button', { class: `chip${calTab === 'embed' ? ' active' : ''}`, onclick: () => { calTab = 'embed'; ctx.refresh(); } }, 'Виджет Google'));
  root.append(tabs);

  if (calTab === 'embed') { root.append(embedWidget()); return; }

  if (!G.originAllowed()) {
    root.append(noticeBlock('Google требует HTTPS',
      'Откройте приложение по https:// (или http://localhost для отладки) — иначе Google не выдаст доступ к календарю.'));
    return;
  }
  if (!G.isConfigured()) {
    root.append(noticeBlock('Google Calendar не подключён',
      'Укажите OAuth Client ID и включите синхронизацию в настройках.',
      h('button', { class: 'btn btn-primary', onclick: openSettings }, 'Открыть настройки')));
    return;
  }

  const holder = h('div', null, h('p', { class: 'muted', style: { padding: '18px 4px' } }, 'Загружаем события…'));
  root.append(holder);

  G.listUpcomingEvents(7).then((events) => {
    clear(holder);
    if (!events.length) {
      holder.append(noticeBlock('На неделю событий нет', 'В подключённых календарях Google ничего не запланировано на ближайшие 7 дней.'));
      return;
    }
    const byDay = new Map();
    for (const e of events) {
      const start = G.eventStart(e);
      const key = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(e);
    }
    for (const [day, items] of byDay) {
      const rows = items.map((e) => h('div', { class: 'ev' },
        h('span', { class: 'bar', style: e._color ? { background: e._color } : null }),
        h('span', { class: 't' }, G.eventIsAllDay(e) ? 'весь день' : fmtTime(G.eventStart(e))),
        h('div', { class: 'b' },
          h('div', { class: 's' }, e.summary || '(без названия)'),
          h('div', { class: 'c' }, [e._cal, e.location].filter(Boolean).join(' · ')))));

      holder.append(h('section', { class: 'cal-day' },
        h('h3', null, fmtDayLabel(day)),
        h('div', { class: 'ev-list' }, ...rows)));
    }
  }).catch((err) => {
    clear(holder);
    holder.append(noticeBlock('Не удалось загрузить события', err.message,
      h('button', { class: 'btn', onclick: () => G.connect().then(ctx.refresh).catch((e) => toast(e.message, { error: true })) }, 'Подключить заново')));
  });
}

/** Разбирает строку настроек: «id» либо «id|#rrggbb» (цвет необязателен). */
function parseEmbedIds(raw) {
  return (raw || '').split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [id, color] = entry.split('|').map((x) => x.trim());
    return { id, color: /^#[0-9a-f]{6}$/i.test(color || '') ? color : null };
  }).filter((c) => c.id);
}

function embedWidget() {
  const cals = parseEmbedIds(state.settings.embedCalendarIds);
  if (!cals.length) {
    return noticeBlock('Виджет не настроен',
      'Укажите в настройках адреса календарей (например, ваш gmail-адрес и id календаря TaskFlow) — они подставятся в официальный виджет Google.',
      h('button', { class: 'btn btn-primary', onclick: openSettings }, 'Открыть настройки'));
  }
  const url = new URL('https://calendar.google.com/calendar/embed');
  url.searchParams.set('ctz', G.TZ);
  url.searchParams.set('mode', state.settings.embedMode || 'WEEK');
  url.searchParams.set('wkst', '2');
  url.searchParams.set('hl', 'ru');
  url.searchParams.set('showTitle', '0');
  url.searchParams.set('showPrint', '0');
  for (const c of cals) url.searchParams.append('src', c.id);
  // Google красит src в собственные цвета только если color задан для КАЖДОГО из них,
  // строго в том же порядке. Иначе весь виджет заливается одним цветом.
  if (cals.some((c) => c.color)) {
    for (const c of cals) url.searchParams.append('color', c.color || '#9fc6e7');
  }

  return h('div', null,
    h('div', { class: 'embed-wrap' },
      h('iframe', { src: url.toString(), title: 'Google Calendar', loading: 'lazy' })),
    h('p', { class: 'hint' }, 'Виджет показывает только те календари, которые доступны вам в текущей сессии Google в этом браузере.'));
}

function noticeBlock(title, text, ...actions) {
  return h('div', { class: 'empty' },
    h('p', { style: { fontWeight: '600', color: 'var(--text-dim)', marginBottom: '6px' } }, title),
    h('p', { style: { maxWidth: '420px', margin: '0 auto 14px' } }, text),
    ...actions);
}

// ---------- Настройки ----------

function sectionBlock(title, ...nodes) {
  return h('section', { class: 'settings-section' }, h('h3', null, title), ...nodes.filter(Boolean));
}

function switchRow(label, hint, checked, onChange) {
  const box = h('input', { type: 'checkbox', checked: checked ? true : null, style: { width: '18px', height: '18px' } });
  box.addEventListener('change', () => onChange(box.checked));
  const id = 'sw-' + Math.random().toString(36).slice(2, 8);
  box.id = id;
  return h('div', { class: 'switch-row' }, box,
    h('label', { for: id }, label, hint ? h('div', { class: 'hint' }, hint) : null));
}

export function openSettings() {
  const s = state.settings;

  // --- Тема
  const themeChips = h('div', { class: 'chips' });
  const themes = [['auto', 'Как в системе'], ['light', 'Светлая'], ['dark', 'Тёмная']];
  const drawThemes = () => {
    clear(themeChips);
    for (const [val, label] of themes) {
      themeChips.append(h('button', {
        class: `chip${s.theme === val ? ' active' : ''}`,
        onclick: () => { setSetting('theme', val); applyTheme(); drawThemes(); },
      }, label));
    }
  };
  drawThemes();

  // --- Google
  const clientIdInput = h('input', {
    class: 'input', type: 'text', spellcheck: 'false', autocomplete: 'off',
    placeholder: '123456789-xxxx.apps.googleusercontent.com', value: s.googleClientId,
  });
  clientIdInput.addEventListener('change', () => patchSettings({ googleClientId: clientIdInput.value.trim() }));

  const calNameInput = h('input', { class: 'input', type: 'text', value: s.gcalCalendarName });
  calNameInput.addEventListener('change', () => patchSettings({ gcalCalendarName: calNameInput.value.trim() || 'TaskFlow', gcalCalendarId: null }));

  const durInput = h('input', { class: 'input', type: 'number', min: '5', max: '480', step: '5', value: String(s.gcalEventMinutes) });
  durInput.addEventListener('change', () => patchSettings({ gcalEventMinutes: Math.max(5, Number(durInput.value) || 30) }));

  const gStatus = h('div');
  const drawStatus = () => {
    clear(gStatus);
    const cls = G.gstatus.lastError ? 'err' : G.gstatus.connected ? 'on' : 'off';
    const text = G.gstatus.lastError ? G.gstatus.lastError
      : G.gstatus.connected ? 'подключено' : 'не подключено';
    append(gStatus,
      h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Состояние'),
        h('span', { class: 'v' }, h('span', { class: `dot-status ${cls}` }), ' ' + text)),
      h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Ожидают выгрузки'),
        h('span', { class: 'v' }, String(G.pendingChanges()))),
      G.gstatus.lastSync ? h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Последняя синхронизация'),
        h('span', { class: 'v' }, fmtTime(new Date(G.gstatus.lastSync)))) : null);
  };
  drawStatus();

  const gButtons = h('div', { class: 'chips', style: { marginTop: '8px' } },
    h('button', {
      class: 'btn btn-primary btn-sm',
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          patchSettings({ googleClientId: clientIdInput.value.trim(), gcalEnabled: true });
          await G.connect();
          toast('Google Calendar подключён');
          const res = await G.syncAll({ interactive: true, force: true });
          if (res.error) toast(res.error, { error: true });
          else toast(`Выгружено: ${res.created + res.updated}, удалено: ${res.deleted}`);
        } catch (err) {
          toast(err.message, { error: true });
        } finally {
          btn.disabled = false;
          drawStatus();
          ctx.refresh();
        }
      },
    }, 'Подключить и выгрузить'),
    h('button', {
      class: 'btn btn-sm',
      onclick: async () => {
        const res = await G.syncAll({ interactive: true, force: true });
        if (res.error) toast(res.error, { error: true });
        else toast(`Создано: ${res.created}, обновлено: ${res.updated}, удалено: ${res.deleted}`);
        drawStatus();
        ctx.refresh();
      },
    }, 'Синхронизировать сейчас'),
    h('button', {
      class: 'btn btn-sm btn-danger',
      onclick: () => { G.disconnect(); drawStatus(); ctx.refresh(); toast('Доступ Google отозван'); },
    }, 'Отключить'));

  // --- Какие календари показывать в списке «Ближайшие события»
  const calListBox = h('div', { style: { marginTop: '4px' } });
  const drawCalList = async () => {
    clear(calListBox);
    if (!G.gstatus.connected) {
      append(calListBox, h('p', { class: 'hint' }, 'Подключите Google Calendar, чтобы выбрать календари.'));
      return;
    }
    append(calListBox, h('p', { class: 'hint' }, 'Загружаю список календарей…'));
    let cals;
    try {
      cals = await G.listCalendars();
    } catch (err) {
      clear(calListBox);
      append(calListBox, h('p', { class: 'hint' }, 'Не удалось получить список: ' + err.message));
      return;
    }
    clear(calListBox);
    for (const c of cals) {
      const hidden = new Set(state.settings.hiddenCalendarIds || []);
      const box = h('input', { type: 'checkbox', checked: hidden.has(c.id) ? null : true,
        style: { width: '18px', height: '18px', flex: '0 0 auto' } });
      box.addEventListener('change', () => {
        const next = new Set(state.settings.hiddenCalendarIds || []);
        if (box.checked) next.delete(c.id); else next.add(c.id);
        patchSettings({ hiddenCalendarIds: [...next] });
        ctx.refresh();
      });
      const label = h('label', { style: {
        display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 0', cursor: 'pointer' } },
        box,
        h('span', { style: { width: '10px', height: '10px', borderRadius: '50%',
          background: c.backgroundColor || 'var(--accent)', flex: '0 0 auto' } }),
        h('span', null, c.summary));
      append(calListBox, label);
    }
  };
  drawCalList();

  // --- Виджет
  const embedInput = h('textarea', {
    class: 'textarea', style: { minHeight: '58px' }, spellcheck: 'false',
    placeholder: 'you@gmail.com|#b99aff, abcdef123@group.calendar.google.com|#92e1c0',
  });
  embedInput.value = s.embedCalendarIds;
  embedInput.addEventListener('change', () => patchSettings({ embedCalendarIds: embedInput.value.trim() }));

  const modeSelect = h('select', { class: 'select' },
    h('option', { value: 'WEEK' }, 'Неделя'),
    h('option', { value: 'MONTH' }, 'Месяц'),
    h('option', { value: 'AGENDA' }, 'Расписание'));
  modeSelect.value = s.embedMode;
  modeSelect.addEventListener('change', () => patchSettings({ embedMode: modeSelect.value }));

  // --- Части дня
  const partsRow = h('div', { class: 'row' });
  for (const [key, label] of [['morning', 'Утро'], ['noon', 'Обед'], ['afternoon', 'День'], ['evening', 'Вечер']]) {
    const inp = h('input', { class: 'input', type: 'time', value: s.dayParts[key] });
    inp.addEventListener('change', () => patchSettings({ dayParts: { ...state.settings.dayParts, [key]: inp.value || s.dayParts[key] } }));
    partsRow.append(h('div', { style: { minWidth: '110px' } }, h('span', { class: 'field-label' }, label), inp));
  }

  // --- Данные
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'hidden' });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const replace = await confirmSheet({
        title: 'Импорт',
        text: 'Заменить текущий список целиком? «Отмена» — объединить: новые задачи добавятся, более свежие версии перезапишут старые.',
        okLabel: 'Заменить', danger: true,
      });
      const res = importJson(text, replace ? 'replace' : 'merge');
      toast(`Импорт: +${res.added}, обновлено ${res.updated}, всего ${res.total}`);
      ctx.refresh();
    } catch (err) {
      toast('Не удалось прочитать файл: ' + err.message, { error: true });
    } finally {
      fileInput.value = '';
    }
  });

  const dataButtons = h('div', { class: 'chips' },
    h('button', {
      class: 'btn btn-sm',
      onclick: () => {
        const blob = new Blob([exportJson()], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = h('a', { href: url, download: `taskflow-${todayStr()}.json` });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
    }, '↓ Экспорт JSON'),
    h('button', { class: 'btn btn-sm', onclick: () => fileInput.click() }, '↑ Импорт JSON'),
    h('button', {
      class: 'btn btn-sm btn-danger',
      onclick: async () => {
        const ok = await confirmSheet({ title: 'Удалить все задачи', text: 'Список очистится безвозвратно. Настройки останутся.', okLabel: 'Удалить всё', danger: true });
        if (!ok) return;
        wipeAll();
        ctx.refresh();
        toast('Все задачи удалены');
      },
    }, 'Очистить всё'),
    fileInput);

  // --- Синхронизация между устройствами
  const tokenInput = h('input', {
    class: 'input', type: 'password', spellcheck: 'false', autocomplete: 'off',
    placeholder: 'Токен из консоли сервера', value: S.getToken(),
  });

  const syncStatusBox = h('div');
  const drawSyncStatus = () => {
    clear(syncStatusBox);
    const on = S.isConfigured();
    const cls = S.syncState.lastError ? 'err' : on ? 'on' : 'off';
    const text = S.syncState.lastError ? S.syncState.lastError
      : on ? 'подключено' : 'не подключено';
    append(syncStatusBox,
      h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Состояние'),
        h('span', { class: 'v' }, h('span', { class: `dot-status ${cls}` }), ' ' + text)),
      h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Задач на этом устройстве'),
        h('span', { class: 'v' }, String(state.tasks.length))),
      S.syncState.lastSync ? h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Последний обмен'),
        h('span', { class: 'v' }, fmtTime(new Date(S.syncState.lastSync)))) : null);
  };
  drawSyncStatus();

  const syncButtons = h('div', { class: 'chips', style: { marginTop: '8px' } },
    h('button', {
      class: 'btn btn-primary btn-sm',
      onclick: async (e) => {
        const btn = e.currentTarget;
        const token = tokenInput.value.trim();
        if (!token) { toast('Вставьте токен', { error: true }); return; }
        btn.disabled = true;
        try {
          // Токен проверяем до сохранения: иначе останется нерабочая настройка,
          // а обмен будет молча падать в фоне.
          await S.checkToken(token);
          S.setToken(token);
          const res = await S.syncNow();
          if (res?.error) throw new Error(res.error);
          toast('Синхронизация подключена');
          drawSyncStatus();
          ctx.refresh();
        } catch (err) {
          toast(`Не подключилось: ${err.message}`, { error: true });
        } finally {
          btn.disabled = false;
        }
      },
    }, 'Подключить'),
    S.isConfigured() ? h('button', {
      class: 'btn btn-sm',
      onclick: async () => {
        const res = await S.syncNow();
        if (res?.error) toast(res.error, { error: true });
        else toast('Задачи синхронизированы');
        drawSyncStatus();
        ctx.refresh();
      },
    }, 'Синхронизировать сейчас') : null,
    S.isConfigured() ? h('button', {
      class: 'btn btn-sm btn-danger',
      onclick: async () => {
        const ok = await confirmSheet({
          title: 'Отключить синхронизацию',
          text: 'Задачи останутся на этом устройстве и на сервере, но обмен прекратится.',
          okLabel: 'Отключить', danger: true,
        });
        if (!ok) return;
        S.setToken('');
        tokenInput.value = '';
        toast('Синхронизация отключена');
        drawSyncStatus();
        ctx.refresh();
      },
    }, 'Отключить') : null);

  openSheet({
    title: 'Настройки',
    bodyNodes: [
      sectionBlock('Внешний вид', themeChips),

      sectionBlock('Синхронизация между устройствами',
        S.syncState.available === false ? h('div', { class: 'banner warn', style: { margin: '0 0 12px' } },
          h('span', null, h('b', null, 'Сервер синхронизации недоступен. '),
            'Приложение открыто как статика — задачи хранятся только в этом браузере. Запустите node serve.mjs или откройте адрес, где он работает.')) : null,
        h('p', { class: 'hint', style: { marginBottom: '8px' } },
          'Задачи хранятся на вашем сервере, и все устройства видят один список. Токен печатается в консоли при запуске сервера (и лежит в data/token.txt). Вставьте один и тот же токен на каждом устройстве.'),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Токен доступа'), tokenInput),
        syncStatusBox, syncButtons),

      sectionBlock('Google Calendar',
        !G.originAllowed() ? h('div', { class: 'banner warn', style: { margin: '0 0 12px' } },
          h('span', null, h('b', null, 'Нужен HTTPS. '),
            'Google разрешает OAuth только с https-адресов и с http://localhost. Сейчас страница открыта по ',
            location.protocol + '//' + location.host, '.')) : null,
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'OAuth Client ID'), clientIdInput,
          h('p', { class: 'hint' }, 'Google Cloud → APIs & Services → Credentials → OAuth client ID (Web application). Инструкция в README.')),
        switchRow('Синхронизировать задачи с Google Calendar',
          'Задачи с датой становятся событиями в отдельном календаре. Правки в Google обратно не переносятся.',
          s.gcalEnabled, (v) => { patchSettings({ gcalEnabled: v }); ctx.refresh(); }),
        switchRow('Выгружать автоматически', 'Через пару секунд после каждой правки.', s.gcalAutoSync, (v) => patchSettings({ gcalAutoSync: v })),
        h('div', { class: 'row', style: { marginTop: '10px' } },
          h('div', null, h('span', { class: 'field-label' }, 'Название календаря'), calNameInput),
          h('div', null, h('span', { class: 'field-label' }, 'Длительность события, мин'), durInput)),
        gStatus, gButtons),

      sectionBlock('Календари в списке событий',
        h('p', { class: 'hint', style: { marginBottom: '4px' } },
          'Снимите галочку, чтобы календарь не подгружался на вкладке «Ближайшие события». На виджет Google это не влияет — он настраивается ниже.'),
        calListBox),

      sectionBlock('Виджет Google Calendar',
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Адреса календарей через запятую'), embedInput,
          h('p', { class: 'hint' }, 'Обычно это ваш gmail-адрес и id календаря TaskFlow (Google Calendar → настройки календаря → «Интеграция»). Чтобы календари отличались по цвету, допишите его через вертикальную черту: id|#b99aff.')),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Режим'), modeSelect)),

      sectionBlock('Планирование дня (Moments)',
        h('p', { class: 'hint', style: { marginBottom: '8px' } }, 'Во сколько ставить задачу, когда в Moments выбрано «Сегодня».'),
        partsRow),

      sectionBlock('Напоминания',
        switchRow('Показывать уведомления', 'Работают, пока вкладка открыта. На iPhone — только если добавить на экран «Домой» и открыть по HTTPS.',
          s.notifications, async (v) => {
            if (v && 'Notification' in window && Notification.permission !== 'granted') {
              const perm = await Notification.requestPermission();
              if (perm !== 'granted') { toast('Браузер не разрешил уведомления', { error: true }); patchSettings({ notifications: false }); return; }
            }
            patchSettings({ notifications: v });
          })),

      sectionBlock('Данные',
        h('p', { class: 'hint', style: { marginBottom: '8px' } },
          'Копия списка всегда лежит в этом браузере, поэтому приложение работает офлайн. При включённой синхронизации главный экземпляр — на вашем сервере. Экспорт JSON пригодится для резервной копии.'),
        dataButtons),

      h('p', { class: 'hint' }, 'TaskFlow · данные уходят только на ваш сервер синхронизации и в Google Calendar, если он включён.'),
    ],
    footNodes: [h('span', { class: 'spacer' }), h('button', { class: 'btn btn-primary', onclick: () => $('.overlay:last-child .sheet-head .icon-btn').click() }, 'Закрыть')],
    onClose: () => ctx.refresh(),
  });
}

// ---------- Тема ----------

export function applyTheme() {
  const t = state.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

// ---------- Баннеры ----------

function renderBanners() {
  const root = $('#banner-root');
  clear(root);
  const dismissed = state.settings.dismissedBanners || [];

  const add = (key, node) => {
    if (dismissed.includes(key)) return;
    node.append(h('button', {
      class: 'close', 'aria-label': 'Скрыть',
      onclick: () => { patchSettings({ dismissedBanners: [...(state.settings.dismissedBanners || []), key] }); ctx.refresh(); },
    }, '✕'));
    root.append(node);
  };

  if (state.settings.gcalEnabled && !G.originAllowed()) {
    add('insecure', h('div', { class: 'banner warn' },
      h('span', null, h('b', null, 'Google Calendar выключен: нужен HTTPS. '),
        'Синхронизация заработает, когда страница откроется по https:// (или с http://localhost при отладке).')));
  } else if (state.settings.gcalEnabled && state.settings.googleClientId && !G.gstatus.connected) {
    add('connect', h('div', { class: 'banner' },
      h('span', null, 'Google Calendar настроен, но доступ не выдан в этой сессии. '),
      h('button', {
        class: 'btn btn-sm', style: { marginLeft: '4px' },
        onclick: () => G.connect().then(() => { toast('Подключено'); scheduleSync(); ctx.refresh(); })
          .catch((e) => toast(e.message, { error: true })),
      }, 'Подключить')));
  }
}

// ---------- Строка состояния синхронизации ----------

function renderSyncLine() {
  const el = $('#sync-line-side');
  if (!el) return;
  clear(el);
  if (!G.isConfigured()) {
    el.append(h('span', null, 'Google Calendar: выключен'));
    return;
  }
  const pending = G.pendingChanges();
  append(el,
    h('div', null, h('b', null, 'Google Calendar'), G.gstatus.connected ? ' · подключён' : ' · нет доступа'),
    h('div', null, G.gstatus.syncing ? 'синхронизация…' : pending ? `${pending} ${plural(pending, 'изменение', 'изменения', 'изменений')} в очереди` : 'всё выгружено'),
    G.gstatus.lastError ? h('div', { style: { color: 'var(--danger)' } }, G.gstatus.lastError) : null);
}

// ---------- Кнопка порядка сортировки ----------

const SORT_HINT = {
  manual: 'Ручной порядок: как расставили перетаскиванием. Нажмите, чтобы вернуть автоматический.',
  auto: 'Автоматический порядок: по времени и приоритету. Нажмите, чтобы закрепить ручной.',
};

function renderSortButton() {
  const btn = $('#btn-sort');
  if (!btn) return;
  const manual = M.isManualSort();
  btn.classList.toggle('hidden', ctx.view === 'calendar' || ctx.view === 'done');
  btn.classList.toggle('active', manual);
  btn.title = SORT_HINT[manual ? 'manual' : 'auto'];
  btn.setAttribute('aria-pressed', manual ? 'true' : 'false');
}

// ---------- Кнопка синхронизации между устройствами ----------

const CLOUD_ICON = { off: '☁', on: '☁', err: '⚠' };

export function renderCloudButton() {
  const btn = $('#btn-cloud');
  if (!btn) return;

  // Кнопку показываем только там, где сервер синхронизации вообще есть.
  btn.classList.toggle('hidden', S.syncState.available === false);
  btn.classList.toggle('spin', S.syncState.syncing);

  const err = S.syncState.lastError;
  const on = S.isConfigured();
  btn.textContent = err && on ? CLOUD_ICON.err : CLOUD_ICON.on;
  btn.classList.toggle('active', on && !err);
  btn.classList.toggle('danger', !!(err && on));

  btn.title = !on ? 'Синхронизация между устройствами не настроена'
    : err ? `Синхронизация: ${err}`
    : S.syncState.lastSync ? `Синхронизировано в ${fmtTime(new Date(S.syncState.lastSync))}`
    : 'Синхронизация включена';
  btn.setAttribute('aria-label', btn.title);
}

/** Ручной обмен по кнопке: без токена ведём в настройки. */
export async function syncDevicesNow() {
  if (!S.isConfigured()) { openSettings(); return; }
  const res = await S.syncNow();
  if (res?.error) toast(`Синхронизация не удалась: ${res.error}`, { error: true });
  else if (res?.skipped === 'offline') toast('Нет сети — обменяемся, когда появится', { error: true });
  else if (res?.ok) toast('Задачи синхронизированы');
  render();
}

export function toggleSortMode() {
  if (ctx.view === 'calendar' || ctx.view === 'done') return;
  const mode = M.toggleSortMode();
  toast(mode === 'manual'
    ? 'Ручной порядок: задачи стоят так, как вы их расставили'
    : 'Автоматический порядок: по времени и приоритету');
  render();
}

// ---------- Главная отрисовка ----------

export function render() {
  // Во время перетаскивания DOM списка ведём вручную — перерисовка его порвёт.
  if (drag) return;

  renderNav();
  $('#view-title').textContent = M.VIEWS[ctx.view]?.title || '';
  $('#view-subtitle').textContent = subtitleFor(ctx.view);
  $('#btn-sync').classList.toggle('spin', G.gstatus.syncing);
  $('#btn-sync').classList.toggle('hidden', !G.isConfigured());
  renderSortButton();
  renderCloudButton();
  renderBanners();

  const content = $('#content');
  const scrollTop = content.scrollTop;
  clear(content);
  if (ctx.view === 'calendar') renderCalendarView(content);
  else renderListView(content, ctx.view);
  content.scrollTop = scrollTop;

  renderSyncLine();
  restoreHandleFocus();
}
