// Делегирование задач агенту: данные, правила переходов, слияние, очередь.
// Чистый модуль: без DOM, без модулей Node, без обращения к времени (кроме nextAt по умолчанию).
// Его импортируют все среды исполнения (браузер, sync.mjs, serve.mjs, mcp.mjs, agent/*),
// поэтому правила статуса существуют в единственном экземпляре.

import { datePart, oneLine } from './core.js';

export const AGENT_STATUSES = ['delegated', 'in_progress', 'review', 'needs_info', 'failed'];

/** short — бейдж в строке; full — title, aria-label, редактор. */
export const AGENT_LABELS = {
  delegated:   { short: 'Делегирована',    full: 'Делегирована' },
  in_progress: { short: 'В работе',        full: 'В работе у агента' },
  review:      { short: 'На проверке',     full: 'Выполнена агентом (на проверке)' },
  needs_info:  { short: 'Нужно уточнение', full: 'Нужно уточнение' },
  failed:      { short: 'Не справился',    full: 'Агент не справился' },
};

/** Группы цвета: три, как требует FR-002. */
export const AGENT_TONE = {
  delegated: 'wait', in_progress: 'wait', review: 'ok', needs_info: 'ask', failed: 'ask',
};

export const LIMITS = Object.freeze({
  TTL_MS: 20 * 60 * 1000,   // таймаут 15 минут + 5 минут запаса (ADR-002)
  NOTE_MAX: 4000,           // символов в тексте результата
  REASON_MAX: 300,          // символов в причине failed
});

/**
 * Предел длины ЦЕЛОЙ заметки агента (с префиксом «Результат агента\n» и т. п.). Единая константа:
 * composeNote гарантирует, что не выдаст длиннее, а sync.mjs отбрасывает новые входящие заметки длиннее.
 */
export const NOTE_TEXT_MAX = LIMITS.NOTE_MAX + 64;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/** @returns {object|undefined} undefined, если raw не объект: «ключа нет». */
export function normalizeAgent(raw) {
  if (!isObj(raw)) return undefined;
  return {
    status: AGENT_STATUSES.includes(raw.status) ? raw.status : null,
    claimedAt: num(raw.claimedAt),
    finishedAt: num(raw.finishedAt),
    claimToken: typeof raw.claimToken === 'string' && raw.claimToken ? raw.claimToken : null,
    // Запись без метки проигрывает любой записи с меткой, а не выигрывает «текущим временем».
    at: Number(raw.at) || 0,
  };
}

/** Метка не меньше прежней + 1: собственные метки клиента не идут назад. */
export function nextAt(prevAt, now = Date.now()) {
  return Math.max(Number(now) || 0, (Number(prevAt) || 0) + 1);
}

const block = (status, prev, now, keep = {}) => ({
  status, claimedAt: null, finishedAt: null, claimToken: null, ...keep, at: nextAt(prev?.at, now),
});

/** Новый блок при галке. */
export const delegateBlock = (prev, now) => block('delegated', prev, now);
/** Явный {status:null, at}: ключ не удаляется, снятие всегда видно слиянию (C5). */
export const clearBlock = (prev, now) => block(null, prev, now);
/** Сброс повторяющейся задачи: status 'delegated', токены и finishedAt обнулены. */
export const resetBlock = (prev, now) => block('delegated', prev, now);

/**
 * Единое правило сброса блока при действии пользователя над задачей: его вызывают
 * js/model.js и mcp.mjs, поэтому клиент и MCP ведут себя одинаково.
 * ev: 'close' | 'reopen' | 'repeat' | 'due_change'; для 'due_change' task уже содержит новый due.
 * @returns {object|undefined} undefined — менять нечего. agentNotes не трогает.
 */
export function reconcileAgent(task, ev, { today, now }) {
  const cur = task?.agent;
  if (!cur || !cur.status) return undefined;
  switch (ev) {
    case 'close':
    case 'reopen':
      return clearBlock(cur, now);
    case 'repeat':
      return resetBlock(cur, now);
    case 'due_change':
      return !task.due || datePart(task.due) > today ? clearBlock(cur, now) : undefined;
    default:
      return undefined;
  }
}

/** Задача из «Сегодня» или просроченная, не закрыта, не входящее. */
export function isDelegable(task, today) {
  return !!task && !task.done && task.kind !== 'inbox' && !!task.due && datePart(task.due) <= today;
}

/** Всё, что нужно строке списка. */
export function agentView(task, today) {
  const status = !task.done && AGENT_STATUSES.includes(task.agent?.status) ? task.agent.status : null;
  const checked = status !== null;
  const canToggle = !task.done && (checked || isDelegable(task, today));
  const label = status ? AGENT_LABELS[status] : null;
  return {
    visible: canToggle,
    checked,
    canToggle,
    status,
    tone: status ? AGENT_TONE[status] : null,
    short: label ? label.short : '',
    full: label ? label.full : '',
  };
}

// ---------- Слияние ----------

const atOf = (a) => Number(a?.at) || 0;

/** Победитель по agent.at; при равенстве остаётся cur. Отсутствие ключа во входящем — «не знаю». */
export function mergeAgent(cur, inc) {
  if (!isObj(inc)) return isObj(cur) ? cur : undefined;
  if (!isObj(cur)) return inc;
  return atOf(inc) > atOf(cur) ? inc : cur;
}

const noteKey = (n) => `${Number(n.at) || 0}\u0000${n.text}`;

/** Объединение по паре (at, text), порядок по at, затем по тексту. Только добавляет. */
export function mergeAgentNotes(a, b) {
  const seen = new Map();
  for (const list of [a, b]) {
    if (!Array.isArray(list)) continue;
    for (const n of list) {
      if (!n || !n.text) continue;
      const k = noteKey(n);
      if (!seen.has(k)) seen.set(k, { at: Number(n.at) || 0, text: String(n.text) });
    }
  }
  return [...seen.values()].sort((x, y) => (x.at - y.at) || (x.text < y.text ? -1 : x.text > y.text ? 1 : 0));
}

/**
 * Пользовательские поля — по updatedAt (как раньше: побеждает строго более свежая запись),
 * agent и agentNotes — каждое по своему правилу. Вход не мутируется.
 */
export function mergeTaskRecord(cur, inc) {
  if (!cur) return inc;
  const base = (inc.updatedAt || 0) > (cur.updatedAt || 0) ? inc : cur;
  const result = { ...base };
  const agent = mergeAgent(cur.agent, inc.agent);
  if (agent !== undefined) result.agent = agent;
  if (Array.isArray(cur.agentNotes) || Array.isArray(inc.agentNotes)) {
    const merged = mergeAgentNotes(cur.agentNotes, inc.agentNotes);
    const same = Array.isArray(base.agentNotes) && JSON.stringify(base.agentNotes) === JSON.stringify(merged);
    if (!same) result.agentNotes = merged;
  }
  return result;
}

const clip = (text, max) => {
  const s = String(text ?? '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** Текст заметки: «Результат агента\n…», «Вопрос агента: …», «Агент не справился: …». Не длиннее NOTE_TEXT_MAX. */
export function composeNote(status, text) {
  const full = status === 'review' ? `Результат агента\n${clip(text, LIMITS.NOTE_MAX)}`
    : status === 'needs_info' ? `Вопрос агента: ${clip(text, LIMITS.NOTE_MAX)}`
    : `Агент не справился: ${clip(oneLine(text), LIMITS.REASON_MAX)}`;
  return full.length > NOTE_TEXT_MAX ? `${full.slice(0, NOTE_TEXT_MAX - 1)}…` : full;
}

// ---------- Условные переходы ----------

const FINISH_STATUSES = ['review', 'needs_info', 'failed'];
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

function finishWith(task, status, text, now) {
  const prev = task.agent;
  const agent = { status, claimedAt: prev.claimedAt ?? null, finishedAt: now, claimToken: null, at: nextAt(prev.at, now) };
  const agentNotes = mergeAgentNotes(task.agentNotes, [{ at: now, text: composeNote(status, text) }]);
  return { ok: true, task: { ...task, agent, agentNotes } };
}

/**
 * Условный переход, чистая функция без IO. op: 'claim' | 'finish' | 'reap'.
 * Не меняет updatedAt задачи и пользовательские поля.
 * @returns {{ok:true, task:object} | {ok:false, reason:string}}
 */
export function applyAgentTransition(task, req, now) {
  if (!isObj(req)) return { ok: false, reason: 'bad_request' };
  switch (req.op) {
    case 'claim': {
      if (!nonEmpty(req.today) || !/^\d{4}-\d{2}-\d{2}$/.test(req.today) || !nonEmpty(req.token)) {
        return { ok: false, reason: 'bad_request' };
      }
      if (!task) return { ok: false, reason: 'not_found' };
      if (task.done) return { ok: false, reason: 'closed' };
      if (task.kind === 'inbox' || !task.due) return { ok: false, reason: 'not_due' };
      if (task.agent?.status !== 'delegated') return { ok: false, reason: 'not_delegated' };
      if (datePart(task.due) > req.today) return { ok: false, reason: 'not_due' };
      const agent = { status: 'in_progress', claimedAt: now, finishedAt: null, claimToken: req.token, at: nextAt(task.agent.at, now) };
      return { ok: true, task: { ...task, agent } };
    }
    case 'finish': {
      if (!FINISH_STATUSES.includes(req.status)) return { ok: false, reason: 'bad_status' };
      if (!nonEmpty(req.text)) return { ok: false, reason: 'bad_request' };
      if (!task) return { ok: false, reason: 'not_found' };
      if (task.done) return { ok: false, reason: 'closed' };
      if (task.agent?.status !== 'in_progress') return { ok: false, reason: 'not_in_progress' };
      if (!nonEmpty(req.claimToken) || req.claimToken !== task.agent.claimToken) return { ok: false, reason: 'token_mismatch' };
      return finishWith(task, req.status, req.text, now);
    }
    case 'reap': {
      if (!task) return { ok: false, reason: 'not_found' };
      if (task.agent?.status !== 'in_progress') return { ok: false, reason: 'not_in_progress' };
      const ttl = Number.isFinite(Number(req.ttlMs)) && req.ttlMs !== undefined ? Number(req.ttlMs) : LIMITS.TTL_MS;
      if (now - (Number(task.agent.claimedAt) || 0) < ttl) return { ok: false, reason: 'not_expired' };
      return finishWith(task, 'failed', 'TTL истёк', now);
    }
    default:
      return { ok: false, reason: 'bad_request' };
  }
}

/** Очередь демона и просроченные in_progress из списка задач. */
export function buildQueue(tasks, { today, now }) {
  const queue = [];
  const stale = [];
  for (const t of tasks || []) {
    const status = t?.agent?.status;
    if (status === 'delegated' && isDelegable(t, today)) queue.push(t);
    else if (status === 'in_progress' && !t.done && now - (Number(t.agent.claimedAt) || 0) >= LIMITS.TTL_MS) stale.push(t);
  }
  queue.sort((a, b) =>
    (datePart(a.due) < datePart(b.due) ? -1 : datePart(a.due) > datePart(b.due) ? 1 : 0)
    || (atOf(a.agent) - atOf(b.agent))
    || ((a.priority || 4) - (b.priority || 4)));
  return { queue, stale };
}
