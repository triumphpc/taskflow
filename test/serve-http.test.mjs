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
