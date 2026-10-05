// End to end on a temporary stack: model.js (the browser logic) delegates a task, the daemon runs it with
// fake-claude through the real MCP and serve.mjs, the user closes it with the checkbox (AC-008, AC-011,
// AC-016, AC-018, AC-022). Needs the MCP SDK for the real mcp.mjs; skipped without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServe, startMcp, hasMcpSdk } from './helpers/serve.mjs';
import { runOnce } from '../agent/delegation-runner.mjs';
import { createTaskflowClient } from '../agent/lib/taskflow-client.mjs';
import { createLock } from '../agent/lib/lock.mjs';
import { LIMITS_RUN } from '../agent/lib/policy.mjs';
import { todayStr } from '../js/core.js';

const FAKE = fileURLToPath(new URL('./helpers/fake-claude.mjs', import.meta.url));
const sdk = await hasMcpSdk();

const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const { state } = await import('../js/store.js');
const M = await import('../js/model.js');

test('e2e: delegated -> daemon with fake-claude -> review -> closed with the checkbox', { skip: !sdk && 'MCP SDK is not installed' }, async () => {
  const server = await startServe();
  const mcp = await startMcp({ apiUrl: server.url });
  const work = await mkdtemp(join(tmpdir(), 'tf-e2e-'));
  try {
    // 1. the user creates a task and ticks "delegate" in the browser logic, then syncs
    state.tasks = []; state.deleted = [];
    const task = M.createTask({ title: 'Поздравить Олега', notes: 'Два предложения', due: todayStr() });
    assert.equal(M.setDelegation(task.id, true).agent.status, 'delegated');
    await server.post('/api/sync', { tasks: state.tasks, deleted: state.deleted });

    // 2. the daemon wakes up
    const client = createTaskflowClient({ url: mcp.url, token: mcp.token });
    const logs = [];
    const out = await runOnce({
      client, lock: createLock(join(work, 'state')), env: { PATH: process.env.PATH, FAKE_CLAUDE_MODE: 'ok' }, log: (e) => logs.push(e),
      command: process.execPath, argsPrefix: [FAKE], limits: { ...LIMITS_RUN, POLL_MS: 100, TASK_TIMEOUT_MS: 5000, KILL_GRACE_MS: 300 },
    });
    assert.deepEqual(out.processed, [{ id: task.id, status: 'review' }]);
    let onServer = (await server.state()).tasks[0];
    assert.equal(onServer.agent.status, 'review');
    assert.equal(onServer.done, false);
    assert.equal(onServer.notes, 'Два предложения');
    assert.equal(onServer.agentNotes.length, 1);

    // 3. the user's next sync brings the result to the browser, the task stays in the list
    const pulled = await (await server.post('/api/sync', { tasks: state.tasks, deleted: state.deleted })).json();
    state.tasks = pulled.tasks;
    assert.equal(M.getTask(task.id).agent.status, 'review');

    // 4. the user closes it with the ordinary checkbox
    M.toggleDone(task.id);
    await server.post('/api/sync', { tasks: state.tasks, deleted: state.deleted });
    onServer = (await server.state()).tasks[0];
    assert.equal(onServer.done, true);
    assert.equal(onServer.agent.status, null);
    assert.equal(onServer.agentNotes.length, 1, 'the result stays in the feed');

    // 5. nothing left to do: the next wake-up does not start a model
    const again = await runOnce({ client, lock: createLock(join(work, 'state')), env: { PATH: process.env.PATH }, command: '/nonexistent', log: () => {} });
    assert.equal(again.outcome, 'empty');
  } finally { await mcp.stop(); await server.stop(); await rm(work, { recursive: true, force: true }); }
});
