// Оверлей перед шторкой Moments: приветствие, шары рассыпаются, собираются в пирамиду
// и встают в ряд лотка. Данные не читаются и не пишутся: модуль получает очередь и
// текст приветствия аргументами, заголовки задач в оверлей не попадают.

import { h, $ } from './dom.js';
import { buildIntro } from './intro-scene.js';
import { railMetrics, showsNumber } from './rail.js';
import { makeBall } from './moments-rail.js';

let current = null; // промис идущей анимации: оверлей на документе один

/** Анимация разрешена: нет «уменьшить движение» и есть Element.prototype.animate.
 *  Настройка читается при каждом вызове, а не при загрузке модуля. */
export function introAllowed() {
  try {
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    return typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';
  } catch {
    return false;
  }
}

const place = (el, x, y) => { el.style.transform = `translate(${x}px, ${y}px)`; };

/**
 * Показывает оверлей с приветствием и пирамидой и разрешается, когда он снят.
 * Никогда не отклоняется: при ошибке снимает оверлей и разрешается 'skipped'.
 * @param {{priority?: number|null}[]} queue  непустая очередь Moments
 * @param {{date: string, count: string}} [greeting]  тексты приветствия; без них блока нет
 * @returns {Promise<'done'|'skipped'>}
 */
export function playIntro(queue, greeting) {
  if (current) return current;
  current = new Promise((resolve) => {
    let overlay = null;
    let timer = null;
    let anims = [];
    let finished = false;

    const onKey = (e) => {
      // Клавиша не должна дойти до приложения: ни повтор зажатой «m», ни Esc.
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      finish('skipped');
    };
    // Именно click, а не момент касания: иначе click после исчезновения оверлея
    // попал бы в элемент под пальцем.
    const onClick = () => finish('skipped');

    function finish(reason) {
      if (finished) return;
      finished = true;
      document.removeEventListener('keydown', onKey, true);
      clearTimeout(timer);
      for (const a of anims) { try { a.cancel(); } catch { /* уже снята */ } }
      overlay?.remove();
      current = null;
      resolve(reason);
    }

    try {
      const view = { w: window.innerWidth, h: window.innerHeight };
      const railBox = railMetrics(Math.max(1, queue.length), view.w);
      const probe = h('div', { class: 'rail intro-rail' });
      const rack = h('div', { class: 'intro-rack' });
      overlay = h('div', { class: 'intro', 'aria-hidden': 'true' }, rack, probe);
      overlay.style.setProperty('--rail-h', `calc(${railBox.bandH}px + var(--safe-b))`);
      overlay.addEventListener('click', onClick);
      ($('#modal-root') ?? document.body).append(overlay);
      document.addEventListener('keydown', onKey, true);

      // Верх полосы лотка измеряем у пустой пробной полосы: safe-area учтена стилями.
      const intro = buildIntro(queue, { ...view, railTop: probe.getBoundingClientRect().top });
      const total = intro.total;
      const opts = { duration: total, easing: 'linear', fill: 'both' };
      rack.style.transformOrigin = `${intro.origin.x}px ${intro.origin.y}px`;

      if (greeting) {
        const g = intro.greeting;
        const dateEl = h('div', { class: 'intro-date' });
        const countEl = h('div', { class: 'intro-count' });
        dateEl.textContent = greeting.date;
        countEl.textContent = greeting.count;
        const box = h('div', { class: 'intro-greeting' }, dateEl, countEl);
        Object.assign(box.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px` });
        overlay.append(box);
        anims.push(box.animate([
          { offset: 0, opacity: 0 },
          { offset: g.fadeIn[1] / total, opacity: 1 },
          { offset: g.fadeOut[0] / total, opacity: 1 },
          { offset: g.fadeOut[1] / total, opacity: 0 },
          { offset: 1, opacity: 0 },
        ], opts));
      }

      for (const b of intro.balls) {
        const el = makeBall({ n: b.n, colorVar: b.colorVar, d: intro.d, showNum: true });
        rack.append(el);
        anims.push(el.animate(b.keys.map((k) => ({
          offset: k.t / total,
          transform: `translate(${k.x - intro.d / 2}px, ${k.y - intro.d / 2}px) rotate(${k.rot}deg) scale(${k.scale})`,
          opacity: k.opacity,
          easing: k.ease,
        })), opts));
        if (b.numberFade && b.fate === 'rail') {
          const num = el.firstChild;
          const from = b.starts.rail / total;
          anims.push(num.animate([
            { offset: 0, opacity: 1 }, { offset: from, opacity: 1 },
            { offset: (b.starts.rail + 380) / total, opacity: 0 }, { offset: 1, opacity: 0 },
          ], opts));
        }
      }
      anims.push(rack.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.05)' }, { transform: 'scale(1)' }],
        { delay: intro.pulse.at, duration: intro.pulse.duration, easing: 'ease-out' }));

      // Шары лотка без пути из пирамиды и чип «+K» проявляются на своих местах.
      const late = [];
      for (const x of intro.extras) {
        const el = makeBall({ n: x.n, colorVar: x.colorVar, d: intro.railD, showNum: showsNumber(intro.railD) });
        place(el, x.x - intro.railD / 2, x.y - intro.railD / 2);
        late.push(el);
      }
      if (intro.counter) {
        const chip = h('span', { class: 'rail-more' });
        chip.textContent = `+${intro.counter.k}`;
        chip.style.setProperty('--d', `${intro.railD}px`);
        place(chip, intro.counter.x - intro.railD / 2, intro.counter.y - intro.railD / 2);
        late.push(chip);
      }
      const [fromT, toT] = intro.extrasFade;
      for (const el of late) {
        overlay.append(el);
        anims.push(el.animate([
          { offset: 0, opacity: 0 }, { offset: fromT / total, opacity: 0 }, { offset: toT / total, opacity: 1 }, { offset: 1, opacity: 1 },
        ], opts));
      }

      timer = setTimeout(() => finish('done'), intro.total);
    } catch {
      finish('skipped');
    }
  });
  return current;
}
