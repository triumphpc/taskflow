// Отрисовка интерфейса: навигация, списки, редактор задачи, настройки.

import { $, h, clear, append, todayStr, addDaysStr, fmtDue, fmtDayLabel, fmtTime, datePart, timePart,
  combineDue, plural, debounce, oneLine, linkify, caretIndexAt } from './util.js';
import { state, subscribe, patchSettings, setSetting, exportJson, importJson, wipeAll } from './store.js';
import * as S from './sync.js';
import * as M from './model.js';

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

const NAV_ITEMS = ['today', 'tomorrow', 'upcoming', 'someday', 'all', 'done'];
const NAV_MOBILE = ['today', 'upcoming', 'all', 'done'];

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
  return '';
}

// ---------- Строка задачи ----------

/** Три кружка быстрого переноса прямо в строке: одно касание — и задача уехала
 *  на другой день, без открытия карточки. «Пн» — ближайший понедельник. */
const SNOOZE = [
  ['\u2192', 'Завтра', () => M.QUICK_DATES.tomorrow()],
  ['\u00bb', 'Через 2 дня', () => M.QUICK_DATES.in2days()],
  ['Пн', 'Следующая неделя', () => M.QUICK_DATES.nextWeek()],
];

function snoozeButtons(task) {
  return h('div', { class: 'snooze' }, ...SNOOZE.map(([glyph, label, when]) => h('button', {
    class: 'snooze-btn',
    title: `Перенести: ${label.toLowerCase()}`,
    'aria-label': `Перенести на ${label.toLowerCase()}: ${oneLine(task.title) || 'без названия'}`,
    onclick: (e) => {
      e.stopPropagation();
      M.scheduleTask(task.id, when());
      toast(`Перенесено: ${label.toLowerCase()}`);
    },
  }, glyph)));
}

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
  if (task.priority <= 3) meta.unshift(h('span', { class: 'chip-p' }, M.PRIORITIES[task.priority].code));

  const li = h('li', {
    class: `task${task.done ? ' done' : ''}`,
    dataset: { id: task.id, p: String(task.priority) },
  },
    h('button', {
      class: 'check',
      'aria-label': task.done ? 'Вернуть в работу' : 'Отметить выполненной',
      onclick: (e) => { e.stopPropagation(); handleToggle(task.id); },
    }),
    h('div', { class: 'task-body' },
      h('div', { class: 'task-title' }, task.title ? linkify(task.title) : 'Без названия'),
      meta.length ? h('div', { class: 'task-meta' }, ...meta) : null),
    h('button', { class: 'task-open', 'aria-label': `Открыть: ${oneLine(task.title)}`, onclick: () => openEditor(task.id) }, 'открыть'),
    task.done ? null : snoozeButtons(task),
    dragHandle(task));

  li.addEventListener('pointerdown', (e) => onRowDown(e, li, false));
  return li;
}

function handleToggle(id) {
  const res = M.toggleDone(id);
  if (res?.kind === 'rescheduled') {
    toast(`Повтор: перенесено на ${fmtDue(res.nextDue).toLowerCase()}`);
  }
}

// ---------- Перетаскивание задач ----------

/**
 * Своя реализация вместо HTML5 drag-and-drop: на тач-экранах он не работает,
 * а приложение ставится как PWA. Тянем на Pointer Events, оригинальная строка
 * остаётся в потоке как метка места вставки, за пальцем/курсором летит копия.
 *
 * Тянуть можно за любое место строки, но строка уже занята двумя жестами:
 * кликом (открыть задачу) и вертикальным свайпом (прокрутить список). Поэтому
 * намерение определяем по вводу, а не по зоне: мышью перетаскивание начинается
 * после сдвига на DRAG_START_PX, пальцем — только после удержания, иначе любая
 * прокрутка утаскивала бы задачу. Ручка `⠿` остаётся: она берёт строку сразу,
 * без удержания, и даёт клавиатурный доступ через ↑/↓.
 */

let drag = null;            // активная сессия перетаскивания
let focusHandle = null;     // задача, чью ручку вернуть в фокус после перерисовки

const DRAG_START_PX = 5;    // порог мышью, после которого считаем это перетаскиванием
const HOLD_MS = 350;        // сколько держать палец на строке, прежде чем она «оторвётся»
const HOLD_SLOP_PX = 10;    // сдвиг пальца до срабатывания удержания — это прокрутка
const EDGE_PX = 70;         // зона автопрокрутки у краёв списка
const EDGE_SPEED = 14;      // максимальная скорость автопрокрутки, px/кадр

const listIds = (list) => Array.from(list.children).map((el) => el.dataset.id).filter(Boolean);

function dragHandle(task) {
  const btn = h('button', {
    class: 'drag-handle',
    'aria-label': `Переместить: ${oneLine(task.title) || 'без названия'}`,
    title: 'Тяните строку в любом месте, чтобы изменить порядок или дату (↑/↓ с клавиатуры)',
  }, '⠿');
  // Ручка перехватывает событие у строки: за неё берём сразу, без удержания.
  btn.addEventListener('pointerdown', (e) => { e.stopPropagation(); onRowDown(e, btn.closest('li.task'), true); });
  btn.addEventListener('keydown', (e) => onHandleKey(e, btn));
  return btn;
}

function onRowDown(e, li, fromHandle) {
  if (drag || (e.button ?? 0) > 0) return;
  const list = li?.parentElement;
  if (!li || !list || list.dataset.noDrag) return;
  // Кружок «готово» — только переключатель: дрогнувшая на нём рука
  // не должна утаскивать задачу вместо отметки.
  if (!fromHandle && e.target.closest?.('.check, .snooze, .linkified')) return;

  // Пальцем по строке ждём удержания, мышью и за ручку — обычный порог сдвига.
  const hold = e.pointerType === 'touch' && !fromHandle;
  const start = { x: e.clientX, y: e.clientY, id: e.pointerId };
  let started = false;
  let timer = 0;

  // Слушаем окно, а не саму строку: pointer capture в Chromium слетает,
  // как только захвативший элемент перестаёт отрисовываться.
  if (fromHandle) e.preventDefault();

  const cleanup = () => {
    clearTimeout(timer);
    timer = 0;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
  };

  const begin = (ev) => { started = true; beginDrag(li, ev, e.pointerType === 'touch'); };

  const move = (ev) => {
    if (ev.pointerId !== start.id) return;
    if (!started) {
      const dist = Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y);
      // Палец поехал раньше, чем сработало удержание, — это прокрутка списка,
      // и дальше она не наша: снимаем слушатели и не мешаем браузеру.
      if (hold) { if (dist > HOLD_SLOP_PX) cleanup(); return; }
      if (dist < DRAG_START_PX) return;
      begin(ev);
    }
    ev.preventDefault();
    moveDrag(ev);
  };
  const stop = (commitDrop) => (ev) => {
    if (ev.pointerId !== start.id) return;
    cleanup();
    if (!started) return;
    endDrag(commitDrop);
    // Отпускание после перетаскивания браузер завершает кликом, а вся строка —
    // кнопка «открыть»: без этого поверх броска раскрылся бы редактор.
    suppressNextClick();
  };
  const up = stop(true);
  const cancel = stop(false);

  if (hold) timer = setTimeout(() => { timer = 0; begin(e); }, HOLD_MS);

  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}

function suppressNextClick() {
  const kill = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
  window.addEventListener('click', kill, { capture: true, once: true });
  // Клика может и не быть — например, после pointercancel. Снимаем сторожа сами.
  setTimeout(() => window.removeEventListener('click', kill, true), 0);
}

/** Пока тянем пальцем, гасим прокрутку и вызов контекстного меню по долгому нажатию. */
const blockDefault = (e) => e.preventDefault();

function beginDrag(li, ev, touch) {
  const rect = li.getBoundingClientRect();
  const ghost = li.cloneNode(true);
  ghost.classList.add('drag-ghost');
  Object.assign(ghost.style, { width: `${rect.width}px`, left: `${rect.left}px`, top: `${rect.top}px` });
  document.body.append(ghost);

  li.classList.add('drag-src');
  document.body.classList.add('is-dragging');
  // Мышь к этому моменту уже могла начать выделять текст строки.
  window.getSelection()?.removeAllRanges();

  drag = {
    li, ghost, touch,
    fromList: li.parentElement,
    startNext: li.nextElementSibling,
    dx: ev.clientX - rect.left,
    dy: ev.clientY - rect.top,
    x: ev.clientX, y: ev.clientY,
    scrollBy: 0,
  };

  if (touch) {
    // touch-action у строки оставлен свободным, иначе список нельзя было бы
    // прокрутить пальцем. Значит, прокрутку на время перетаскивания глушим
    // сами — палец к этому моменту стоял неподвижно, и браузер её ещё не начал.
    window.addEventListener('touchmove', blockDefault, { passive: false });
    window.addEventListener('contextmenu', blockDefault, true);
    navigator.vibrate?.(10);
  }
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
  if (d.touch) {
    window.removeEventListener('touchmove', blockDefault);
    window.removeEventListener('contextmenu', blockDefault, true);
  }

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

/** Подгоняет высоту textarea под содержимое: одна строка — одна строка. */
function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function composer() {
  // Именно textarea, а не input: input по спецификации вырезает переводы строк,
  // и вставленный многострочный текст молча схлопывался бы в одну строку.
  const input = h('textarea', {
    rows: '1',
    // На узком экране длинная подсказка всё равно обрезается на полуслове,
    // а рядом с ней ещё и скрыт хинт «Enter — добавить».
    placeholder: window.innerWidth <= 620
      ? 'Новая задача…  («завтра 18:30 !1»)'
      : 'Новая задача…  («завтра 18:30 !1» тоже понимается)',
    'aria-label': 'Новая задача',
    autocomplete: 'off',
  });
  input.addEventListener('input', () => autoGrow(input));

  const submit = () => {
    const value = input.value.trim();
    if (!value) return;
    const parsed = parseQuickInput(value, defaultDateForView(ctx.view));
    if (!parsed.title) return;
    const task = M.createTask(parsed);
    input.value = '';
    autoGrow(input);
    toast('Задача добавлена', { actionLabel: 'Открыть', action: () => openEditor(task.id) });
  };

  // Enter добавляет задачу, Shift+Enter — перенос строки внутри названия.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });

  return h('div', { class: 'composer' },
    h('button', { class: 'plus', 'aria-label': 'Добавить', onclick: submit }, '+'),
    input,
    h('span', { class: 'composer-hint' }, 'Enter — добавить, ⇧Enter — перенос'));
}

export function focusComposer() {
  const input = $('.composer textarea');
  if (!input) return false;
  // Поле ввода живёт внутри прокручиваемого списка: если экран промотан вниз,
  // один только фокус выглядит как «ничего не произошло».
  input.scrollIntoView({ block: 'nearest' });
  input.focus();
  return true;
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
            text: `Будет удалено ${snapshot.length} ${plural(snapshot.length, 'задача', 'задачи', 'задач')}.`,
            okLabel: 'Очистить', danger: true,
          });
          if (!ok) return;
          const n = M.clearCompleted();
          toast(`Удалено: ${n}`, {
            actionLabel: 'Вернуть',
            action: () => { snapshot.forEach((t) => M.createTask({ ...t })); },
          });
        },
      }, 'Очистить выполненные')));
  }
}

// ---------- Редактор задачи ----------

export function openEditor(taskId) {
  let task = M.getTask(taskId);
  if (!task) return;

  // Обмен с сервером подменяет state.tasks целиком (sync.js), поэтому держать
  // ссылку на объект нельзя: после первого же обмена редактор рисовал бы
  // устаревший снимок — приоритет не подсвечивался, подзадачи не появлялись.
  const reread = () => { task = M.getTask(taskId) || task; return task; };

  const apply = (patch) => { M.updateTask(task.id, patch); ctx.refresh(); };
  const applyQuiet = debounce((patch) => apply(patch), 400);

  // --- Заголовок и заметки
  // textarea, чтобы название с переводами строк и показывалось, и правилось как есть.
  const titleInput = h('textarea', { class: 'input input-title', rows: '1', placeholder: 'Название задачи', 'aria-label': 'Название' });
  titleInput.value = task.title;
  titleInput.addEventListener('input', () => { autoGrow(titleInput); applyQuiet({ title: titleInput.value }); });

  // Заметки живут в двух видах. Пока их не правят — обычный текст, в котором
  // ссылки кликабельны; как только начали править — textarea, потому что внутри
  // неё ссылка кликабельной не бывает, там текст всегда сырой.
  const notesInput = h('textarea', { class: 'textarea hidden', placeholder: 'Заметки…', 'aria-label': 'Заметки' });
  notesInput.value = task.notes;
  const notesView = h('div', { class: 'textarea notes-view', tabindex: '0', role: 'textbox', 'aria-label': 'Заметки' });

  const renderNotesView = () => {
    clear(notesView);
    if (notesInput.value.trim()) notesView.append(...linkify(notesInput.value));
    else notesView.append(h('span', { class: 'ph' }, 'Заметки…'));
  };

  const editNotes = (caret) => {
    notesView.classList.add('hidden');
    notesInput.classList.remove('hidden');
    notesInput.focus();
    const pos = caret ?? notesInput.value.length;
    notesInput.setSelectionRange(pos, pos);
  };

  const showNotes = () => {
    renderNotesView();
    notesInput.classList.add('hidden');
    notesView.classList.remove('hidden');
  };

  notesView.addEventListener('click', (e) => {
    // По ссылке — открыть её, а не начать правку. На тач-экранах click нередко
    // приходит с target самого блока, а не ссылки, поэтому смотрим ещё и на то,
    // что лежит под точкой нажатия. Без этой проверки тап по ссылке в карточке
    // открывал правку, а сама ссылка не срабатывала.
    if (e.target.closest?.('a')) return;
    const overLink = (e.clientX || e.clientY)
      && document.elementFromPoint(e.clientX, e.clientY)?.closest?.('a');
    if (overLink) { overLink.click(); return; }
    editNotes(caretIndexAt(notesView, e.clientX, e.clientY));
  });
  // С клавиатуры правка открывается явным Enter или пробелом. По самому фокусу её
  // открывать нельзя: вид фокусируемый, и мышь забирает фокус ещё на pointerdown —
  // правка успевала открыться до click, и курсор вставал в конец вместо точки нажатия.
  notesView.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (!notesInput.classList.contains('hidden')) return;
    e.preventDefault();
    editNotes();
  });
  notesInput.addEventListener('input', () => applyQuiet({ notes: notesInput.value }));
  notesInput.addEventListener('blur', showNotes);
  renderNotesView();

  // --- Приоритет
  const prioWrap = h('div', { class: 'prio-grid' });
  const renderPrio = () => {
    reread();
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
    reread();
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
    reread();
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
    reread();
    clear(subWrap);
    for (const s of task.subtasks) {
      const title = h('input', { class: 'st-title', value: s.title, 'aria-label': 'Подзадача' });
      title.addEventListener('change', () => { M.renameSubtask(task.id, s.id, title.value); });
      subWrap.append(h('div', { class: `subtask${s.done ? ' done' : ''}` },
        h('button', {
          class: 'check', 'aria-label': 'Отметить подзадачу',
          onclick: () => { M.toggleSubtask(task.id, s.id); renderSubs(); ctx.refresh(); },
        }),
        title,
        h('button', {
          class: 'rm', 'aria-label': 'Удалить подзадачу',
          onclick: () => { M.removeSubtask(task.id, s.id); renderSubs(); ctx.refresh(); },
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
      subWrap.querySelector('.subtask-add input')?.focus();
    });
    subWrap.append(h('div', { class: 'subtask-add' }, h('span', null, '+'), add));
  }
  renderSubs();

  const sheet = openSheet({
    title: 'Задача',
    bodyNodes: [
      h('div', { class: 'field' }, titleInput),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Заметки'), notesView, notesInput),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Подзадачи'), subWrap),
      h('div', { class: 'field' },
        h('span', { class: 'field-label' }, 'Когда'),
        quickWrap,
        h('div', { class: 'row' }, dateInput, timeInput)),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Повтор'), repeatWrap),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Приоритет'), prioWrap),
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
    onClose: () => { unsubscribe(); ctx.refresh(); },
  });

  // Правки с другого устройства должны доезжать до открытого редактора.
  // Поля, в которых сейчас печатают, не трогаем — иначе курсор прыгнет.
  const unsubscribe = subscribe((reason) => {
    if (reason !== 'sync:applied') return;
    if (!M.getTask(taskId)) { sheet.close(); return; }
    reread();
    if (document.activeElement !== titleInput) { titleInput.value = task.title; autoGrow(titleInput); }
    if (document.activeElement !== notesInput) { notesInput.value = task.notes; renderNotesView(); }
    renderPrio();
    if (!subWrap.contains(document.activeElement)) renderSubs();
    syncDateInputs();
  });

  // scrollHeight имеет смысл только когда элемент уже в документе.
  setTimeout(() => { autoGrow(titleInput); if (!task.title) titleInput.focus(); }, 40);
  return sheet;
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

      h('p', { class: 'hint' }, 'TaskFlow · данные уходят только на ваш сервер синхронизации.'),
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

// ---------- Строка состояния синхронизации ----------

function renderSyncLine() {
  const el = $('#sync-line-side');
  if (!el) return;
  clear(el);
  if (S.syncState.available === false) {
    el.append(h('span', null, 'Сервер синхронизации недоступен'));
    return;
  }
  if (!S.isConfigured()) {
    el.append(h('span', null, 'Синхронизация между устройствами: выключена'));
    return;
  }
  append(el,
    h('div', null, h('b', null, 'Синхронизация между устройствами')),
    h('div', null, S.syncState.syncing ? 'обмен…'
      : S.syncState.lastSync ? `обновлено в ${fmtTime(new Date(S.syncState.lastSync))}`
      : 'ещё не обменивались'),
    S.syncState.lastError ? h('div', { style: { color: 'var(--danger)' } }, S.syncState.lastError) : null);
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
  btn.classList.toggle('hidden', ctx.view === 'done');
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
  if (ctx.view === 'done') return;
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
  renderSortButton();
  renderCloudButton();

  const content = $('#content');
  const scrollTop = content.scrollTop;
  clear(content);
  renderListView(content, ctx.view);
  content.scrollTop = scrollTop;

  renderSyncLine();
  restoreHandleFocus();
}
