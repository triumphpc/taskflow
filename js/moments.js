// Moments — планирование дня. Проводит по задачам, которые «висят» на сегодня,
// и для каждой спрашивает: когда делать и какой приоритет.

import { fmtDue, plural } from './core.js';
import { h, clear, linkify } from './dom.js';
import * as M from './model.js';
import { schedulePicker } from './scheduler.js';
import { openSheet, toast, ctx, openEditor, sourceLine, agentFeed } from './ui.js';

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
        h('p', null, 'Ни входящих на разбор, ни просроченных задач, ни задач на сегодня.')),
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

  function step() {
    clear(body);
    progress.style.width = `${Math.round((index / queue.length) * 100)}%`;

    if (index >= queue.length) return finish();

    const task = queue[index];
    footInfo.textContent = `${index + 1} из ${queue.length}`;

    // --- Карточка задачи
    // У входящего строка «Сейчас: …» бессмысленна — даты у него нет по
    // определению. Вместо неё показываем то, ради чего его вообще открыли:
    // откуда пришло и что успел выяснить агент.
    const isInbox = task.kind === 'inbox';
    const card = h('div', { class: 'moments-task' },
      isInbox ? sourceLine(task) : null,
      h('h3', null, task.title || 'Без названия'),
      isInbox ? agentFeed(task) : null,
      task.notes ? h('p', { class: 'notes' }, linkify(clampNotes(task.notes))) : null,
      isInbox ? null : h('p', { class: 'cur' },
        `Сейчас: ${fmtDue(task.due)}`,
        task.subtasks.length ? ` · ${task.subtasks.length} ${plural(task.subtasks.length, 'подзадача', 'подзадачи', 'подзадач')}` : '',
        task.repeat ? ` · ${M.repeatLabel(task.repeat)}` : ''));

    // --- Приоритет и срок
    // Тот же компонент, что в окне добавления и в карточке: раньше здесь жила
    // третья по счёту копия этих кнопок, и она успела разойтись с остальными.
    const picker = schedulePicker({
      value: { priority: task.priority, due: task.due, dateAnswered: !isInbox },
      onChange: (v) => {
        const patch = {};
        if (v.priority !== null) patch.priority = v.priority;
        if (v.dateAnswered) patch.due = v.due;
        if (v.dateAnswered && !v.due) patch.repeat = null;
        M.updateTask(task.id, patch);
      },
      // Ответ на последний шаг листает очередь дальше — ради этого темпа Moments
      // и существует.
      onDone: () => {
        stats.planned++;
        const t = M.getTask(task.id);
        toast(t?.due ? fmtDue(t.due) : 'Осталось во «Входящих»', { ms: 2000 });
        next();
      },
    });

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
      isInbox
        // Ответа нет — значит и правки нет: запись без даты остаётся входящей
        // и вернётся в очередь следующего прохода.
        ? h('button', { class: 'chip', onclick: () => { stats.skipped++; next(); } }, '↷ Пока не разбираю')
        : null,
      h('button', {
        class: 'chip',
        style: { color: 'var(--danger)' },
        onclick: () => { M.deleteTask(task.id); stats.deleted++; toast('Удалено', { ms: 2000 }); next(); },
      }, '✕ Не актуально'));

    body.append(card, picker.node, actions);
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
