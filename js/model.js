// Операции над задачами: создание, правка, завершение, повторы, выборки для разделов.

import { state, commit, normalizeTask, tombstone, deriveKind } from './store.js';
import {
  uid, todayStr, addDaysStr, nextMondayStr, datePart, timePart, combineDue,
  isAllDay, parseDue, isOverdue, fromDateStr, toDateStr, nextOccurrence,
} from './core.js';

export const PRIORITIES = {
  1: { id: 1, code: 'P1', name: 'Срочно и важно', hint: 'сделать сейчас', varName: '--p1' },
  2: { id: 2, code: 'P2', name: 'Важно, не срочно', hint: 'запланировать', varName: '--p2' },
  3: { id: 3, code: 'P3', name: 'Срочно, не важно', hint: 'делегировать', varName: '--p3' },
  4: { id: 4, code: 'P4', name: 'Не важно, не срочно', hint: 'потом или никогда', varName: '--p4' },
};

export const REPEAT_LABELS = {
  daily: 'Ежедневно',
  weekly: 'Еженедельно',
  monthly: 'Ежемесячно',
};

export function repeatLabel(repeat) {
  if (!repeat) return '';
  const base = REPEAT_LABELS[repeat.freq] || 'Повтор';
  const n = repeat.interval || 1;
  if (n === 1) return base;
  const unit = repeat.freq === 'daily' ? 'дн.' : repeat.freq === 'weekly' ? 'нед.' : 'мес.';
  return `Каждые ${n} ${unit}`;
}

// Тип пересчитываем на каждой правке — иначе «убрал дату» оставило бы запись
// задачей без даты, то есть в разделе, которого больше нет.
const touch = (t) => { t.updatedAt = Date.now(); t.kind = deriveKind(t); };

// ---------- CRUD ----------

export function createTask(patch = {}) {
  const task = normalizeTask({
    id: uid(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // Метка времени всегда больше перенумерованных весов (ORDER_STEP…N·ORDER_STEP),
    // поэтому новая задача встаёт в конец своей группы — и в авто-, и в ручном режиме.
    order: Date.now(),
    ...patch,
  });
  state.tasks.unshift(task);
  commit('task:create');
  return task;
}

export function getTask(id) {
  return state.tasks.find((t) => t.id === id) || null;
}

export function updateTask(id, patch) {
  const t = getTask(id);
  if (!t) return null;
  Object.assign(t, patch);
  // Повтор без даты бессмыслен — снимаем его.
  if (t.repeat && !t.due) t.repeat = null;
  if (t.repeat && !t.repeat.anchor) t.repeat.anchor = datePart(t.due);
  touch(t);
  commit('task:update');
  return t;
}

export function deleteTask(id) {
  const i = state.tasks.findIndex((t) => t.id === id);
  if (i < 0) return null;
  const [t] = state.tasks.splice(i, 1);
  tombstone(t.id);
  commit('task:delete');
  return t;
}

export function clearCompleted() {
  const done = state.tasks.filter((t) => t.done);
  const at = Date.now();
  done.forEach((t) => tombstone(t.id, at));
  state.tasks = state.tasks.filter((t) => !t.done);
  commit('tasks:clear-completed');
  return done.length;
}

// ---------- Повторы ----------

// ---------- Завершение ----------

/**
 * Переключает готовность. Для повторяющейся задачи вместо закрытия
 * переносит её на следующую дату серии и снимает галочки с подзадач.
 * Возвращает {kind:'done'|'undone'|'rescheduled', nextDue?}.
 */
export function toggleDone(id) {
  const t = getTask(id);
  if (!t) return null;

  if (t.done) {
    t.done = false;
    t.completedAt = null;
    touch(t);
    commit('task:undone');
    return { kind: 'undone', task: t };
  }

  if (t.repeat && t.due) {
    const base = datePart(t.due);
    const nextDate = nextOccurrence(base, t.repeat, todayStr() > base ? todayStr() : base);
    t.completions = [...(t.completions || []), { at: Date.now(), due: t.due }].slice(-50);
    t.due = combineDue(nextDate, t.repeat.time || timePart(t.due));
    t.subtasks = t.subtasks.map((s) => ({ ...s, done: false }));
    t.notifiedFor = null;
    touch(t);
    commit('task:rescheduled');
    return { kind: 'rescheduled', task: t, nextDue: t.due };
  }

  t.done = true;
  t.completedAt = Date.now();
  touch(t);
  commit('task:done');
  return { kind: 'done', task: t };
}

// ---------- Подзадачи ----------

export function addSubtask(taskId, title) {
  const t = getTask(taskId);
  if (!t || !title.trim()) return null;
  const sub = { id: uid(), title: title.trim(), done: false };
  t.subtasks.push(sub);
  touch(t);
  commit('subtask:add');
  return sub;
}

export function toggleSubtask(taskId, subId) {
  const t = getTask(taskId);
  const s = t?.subtasks.find((x) => x.id === subId);
  if (!s) return;
  s.done = !s.done;
  touch(t);
  commit('subtask:toggle');
}

export function renameSubtask(taskId, subId, title) {
  const t = getTask(taskId);
  const s = t?.subtasks.find((x) => x.id === subId);
  if (!s) return;
  s.title = title;
  touch(t);
  commit('subtask:rename');
}

export function removeSubtask(taskId, subId) {
  const t = getTask(taskId);
  if (!t) return;
  t.subtasks = t.subtasks.filter((x) => x.id !== subId);
  touch(t);
  commit('subtask:remove');
}

// ---------- Быстрое планирование ----------

/** Пресеты для чипов «когда»: возвращают 'YYYY-MM-DD'. */
export const QUICK_DATES = {
  today: () => todayStr(),
  tomorrow: () => addDaysStr(todayStr(), 1),
  in2days: () => addDaysStr(todayStr(), 2),
  nextWeek: () => nextMondayStr(),
};

/** Ставит дату, сохраняя уже выбранное время (если оно было). */
export function scheduleTask(id, dateStr, time = undefined) {
  const t = getTask(id);
  if (!t) return null;
  const keepTime = time === undefined ? timePart(t.due) : time;
  return updateTask(id, { due: combineDue(dateStr, keepTime) });
}

// ---------- Ручной порядок (drag & drop) ----------

/** Шаг между соседями при перенумерации — оставляет запас на вставки. */
const ORDER_STEP = 1000;

// ---------- Выборки ----------

export const VIEWS = {
  today: { id: 'today', title: 'Сегодня', icon: '☀︎' },
  inbox: { id: 'inbox', title: 'Входящие', icon: '✉' },
  tomorrow: { id: 'tomorrow', title: 'Завтра', icon: '→' },
  upcoming: { id: 'upcoming', title: 'Ближайшие', icon: '▤' },
  all: { id: 'all', title: 'Все задачи', icon: '≡' },
  done: { id: 'done', title: 'Выполнено', icon: '✓' },
};

const byPriorityThenTime = (a, b) => {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const ta = timePart(a.due), tb = timePart(b.due);
  if (ta && tb && ta !== tb) return ta < tb ? -1 : 1;
  if (ta && !tb) return -1;
  if (!ta && tb) return 1;
  return (a.order || 0) - (b.order || 0);
};

// Сначала дата, потом время внутри дня, потом приоритет. Дату сравнивать
// обязательно: группы «Просрочено» и «Позже» собирают разные дни, и без этого
// они выстраивались по одному приоритету — то есть в порядке добавления.
const byTimeThenPriority = (a, b) => {
  const da = datePart(a.due), db = datePart(b.due);
  if (da && db && da !== db) return da < db ? -1 : 1;
  const ta = timePart(a.due), tb = timePart(b.due);
  if (ta && tb && ta !== tb) return ta < tb ? -1 : 1;
  if (ta && !tb) return -1;
  if (!ta && tb) return 1;
  return a.priority - b.priority;
};

const byOrder = (a, b) => (a.order || 0) - (b.order || 0);

export const isManualSort = () => state.settings.sortMode === 'manual';

/**
 * Сортирует список задач группы. В ручном режиме главный ключ — `order`
 * (его двигает перетаскивание), автоматический порядок остаётся тай-брейкером.
 */
const sortGroup = (list, cmp) =>
  list.sort(isManualSort() ? (a, b) => byOrder(a, b) || cmp(a, b) : cmp);

// Активные задачи — без выполненных и без неразобранных входящих. Входящее
// не задача: пока ему не назначили день, в разделах задач ему делать нечего.
const active = () => state.tasks.filter((t) => !t.done && t.kind !== 'inbox');

/** Неразобранные входящие: от свежего к старому по времени источника. */
export function inboxItems() {
  return state.tasks
    .filter((t) => !t.done && t.kind === 'inbox')
    .sort((a, b) => (b.source?.at || b.createdAt || 0) - (a.source?.at || a.createdAt || 0));
}

/**
 * Превращает входящее в задачу: назначает день, всё остальное — source,
 * agentNotes, приоритет — остаётся при записи.
 */
export function inboxToTask(id, dateStr, time = null) {
  const t = getTask(id);
  if (!t || t.kind !== 'inbox') return null;
  // Умолчания нет намеренно: раньше здесь стоял todayStr(), и «Сегодня» набивался
  // записями, которые пользователь всего лишь открыл на разбор.
  if (!dateStr) return null;
  return scheduleTask(id, dateStr, time);
}

/**
 * Задачи раздела, сгруппированные для отрисовки.
 * Возвращает [{key, title, tone?, tasks:[]}].
 */
export function groupsForView(viewId) {
  const today = todayStr();
  const tomorrow = addDaysStr(today, 1);

  if (viewId === 'today') {
    const overdue = sortGroup(active().filter((t) => t.due && datePart(t.due) < today), byTimeThenPriority);
    const todays = sortGroup(active().filter((t) => t.due && datePart(t.due) === today), byTimeThenPriority);
    return [
      overdue.length && { key: 'overdue', title: 'Просрочено', tone: 'overdue', tasks: overdue },
      { key: 'today', title: 'Сегодня', tasks: todays, dropDue: today },
    ].filter(Boolean);
  }

  if (viewId === 'tomorrow') {
    const list = sortGroup(active().filter((t) => t.due && datePart(t.due) === tomorrow), byTimeThenPriority);
    return [{ key: 'tomorrow', title: 'Завтра', tasks: list, dropDue: tomorrow }];
  }

  if (viewId === 'upcoming') {
    const future = active()
      .filter((t) => t.due && datePart(t.due) > today)
      .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
    const byDay = new Map();
    for (const t of future) {
      const d = datePart(t.due);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(t);
    }
    return Array.from(byDay, ([day, tasks]) => ({
      key: day, title: day, isDay: true, dropDue: day,
      tasks: sortGroup(tasks, byTimeThenPriority),
    }));
  }

  if (viewId === 'all') {
    const buckets = [
      { key: 'overdue', title: 'Просрочено', tone: 'overdue', tasks: [] },
      { key: 'today', title: 'Сегодня', tasks: [], dropDue: today },
      { key: 'tomorrow', title: 'Завтра', tasks: [], dropDue: tomorrow },
      { key: 'later', title: 'Позже', tasks: [] },
    ];
    const idx = Object.fromEntries(buckets.map((b, i) => [b.key, i]));
    for (const t of active()) {
      const d = datePart(t.due);
      const key = d < today ? 'overdue' : d === today ? 'today' : d === tomorrow ? 'tomorrow' : 'later';
      buckets[idx[key]].tasks.push(t);
    }
    for (const b of buckets) sortGroup(b.tasks, byTimeThenPriority);
    return buckets.filter((b) => b.tasks.length);
  }

  if (viewId === 'done') {
    const list = state.tasks.filter((t) => t.done)
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
    return [{ key: 'done', title: 'Выполнено', tasks: list, noDrag: true }];
  }

  return [];
}

// ---------- Перетаскивание ----------

/**
 * Переносит задачу в другую группу списка: это просто смена даты, время дня
 * сохраняется. Ветка `dropDue === null` (снять дату вместе с повтором) сейчас
 * недостижима — групп без даты не осталось, задача возвращается во «Входящие»
 * снятием даты в редакторе; оставлена как общая логика переноса.
 * `dropDue`: 'YYYY-MM-DD' | null. Возвращает задачу либо null, если ничего не изменилось.
 */
export function moveToGroupDate(id, dropDue) {
  const t = getTask(id);
  if (!t) return null;
  if (dropDue === null) {
    if (!t.due) return null;
    return updateTask(id, { due: null, repeat: null });
  }
  if (datePart(t.due) === dropDue) return null;
  return scheduleTask(id, dropDue);
}

/**
 * Фиксирует текущий автоматический порядок в поле `order`, чтобы при переходе
 * на ручную сортировку список остался на месте. Проходит по «Все задачи»
 * и «Выполнено» — вместе они покрывают каждую задачу ровно один раз.
 */
function freezeCurrentOrder() {
  for (const g of [...groupsForView('all'), ...groupsForView('done')]) {
    g.tasks.forEach((t, i) => { t.order = (i + 1) * ORDER_STEP; });
  }
}

/**
 * Записывает ручной порядок для перечисленных списков (`[[id, id, …], …]`).
 * Первый вызов переводит приложение в режим ручной сортировки.
 */
export function applyManualOrder(lists) {
  if (!isManualSort()) {
    freezeCurrentOrder();
    state.settings.sortMode = 'manual';
  }
  for (const ids of lists) {
    ids.forEach((id, i) => {
      const t = getTask(id);
      if (t) { t.order = (i + 1) * ORDER_STEP; touch(t); }
    });
  }
  commit('tasks:reorder');
}

/** Переключает режим сортировки. Возвращает новый режим. */
export function toggleSortMode() {
  if (!isManualSort()) freezeCurrentOrder();
  state.settings.sortMode = isManualSort() ? 'auto' : 'manual';
  commit('settings:sort-mode');
  return state.settings.sortMode;
}

/** Счётчики для навигации. */
export function counts() {
  const today = todayStr();
  const tomorrow = addDaysStr(today, 1);
  const a = active();
  return {
    today: a.filter((t) => t.due && datePart(t.due) <= today).length,
    tomorrow: a.filter((t) => t.due && datePart(t.due) === tomorrow).length,
    upcoming: a.filter((t) => t.due && datePart(t.due) > today).length,
    inbox: inboxItems().length,
    all: a.length,
    done: state.tasks.filter((t) => t.done).length,
  };
}

/**
 * Одна очередь планирования: сначала неразобранные входящие, затем то, что
 * «висит» на сегодня — просроченное и назначенное на сегодня. Разбор входящих
 * не отдельный обряд, а начало того же прохода: сперва решаем, что вообще
 * берём в работу, потом раскладываем по времени.
 *
 * Ветки «задачи без даты» здесь больше нет: активная запись без даты — это
 * входящее, и она уже в начале очереди.
 */
export function momentsCandidates() {
  const today = todayStr();
  const rank = (t) => (datePart(t.due) < today ? 0 : 1);
  const tasks = active()
    .filter((t) => datePart(t.due) <= today)
    .sort((a, b) => rank(a) - rank(b) || a.priority - b.priority || (a.order || 0) - (b.order || 0));
  return [...inboxItems(), ...tasks];
}

/** Задачи со временем, для которых пора показать напоминание. */
export function dueReminders(now = new Date()) {
  return active().filter((t) => {
    if (!t.due || isAllDay(t.due)) return false;
    if (t.notifiedFor === t.due) return false;
    const at = parseDue(t.due).getTime();
    return at <= now.getTime() && now.getTime() - at < 12 * 3600 * 1000;
  });
}

export function markNotified(id) {
  const t = getTask(id);
  if (!t) return;
  t.notifiedFor = t.due;
  commit('task:notified');
}

export { isOverdue, nextOccurrence };
