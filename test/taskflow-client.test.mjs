import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskflowClient, TaskflowRejected, TaskflowUnavailable } from '../agent/lib/taskflow-client.mjs';
import { startServe, freePort, REPO } from './helpers/serve.mjs';
import { todayStr } from '../js/core.js';

const SECRET = 'super-secret-mcp-token';
const rpcOk = (obj, extra = {}) => ({ result: { content: [{ type: 'text', text: JSON.stringify(obj) }], ...extra } });
const fakeFetch = (handler) => async (url, init) => {
  const r = await handler(url, init);
  return new Response(r.body ?? JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'Content-Type': r.type ?? 'application/json' } });
};
const client = (handler, o = {}) => createTaskflowClient({ url: 'http://x/mcp', token: SECRET, fetchImpl: fakeFetch(handler), ...o });

test('client: request headers and JSON-RPC body follow the design (M8)', async () => {
  let seen;
  const c = client((url, init) => { seen = { url, init }; return { json: rpcOk({ today: '2026-10-04', queue: [], stale: [] }) }; });
  await c.queue({ today: '2026-10-04', taskId: 'abc' });
  assert.equal(seen.url, 'http://x/mcp');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(seen.init.headers['Content-Type'], 'application/json');
  assert.equal(seen.init.headers.Accept, 'application/json, text/event-stream');
  const body = JSON.parse(seen.init.body);
  assert.deepEqual([body.jsonrpc, body.method, body.params.name], ['2.0', 'tools/call', 'agent_queue']);
  assert.deepEqual(body.params.arguments, { today: '2026-10-04', task_id: 'abc' });
});

test('client: claim/finish/reap map to the tools and parse the JSON line', async () => {
  const calls = [];
  const c = client((url, init) => {
    const b = JSON.parse(init.body); calls.push([b.params.name, b.params.arguments]);
    return { json: rpcOk(b.params.name === 'agent_claim' ? { ok: true, claimToken: 'tk', task: { id: 'i' } } : { ok: true, status: 'review' }) };
  });
  assert.equal((await c.claim({ id: 'i', today: '2026-10-04' })).claimToken, 'tk');
  assert.equal((await c.finish({ id: 'i', claimToken: 'tk', status: 'review', text: 'r' })).status, 'review');
  await c.reap({ id: 'i' });
  assert.deepEqual(calls[0], ['agent_claim', { task_id: 'i', today: '2026-10-04' }]);
  assert.deepEqual(calls[1], ['agent_finish', { task_id: 'i', claim_token: 'tk', status: 'review', text: 'r' }]);
  assert.deepEqual(calls[2], ['agent_finish', { task_id: 'i', by_ttl: true }]);
});

test('client: AGENT_REJECTED gives TaskflowRejected(reason)', async () => {
  const c = client(() => ({ json: { result: { isError: true, content: [{ type: 'text', text: 'AGENT_REJECTED:token_mismatch' }] } } }));
  await assert.rejects(c.finish({ id: 'i', claimToken: 'x', status: 'review', text: 't' }), (e) => e instanceof TaskflowRejected && e.reason === 'token_mismatch');
});

test('client: network error, 5xx, 401, garbage, timeout, tool error give TaskflowUnavailable', async () => {
  const cases = [
    () => { throw new TypeError('fetch failed'); },
    () => ({ status: 502, body: 'bad gateway' }),
    () => ({ status: 503, json: {} }),
    () => ({ status: 401, json: { error: 'no' } }),
    () => ({ body: 'not json at all' }),
    () => ({ json: { jsonrpc: '2.0' } }),
    () => ({ json: { error: { code: -1, message: 'x' } } }),
    () => ({ json: { result: { isError: true, content: [{ type: 'text', text: 'Сервер синхронизации не отвечает' }] } } }),
    () => ({ json: { result: { content: [{ type: 'text', text: 'not json' }] } } }),
  ];
  for (const h of cases) await assert.rejects(client(h).queue({ today: '2026-10-04' }), TaskflowUnavailable);
  const slow = createTaskflowClient({ url: 'http://x', token: SECRET, timeoutMs: 30,
    fetchImpl: (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))) });
  await assert.rejects(slow.queue({ today: '2026-10-04' }), TaskflowUnavailable);
});

test('client: SSE-framed responses are parsed', async () => {
  const c = client(() => ({ type: 'text/event-stream', body: `event: message\ndata: ${JSON.stringify(rpcOk({ ok: true, status: 'failed' }))}\n\n` }));
  assert.equal((await c.reap({ id: 'i' })).status, 'failed');
});

test('client: the token never appears in error messages', async () => {
  const handlers = [() => { throw new Error(`boom ${SECRET}`); }, () => ({ status: 500, body: SECRET }), () => ({ body: SECRET }),
    () => ({ json: { result: { isError: true, content: [{ type: 'text', text: `leak ${SECRET}` }] } } })];
  for (const h of handlers) {
    await assert.rejects(client(h).queue({ today: '2026-10-04' }), (e) => { assert.ok(!e.message.includes(SECRET), e.message); assert.ok(!String(e.stack).includes(SECRET)); return true; });
  }
});

// ---- live against mcp.mjs (needs the SDK; skipped otherwise) ----

let hasSdk = true;
try { await import('@modelcontextprotocol/sdk/server/index.js'); } catch { hasSdk = false; }

test('client: live against mcp.mjs and serve.mjs in a temp env (no initialize needed)', { skip: !hasSdk && 'MCP SDK is not installed' }, async () => {
  const today = todayStr();
  const s = await startServe({ tasks: [{ id: 'live-1', title: 'Live', notes: 'n', due: today, done: false, kind: 'task', priority: 4, updatedAt: 1, createdAt: 1,
    agent: { status: 'delegated', claimedAt: null, finishedAt: null, claimToken: null, at: 5 } }] });
  const dir = await mkdtemp(join(tmpdir(), 'taskflow-mcp-'));
  const port = await freePort();
  const mcpToken = 'live-mcp-token';
  const child = spawn(process.execPath, [join(REPO, 'mcp.mjs')], {
    env: { PATH: process.env.PATH, HOME: dir, TASKFLOW_DATA: dir, TASKFLOW_API: s.url, TASKFLOW_TOKEN: s.token, TASKFLOW_MCP_TOKEN: mcpToken, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume(); child.stderr.resume();
  try {
    const url = `http://127.0.0.1:${port}/mcp`;
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(url, { method: 'GET' }); if (r.status === 405) break; } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    const c = createTaskflowClient({ url, token: mcpToken });
    const q = await c.queue({ today });
    assert.deepEqual(q.queue.map((t) => t.id), ['live-1']);
    const { claimToken } = await c.claim({ id: 'live-1', today });
    await assert.rejects(c.claim({ id: 'live-1', today }), (e) => e instanceof TaskflowRejected && e.reason === 'not_delegated');
    assert.equal((await c.finish({ id: 'live-1', claimToken, status: 'needs_info', text: 'Какой срок?' })).status, 'needs_info');
    assert.equal((await s.state()).tasks[0].agent.status, 'needs_info');
    const bad = createTaskflowClient({ url, token: 'wrong' });
    await assert.rejects(bad.queue({ today }), TaskflowUnavailable);
  } finally { child.kill('SIGKILL'); await s.stop(); await rm(dir, { recursive: true, force: true }); }
});
