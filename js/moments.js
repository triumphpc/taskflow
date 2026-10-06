// Moments — планирование дня. Проводит по задачам, которые «висят» на сегодня,
// и для каждой спрашивает: когда делать и какой приоритет.

import { fmtDue, plural } from './core.js';
import { h, clear, linkify } from './dom.js';
import * as M from './model.js';
import { schedulePicker } from './scheduler.js';
import { introAllowed, playIntro } from './moments-intro.js';
import { sheetTitle, greetingParts, createGate, transitionPlan } from './moments-flow.js';
import { ballColorVar } from './pyramid.js';
import { makeBall, createRailView } from './moments-rail.js';
import { openSheet, toast, ctx, openEditor, sourceLine, agentFeed } from './ui.js';

/** Заметку в карточке показываем куском. Режем по границе слова: адрес пробелов
 *  внутри не содержит, поэтому так ссылка на срезе не превратится в битую. */
function clampNotes(notes, max = 220) {
  if (notes.length <= max) return notes;
  const cut = notes.slice(0, max);
  const space = cut.search(/\s\S*$/);
  return (space > max * 0.6 ? cut.slice(0, space) : cut) + '…';
}

let active = false; // одна сессия Moments за раз: от входа до закрытия шторки
let opened = false; // шторка очереди уже открыта

export function openMoments() {
  if (active) return;
  // Очередь и дата считаются один раз: приветствие, заголовок и подвал берут число отсюда.
  const queue = M.momentsCandidates();
  if (!queue.length) return openEmpty();           // без анимации и без сессии
  const now = new Date();
  const title = sheetTitle(now, queue.length);
  const greeting = greetingParts(now, queue.length);
  active = true;
  opened = false;
  // Сбой до открытия шторки не должен оставлять сессию занятой; после открытия её снимет onClose.
  const release = () => { if (!opened) active = false; };
  if (!introAllowed()) {  // «уменьшить движение» или нет WAAPI
    try { return openQueue(queue, { entry: 'static', title }); } catch (e) { release(); throw e; }
  }
  // Причина нужна шторке: после таймера первый шар выкатывается, после пропуска он уже на карточке.
  playIntro(queue, greeting)
    .then((reason) => openQueue(queue, { entry: reason, title }))
    .catch(release);
}

function openEmpty() {
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
}

function openQueue(queue, { entry, title }) {
  let index = 0;
  let rendered = false;
  let shown = -1;         // индекс, который сейчас нарисован
  let badge = null;       // шар на карточке текущей задачи
  let rail = null;        // лоток: только в режиме с движением
  let anims = [];         // анимации перехода, которые надо снять при закрытии
  let watchdog = null;
  const stats = { planned: 0, done: 0, skipped: 0, deleted: 0 };
  const motion = entry !== 'static';
  // Цвета шаров замораживаются при входе: приоритет, поменянный в пикере, лоток не перекрашивает.
  const colors = queue.map((t) => ballColorVar(t.priority));

  const content = h('div');
  const progress = h('i', { style: { width: '0%' } });
  const footInfo = h('span', { class: 'muted', style: { fontSize: '12.5px' } });

  const gate = createGate();

  // Идемпотентно: закрыть можно в любой момент, в том числе посреди перехода.
  function onClose() {
    gate.close();
    clearTimeout(watchdog);
    for (const a of anims) { try { a.cancel(); } catch { /* уже снята */ } }
    rail?.destroy();
    active = false;
    ctx.refresh();
  }

  const skipBtn = h('button', { class: 'btn btn-ghost', onclick: () => answer(() => { stats.skipped++; }) }, 'Пропустить');

  const sheetRef = openSheet({
    title,
    bodyNodes: [h('div', { class: 'moments-progress' }, progress), content],
    footNodes: [
      footInfo,
      h('span', { class: 'spacer' }),
      skipBtn,
    ],
    overlayClass: motion ? 'overlay-rail' : undefined,
    onClose,
  });
  opened = true;
  sheetRef.body.classList.add('moments-body');
  sheetRef.sheet.setAttribute('tabindex', '-1');
  if (motion) {
    rail = createRailView({ overlay: sheetRef.overlay, colors, total: queue.length, viewW: window.innerWidth });
    rail.show(entry === 'done' ? -1 : 0);
  }

  // Данные пишутся до перехода, в момент нажатия. Пока gate занят, второй ответ ничего не делает.
  const go = (kind) => {
    const from = index;
    index++;
    if (!motion) {
      step();
      gate.unlock();
      return;
    }
    runTransition(from, kind);
  };
  const answer = (act) => {
    if (index >= queue.length) return false; // «День распланирован»: отвечать больше не на что
    return gate.lock(() => {
      act();
      go(index + 1 >= queue.length ? 'last' : 'next');
    });
  };

  const discOf = (el) => {
    const r = el.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, d: r.width };
  };
  const ease = 'cubic-bezier(.2, .8, .3, 1)';

  // Вход шторки в режиме с лотком: CSS-анимации отключены, цель полёта уже измерена.
  function enterSheet() {
    anims.push(sheetRef.sheet.animate(
      [{ transform: 'translateY(14px)', opacity: 0 }, { transform: 'none', opacity: 1 }],
      { duration: 180, easing: ease }));
  }

  // Завершение не ждёт .finished по одной: cancel() отклоняет его, поэтому allSettled плюс сторож.
  function whenDone(list, ms, done) {
    let settled = false;
    const settle = () => {
      if (gate.state === 'closed') return;
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      try { done(); } finally {
        setInert(false);
        gate.unlock();
      }
    };
    watchdog = setTimeout(settle, ms + 300);
    Promise.allSettled(list.map((a) => a.finished)).then(settle);
  }

  function setInert(on) {
    const slide = content.firstElementChild;
    if (slide) slide.inert = on;
    skipBtn.inert = on;
  }

  // Сбой анимации: мгновенная смена карточки, ввод снова открыт.
  function recover(ghost, fresh) {
    clearTimeout(watchdog);
    for (const a of [...fresh, ...anims]) { try { a.cancel(); } catch { /* уже снята */ } }
    ghost?.remove();
    if (gate.state === 'closed') return;
    if (shown !== index) step();
    rail?.show(Math.min(index, queue.length)); // лоток сходится с текущим шагом, висящих анимаций нет
    if (badge) badge.style.visibility = '';
    setInert(false);
    gate.unlock();
  }

  // Первый шар после интро: выкатывается из лотка на карточку.
  function runFirst() {
    const fresh = [];
    try {
      const plan = transitionPlan('first');
      step({ hideBadge: true });
      const target = discOf(badge); // до анимации входа шторки: в цели нет сдвига
      enterSheet();
      setInert(true);
      const move = rail.advance(-1, 0, { target, plan });
      fresh.push(...move.anims);
      anims.push(...fresh);
      whenDone(fresh.length ? fresh : anims, plan.total, () => {
        badge.style.visibility = '';
        move.settle();
      });
    } catch {
      recover(null, fresh);
    }
  }

  // Переход: старая карточка уезжает клоном, новая въезжает, шар из лотка садится на неё.
  function runTransition(from, kind) {
    const fresh = [];
    let ghost = null;
    try {
      const plan = transitionPlan(kind);
      const oldSlide = content.firstElementChild;
      const sheetBox = sheetRef.sheet.getBoundingClientRect();
      const bodyBox = sheetRef.body.getBoundingClientRect();
      const oldBox = oldSlide.getBoundingClientRect();
      ghost = h('div', { class: 'moments-ghost', 'aria-hidden': 'true' });
      ghost.inert = true;
      Object.assign(ghost.style, {
        left: `${bodyBox.left - sheetBox.left - sheetRef.sheet.clientLeft}px`, top: `${bodyBox.top - sheetBox.top - sheetRef.sheet.clientTop}px`,
        width: `${bodyBox.width}px`, height: `${bodyBox.height}px`,
      });
      const clone = oldSlide.cloneNode(true); // без обработчиков: ghost ни на что не отвечает
      Object.assign(clone.style, {
        position: 'absolute', left: `${oldBox.left - bodyBox.left}px`, top: `${oldBox.top - bodyBox.top}px`, width: `${oldBox.width}px`,
      });
      ghost.append(clone);
      sheetRef.sheet.append(ghost);

      step();
      const slide = content.firstElementChild;
      setInert(true);
      let target = null;
      if (kind !== 'last') {
        badge.style.visibility = 'hidden';
        target = discOf(badge); // до анимации входа: без сдвига
      }

      fresh.push(clone.animate(
        [{ transform: 'translateX(0)', opacity: 1 }, { transform: `translateX(${Math.round(oldBox.width * 0.35)}px)`, opacity: 0 }],
        { delay: plan.exit.at, duration: plan.exit.dur, easing: ease, fill: 'forwards' }));
      const oldBall = clone.querySelector('.moments-ball');
      if (oldBall) {
        fresh.push(oldBall.animate(
          [{ transform: 'translateX(0) rotate(0deg) scale(1)', opacity: 1 },
            { transform: 'translateX(36px) rotate(360deg) scale(.3)', opacity: 0 }],
          { delay: plan.ghostBall.at, duration: plan.ghostBall.dur, easing: ease, fill: 'forwards' }));
      }
      let move = null;
      if (kind !== 'last') {
        fresh.push(slide.animate(
          [{ transform: 'translateY(24px)', opacity: 0 }, { transform: 'none', opacity: 1 }],
          { delay: plan.enter.at, duration: plan.enter.dur, easing: ease, fill: 'backwards' }));
        move = rail.advance(from, index, { target, plan });
        fresh.push(...move.anims);
      }
      anims.push(...fresh);
      whenDone(fresh, plan.total, () => {
        if (badge) badge.style.visibility = '';
        move?.settle();
        ghost.remove();
      });
    } catch {
      recover(ghost, fresh);
    }
  }

  function step({ hideBadge = false } = {}) {
    clear(content);
    shown = index;
    progress.style.width = `${Math.round((index / queue.length) * 100)}%`;

    if (index >= queue.length) { badge = null; finish(); return resetView(); }

    const task = queue[index];
    footInfo.textContent = `${index + 1} из ${queue.length}`;

    // --- Карточка задачи
    // У входящего строка «Сейчас: …» бессмысленна — даты у него нет по
    // определению. Вместо неё показываем то, ради чего его вообще открыли:
    // откуда пришло и что успел выяснить агент.
    const isInbox = task.kind === 'inbox';
    badge = motion ? makeBall({ n: index + 1, colorVar: colors[index], d: 44, showNum: true }) : null;
    badge?.classList.add('moments-ball');
    if (hideBadge) badge.style.visibility = 'hidden';
    const card = h('div', { class: motion ? 'moments-task has-ball' : 'moments-task' },
      badge,
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
      onChange: (v) => gate.ifIdle(() => {
        const patch = {};
        if (v.priority !== null) badge?.style.setProperty('--c', `var(${ballColorVar(v.priority)})`);
        if (v.priority !== null) patch.priority = v.priority;
        if (v.dateAnswered) patch.due = v.due;
        if (v.dateAnswered && !v.due) patch.repeat = null;
        M.updateTask(task.id, patch);
      }),
      // Ответ на последний шаг листает очередь дальше — ради этого темпа Moments
      // и существует.
      onDone: () => answer(() => {
        stats.planned++;
        const t = M.getTask(task.id);
        toast(t?.due ? fmtDue(t.due) : 'Осталось во «Входящих»', { ms: 2000 });
      }),
    });

    // --- Прочие действия
    const actions = h('div', { class: 'chips', style: { marginTop: '14px' } },
      h('button', {
        class: 'chip',
        onclick: () => answer(() => {
          const res = M.toggleDone(task.id);
          stats.done++;
          toast(res?.kind === 'rescheduled' ? `Повтор: перенесено на ${fmtDue(res.nextDue).toLowerCase()}` : 'Выполнено', { ms: 2000 });
        }),
      }, '✓ Уже сделано'),
      h('button', { class: 'chip', onclick: () => gate.ifIdle(() => { sheetRef.close(); openEditor(task.id); }) }, '✎ Открыть задачу'),
      isInbox
        // Ответа нет — значит и правки нет: запись без даты остаётся входящей
        // и вернётся в очередь следующего прохода.
        ? h('button', { class: 'chip', onclick: () => answer(() => { stats.skipped++; }) }, '↷ Пока не разбираю')
        : null,
      h('button', {
        class: 'chip',
        style: { color: 'var(--danger)' },
        onclick: () => answer(() => { M.deleteTask(task.id); stats.deleted++; toast('Удалено', { ms: 2000 }); }),
      }, '✕ Не актуально'));

    content.append(h('div', { class: 'moments-slide' }, card, picker.node, actions));
    resetView();
  }

  // Новая карточка начинается сверху, фокус остаётся в шторке (первый рендер не трогаем).
  function resetView() {
    if (rendered) {
      sheetRef.body.scrollTop = 0;
      sheetRef.sheet.focus({ preventScroll: true });
    }
    rendered = true;
  }

  function finish() {
    progress.style.width = '100%';
    footInfo.textContent = '';
    skipBtn.style.display = 'none';
    clear(content);
    content.append(h('div', { class: 'empty' },
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

  if (!motion) step();
  else if (entry === 'done') gate.lock(() => runFirst());
  else {
    step();
    rail.show(0);
    enterSheet();
  }
}
