// FROZEN copy of the client logic of the base commit (before agent delegation): normalizeTask without the
// `agent` field and the sync cycle of js/sync.js (send everything, replace local state with the merged result).
// It stands for an old browser tab or PWA that has not picked up the new code. Do not update it.

import { randomUUID } from 'node:crypto';

const uid = () => randomUUID();

function deriveKind(t) {
  return t.done || t.due ? 'task' : 'inbox';
}

/** Допустимые источники входящего. Неизвестный считаем ручным. */
const SOURCE_KINDS = ['gmail', 'telegram', 'web', 'calendar', 'agent', 'manual'];

function normalizeSource(s) {
  if (!s || typeof s !== 'object') return null;
  return {
    kind: SOURCE_KINDS.includes(s.kind) ? s.kind : 'manual',
    url: s.url || null,
    title: s.title || '',
    ref: s.ref || null,
    at: Number(s.at) || Date.now(),
  };
}

/** Приводит задачу из хранилища к текущей форме — на случай старых записей. */
export function normalizeTask(t) {
  return {
    id: t.id || uid(),
    title: t.title || '',
    notes: t.notes || '',
    subtasks: Array.isArray(t.subtasks) ? t.subtasks.map((s) => ({
      id: s.id || uid(), title: s.title || '', done: !!s.done,
    })) : [],
    done: !!t.done,
    completedAt: t.completedAt || null,
    due: t.due || null,
    priority: [1, 2, 3, 4].includes(t.priority) ? t.priority : 4,
    repeat: t.repeat ? {
      freq: t.repeat.freq,                      // daily | weekly | monthly
      interval: Math.max(1, t.repeat.interval || 1),
      time: t.repeat.time || null,              // 'HH:mm' | null
      anchor: t.repeat.anchor || null,          // 'YYYY-MM-DD' — начало серии
    } : null,
    notifiedFor: t.notifiedFor || null,
    completions: Array.isArray(t.completions) ? t.completions : [],
    createdAt: t.createdAt || Date.now(),
    updatedAt: t.updatedAt || Date.now(),
    order: typeof t.order === 'number' ? t.order : Date.now(),
    // Запись без kind, созданная до появления «Входящих», читается по тому же
    // правилу, что и новая: с датой — задача, без даты и не выполнена — входящее.
    kind: deriveKind(t),
    source: normalizeSource(t.source),
    // Лента агента. Живёт отдельно от notes: то, что пишет человек, агент не трогает.
    agentNotes: Array.isArray(t.agentNotes)
      ? t.agentNotes
        .filter((n) => n && n.text)
        .map((n) => ({ at: Number(n.at) || Date.now(), text: String(n.text) }))
      : [],
  };
}

/** One old-client sync cycle against a SyncStore, exactly like js/sync.js: send all, replace with the merge. */
export function createLegacyClient(store, tasks = [], deleted = []) {
  const client = {
    tasks: tasks.map(normalizeTask),
    deleted: [...deleted],
    edit(id, patch) {
      const t = client.tasks.find((x) => x.id === id);
      Object.assign(t, patch, { updatedAt: Date.now() });
    },
    async sync() {
      const data = await store.sync({ tasks: client.tasks, deleted: client.deleted });
      client.tasks = (data.tasks || []).map(normalizeTask);
      client.deleted = (data.deleted || []).filter((d) => d && d.id);
      return data;
    },
  };
  return client;
}
