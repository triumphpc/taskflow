import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LIMIT_DEFAULTS, LIST_MAX, POLICY_FILE_MAX_BYTES, defaultPolicyPath, loadSendPolicy, policyState } from '../agent/lib/send-policy.mjs';

const MOD = fileURLToPath(new URL('../agent/lib/send-policy.mjs', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'tf-policy-'));
process.on('exit', () => { try { rm(dir, { recursive: true, force: true }); } catch { /* ok */ } });
let n = 0;
async function put(doc, mode = 0o600) {
  const p = join(dir, `p${n++}.json`);
  await writeFile(p, typeof doc === 'string' ? doc : JSON.stringify(doc), { mode });
  await chmod(p, mode);
  return p;
}
const VALID = { version: 1, allow: { vk_chats: ['c1@chat'], jira_projects: ['VKTAI'] } };

test('send-policy: defaults and the default path', () => {
  assert.deepEqual({ ...LIMIT_DEFAULTS }, { vk: 3, gitlab_comment: 20, jira: 3, confluence: 2 });
  assert.equal(LIST_MAX, 200);
  assert.equal(POLICY_FILE_MAX_BYTES, 65536);
  assert.equal(defaultPolicyPath('/h'), '/h/.config/taskflow-agent/send-policy.json');
});

test('send-policy: a valid 0600 file loads, absent lists are empty, limits default', async () => {
  const r = loadSendPolicy(await put(VALID));
  assert.equal(r.ok, true);
  assert.deepEqual([...r.policy.allow.vk_chats], ['c1@chat']);
  assert.deepEqual([...r.policy.allow.gitlab_projects], []);
  assert.deepEqual([...r.policy.allow.confluence_spaces], []);
  assert.deepEqual(r.policy.limits, { ...LIMIT_DEFAULTS });
  assert.equal(policyState(await put(VALID)), 'ok');
});

test('send-policy: every failure reason is reproducible', async () => {
  const reason = (p, o) => { const r = loadSendPolicy(p, o); assert.equal(r.ok, false, p); return r.reason; };
  assert.equal(reason(join(dir, 'nope.json')), 'missing');
  assert.equal(reason(join(dir, 'no-dir', 'x.json')), 'missing');
  // symlink to a good file
  const real = await put(VALID);
  const link = join(dir, 'link.json');
  await symlink(real, link);
  assert.equal(reason(link), 'not_file');
  // a directory
  await mkdir(join(dir, 'adir'));
  assert.equal(reason(join(dir, 'adir')), 'not_file');
  // permissions: group/other bits and owner execute
  assert.equal(reason(await put(VALID, 0o644)), 'mode');
  assert.equal(reason(await put(VALID, 0o640)), 'mode');
  assert.equal(reason(await put(VALID, 0o604)), 'mode');
  assert.equal(reason(await put(VALID, 0o700)), 'mode');
  assert.equal(loadSendPolicy(await put(VALID, 0o400)).ok, true, '0400 is fine');
  // foreign owner
  assert.equal(reason(await put(VALID), { uid: process.getuid() + 1 }), 'owner');
  // size
  assert.equal(reason(await put(JSON.stringify({ version: 1, pad: 'x'.repeat(POLICY_FILE_MAX_BYTES) }))), 'size');
  // json / version / shape
  assert.equal(reason(await put('{not json')), 'json');
  assert.equal(reason(await put('')), 'json');
  assert.equal(reason(await put({ version: 2, allow: {} })), 'version');
  assert.equal(reason(await put({ allow: {} })), 'version');
  assert.equal(reason(await put({ version: '1' })), 'version');
  assert.equal(reason(await put([])), 'shape');
  assert.equal(reason(await put('null')), 'shape');
  assert.equal(reason(await put({ version: 1, extra: 1 })), 'shape');
  assert.equal(reason(await put({ version: 1, allow: { telegram: [] } })), 'shape');
  assert.equal(reason(await put({ version: 1, allow: { vk_chats: 'c1' } })), 'shape');
  assert.equal(reason(await put({ version: 1, allow: { vk_chats: [''] } })), 'shape');
  assert.equal(reason(await put({ version: 1, allow: { vk_chats: [1] } })), 'shape');
  assert.equal(reason(await put({ version: 1, allow: { vk_chats: [null] } })), 'shape');
  assert.equal(reason(await put({ version: 1, allow: [] })), 'shape');
  assert.equal(reason(await put({ version: 1, limits: { vk: 0 } })), 'shape');
  assert.equal(reason(await put({ version: 1, limits: { vk: 1.5 } })), 'shape');
  assert.equal(reason(await put({ version: 1, limits: { vk: '3' } })), 'shape');
  assert.equal(reason(await put({ version: 1, limits: { slack: 3 } })), 'shape');
  assert.equal(reason(await put({ version: 1, limits: [] })), 'shape');
  assert.equal(reason(await put({ version: 1, allow: { vk_chats: Array.from({ length: LIST_MAX + 1 }, (_, i) => `c${i}`) } })), 'shape');
  assert.equal(loadSendPolicy(await put({ version: 1, allow: { vk_chats: Array.from({ length: LIST_MAX }, (_, i) => `c${i}`) } })).ok, true);
  assert.equal(policyState(await put('{bad')), 'invalid');
  assert.equal(policyState(join(dir, 'nope.json')), 'missing');
});

test('send-policy: [send] AC-013 empty lists load as ok but policyState is "empty"; a missing allow key is an empty list', async () => {
  for (const doc of [{ version: 1 }, { version: 1, allow: {} }, { version: 1, allow: { vk_chats: [], jira_projects: [], gitlab_projects: [], confluence_spaces: [] } }]) {
    const p = await put(doc);
    assert.equal(loadSendPolicy(p).ok, true);
    assert.equal(policyState(p), 'empty');
  }
});

test('send-policy: [send] AC-013 the file is re-read on each call, no cache', async () => {
  const p = await put({ version: 1, allow: {} });
  assert.equal(policyState(p), 'empty');
  await writeFile(p, JSON.stringify({ version: 1, allow: { vk_chats: ['x'] } }));
  assert.equal(policyState(p), 'ok');
  assert.ok(loadSendPolicy(p).policy.allow.vk_chats.has('x'));
  await writeFile(p, JSON.stringify({ version: 1, allow: { vk_chats: ['y'] } }));
  const again = loadSendPolicy(p).policy.allow.vk_chats;
  assert.ok(again.has('y') && !again.has('x'));
  await writeFile(p, '{broken');
  assert.equal(policyState(p), 'invalid');
  await chmod(p, 0o666);
  assert.equal(loadSendPolicy(p).reason, 'mode');
});

test('send-policy: limits can only go down from the defaults', async () => {
  const r = loadSendPolicy(await put({ version: 1, limits: { vk: 99, gitlab_comment: 5, jira: 3, confluence: 1000 } }));
  assert.deepEqual(r.policy.limits, { vk: 3, gitlab_comment: 5, jira: 3, confluence: 2 });
  assert.deepEqual(loadSendPolicy(await put({ version: 1, limits: { vk: 1 } })).policy.limits, { vk: 1, gitlab_comment: 20, jira: 3, confluence: 2 });
});

test('send-policy: no call prints list values or anything else to stdout or stderr', async () => {
  const secret = 'SECRET-CHAT-ID-777';
  const good = await put({ version: 1, allow: { vk_chats: [secret] } });
  const bad = await put({ version: 1, allow: { vk_chats: [secret, 5] } });
  const open = await put({ version: 1, allow: { vk_chats: [secret] } }, 0o644);
  const code = `import * as m from ${JSON.stringify(MOD)}; for (const p of ${JSON.stringify([good, bad, open, join(dir, 'nope.json')])}) { m.loadSendPolicy(p); m.policyState(p); }`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});
