// Пошаговый выбор приоритета и срока. Один компонент на четыре места: окно новой
// задачи, карточка задачи, разбор входящего и Moments. Раньше в каждом из них был
// свой набор кнопок со своей логикой — и они успели разойтись между собой.
//
// Вопросы задаются по одному: приоритет → какой день → во сколько. Следующий шаг
// раскрывается только после ответа на предыдущий, поэтому пользователь никогда не
// видит перед собой полтора десятка кнопок сразу.

import { todayStr, addDaysStr, toDateStr, fromDateStr, datePart, timePart, combineDue,
  fmtDateShort, MONTHS_NOM } from './core.js';
import { h, clear } from './dom.js';
import { state } from './store.js';
import * as M from './model.js';

const DAY_PARTS = [
  ['morning', 'Утро'],
  ['noon', 'Обед'],
  ['afternoon', 'День'],
  ['evening', 'Вечер'],
];

const QUICK = [
  ['today', 'Сегодня', () => M.QUICK_DATES.today()],
  ['tomorrow', 'Завтра', () => M.QUICK_DATES.tomorrow()],
  ['in2days', 'Через 2 дня', () => M.QUICK_DATES.in2days()],
  ['nextWeek', 'След. неделя', () => M.QUICK_DATES.nextWeek()],
];

/**
 * @param {object} opts
 * @param {{priority?:number|null, due?:string|null, dateAnswered?:boolean}} opts.value
 *        Начальное состояние. `dateAnswered` разводит «срока нет, потому что так
 *        решили» и «про срок ещё не спрашивали»: по одному только `due === null`
 *        эти два случая неразличимы, а ведут себя они по-разному.
 * @param {(v:{priority:number|null, due:string|null, dateAnswered:boolean}, step:string)=>void} opts.onChange
 * @param {(() => void)|null} opts.onDone Вызывается, когда отвечен последний шаг:
 *        выбрано время, либо выбрано «Без даты» (тогда времени и не будет).
 * @param {string[]} opts.steps Какие шаги показывать. Карточка задачи правит
 *        приоритет и срок по отдельности, поэтому просит только нужный кусок.
 */
export function schedulePicker({ value = {}, onChange = () => {}, onDone = null,
  steps = ['priority', 'date', 'time'] } = {}) {
  let priority = value.priority ?? null;
  let date = datePart(value.due ?? null);
  let time = timePart(value.due ?? null);
  let dateAnswered = value.dateAnswered ?? (value.due != null);
  let timeAnswered = !!time;
  let calMonth = null; // {y, m} — календарь открыт; null — показан ряд быстрых дат

  const node = h('div', { class: 'sched' });

  const get = () => ({ priority, due: combineDue(date, time), dateAnswered });
  const isComplete = () => priority !== null && dateAnswered;

  const emit = (step, done = false) => {
    render();
    onChange(get(), step);
    if (done && onDone) onDone();
  };

  // ---------- Шаг 1: приоритет

  function prioRow() {
    const row = h('div', { class: 'sched-row' });
    for (const p of Object.values(M.PRIORITIES)) {
      row.append(h('button', {
        type: 'button',
        class: `sched-btn prio${priority === p.id ? ' on' : ''}`,
        style: { '--c': `var(${p.varName})` },
        title: `${p.name} — ${p.hint}`,
        'aria-pressed': priority === p.id ? 'true' : 'false',
        onclick: () => { priority = p.id; emit('priority'); },
      }, h('span', { class: 'dot' }), p.code));
    }
    return row;
  }

  // ---------- Шаг 2: какой день

  function setDate(next) {
    date = next;
    dateAnswered = true;
    calMonth = null;
    if (!next) { time = null; timeAnswered = false; }
    emit('date', !next);
  }

  function dateRow() {
    const row = h('div', { class: 'sched-row' });
    for (const [key, label, fn] of QUICK) {
      const d = fn();
      row.append(h('button', {
        type: 'button',
        class: `sched-btn${date === d ? ' on' : ''}`,
        title: fmtDateShort(d),
        'aria-pressed': date === d ? 'true' : 'false',
        onclick: () => setDate(d),
        dataset: { quick: key },
      }, label));
    }
    // Календарь нужен только для «какого-то другого дня», поэтому он подсвечен,
    // когда выбранная дата не совпала ни с одной быстрой кнопкой.
    const custom = date && !QUICK.some(([, , fn]) => fn() === date);
    row.append(h('button', {
      type: 'button',
      class: `sched-btn icon${custom ? ' on' : ''}`,
      'aria-label': 'Выбрать дату в календаре',
      title: custom ? fmtDateShort(date) : 'Другой день',
      onclick: () => {
        const base = date ? fromDateStr(date) : new Date();
        calMonth = { y: base.getFullYear(), m: base.getMonth() };
        render();
      },
    }, '🗓', custom ? h('small', null, fmtDateShort(date)) : null));
    row.append(h('button', {
      type: 'button',
      class: `sched-btn ghost${dateAnswered && !date ? ' on' : ''}`,
      'aria-pressed': dateAnswered && !date ? 'true' : 'false',
      title: 'Останется во «Входящих»',
      onclick: () => setDate(null),
    }, 'Без даты'));
    return row;
  }

  // ---------- Календарь месяца

  function calendar() {
    const { y, m } = calMonth;
    const shift = (n) => {
      const d = new Date(y, m + n, 1);
      calMonth = { y: d.getFullYear(), m: d.getMonth() };
      render();
    };

    const head = h('div', { class: 'cal-head' },
      h('button', { type: 'button', class: 'cal-nav', 'aria-label': 'Предыдущий месяц', onclick: () => shift(-1) }, '‹'),
      h('span', { class: 'cal-title' }, `${MONTHS_NOM[m]} ${y}`),
      h('button', { type: 'button', class: 'cal-nav', 'aria-label': 'Следующий месяц', onclick: () => shift(1) }, '›'),
      h('button', { type: 'button', class: 'cal-back', onclick: () => { calMonth = null; render(); } }, 'Назад'));

    const grid = h('div', { class: 'cal-grid' });
    for (const w of ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс']) {
      grid.append(h('span', { class: 'cal-wd' }, w));
    }

    // Считаем в локальном времени: getDay() у локальной полуночи, дальше — только
    // сложение дней строками. Через UTC сетка съезжала бы на день в минусовых зонах.
    const first = new Date(y, m, 1);
    const offset = (first.getDay() + 6) % 7;
    let cur = addDaysStr(toDateStr(first), -offset);
    const today = todayStr();

    for (let i = 0; i < 42; i++) {
      const d = fromDateStr(cur);
      const outside = d.getMonth() !== m;
      const iso = cur;
      grid.append(h('button', {
        type: 'button',
        class: `cal-day${outside ? ' out' : ''}${iso === today ? ' today' : ''}${iso === date ? ' on' : ''}`,
        'aria-pressed': iso === date ? 'true' : 'false',
        'aria-label': fmtDateShort(iso),
        onclick: () => setDate(iso),
      }, String(d.getDate())));
      cur = addDaysStr(cur, 1);
    }

    return h('div', { class: 'cal' }, head, grid);
  }

  // ---------- Шаг 3: во сколько

  function timeRow() {
    const row = h('div', { class: 'sched-row' });
    const parts = state.settings.dayParts;
    for (const [key, label] of DAY_PARTS) {
      const t = parts[key];
      row.append(h('button', {
        type: 'button',
        class: `sched-btn${time === t ? ' on' : ''}`,
        'aria-pressed': time === t ? 'true' : 'false',
        onclick: () => { time = t; timeAnswered = true; emit('time', true); },
      }, label, h('small', null, t)));
    }
    row.append(h('button', {
      type: 'button',
      class: `sched-btn ghost${timeAnswered && !time ? ' on' : ''}`,
      'aria-pressed': timeAnswered && !time ? 'true' : 'false',
      onclick: () => { time = null; timeAnswered = true; emit('time', true); },
    }, 'Без времени'));
    return row;
  }

  // ---------- Сборка

  function step(label, ...nodes) {
    return h('div', { class: 'sched-step' },
      h('span', { class: 'sched-label' }, label), ...nodes);
  }

  const shows = (id) => steps.includes(id);

  function render() {
    clear(node);
    // Шаг раскрывается только после ответа на предыдущий. Если предыдущего шага
    // в наборе нет (карточка задачи правит срок отдельно), ждать нечего.
    if (shows('priority')) node.append(step('Приоритет', prioRow()));
    const prioReady = !shows('priority') || priority !== null;
    if (shows('date') && prioReady) {
      node.append(step('Когда', calMonth ? calendar() : dateRow()));
    }
    if (shows('time') && prioReady && dateAnswered && date) {
      node.append(step('Во сколько', timeRow()));
    }
  }

  render();

  return {
    node,
    get,
    isComplete,
    /** Первый шаг без ответа — чтобы подсветить его, когда жмут «Добавить» рано. */
    pendingStep: () => {
      if (shows('priority') && priority === null) return 'priority';
      if (shows('date') && !dateAnswered) return 'date';
      return null;
    },
    /** Перерисовка под внешнее состояние: разбор быстрого ввода, приход синхронизации. */
    set(next = {}, { silent = true } = {}) {
      if ('priority' in next) priority = next.priority ?? null;
      if ('due' in next) {
        date = datePart(next.due ?? null);
        time = timePart(next.due ?? null);
        timeAnswered = !!time;
      }
      if ('dateAnswered' in next) dateAnswered = !!next.dateAnswered;
      else if ('due' in next) dateAnswered = next.due != null;
      if ('calendar' in next && next.calendar === false) calMonth = null;
      render();
      if (!silent) onChange(get(), 'set');
    },
    /** Мигнуть шагом, на который пользователь не ответил. */
    nudge(which) {
      const order = steps.filter((id) => id !== 'time');
      const el = node.children[Math.max(0, order.indexOf(which))];
      if (!el) return;
      el.classList.remove('nudge');
      void el.offsetWidth;
      el.classList.add('nudge');
      el.querySelector('button')?.focus();
    },
  };
}
