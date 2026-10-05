// New MCP tools and the agent-block side effects of task_done/task_edit/task_snooze,
// against a real serve.mjs in a temp dir (AC-016, AC-017, AC-018, AC-027).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startServe } from './helpers/serve.mjs';
import { todayStr, addDaysStr } from '../js/core.js';

const TODAY = todayStr();
const TOMORROW = addDaysStr(TODAY, 1);
const blk = (status, o = {}) => ({ status, claimedAt: null, finishedAt: null, claimToken: null, at: 1000, ...o });
const rec = (id, o = {}) => ({ id, title: `Task ${id}`, notes: 'note', due: TODAY, done: false, kind: 'task', priority: 4, updatedAt: 100, createdAt: 1, order: 1, ...o });

const server = await startServe({
  tasks: [
    rec('q-today', { agent: blk('delegated', { at: 20 }) }),
    rec('q-over', { due: addDaysStr(TODAY, -2), priority: 2, agent: blk('delegated', { at: 10 }) }),
    rec('q-future', { due: TOMORROW, agent: blk('delegated') }),
    rec('q-nodue', { due: null, agent: blk('delegated') }),
    rec('q-plain'),
    rec('q-stale', { agent: blk('in_progress', { claimedAt: 5, claimToken: 'old' }) }),
  ],
});
process.env.TASKFLOW_API = server.url;
process.env.TASKFLOW_TOKEN = server.token;
const { TOOLS } = await import('../mcp.mjs');
const tool = (n) => TOOLS.find((t) => t.name === n);
const call = async (n, args) => { try { return { ok: true, text: await tool(n).run(args) }; } catch (e) { return { ok: false, text: e.message }; } };
const task = async (id) => (await server.state()).tasks.find((t) => t.id === id);
const seed = (t) => server.post('/api/sync', { tasks: [t], deleted: [] });
after(() => server.stop());

test('mcp tools: three new tools are appended after the existing ones with the service description', () => {
  const names = TOOLS.map((t) => t.name);
  assert.deepEqual(names.slice(-3), ['agent_queue', 'agent_claim', 'agent_finish']);
  for (const n of names.slice(-3)) assert.match(tool(n).description, /Служебный инструмент демона делегирования, из диалога не вызывать/);
  assert.equal(names.length, 15);
});

test('mcp tools: agent_queue returns today/overdue delegated in order, one JSON line (AC-018, AC-007)', async () => {
  const r = await call('agent_queue', { today: TODAY });
  assert.equal(r.ok, true);
  assert.ok(!r.text.includes('\n'));
  const out = JSON.parse(r.text);
  assert.deepEqual(out.queue.map((t) => t.id), ['q-over', 'q-today']);
  assert.deepEqual(Object.keys(out.queue[0]).sort(), ['delegatedAt', 'due', 'id', 'notes', 'priority', 'title']);
  assert.deepEqual(out.stale.map((t) => t.id), ['q-stale']);
  assert.equal(out.today, TODAY);
});

test('mcp tools: agent_queue with task_id reports existence and state', async () => {
  const yes = JSON.parse((await call('agent_queue', { today: TODAY, task_id: 'q-stale' })).text).task;
  assert.deepEqual(yes, { id: 'q-stale', exists: true, done: false, status: 'in_progress', claimToken: 'old' });
  const no = JSON.parse((await call('agent_queue', { today: TODAY, task_id: 'ghost' })).text).task;
  assert.deepEqual(no, { id: 'ghost', exists: false });
  assert.equal((await call('agent_queue', { today: 'garbage' })).text, 'AGENT_REJECTED:bad_request');
});

test('mcp tools: agent_queue with a later today takes tasks due tomorrow (C8: today comes from the caller)', async () => {
  const out = JSON.parse((await call('agent_queue', { today: TOMORROW })).text);
  assert.ok(out.queue.some((t) => t.id === 'q-future'));
});

test('mcp tools: claim then finish (review) writes status and note; second claim and wrong token refused (AC-018, AC-016)', async () => {
  await seed(rec('c1', { agent: blk('delegated', { at: 5 }) }));
  const claim = await call('agent_claim', { task_id: 'c1', today: TODAY });
  assert.equal(claim.ok, true);
  const { claimToken, task: t } = JSON.parse(claim.text);
  assert.ok(claimToken);
  assert.deepEqual(t, { id: 'c1', title: 'Task c1', notes: 'note', due: TODAY });
  assert.equal((await call('agent_claim', { task_id: 'c1', today: TODAY })).text, 'AGENT_REJECTED:not_delegated');
  assert.equal((await call('agent_finish', { task_id: 'c1', claim_token: 'bad', status: 'review', text: 'x' })).text, 'AGENT_REJECTED:token_mismatch');
  const fin = await call('agent_finish', { task_id: 'c1', claim_token: claimToken, status: 'review', text: 'Готовый текст' });
  assert.deepEqual(JSON.parse(fin.text), { ok: true, status: 'review' });
  const after = await task('c1');
  assert.equal(after.agent.status, 'review');
  assert.equal(after.done, false);
  assert.equal(after.notes, 'note', 'user notes untouched');
  assert.equal(after.agentNotes.at(-1).text, 'Результат агента\nГотовый текст');
});

test('mcp tools: refusals are errors with AGENT_REJECTED:<reason>', async () => {
  assert.equal((await call('agent_claim', { task_id: 'q-future', today: TODAY })).text, 'AGENT_REJECTED:not_due');
  assert.equal((await call('agent_claim', { task_id: 'ghost', today: TODAY })).text, 'AGENT_REJECTED:not_found');
  assert.equal((await call('agent_finish', { task_id: 'q-plain', claim_token: 'x', status: 'review', text: 'x' })).text, 'AGENT_REJECTED:not_in_progress');
  assert.equal((await call('agent_finish', { task_id: 'q-plain', claim_token: 'x', status: 'bogus', text: 'x' })).text, 'AGENT_REJECTED:bad_status');
});

test('mcp tools: agent_finish by_ttl reaps a stale in_progress, refuses a fresh one', async () => {
  const ok = await call('agent_finish', { task_id: 'q-stale', by_ttl: true });
  assert.deepEqual(JSON.parse(ok.text), { ok: true, status: 'failed' });
  await seed(rec('fresh', { agent: blk('in_progress', { claimedAt: Date.now(), claimToken: 't', at: 5 }) }));
  assert.equal((await call('agent_finish', { task_id: 'fresh', by_ttl: true })).text, 'AGENT_REJECTED:not_expired');
});

test('mcp tools: task_done closes a delegated task and clears the status (AC-016)', async () => {
  await seed(rec('d1', { agent: blk('review', { at: 50 }), agentNotes: [{ at: 50, text: 'res' }] }));
  await call('task_done', { task: 'd1' });
  const t = await task('d1');
  assert.equal(t.done, true);
  assert.equal(t.agent.status, null);
  assert.ok(t.agent.at > 50);
  assert.equal(t.agentNotes.length, 1);
  await call('task_done', { task: 'd1', undo: true });
  assert.equal((await task('d1')).done, false);
  assert.equal((await task('d1')).agent.status, null);
});

test('mcp tools: task_done on a repeating series resets to delegated and keeps notes (AC-017)', async () => {
  await seed(rec('r1', { repeat: { freq: 'daily', interval: 1, time: null, anchor: TODAY }, agent: blk('review', { at: 50, finishedAt: 7 }), agentNotes: [{ at: 50, text: 'res' }] }));
  await call('task_done', { task: 'r1' });
  const t = await task('r1');
  assert.equal(t.agent.status, 'delegated');
  assert.equal(t.agent.finishedAt, null);
  assert.equal(t.due, TOMORROW);
  assert.equal(t.agentNotes.length, 1);
});

test('mcp tools: task_edit and task_snooze to the future or without a date clear the block, today/past keep it', async () => {
  await seed(rec('e1', { agent: blk('delegated', { at: 50 }), agentNotes: [{ at: 50, text: 'n' }] }));
  await call('task_edit', { task: 'e1', title: 'renamed' });
  assert.equal((await task('e1')).agent.status, 'delegated');
  await call('task_edit', { task: 'e1', due: 'сегодня' });
  assert.equal((await task('e1')).agent.status, 'delegated');
  await call('task_edit', { task: 'e1', due: 'завтра' });
  assert.equal((await task('e1')).agent.status, null);
  assert.equal((await task('e1')).agentNotes.length, 1);

  await seed(rec('e2', { agent: blk('failed', { at: 50 }) }));
  await call('task_edit', { task: 'e2', clear_due: true });
  assert.equal((await task('e2')).agent.status, null);

  await seed(rec('s1', { agent: blk('delegated', { at: 50 }) }));
  await call('task_snooze', { task: 's1', due: TODAY });
  assert.equal((await task('s1')).agent.status, 'delegated');
  await call('task_snooze', { task: 's1', due: '+3' });
  assert.equal((await task('s1')).agent.status, null);
});

test('mcp tools: tasks without a block are untouched by the side effects (no agent key appears)', async () => {
  await seed(rec('p1'));
  await call('task_snooze', { task: 'p1', due: '+2' });
  await call('task_done', { task: 'p1' });
  assert.ok(!('agent' in (await task('p1'))));
});

test('mcp tools: output of existing tools for tasks with a block only gains agent elements', async () => {
  await seed(rec('o1', { agent: blk('review', { at: 5 }) }));
  const line = await call('task_get', { task: 'o1' });
  assert.match(line.text, /агент: На проверке/);
  assert.match(line.text, /Статус агента: Выполнена агентом \(на проверке\)/);
  await seed(rec('o2', { done: true, agent: blk(null, { at: 5 }) }));
  assert.doesNotMatch((await call('task_get', { task: 'o2' })).text, /агент|Статус агента/);
});

test('mcp tools: mcp.mjs never writes the data file itself (single owner serve.mjs)', async () => {
  const src = await readFile(new URL('../mcp.mjs', import.meta.url), 'utf8');
  assert.ok(!/taskflow\.json/.test(src));
  assert.ok(!/renameSync|rename\(/.test(src));
});

test('mcp tools: block reset matches js/model.js on the same input (parity)', async () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const { state } = await import('../js/store.js');
  const M = await import('../js/model.js');
  const shape = (a) => a && { status: a.status, claimedAt: a.claimedAt, finishedAt: a.finishedAt, claimToken: a.claimToken };
  const base = (id) => rec(id, { agent: blk('review', { at: 50, claimToken: 'x', finishedAt: 4 }) });
  for (const [id, mcpCall, modelCall] of [
    ['m-close', () => call('task_done', { task: 'm-close' }), (t) => M.toggleDone(t.id)],
    ['m-future', () => call('task_snooze', { task: 'm-future', due: '+4' }), (t) => M.scheduleTask(t.id, addDaysStr(TODAY, 4))],
  ]) {
    await seed(base(id));
    await mcpCall();
    state.tasks = [structuredClone(base(id))];
    modelCall(state.tasks[0]);
    assert.deepEqual(shape((await task(id)).agent), shape(state.tasks[0].agent), id);
  }
});
