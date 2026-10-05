// Test helpers: an isolated SyncStore in a temp dir and a fetch that serves mcp.mjs from it
// in-process. Real data directories are never used.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncStore } from '../../sync.mjs';

export const TEST_TOKEN = 'test-sync-token';

export async function makeStore({ tasks = [], deleted = [], rev = 1 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'taskflow-test-'));
  await writeFile(join(dir, 'taskflow.json'), JSON.stringify({ schema: 1, rev, updatedAt: 0, tasks, deleted }));
  process.env.TASKFLOW_TOKEN = TEST_TOKEN;
  const store = await new SyncStore(dir).init();
  return { store, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Replaces global fetch with a router over `store` (same routes as serve.mjs). Returns restore(). */
export function installFetch(store) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const auth = init.headers?.Authorization || init.headers?.authorization;
    if (!store.checkToken(auth)) return json(401, { error: 'Неверный токен' });
    if (path === '/api/state') return json(200, store.snapshot());
    if (path === '/api/sync') return json(200, await store.sync(JSON.parse(init.body)));
    if (path === '/api/agent/transition' && typeof store.agentTransition === 'function') {
      const r = await store.agentTransition(JSON.parse(init.body));
      return json(r.ok ? 200 : 409, r);
    }
    return json(404, { error: 'Нет такого метода' });
  };
  return () => { globalThis.fetch = original; };
}
