import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readdir, stat, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backup, counts, compare, checkSnapshot } from '../scripts/deploy-check.mjs';

const CLI = fileURLToPath(new URL('../scripts/deploy-check.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/legacy-tasks.json', import.meta.url));
const mk = async () => mkdtemp(join(tmpdir(), 'tf-deploy-'));
const write = async (dir, name, obj) => { const f = join(dir, name); await writeFile(f, JSON.stringify(obj)); return f; };
const task = (id, o = {}) => ({ id, title: id, updatedAt: 1, createdAt: 1, ...o });

test('deploy-check: counts reports total/open/done/deleted', async () => {
  const d = await mk();
  try {
    const f = await write(d, 'a.json', { tasks: [task('a'), task('b', { done: true }), task('c')], deleted: [{ id: 'x', at: 1 }] });
    assert.deepEqual(counts(f), { total: 3, open: 2, done: 1, deleted: 1 });
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('deploy-check: backup makes a 0600 copy and keeps the five latest (AC-028)', async () => {
  const d = await mk();
  try {
    await write(d, 'taskflow.json', { tasks: [task('a'), task('b')], deleted: [] });
    let last;
    for (let i = 0; i < 7; i++) last = backup(d, { keep: 5, now: new Date(Date.UTC(2026, 9, 4, 9, 0, i)) });
    const files = (await readdir(join(d, 'backups'))).sort();
    assert.equal(files.length, 5);
    assert.equal(files[0], 'taskflow-20261004T090002000Z.json');
    assert.equal((await stat(last.file)).mode & 0o777, 0o600);
    assert.equal(last.total, 2);
    assert.deepEqual(JSON.parse(await readFile(last.file, 'utf8')).tasks.map((t) => t.id), ['a', 'b']);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('deploy-check: backup does not modify the source file', async () => {
  const d = await mk();
  try {
    const f = await write(d, 'taskflow.json', { tasks: [task('a')], deleted: [] });
    const before = await readFile(f, 'utf8');
    backup(d);
    assert.equal(await readFile(f, 'utf8'), before);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('deploy-check: compare fails when an id vanished without a tombstone, passes on growth or tombstone (AC-028)', async () => {
  const d = await mk();
  try {
    const before = await write(d, 'b.json', { tasks: [task('a'), task('b')], deleted: [] });
    const lost = await write(d, 'l.json', { tasks: [task('a')], deleted: [] });
    const grown = await write(d, 'g.json', { tasks: [task('a'), task('b'), task('c')], deleted: [] });
    const tomb = await write(d, 't.json', { tasks: [task('a')], deleted: [{ id: 'b', at: 5 }] });
    assert.deepEqual(compare(before, lost), { ok: false, missing: ['b'] });
    assert.equal(compare(before, grown).ok, true);
    assert.equal(compare(before, tomb).ok, true);
    assert.equal(spawnSync(process.execPath, [CLI, 'compare', before, lost]).status, 1);
    assert.equal(spawnSync(process.execPath, [CLI, 'compare', before, grown]).status, 0);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('deploy-check: check-snapshot passes on a synthetic snapshot of all historical forms (AC-023)', async () => {
  const d = await mk();
  try {
    const legacy = JSON.parse(await readFile(FIXTURE, 'utf8'));
    const withAgent = [task('w1', { agent: { status: 'review', claimedAt: 1, finishedAt: 2, claimToken: null, at: 3 } }), task('w2', { agent: 'garbage' }), task('w3', { agent: null })];
    const f = await write(d, 's.json', { tasks: [...legacy.tasks, ...withAgent], deleted: [] });
    const r = checkSnapshot(f);
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
    assert.equal(r.total, 14);
    const cli = spawnSync(process.execPath, [CLI, 'check-snapshot', f], { encoding: 'utf8' });
    assert.equal(cli.status, 0);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('deploy-check: CLI usage errors exit 2 and a missing file exits 2', async () => {
  assert.equal(spawnSync(process.execPath, [CLI]).status, 2);
  assert.equal(spawnSync(process.execPath, [CLI, 'counts', '/nonexistent/file.json']).status, 2);
});

test('deploy-check: README documents rollout: backup locally and on VPS, stop on mismatch, rollback', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  for (const frag of ['deploy-check.mjs backup', 'deploy-check.mjs counts', 'deploy-check.mjs compare', 'check-snapshot', 'VPS', 'Rollback', 'stop']) {
    assert.ok(readme.includes(frag), frag);
  }
});

test('deploy-check: invalid --keep exits 2 before any backup or deletion (review I09)', async () => {
  const d = await mk();
  try {
    await write(d, 'taskflow.json', { tasks: [task('a')], deleted: [] });
    for (let i = 0; i < 3; i++) backup(d, { keep: 5, now: new Date(Date.UTC(2026, 9, 4, 9, 0, i)) });
    const before = (await readdir(join(d, 'backups'))).sort();
    for (const bad of [['--keep', '0'], ['--keep', '-1'], ['--keep', 'abc'], ['--keep', '1.5'], ['--keep'], ['--bogus', '2']]) {
      const r = spawnSync(process.execPath, [CLI, 'backup', d, ...bad]);
      assert.equal(r.status, 2, bad.join(' '));
      assert.deepEqual((await readdir(join(d, 'backups'))).sort(), before, bad.join(' '));
    }
    for (const bad of [0, -1, 1.5, NaN]) assert.throws(() => backup(d, { keep: bad }), RangeError);
    assert.deepEqual((await readdir(join(d, 'backups'))).sort(), before);
    assert.equal(spawnSync(process.execPath, [CLI, 'backup', d, '--keep', '2']).status, 0);
    assert.equal((await readdir(join(d, 'backups'))).length, 2);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('deploy-check: the freshly made backup is never deleted, even when older backups sort after it (review I09)', async () => {
  const d = await mk();
  try {
    await write(d, 'taskflow.json', { tasks: [task('a')], deleted: [] });
    for (let i = 5; i < 8; i++) backup(d, { keep: 9, now: new Date(Date.UTC(2026, 9, 4, 9, 0, i)) });
    const last = backup(d, { keep: 1, now: new Date(Date.UTC(2026, 9, 4, 8, 0, 0)) });   // oldest stamp
    const files = await readdir(join(d, 'backups'));
    assert.equal(files.length, 1);
    assert.ok(last.file.endsWith(files[0]));
  } finally { await rm(d, { recursive: true, force: true }); }
});
