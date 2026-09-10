// Обёртки над DOM: выборка узлов, создание элементов, ссылки внутри текста.
// Всё, что обращается к странице; чистые функции живут в js/core.js.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Создаёт элемент. h('div', {class:'x', onclick:fn}, 'text', child) */
export function h(tag, attrs = null, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** append, который молча пропускает null/undefined/false (иначе в DOM попадёт «null»). */
export function append(el, ...kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---------- Ссылки внутри текста ----------

// Ловим и полные адреса, и голые «www.». Пробелы, угловые скобки и кавычки
// в адрес не входят — на них выражение и останавливается.
const URL_SRC = "(?:https?://|www\\.)[^\\s<>\"'«»]+";

// Знаки препинания, прилипшие к концу адреса: «смотри https://a.b/c, там…»
const TAIL = /[.,;:!?…"'*_]+$/;
const PAIRS = { ')': '(', ']': '[', '}': '{', '»': '«' };

/** Отрезает от найденного адреса хвост, который на самом деле принадлежит
 *  предложению, а не ссылке. Закрывающую скобку оставляем, только если
 *  открывающая тоже внутри адреса — как в ссылках на вики. */
function trimTail(raw) {
  let url = raw.replace(TAIL, '');
  while (url && PAIRS[url.slice(-1)]) {
    const close = url.slice(-1);
    const open = PAIRS[close];
    if (url.split(open).length >= url.split(close).length) break;
    url = url.slice(0, -1).replace(TAIL, '');
  }
  return url;
}

/** Находит ссылки в тексте: [{ start, end, raw, href }]. `raw` — как написано
 *  в тексте, `href` — то, что можно открыть (у «www.» дописан протокол). */
export function findLinks(text) {
  const src = String(text ?? '');
  if (!src) return [];
  const re = new RegExp(URL_SRC, 'gi');
  const out = [];
  for (let m; (m = re.exec(src));) {
    const raw = trimTail(m[0]);
    // Голый «www.» считаем адресом, только если за ним есть домен с точкой:
    // иначе «www.» посреди фразы утащило бы в ссылку соседние слова.
    if (!/^https?:\/\/[^\s/]/i.test(raw) && !/^www\.[^\s/]+\.[^\s/.]{2}/i.test(raw)) continue;
    out.push({
      start: m.index,
      end: m.index + raw.length,
      raw,
      href: /^www\./i.test(raw) ? 'https://' + raw : raw,
    });
    re.lastIndex = m.index + m[0].length;
  }
  return out;
}

/** Текст → массив узлов, где адреса стали кликабельными <a>. Остальное
 *  остаётся текстовыми узлами, поэтому вставлять в DOM безопасно. */
export function linkify(text) {
  const src = String(text ?? '');
  const links = findLinks(src);
  if (!links.length) return [src];
  const nodes = [];
  let pos = 0;
  for (const l of links) {
    if (l.start > pos) nodes.push(src.slice(pos, l.start));
    nodes.push(h('a', {
      class: 'linkified',
      href: l.href,
      target: '_blank',
      rel: 'noopener noreferrer',
      // Переход делаем сами, а не полагаемся на обработку target="_blank"
      // браузером: в установленном PWA его глушит блокировщик всплывающих окон,
      // а в заметках вид со ссылками прячется прямо в обработчике нажатия —
      // браузер успевает отменить переход. Если открыть вкладку не дали,
      // уходим по адресу в текущем окне.
      onclick: (e) => {
        e.stopPropagation();
        e.preventDefault();
        const win = window.open(l.href, '_blank');
        if (win) { try { win.opener = null; } catch { /* другой источник */ } }
        else location.href = l.href;
      },
      onpointerdown: (e) => e.stopPropagation(),
    }, l.raw));
    pos = l.end;
  }
  if (pos < src.length) nodes.push(src.slice(pos));
  return nodes;
}

/** Символьная позиция в тексте под точкой экрана. Нужна, чтобы клик по заметке
 *  открывал правку с курсором там, куда ткнули, а не в конце текста.
 *  Вернёт null, если браузер не подсказал позицию — тогда курсор идёт в конец. */
export function caretIndexAt(root, clientX, clientY) {
  let node = null;
  let offset = 0;
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(clientX, clientY);
    if (pos) { node = pos.offsetNode; offset = pos.offset; }
  } else if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(clientX, clientY);
    if (range) { node = range.startContainer; offset = range.startOffset; }
  }
  if (!node || !root.contains(node)) return null;

  // Позиция пришла относительно одного текстового узла, а в textarea нужен
  // сквозной индекс — складываем длины всех узлов до него.
  let index = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) {
    if (n === node) return index + offset;
    index += n.nodeValue.length;
  }
  return null;
}
