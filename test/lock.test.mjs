import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, utimes, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLock } from '../agent/lib/lock.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'tf-lock-'));

test('lock: second acquire is refused while the first is alive, works after release', async () => {
  const d = await tmp();
  try {
    const a = createLock(d); const b = createLock(d, { pid: process.pid });
    assert.equal(a.acquire(), true);
    assert.equal(b.acquire(), false);
    a.release();
    assert.equal(b.acquire(), true);
    b.release();
    await assert.rejects(stat(join(d, 'lock.d')));
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('lock: a lock of a dead process is taken over', async () => {
  const d = await tmp();
  try {
    const dead = spawn(process.execPath, ['-e', '0']);
    await new Promise((r) => dead.on('close', r));
    await mkdir(join(d, 'lock.d'));
    await writeFile(join(d, 'lock.d', 'pid'), `${dead.pid}\n`);
    const l = createLock(d);
    assert.equal(l.acquire(), true);
    l.release();
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('lock: a fresh lock dir without pid counts as held, an old one as abandoned', async () => {
  const d = await tmp();
  try {
    await mkdir(join(d, 'lock.d'));
    assert.equal(createLock(d).acquire(), false);
    const old = new Date(Date.now() - 60_000);
    await utimes(join(d, 'lock.d'), old, old);
    const l = createLock(d);
    assert.equal(l.acquire(), true);
    l.release();
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('lock: release without acquire does not remove someone else\'s lock', async () => {
  const d = await tmp();
  try {
    const a = createLock(d); a.acquire();
    createLock(d).release();
    assert.ok((await stat(join(d, 'lock.d'))).isDirectory());
    a.release();
  } finally { await rm(d, { recursive: true, force: true }); }
});
