import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { takeSlot } from '../agent/lib/send-slots.mjs';

const MOD = fileURLToPath(new URL('../agent/lib/send-slots.mjs', import.meta.url));
async function runDir() {
  const d = await mkdtemp(join(tmpdir(), 'tf-slots-'));
  await mkdir(join(d, 'slots'), { mode: 0o700 });
  return d;
}

test('send-slots: [send] AC-010 sequential: limit 3 gives slots 1, 2, 3 and then ok:false; a slot is never returned', async () => {
  const d = await runDir();
  try {
    assert.deepEqual(takeSlot(d, 'vk', 3, 'a'), { ok: true, n: 1 });
    assert.deepEqual(takeSlot(d, 'vk', 3, 'b'), { ok: true, n: 2 });
    assert.deepEqual(takeSlot(d, 'vk', 3, 'c'), { ok: true, n: 3 });
    assert.deepEqual(takeSlot(d, 'vk', 3, 'd'), { ok: false });
    assert.deepEqual(takeSlot(d, 'vk', 3, 'e'), { ok: false });
    assert.deepEqual((await readdir(join(d, 'slots'))).sort(), ['vk-1', 'vk-2', 'vk-3']);
    assert.equal(await readFile(join(d, 'slots', 'vk-2'), 'utf8'), 'b', 'tool_use_id inside for debugging');
    assert.equal((await stat(join(d, 'slots', 'vk-1'))).mode & 0o777, 0o600);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('send-slots: kinds are independent (vk does not spend jira)', async () => {
  const d = await runDir();
  try {
    for (let i = 0; i < 3; i++) assert.equal(takeSlot(d, 'vk', 3, 'x').ok, true);
    assert.equal(takeSlot(d, 'vk', 3, 'x').ok, false);
    assert.deepEqual(takeSlot(d, 'jira', 3, 'y'), { ok: true, n: 1 });
    assert.deepEqual(takeSlot(d, 'gitlab_comment', 1, 'y'), { ok: true, n: 1 });
    assert.equal(takeSlot(d, 'gitlab_comment', 1, 'y').ok, false);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('send-slots: [send] AC-023 parallel processes on limit 3 take exactly 3 slots', async () => {
  const d = await runDir();
  try {
    const code = `import { takeSlot } from ${JSON.stringify(MOD)}; const r = takeSlot(${JSON.stringify(d)}, 'vk', 3, 'p' + process.pid); process.stdout.write(JSON.stringify(r));`;
    const results = await Promise.all(Array.from({ length: 12 }, () => new Promise((res, rej) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      c.stdout.on('data', (x) => { out += x; });
      c.on('error', rej);
      c.on('close', () => res(JSON.parse(out)));
    })));
    assert.equal(results.filter((r) => r.ok).length, 3);
    assert.equal(results.filter((r) => !r.ok).length, 9);
    assert.deepEqual(results.filter((r) => r.ok).map((r) => r.n).sort(), [1, 2, 3]);
    assert.equal((await readdir(join(d, 'slots'))).length, 3);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('send-slots: a file-system error other than EEXIST is thrown, not turned into ok:false', async () => {
  const d = await mkdtemp(join(tmpdir(), 'tf-slots-'));
  try {
    assert.throws(() => takeSlot(d, 'vk', 3, 'x'), (e) => e.code === 'ENOENT', 'no slots/ directory');
    assert.throws(() => takeSlot(join(d, 'missing'), 'vk', 3, 'x'), (e) => e.code === 'ENOENT');
    assert.throws(() => takeSlot(d, '../x', 3, 'x'), TypeError);
    assert.throws(() => takeSlot(d, 'vk', 'many', 'x'), TypeError);
    assert.deepEqual(takeSlot(d, 'vk', 0, 'x'), { ok: false });
  } finally { await rm(d, { recursive: true, force: true }); }
});
