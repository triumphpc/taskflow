// Оверлей «бильярдная пирамида» перед шторкой Moments: шары скатываются к центру и
// собираются в пирамиду, по номеру на каждую задачу очереди. Данные не читаются и не
// пишутся: модуль получает очередь аргументом и ничего про задачи не показывает.

import { h, $ } from './dom.js';
import { buildIntro, EASE_ROLL } from './pyramid.js';

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

/**
 * Показывает оверлей с пирамидой и разрешается, когда он снят.
 * Никогда не отклоняется: при ошибке снимает оверлей и разрешается 'skipped'.
 * @param {{priority?: number|null}[]} queue  непустая очередь Moments
 * @returns {Promise<'done'|'skipped'>}
 */
export function playIntro(queue) {
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
      const intro = buildIntro(queue, { w: window.innerWidth, h: window.innerHeight });
      const rack = h('div', { class: 'intro-rack' });
      rack.style.transformOrigin = `${intro.origin.x}px ${intro.origin.y}px`;
      const els = intro.balls.map((b) => {
        const num = h('span', { class: 'ball-num' });
        num.textContent = String(b.n);
        const el = h('span', { class: 'ball' }, num);
        el.style.setProperty('--c', `var(${b.colorVar})`);
        el.style.setProperty('--d', `${intro.d}px`);
        return el;
      });
      rack.append(...els);
      overlay = h('div', { class: 'intro', 'aria-hidden': 'true' }, rack);
      overlay.addEventListener('click', onClick);
      ($('#modal-root') ?? document.body).append(overlay);
      document.addEventListener('keydown', onKey, true);

      intro.balls.forEach((b, i) => {
        const frames = b.path.map((p, k) => ({
          offset: p.offset,
          transform: `translate(${p.x - intro.d / 2}px, ${p.y - intro.d / 2}px) rotate(${p.rot}deg)`,
          easing: k === 0 ? EASE_ROLL : 'ease-out',
        }));
        anims.push(els[i].animate(frames, { delay: b.delay, duration: b.duration, easing: 'linear', fill: 'both' }));
      });
      anims.push(rack.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.05)' }, { transform: 'scale(1)' }],
        { delay: intro.pulse.delay, duration: intro.pulse.duration, easing: 'ease-out' }));

      timer = setTimeout(() => finish('done'), intro.total);
    } catch {
      finish('skipped');
    }
  });
  return current;
}
