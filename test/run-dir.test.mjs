import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, readdir, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { RUN_KEEP_MS, createRunDir, findLatestRunDir, pruneRunDirs } from '../agent/lib/run-dir.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'tf-rundir-'));
const DAY = 24 * 3600 * 1000;

test('run-dir: creates runs/<id>-<ms> with slots/ and meta.json, modes 0700 and 0600 (C9)', async () => {
  const s = await tmp();
  try {
    const { dir } = createRunDir({ stateDir: join(s, 'state'), taskId: 'abc-1', due: '2026-10-07', now: 1_700_000_000_000 });
    assert.equal(dir, join(s, 'state', 'runs', 'abc-1-1700000000000'));
    assert.equal((await stat(dirname(dir))).mode & 0o777, 0o700);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, 'slots'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, 'meta.json'))).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')), { v: 1, taskId: 'abc-1', due: '2026-10-07', startedAt: 1_700_000_000_000 });
    const again = createRunDir({ stateDir: join(s, 'state'), taskId: 'abc-1', due: null, now: 1_700_000_000_000 });
    assert.notEqual(again.dir, dir, 'same millisecond does not collide');
  } finally { await rm(s, { recursive: true, force: true }); }
});

test('run-dir: a hostile id is sanitised and the result stays inside runs/', async () => {
  const s = await tmp();
  try {
    for (const id of ['../../etc', 'a b/c', 'Привет мир', 'x'.repeat(100), '', null]) {
      const { dir } = createRunDir({ stateDir: s, taskId: id, due: null, now: 5 });
      assert.equal(dirname(dir), join(s, 'runs'), String(id));
      assert.match(dir.slice(join(s, 'runs').length + 1), /^[A-Za-z0-9_-]{1,40}-\d+$/);
    }
    const { dir } = createRunDir({ stateDir: s, taskId: 'x'.repeat(100), due: null, now: 6 });
    assert.equal(JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')).taskId, 'x'.repeat(100), 'meta keeps the real id');
  } finally { await rm(s, { recursive: true, force: true }); }
});

test('run-dir: findLatestRunDir picks the newest of the task, ignores others and old ones', async () => {
  const s = await tmp();
  const now = 10 * RUN_KEEP_MS;
  try {
    createRunDir({ stateDir: s, taskId: 'a', due: '1', now: now - 3000 });
    const newest = createRunDir({ stateDir: s, taskId: 'a', due: '2', now: now - 1000 });
    createRunDir({ stateDir: s, taskId: 'a', due: '3', now: now - 2000 });
    createRunDir({ stateDir: s, taskId: 'b', due: 'other', now: now - 10 });
    createRunDir({ stateDir: s, taskId: 'old', due: 'x', now: now - RUN_KEEP_MS - 1 });
    const hit = findLatestRunDir({ stateDir: s, taskId: 'a', now });
    assert.equal(hit.dir, newest.dir);
    assert.equal(hit.meta.due, '2');
    assert.equal(findLatestRunDir({ stateDir: s, taskId: 'old', now }), null, 'older than 14 days');
    assert.equal(findLatestRunDir({ stateDir: s, taskId: 'nobody', now }), null);
    assert.equal(findLatestRunDir({ stateDir: join(s, 'none'), taskId: 'a', now }), null);
  } finally { await rm(s, { recursive: true, force: true }); }
});

test('run-dir: pruneRunDirs removes old run dirs only; fresh dirs, symlinks, files and foreign names stay', async () => {
  const s = await tmp();
  const outside = await tmp();
  const now = 20 * RUN_KEEP_MS;
  try {
    const old1 = createRunDir({ stateDir: s, taskId: 'o1', due: null, now: now - RUN_KEEP_MS - 5 });
    const old2 = createRunDir({ stateDir: s, taskId: 'o2', due: null, now: now - 3 * RUN_KEEP_MS });
    const fresh = createRunDir({ stateDir: s, taskId: 'f', due: null, now: now - DAY });
    const runs = join(s, 'runs');
    await writeFile(join(outside, 'precious'), 'x');
    await symlink(outside, join(runs, 'evil-1'));             // name matches the pattern, but it is a symlink and ancient
    await writeFile(join(runs, 'file-1'), 'x');               // a regular file with a matching name
    await mkdir(join(runs, 'foreign'));                        // a directory with a foreign name
    await mkdir(join(runs, 'weird name-1'));
    const n = pruneRunDirs({ stateDir: s, now });
    assert.equal(n, 2);
    const left = (await readdir(runs)).sort();
    assert.ok(!left.some((x) => [old1.dir, old2.dir].map((d) => d.split('/').pop()).includes(x)));
    for (const keep of [fresh.dir.split('/').pop(), 'evil-1', 'file-1', 'foreign', 'weird name-1']) assert.ok(left.includes(keep), keep);
    assert.equal(await readFile(join(outside, 'precious'), 'utf8'), 'x', 'the symlink target is untouched');
    assert.equal(pruneRunDirs({ stateDir: join(s, 'none'), now }), 0);
    assert.equal(pruneRunDirs({ stateDir: s, now, keepMs: 1000 }) >= 1, true, 'custom keepMs');
  } finally { await rm(s, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('run-dir: [send] I05/CR-I04 meta keeps claimedAt and never the claimToken; findLatestRunDir with claimedAt takes only the dir of that claim', async () => {
  const s = await tmp();
  const now = 10 * RUN_KEEP_MS;
  try {
    const old = createRunDir({ stateDir: s, taskId: 'a', due: '1', now: now - 3000, claim: { claimToken: 'tok-old', claimedAt: 111 } });
    const mine = createRunDir({ stateDir: s, taskId: 'a', due: '1', now: now - 2000, claim: { claimToken: 'tok-1', claimedAt: 222 } });
    const later = createRunDir({ stateDir: s, taskId: 'a', due: '1', now: now - 1000, claim: { claimToken: 'tok-2', claimedAt: 333 } });
    const meta = JSON.parse(await readFile(join(mine.dir, 'meta.json'), 'utf8'));
    assert.equal('claimToken' in meta, false);
    assert.ok(!JSON.stringify(meta).includes('tok-1'));
    assert.equal(meta.claimedAt, 222);
    assert.equal(findLatestRunDir({ stateDir: s, taskId: 'a', now, claimedAt: 222 }).dir, mine.dir);
    assert.equal(findLatestRunDir({ stateDir: s, taskId: 'a', now, claimedAt: 111 }).dir, old.dir);
    assert.equal(findLatestRunDir({ stateDir: s, taskId: 'a', now, claimedAt: 333 }).dir, later.dir);
    assert.equal(findLatestRunDir({ stateDir: s, taskId: 'a', now, claimedAt: 999 }), null, 'foreign claim: no dir');
    assert.equal(findLatestRunDir({ stateDir: s, taskId: 'a', now, claimedAt: null }), null, 'unknown claim matches nothing');
    assert.equal(findLatestRunDir({ stateDir: s, taskId: 'a', now }).dir, later.dir, 'without claimedAt: newest, as before');
    const bare = createRunDir({ stateDir: s, taskId: 'b', due: null, now });
    const bareMeta = JSON.parse(await readFile(join(bare.dir, 'meta.json'), 'utf8'));
    assert.equal('claimToken' in bareMeta, false);
    assert.equal(findLatestRunDir({ stateDir: s, taskId: 'b', now, claimedAt: 5 }), null);
  } finally { await rm(s, { recursive: true, force: true }); }
});

test('run-dir: [send] SEC15 findLatestRunDir with claimedAt: null never matches a meta whose claimedAt is null', async () => {
  const s = await tmp();
  const now = 10 * RUN_KEEP_MS;
  try {
    createRunDir({ stateDir: s, taskId: 'a', due: '1', now: now - 1000, claim: { claimToken: 't', claimedAt: null } });
    const meta = JSON.parse(await readFile(join(findLatestRunDir({ stateDir: s, taskId: 'a', now }).dir, 'meta.json'), 'utf8'));
    assert.equal(meta.claimedAt, null);
    assert.equal(findLatestRunDir({ stateDir: s, taskId: 'a', now, claimedAt: null }), null);
  } finally { await rm(s, { recursive: true, force: true }); }
});
