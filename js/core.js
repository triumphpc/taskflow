// Чистые функции: генератор id, даты, форматирование. Обращений к странице
// здесь нет — файл импортируют и браузерное приложение, и mcp.mjs в Node,
// поэтому правила про даты живут в единственном экземпляре.
// Даты хранятся как локальные наивные строки: 'YYYY-MM-DD' (весь день)
// или 'YYYY-MM-DDTHH:mm' (с временем).

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ---------- Даты ----------

export const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
export const WEEKDAYS_FULL = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
export const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const pad2 = (n) => String(n).padStart(2, '0');

/** Date -> 'YYYY-MM-DD' в локальной зоне. */
export function toDateStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 'YYYY-MM-DD' -> Date (локальная полночь). */
export function fromDateStr(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export const todayStr = () => toDateStr(new Date());

export function addDaysStr(dateStr, n) {
  const d = fromDateStr(dateStr);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

/** Ближайший понедельник строго после сегодня. */
export function nextMondayStr(from = todayStr()) {
  const d = fromDateStr(from);
  const shift = (8 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + shift);
  return toDateStr(d);
}

export const isAllDay = (due) => !!due && due.length === 10;
export const datePart = (due) => (due ? due.slice(0, 10) : null);
export const timePart = (due) => (due && due.length > 10 ? due.slice(11, 16) : null);
export const combineDue = (date, time) => (date ? (time ? `${date}T${time}` : date) : null);

/** Наивная локальная строка -> Date. Для «весь день» — локальная полночь. */
export function parseDue(due) {
  if (!due) return null;
  const [datePartStr, timePartStr] = due.split('T');
  const [y, m, d] = datePartStr.split('-').map(Number);
  if (!timePartStr) return new Date(y, m - 1, d);
  const [hh, mm] = timePartStr.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

export function fmtDayLabel(dateStr) {
  const today = todayStr();
  if (dateStr === today) return 'Сегодня';
  if (dateStr === addDaysStr(today, 1)) return 'Завтра';
  if (dateStr === addDaysStr(today, -1)) return 'Вчера';
  const d = fromDateStr(dateStr);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const base = `${WEEKDAYS_SHORT[d.getDay()]}, ${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
  return sameYear ? base : `${base} ${d.getFullYear()}`;
}

/** Всегда «чт, 20 августа» — без подмены на «Сегодня»/«Завтра». */
export function fmtDateShort(dateStr) {
  const d = fromDateStr(dateStr);
  return `${WEEKDAYS_SHORT[d.getDay()]}, ${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
}

/** «Сегодня, 10:00» / «пт, 22 августа». */
export function fmtDue(due) {
  if (!due) return '';
  const day = fmtDayLabel(datePart(due));
  const time = timePart(due);
  return time ? `${day}, ${time}` : day;
}

export function fmtTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Просрочено: время прошло (для «весь день» — день уже закончился). */
export function isOverdue(due, now = new Date()) {
  if (!due) return false;
  if (isAllDay(due)) return datePart(due) < toDateStr(now);
  return parseDue(due).getTime() < now.getTime();
}

/**
 * Следующая дата серии строго после `afterDateStr`.
 * Для месячного повтора день месяца сохраняется и подрезается по длине месяца.
 */
export function nextOccurrence(fromDateStr_, repeat, afterDateStr = todayStr()) {
  const interval = Math.max(1, repeat.interval || 1);
  let cur = fromDateStr_;
  let guard = 0;

  if (repeat.freq === 'monthly') {
    const anchorDay = fromDateStr(fromDateStr_).getDate();
    let d = fromDateStr(fromDateStr_);
    while (toDateStr(d) <= afterDateStr && guard++ < 600) {
      const m = d.getMonth() + interval;
      const y = d.getFullYear() + Math.floor(m / 12);
      const mm = ((m % 12) + 12) % 12;
      const lastDay = new Date(y, mm + 1, 0).getDate();
      d = new Date(y, mm, Math.min(anchorDay, lastDay));
    }
    return toDateStr(d);
  }

  const step = repeat.freq === 'weekly' ? 7 * interval : interval;
  while (cur <= afterDateStr && guard++ < 3000) cur = addDaysStr(cur, step);
  return cur;
}

export function daysBetween(aStr, bStr) {
  return Math.round((fromDateStr(bStr) - fromDateStr(aStr)) / 86400000);
}

/** Схлопывает многострочный текст в одну строку — для мест, где перенос неуместен
 *  (заголовок уведомления, aria-label, summary события). */
export function oneLine(text) {
  return String(text ?? '').replace(/\s*\n+\s*/g, ' ').trim();
}

export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}
