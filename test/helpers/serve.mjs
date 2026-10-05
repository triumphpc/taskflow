// Starts a real serve.mjs on a free port with a throwaway data dir. `root` lets a test run a copy of
// the server files (no node_modules) to prove it starts without dependencies (NFR-009).
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, cp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const SYNC_TOKEN = 'test-sync-token';

export function freePort() {
  return new Promise((res, rej) => {
    const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
    s.on('error', rej);
  });
}

/** Copy of the server-side files only: serve.mjs, sync.mjs, js/ (no node_modules, no data). */
export async function copyServerFiles() {
  const root = await mkdtemp(join(tmpdir(), 'taskflow-srv-'));
  await cp(join(REPO, 'serve.mjs'), join(root, 'serve.mjs'));
  await cp(join(REPO, 'sync.mjs'), join(root, 'sync.mjs'));
  await cp(join(REPO, 'js'), join(root, 'js'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  return root;
}

export async function startServe({ tasks = [], deleted = [], root = REPO } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'taskflow-data-'));
  await writeFile(join(dir, 'taskflow.json'), JSON.stringify({ schema: 1, rev: 1, updatedAt: 0, tasks, deleted }));
  const port = await freePort();
  const child = spawn(process.execPath, [join(root, 'serve.mjs')], {
    env: { PATH: process.env.PATH, HOME: dir, TASKFLOW_DATA: dir, TASKFLOW_TOKEN: SYNC_TOKEN, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.stdout.resume();
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${url}/api/ping`)).ok) break; } catch { /* not yet */ }
    if (child.exitCode !== null) throw new Error(`serve.mjs exited: ${err}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  const headers = { Authorization: `Bearer ${SYNC_TOKEN}`, 'Content-Type': 'application/json' };
  return {
    url, dir, headers, token: SYNC_TOKEN,
    state: async () => (await fetch(`${url}/api/state`, { headers })).json(),
    post: (path, body, h = headers) => fetch(`${url}${path}`, { method: 'POST', headers: h, body: typeof body === 'string' ? body : JSON.stringify(body) }),
    stop: async () => { child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); },
  };
}

/** Real mcp.mjs on a free port in front of a started serve (needs the MCP SDK). */
export async function startMcp({ apiUrl, syncToken = SYNC_TOKEN, mcpToken = 'test-mcp-token' }) {
  const dir = await mkdtemp(join(tmpdir(), 'taskflow-mcp-'));
  const port = await freePort();
  const child = spawn(process.execPath, [join(REPO, 'mcp.mjs')], {
    env: { PATH: process.env.PATH, HOME: dir, TASKFLOW_DATA: dir, TASKFLOW_API: apiUrl, TASKFLOW_TOKEN: syncToken, TASKFLOW_MCP_TOKEN: mcpToken, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume(); child.stderr.resume();
  const url = `http://127.0.0.1:${port}/mcp`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(url); if (r.status === 405) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { url, token: mcpToken, stop: async () => { child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); } };
}

export async function hasMcpSdk() {
  try { await import('@modelcontextprotocol/sdk/server/index.js'); return true; } catch { return false; }
}
