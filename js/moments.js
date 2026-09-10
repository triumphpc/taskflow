// Moments — планирование дня. Проводит по задачам, которые «висят» на сегодня,
// и для каждой спрашивает: когда делать и какой приоритет.

import { h, clear, fmtDue, fmtDayLabel, fmtDateShort, timePart, combineDue, plural, linkify } from './util.js';
import { state } from './store.js';
import * as M from './model.js';
import { openSheet, toast, ctx, openEditor } from './ui.js';

const DAY_PARTS = [
  ['morning', 'Утро'],
  ['noon', 'Обед'],
  ['afternoon', 'День'],
  ['evening', 'Вечер'],
];

/** Заметку в карточке показываем куском. Режем по границе слова: адрес пробелов
 *  внутри не содержит, поэтому так ссылка на срезе не превратится в битую. */
function clampNotes(notes, max = 220) {
  if (notes.length <= max) return notes;
  const cut = notes.slice(0, max);
  const space = cut.search(/\s\S*$/);
  return (space > max * 0.6 ? cut.slice(0, space) : cut) + '…';
}

export function openMoments() {
  const queue = M.momentsCandidates();

  if (!queue.length) {
    const closeBtn = h('button', { class: 'btn btn-primary' }, 'Закрыть');
    const emptySheet = openSheet({
      title: 'Moments',
      bodyNodes: h('div', { class: 'empty' },
        h('div', { class: 'big' }, '◎'),
        h('p', { style: { fontWeight: '600', color: 'var(--text-dim)', marginBottom: '4px' } }, 'Планировать нечего'),
        h('p', null, 'Нет ни просроченных задач, ни задач на сегодня, ни задач без даты.')),
      footNodes: [h('span', { class: 'spacer' }), closeBtn],
    });
    closeBtn.addEventListener('click', () => emptySheet.close());
    return;
  }

  let index = 0;
  const stats = { planned: 0, done: 0, skipped: 0, deleted: 0 };

  const body = h('div');
  const progress = h('i', { style: { width: '0%' } });
  const footInfo = h('span', { class: 'muted', style: { fontSize: '12.5px' } });

  const sheetRef = openSheet({
    title: 'Moments · планирование дня',
    bodyNodes: [h('div', { class: 'moments-progress' }, progress), body],
    footNodes: [
      footInfo,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-ghost', onclick: () => { stats.skipped++; next(); } }, 'Пропустить'),
    ],
    onClose: () => ctx.refresh(),
  });

  const next = () => { index++; step(); };

  function applyAndNext(patch, message) {
    const task = queue[index];
    M.updateTask(task.id, patch);
    stats.planned++;
    if (message) toast(message, { ms: 2200 });
    next();
  }

  function step() {
    clear(body);
    progress.style.width = `${Math.round((index / queue.length) * 100)}%`;

    if (index >= queue.length) return finish();

    const task = queue[index];
    footInfo.textContent = `${index + 1} из ${queue.length}`;

    // --- Карточка задачи
    const card = h('div', { class: 'moments-task' },
      h('h3', null, task.title || 'Без названия'),
      task.notes ? h('p', { class: 'notes' }, linkify(clampNotes(task.notes))) : null,
      h('p', { class: 'cur' },
        task.due ? `Сейчас: ${fmtDue(task.due)}` : 'Сейчас: без даты',
        task.subtasks.length ? ` · ${task.subtasks.length} ${plural(task.subtasks.length, 'подзадача', 'подзадачи', 'подзадач')}` : '',
        task.repeat ? ` · ${M.repeatLabel(task.repeat)}` : ''));

    // --- Приоритет
    const prioChips = h('div', { class: 'chips' });
    const drawPrio = () => {
      clear(prioChips);
      for (const p of Object.values(M.PRIORITIES)) {
        prioChips.append(h('button', {
          class: `chip${task.priority === p.id ? ' active' : ''}`,
          title: p.name,
          onclick: () => { M.updateTask(task.id, { priority: p.id }); drawPrio(); },
        }, `${p.code} · ${p.name}`));
      }
    };
    drawPrio();

    // --- Когда
    const whenWrap = h('div', { class: 'when-grid' });
    const dayPartsWrap = h('div', { class: 'daypart-grid hidden' });

    const todayBtn = h('button', {
      class: 'when-btn',
      style: { width: '100%' },
      'aria-expanded': 'false',
      onclick: () => {
        const shown = dayPartsWrap.classList.toggle('hidden');
        todayBtn.setAttribute('aria-expanded', shown ? 'false' : 'true');
      },
    }, 'Сегодня', h('small', null, 'выбрать время дня ▾'));

    for (const [key, label] of DAY_PARTS) {
      const time = state.settings.dayParts[key];
      dayPartsWrap.append(h('button', {
        class: 'when-btn',
        onclick: () => applyAndNext({ due: combineDue(M.QUICK_DATES.today(), time) }, `${label}, ${time}`),
      }, label, h('small', null, time)));
    }

    const mk = (label, dateFn, sub) => h('button', {
      class: 'when-btn',
      onclick: () => {
        const date = dateFn();
        applyAndNext({ due: combineDue(date, timePart(task.due)) }, fmtDayLabel(date));
      },
    }, label, sub ? h('small', null, sub) : null);

    whenWrap.append(
      mk('Завтра', M.QUICK_DATES.tomorrow, fmtDateShort(M.QUICK_DATES.tomorrow())),
      mk('Через 2 дня', M.QUICK_DATES.in2days, fmtDateShort(M.QUICK_DATES.in2days())),
      mk('На следующей неделе', M.QUICK_DATES.nextWeek, fmtDateShort(M.QUICK_DATES.nextWeek())),
      h('button', {
        class: 'when-btn',
        onclick: () => applyAndNext({ due: null, repeat: null }, 'Убрано из расписания'),
      }, 'Без даты', h('small', null, 'вернуться к ней позже')));

    // --- Прочие действия
    const actions = h('div', { class: 'chips', style: { marginTop: '14px' } },
      h('button', {
        class: 'chip',
        onclick: () => {
          const res = M.toggleDone(task.id);
          stats.done++;
          toast(res?.kind === 'rescheduled' ? `Повтор: перенесено на ${fmtDue(res.nextDue).toLowerCase()}` : 'Выполнено', { ms: 2000 });
          next();
        },
      }, '✓ Уже сделано'),
      h('button', { class: 'chip', onclick: () => { sheetRef.close(); openEditor(task.id); } }, '✎ Открыть задачу'),
      h('button', {
        class: 'chip',
        style: { color: 'var(--danger)' },
        onclick: () => { M.deleteTask(task.id); stats.deleted++; toast('Удалено', { ms: 2000 }); next(); },
      }, '✕ Не актуально'));

    body.append(
      card,
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Приоритет'), prioChips),
      h('div', { class: 'field' },
        h('span', { class: 'field-label' }, 'Когда делать'),
        todayBtn, dayPartsWrap,
        h('div', { style: { height: '7px' } }),
        whenWrap),
      actions);
  }

  function finish() {
    progress.style.width = '100%';
    footInfo.textContent = '';
    clear(body);
    body.append(h('div', { class: 'empty' },
      h('div', { class: 'big' }, '✓'),
      h('p', { style: { fontWeight: '600', color: 'var(--text-dim)', marginBottom: '6px' } }, 'День распланирован'),
      h('p', null, [
        stats.planned ? `запланировано ${stats.planned}` : null,
        stats.done ? `выполнено ${stats.done}` : null,
        stats.skipped ? `пропущено ${stats.skipped}` : null,
        stats.deleted ? `удалено ${stats.deleted}` : null,
      ].filter(Boolean).join(' · ') || 'ничего не изменилось'),
      h('button', {
        class: 'btn btn-primary', style: { marginTop: '14px' },
        onclick: () => { sheetRef.close(); ctx.setView('today'); },
      }, 'Перейти к сегодняшним')));
  }

  step();
}
