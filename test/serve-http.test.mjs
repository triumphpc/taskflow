import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { startServe, copyServerFiles } from './helpers/serve.mjs';

const TODAY = '2026-10-04';
const rec = (o = {}) => ({ id: 't1', title: 'T', notes: '', due: TODAY, done: false, kind: 'task', priority: 4, updatedAt: 100, createdAt: 1,
  agent: { status: 'delegated', claimedAt: null, finishedAt: null, claimToken: null, at: 10 }, ...o });

test('serve http: ping without token, 401 without token on state/sync/transition', async () => {
  const s = await startServe();
  try {
    assert.equal((await fetch(`${s.url}/api/ping`)).status, 200);
    assert.equal((await fetch(`${s.url}/api/state`)).status, 401);
    assert.equal((await s.post('/api/sync', { tasks: [] }, { 'Content-Type': 'application/json' })).status, 401);
    assert.equal((await s.post('/api/agent/transition', { op: 'claim' }, { 'Content-Type': 'application/json' })).status, 401);
  } finally { await s.stop(); }
});

test('serve http: /api/agent/transition 200 / 409 / 400 (AC-018 server part)', async () => {
  const s = await startServe({ tasks: [rec()] });
  try {
    const claim = await s.post('/api/agent/transition', { op: 'claim', id: 't1', today: TODAY });
    assert.equal(claim.status, 200);
    const body = await claim.json();
    assert.equal(body.ok, true);
    assert.equal(body.agent.status, 'in_progress');
    const again = await s.post('/api/agent/transition', { op: 'claim', id: 't1', today: TODAY });
    assert.equal(again.status, 409);
    assert.deepEqual(await again.json(), { ok: false, reason: 'not_delegated' });
    const finish = await s.post('/api/agent/transition', { op: 'finish', id: 't1', claimToken: body.agent.claimToken, status: 'review', text: 'Готово' });
    assert.equal(finish.status, 200);
    assert.equal((await s.state()).tasks[0].agent.status, 'review');
    assert.equal((await s.post('/api/agent/transition', '{bad json')).status, 400);
    assert.equal((await s.post('/api/agent/transition', { op: 'dance' })).status, 400);
    assert.equal((await fetch(`${s.url}/api/agent/transition`, { headers: s.headers })).status, 404);
  } finally { await s.stop(); }
});

test('serve http: other routes unchanged (state, sync)', async () => {
  const s = await startServe({ tasks: [rec({ agent: undefined })] });
  try {
    const st = await s.state();
    assert.equal(st.tasks.length, 1);
    const r = await (await s.post('/api/sync', { tasks: [rec({ id: 't2', updatedAt: 5 })], deleted: [] })).json();
    assert.equal(r.applied, 1);
    assert.equal((await (await fetch(`${s.url}/api/nope`, { headers: s.headers })).json()).error, 'Нет такого метода');
  } finally { await s.stop(); }
});

test('serve http: a copy of server files without node_modules starts and serves transitions (AC-029)', async () => {
  const root = await copyServerFiles();
  const s = await startServe({ tasks: [rec()], root });
  try {
    assert.equal((await s.post('/api/agent/transition', { op: 'claim', id: 't1', today: TODAY })).status, 200);
    assert.equal((await fetch(`${s.url}/js/agent.js`)).status, 200);
  } finally { await s.stop(); await rm(root, { recursive: true, force: true }); }
});

test('serve http: sync.mjs/serve.mjs import only js/agent.js, js/core.js and node: modules (AC-029)', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const f of ['../sync.mjs', '../serve.mjs']) {
    const src = await readFile(new URL(f, import.meta.url), 'utf8');
    const specs = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    for (const sp of specs) assert.ok(sp.startsWith('node:') || sp.startsWith('./'), `${f}: ${sp}`);
  }
});

test('serve http: [send] AC-032 transition accepts journal on finish and reap, answers journals on claim and journalStored; codes unchanged', async () => {
  const note = `Результат агента\nЖурнал действий (срок ${TODAY})\n- выполнено · Jira → OPS-1 · ссылка не получена\n\nтекст`;
  const s = await startServe({ tasks: [rec({ agentNotes: [{ at: 1, text: note, kind: 'journal' }] }), rec({ id: 't2', agent: { status: 'in_progress', claimedAt: 5, finishedAt: null, claimToken: 'old', at: 10 } })] });
  try {
    const claim = await (await s.post('/api/agent/transition', { op: 'claim', id: 't1', today: TODAY })).json();
    assert.equal(claim.journals.length, 1);
    assert.ok(claim.journals[0].text.startsWith(`Журнал действий (срок ${TODAY})`));
    assert.deepEqual(Object.keys(claim.task), ['id', 'title', 'notes', 'due']);
    const journal = { due: TODAY, entries: [{ kind: 'vk', outcome: 'ok', target: 'чат c', ref: 'https://x/1' }] };
    const fin = await s.post('/api/agent/transition', { op: 'finish', id: 't1', claimToken: claim.agent.claimToken, status: 'review', text: 'Готово', journal });
    assert.equal(fin.status, 200);
    assert.equal((await fin.json()).journalStored, true);
    const notes = (await s.state()).tasks.find((t) => t.id === 't1').agentNotes;
    assert.ok(notes.at(-1).text.includes('- выполнено · VK Teams → чат c · https://x/1'));
    const reap = await s.post('/api/agent/transition', { op: 'reap', id: 't2', journal });
    assert.equal(reap.status, 200);
    assert.equal((await reap.json()).journalStored, true);
    assert.equal((await s.post('/api/agent/transition', { op: 'reap', id: 't2', journal })).status, 409);
    // a request without a journal gets the old answer shape
    const plain = await s.post('/api/agent/transition', { op: 'claim', id: 'nope', today: TODAY });
    assert.equal(plain.status, 409);
  } finally { await s.stop(); }
});

test('serve http: [send] AC-028 a synthetic snapshot without any journal reads as before, schema stays 1', async () => {
  const s = await startServe({ tasks: [rec({ agent: undefined })] });
  try {
    const st = await s.state();
    assert.equal((await (await fetch(`${s.url}/api/ping`)).json()).schema, 1);
    assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(`${s.dir}/taskflow.json`, 'utf8')).schema, 1);
    assert.equal(st.tasks.length, 1);
    assert.ok(!('agentNotes' in st.tasks[0]) || st.tasks[0].agentNotes.length === 0);
  } finally { await s.stop(); }
});
