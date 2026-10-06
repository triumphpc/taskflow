// Шары Moments в DOM: общий шар интро, лотка и бейджа на карточке, а также сам лоток.
// Тексты строятся только через textContent, данные задач сюда не попадают: лоток знает
// номера и цвета шаров, но не заголовки.

import { h } from './dom.js';
import { railMetrics, railState, railDiff, flightDelta, showsNumber } from './rail.js';

const EASE = 'cubic-bezier(.4, 0, .2, 1)';

/** Шар: <span class="ball"> с номером на светлом круге.
 *  colorVar: '--p1'..'--p4' или '--ball-none'; showNum: показывать ли номер. */
export function makeBall({ n, colorVar, d, showNum }) {
  const num = h('span', { class: 'ball-num' });
  num.textContent = String(n);
  const el = h('span', { class: showNum ? 'ball' : 'ball no-num' }, num);
  el.style.setProperty('--c', `var(${colorVar})`);
  el.style.setProperty('--d', `${d}px`);
  return el;
}

const at = (el, x) => { el.style.transform = `translate(${x}px, 0px)`; };
const timing = (span, extra) => ({ delay: span.at, duration: span.dur, easing: EASE, ...extra });

/**
 * Лоток внутри оверлея шторки. colors[i] — цвет шара задачи i, замороженный при входе.
 * show(index) рисует состояние сразу; advance(from, to, {target, plan}) описывает переход
 * анимациями и возвращает {anims, settle}; destroy() отменяет анимации и убирает лоток.
 */
export function createRailView({ overlay, colors, total, viewW }) {
  const metrics = railMetrics(total, viewW);
  overlay.style.setProperty('--rail-h', `calc(${metrics.bandH}px + var(--safe-b))`);
  const node = h('div', { class: 'rail' });
  overlay.append(node);

  const balls = new Map(); // n -> элемент шара в лотке
  const anims = [];
  let chip = null;
  let state = null;
  let destroyed = false;

  const spawn = (n, x) => {
    const el = makeBall({ n, colorVar: colors[n - 1], d: metrics.d, showNum: showsNumber(metrics.d) });
    at(el, x);
    node.append(el);
    balls.set(n, el);
    return el;
  };
  const spawnChip = (k, x) => {
    chip = h('span', { class: 'rail-more' });
    chip.style.setProperty('--d', `${metrics.d}px`);
    chip.textContent = `+${k}`;
    at(chip, x);
    node.append(chip);
  };
  // Анимация попадает в список сразу: при сбое show() или destroy() её снимут.
  const track = (a) => { anims.push(a); return a; };
  const cancelAll = () => {
    for (const a of anims.splice(0)) { try { a.cancel(); } catch { /* уже снята */ } }
  };

  function show(index) {
    cancelAll();
    while (node.firstChild) node.firstChild.remove(); // и улетавший шар, которого уже нет в balls
    balls.clear();
    chip = null;
    state = railState(metrics, total, index);
    for (const s of state.slots) spawn(s.n, s.x);
    if (state.counter) spawnChip(state.counter.k, state.counter.x);
  }

  function advanceInner(from, to, { target, plan }) {
    const prev = state ?? railState(metrics, total, from);
    const next = railState(metrics, total, to);
    const diff = railDiff(prev, next);
    state = next; // до анимаций: при сбое состояние уже новое, show(to) перерисует
    const fresh = [];
    let leaving = null;
    let fadedChip = null;

    if (diff.leaving !== null) {
      leaving = balls.get(diff.leaving) ?? null;
      balls.delete(diff.leaving);
      if (leaving && plan.ball) {
        const box = leaving.getBoundingClientRect();
        const f = flightDelta({ cx: box.left + box.width / 2, cy: box.top + box.height / 2, d: metrics.d }, target);
        const x0 = prev.slots.find((s) => s.n === diff.leaving).x;
        fresh.push(track(leaving.animate([
          { transform: `translate(${x0}px, 0px) rotate(0deg) scale(1)` },
          { transform: `translate(${x0 + f.dx}px, ${f.dy}px) rotate(360deg) scale(${f.scale})` },
        ], timing(plan.ball, { fill: 'forwards' }))));
        if (!showsNumber(metrics.d)) {
          // Номер на шаре меньше 36 px скрыт; по пути на карточку он проявляется.
          leaving.classList.remove('no-num');
          fresh.push(track(leaving.firstChild.animate([{ opacity: 0 }, { opacity: 1 }], timing(plan.ball, { fill: 'both' }))));
        }
      } else if (leaving) {
        leaving.remove();
        leaving = null;
      }
    }

    for (const m of diff.moved) {
      const el = balls.get(m.n);
      at(el, m.toX);
      if (plan.shift) {
        fresh.push(track(el.animate([
          { transform: `translate(${m.fromX}px, 0px)` },
          { transform: `translate(${m.toX}px, 0px)` },
        ], timing(plan.shift, { fill: 'backwards' }))));
      }
    }
    for (const e of diff.entering) {
      const el = spawn(e.n, e.x);
      if (plan.pull) fresh.push(track(el.animate([{ opacity: 0 }, { opacity: 1 }], timing(plan.pull, { fill: 'backwards' }))));
    }
    if (diff.counter) {
      if (diff.counter.to > 0 && chip) {
        chip.textContent = `+${diff.counter.to}`;
      } else if (diff.counter.to === 0 && chip) {
        fadedChip = chip;
        chip = null;
        if (plan.pull) fresh.push(track(fadedChip.animate([{ opacity: 1 }, { opacity: 0 }], timing(plan.pull, { fill: 'forwards' }))));
        else { fadedChip.remove(); fadedChip = null; }
      }
    }

    let settled = false;
    return {
      anims: fresh,
      settle() {
        if (settled) return;
        settled = true;
        leaving?.remove();
        fadedChip?.remove();
      },
    };
  }

  function advance(from, to, opts) {
    try {
      return advanceInner(from, to, opts);
    } catch (e) {
      show(to); // лоток всегда сходится с состоянием to, даже если анимацию собрать не удалось
      throw e;
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    cancelAll();
    node.remove();
  }

  return { node, metrics, show, advance, destroy };
}
