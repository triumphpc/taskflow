import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, stat, mkdir, symlink, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ensureSandbox, defaultSandboxDir, SandboxError, SANDBOX_MARKER } from '../agent/lib/sandbox.mjs';

const tmp = async () => { const d = await mkdtemp(join(tmpdir(), 'tf-sb-')); return { d, done: () => rm(d, { recursive: true, force: true }) }; };

test('sandbox: created with mode 0700 under ~/.local/state/taskflow-agent/work (SEC01)', async () => {
  const { d, done } = await tmp();
  try {
    const dir = ensureSandbox({ home: d });
    assert.equal(dir, join(d, '.local', 'state', 'taskflow-agent', 'work'));
    assert.equal(dir, defaultSandboxDir(d));
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.notEqual(dir, d);
  } finally { await done(); }
});

test('sandbox: a pre-existing directory with loose permissions is refused and NOT chmod-ed (I02)', async () => {
  const { d, done } = await tmp();
  try {
    const dir = defaultSandboxDir(d);
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o755);
    assert.throws(() => ensureSandbox({ home: d }), SandboxError);
    assert.equal((await stat(dir)).mode & 0o777, 0o755, 'foreign mode left as is');
  } finally { await done(); }
});

test('sandbox: a freshly created directory gets the marker; our own sandbox is accepted on re-run, even non-empty (I02)', async () => {
  const { d, done } = await tmp();
  try {
    const dir = ensureSandbox({ home: d });
    assert.ok((await readdir(dir)).includes(SANDBOX_MARKER));
    await writeFile(join(dir, 'left-by-claude.txt'), 'x');
    assert.equal(ensureSandbox({ home: d }), dir);
    assert.equal(ensureSandbox({ home: d }), dir);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  } finally { await done(); }
});

test('sandbox: an existing empty 0700 directory is adopted (gets a marker), a non-empty foreign one is refused (I02)', async () => {
  const { d, done } = await tmp();
  try {
    const empty = join(d, 'empty');
    await mkdir(empty, { mode: 0o700 });
    await chmod(empty, 0o700);
    assert.equal(ensureSandbox({ override: empty, home: d }), empty);
    assert.ok((await readdir(empty)).includes(SANDBOX_MARKER));

    const foreign = join(d, 'foreign');
    await mkdir(foreign, { mode: 0o700 });
    await chmod(foreign, 0o700);
    await writeFile(join(foreign, 'user-data.txt'), 'mine');
    assert.throws(() => ensureSandbox({ override: foreign, home: d }), SandboxError);
    assert.deepEqual(await readdir(foreign), ['user-data.txt'], 'nothing is written into a foreign directory');
  } finally { await done(); }
});

test('sandbox: a symlink as the directory is refused and its target is not chmod-ed (I02)', async () => {
  const { d, done } = await tmp();
  try {
    const target = join(d, 'target');
    await mkdir(target, { mode: 0o755 });
    await chmod(target, 0o755);
    await symlink(target, join(d, 'link'));
    assert.throws(() => ensureSandbox({ override: join(d, 'link'), home: d }), SandboxError);
    assert.equal((await stat(target)).mode & 0o777, 0o755);
    assert.deepEqual(await readdir(target), []);
  } finally { await done(); }
});

test('sandbox: a symlink in the path below home is refused (I02)', async () => {
  const { d, done } = await tmp();
  try {
    const elsewhere = join(d, 'elsewhere');
    await mkdir(elsewhere);
    const home = join(d, 'home');
    await mkdir(home);
    await symlink(elsewhere, join(home, '.local'));
    assert.throws(() => ensureSandbox({ home }), SandboxError);
    assert.deepEqual(await readdir(elsewhere), [], 'nothing was created through the link');
  } finally { await done(); }
});

test('sandbox: an ancestor of home (and the filesystem root) is refused (I02)', async () => {
  const { d, done } = await tmp();
  try {
    const home = join(d, 'users', 'me');
    await mkdir(home, { recursive: true });
    assert.throws(() => ensureSandbox({ override: join(d, 'users'), home }), SandboxError);
    assert.throws(() => ensureSandbox({ override: d, home }), SandboxError);
    assert.throws(() => ensureSandbox({ override: dirname(d), home }), SandboxError);
    assert.throws(() => ensureSandbox({ override: '/', home }), SandboxError);
    // a sibling that is not an ancestor is fine
    assert.equal(ensureSandbox({ override: join(d, 'users', 'sandbox'), home }), join(d, 'users', 'sandbox'));
  } finally { await done(); }
});

test('sandbox: the home directory (also via symlink) is refused as an override (SEC01)', async () => {
  const { d, done } = await tmp();
  try {
    assert.throws(() => ensureSandbox({ override: d, home: d }), SandboxError);
    await symlink(d, join(d, 'link'));
    assert.throws(() => ensureSandbox({ override: join(d, 'link'), home: d }), SandboxError);
    assert.equal(ensureSandbox({ override: join(d, 'custom'), home: d }), join(d, 'custom'));
  } finally { await done(); }
});
