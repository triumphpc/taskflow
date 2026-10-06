// Совместимость данных: правило «время только для сегодня» живёт в интерфейсе выбора
// срока и не меняет ни формат задач, ни слияние, ни перенос в модели. Только временное
// хранилище в памяти, реальные данные не трогаются.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

const { state, importJson, exportJson } = await import('../js/store.js');
const M = await import('../js/model.js');
const { todayStr, addDaysStr } = await import('../js/core.js');

beforeEach(() => { store.clear(); state.tasks = []; state.deleted = []; });

test('compat: an old task due in 3 days at 09:00 survives import, merge and export unchanged (AC-022)', () => {
  const due = `${addDaysStr(todayStr(), 3)}T09:00`;
  const old = { id: 'old1', title: 'Старая задача', due, priority: 2, done: false, updatedAt: 1000 };
  importJson(JSON.stringify({ app: 'taskflow', tasks: [old] }), 'merge');
  assert.equal(M.getTask('old1').due, due);
  // более свежая копия с другого устройства (с тем же сроком) не ломает время
  importJson(JSON.stringify({ tasks: [{ ...old, title: 'Старая задача 2', updatedAt: 2000 }] }), 'merge');
  assert.equal(M.getTask('old1').due, due);
  assert.equal(M.getTask('old1').title, 'Старая задача 2');
  const out = JSON.parse(exportJson());
  assert.equal(out.tasks.find((t) => t.id === 'old1').due, due);
});

test('compat: scheduleTask to a future date keeps the time and drops delegation as before (AC-022)', () => {
  const t = M.createTask({ title: 'Для агента', due: `${todayStr()}T10:00`, priority: 2 });
  assert.equal(M.setDelegation(t.id, true).agent.status, 'delegated');
  const moved = M.scheduleTask(t.id, addDaysStr(todayStr(), 1));
  assert.equal(moved.due, `${addDaysStr(todayStr(), 1)}T10:00`);
  assert.ok(!moved.agent?.status, 'delegation is released');
});

test('compat: scheduleTask with an explicit null time still produces a date-only due (AC-022)', () => {
  const t = M.createTask({ title: 'x', due: `${todayStr()}T10:00`, priority: 3 });
  assert.equal(M.scheduleTask(t.id, addDaysStr(todayStr(), 2), null).due, addDaysStr(todayStr(), 2));
});
