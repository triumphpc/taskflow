import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SEND_TOOLS } from '../agent/lib/policy.mjs';
import { checkSettingsForSend, ruleCoversTool, settingsFiles } from '../agent/lib/settings-preflight.mjs';

const [VK, NOTE] = SEND_TOOLS;

async function env() {
  const root = await mkdtemp(join(tmpdir(), 'tf-pf-'));
  const home = join(root, 'home');
  const cwd = join(root, 'sandbox');
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(cwd, '.claude'), { recursive: true });
  const put = (where, name, doc) => writeFile(join(where === 'home' ? home : cwd, '.claude', name), typeof doc === 'string' ? doc : JSON.stringify(doc));
  return { home, cwd, put, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('preflight: [send] SEC02 ruleCoversTool: exact name, server prefix, wildcards and "*" cover a send tool; unrelated rules do not', () => {
  for (const r of [VK, 'mcp__mcp-workspace-assistant', 'mcp__*', '*', 'mcp__mcp-workspace-assistant__*', 'mcp__mcp-workspace-assistant__messenger-*', ' mcp__mcp-workspace-assistant ']) {
    assert.equal(ruleCoversTool(r, VK), true, JSON.stringify(r));
  }
  for (const r of ['mcp__mcp-workspace-assistant__messenger-list-chats', 'mcp__mcp-jira', 'Bash', 'Read(*)', '', '   ', 5, null, undefined, 'mcp__mcp-workspace', 'mcp__generic_gitlab__get_*']) {
    assert.equal(ruleCoversTool(r, VK), false, JSON.stringify(r));
  }
  assert.equal(ruleCoversTool('mcp__generic_gitlab', NOTE), true);
});

test('preflight: [send] SEC02 no files, empty settings and read-only allow rules pass', async () => {
  const e = await env();
  try {
    assert.deepEqual(checkSettingsForSend({ home: e.home, cwd: e.cwd, managedDir: null }), { ok: true });
    await e.put('home', 'settings.json', { permissions: { allow: ['mcp__mcp-jira__jira_get_issue', 'Bash(ls)'], deny: [VK] }, model: 'x' });
    await e.put('home', 'settings.local.json', {});
    await e.put('cwd', 'settings.json', { permissions: {} });
    assert.deepEqual(checkSettingsForSend({ home: e.home, cwd: e.cwd, managedDir: null }), { ok: true });
  } finally { await e.cleanup(); }
});

test('preflight: [send] SEC02 an allow rule for a send tool, its server, "*" or "mcp__*" in any of the four files is refused; the answer carries file and reason, never the rule', async () => {
  for (const [where, name] of [['home', 'settings.json'], ['home', 'settings.local.json'], ['cwd', 'settings.json'], ['cwd', 'settings.local.json']]) {
    for (const rule of [VK, 'mcp__generic_gitlab', '*', 'mcp__*']) {
      const e = await env();
      try {
        await e.put(where, name, { permissions: { allow: ['Bash(ls)', rule] } });
        const r = checkSettingsForSend({ home: e.home, cwd: e.cwd, managedDir: null });
        assert.equal(r.ok, false, `${where}/${name} ${rule}`);
        assert.deepEqual(r.problems, [{ file: settingsFiles(e).find((f) => f.endsWith(`/${name}`) && f.startsWith(where === 'home' ? e.home : e.cwd)), reason: 'allow_send_tool' }]);
        assert.ok(!JSON.stringify(r).includes(rule === '*' ? 'zzzz' : rule), 'the rule value is not in the result');
      } finally { await e.cleanup(); }
    }
  }
});

test('preflight: [send] SEC02 a broken or unreadable settings file is refused (fail-closed) without its text; a directory in its place too', async () => {
  const e = await env();
  try {
    await e.put('home', 'settings.json', '{СЕКРЕТНЫЙ-МУСОР');
    await mkdir(join(e.cwd, '.claude', 'settings.local.json'));
    const r = checkSettingsForSend({ home: e.home, cwd: e.cwd, managedDir: null });
    assert.equal(r.ok, false);
    assert.deepEqual(r.problems.map((p) => p.reason), ['unreadable', 'unreadable']);
    assert.ok(!JSON.stringify(r).includes('СЕКРЕТНЫЙ'));
  } finally { await e.cleanup(); }
});

test('preflight: [send] SEC02 a non-array allow and a non-object permissions are ignored', async () => {
  const e = await env();
  try {
    await e.put('home', 'settings.json', { permissions: { allow: 'mcp__*' } });
    await e.put('cwd', 'settings.json', { permissions: 'x' });
    assert.deepEqual(checkSettingsForSend({ home: e.home, cwd: e.cwd, managedDir: null }), { ok: true });
  } finally { await e.cleanup(); }
});

test('preflight: [send] SEC12 ruleCoversTool strips a trailing "(...)" and supports "*" anywhere as a glob', () => {
  for (const r of [`${VK}(*)`, `${VK}(anything)`, 'mcp__mcp-workspace-assistant__*send*', '*messenger-send-message', 'mcp__*__messenger-send-message', 'mcp__mcp-workspace-assistant__messenger-send-*(x)']) {
    assert.equal(ruleCoversTool(r, VK), true, r);
  }
  for (const r of ['mcp__mcp-workspace-assistant__messenger-list-*', '*list*', 'Bash(*)', 'mcp__jira__*send*', '(x)', 'mcp__a.b__*']) {
    assert.equal(ruleCoversTool(r, VK), false, r);
  }
});

test('preflight: [send] SEC12 the settings root is CLAUDE_CONFIG_DIR when set, else ~/.claude; managed files and managed-settings.d are checked', async () => {
  const e = await env();
  try {
    const cfg = join(e.cwd, '..', 'cfg');
    const managed = join(e.cwd, '..', 'managed');
    await mkdir(cfg, { recursive: true });
    await mkdir(join(managed, 'managed-settings.d'), { recursive: true });
    assert.deepEqual(settingsFiles({ home: e.home, cwd: e.cwd, configDir: cfg, managedDir: managed }).slice(0, 2), [join(cfg, 'settings.json'), join(cfg, 'settings.local.json')]);
    assert.equal(settingsFiles({ home: e.home, cwd: e.cwd, managedDir: null })[0], join(e.home, '.claude', 'settings.json'));
    const opts = { home: e.home, cwd: e.cwd, configDir: cfg, managedDir: managed };
    assert.deepEqual(checkSettingsForSend(opts), { ok: true });
    // allow rule in ~/.claude is no longer read when CLAUDE_CONFIG_DIR points elsewhere
    await e.put('home', 'settings.json', { permissions: { allow: [VK] } });
    assert.deepEqual(checkSettingsForSend(opts), { ok: true });
    await writeFile(join(cfg, 'settings.local.json'), JSON.stringify({ permissions: { allow: [`${VK}(x)`] } }));
    assert.deepEqual(checkSettingsForSend(opts).problems, [{ file: join(cfg, 'settings.local.json'), reason: 'allow_send_tool' }]);
    await rm(join(cfg, 'settings.local.json'));
    await writeFile(join(managed, 'managed-settings.json'), JSON.stringify({ permissions: { allow: ['mcp__*'] } }));
    assert.deepEqual(checkSettingsForSend(opts).problems, [{ file: join(managed, 'managed-settings.json'), reason: 'allow_send_tool' }]);
    await rm(join(managed, 'managed-settings.json'));
    await writeFile(join(managed, 'managed-settings.d', '10-x.json'), JSON.stringify({ permissions: { allow: ['mcp__generic_gitlab'] } }));
    await writeFile(join(managed, 'managed-settings.d', 'note.txt'), 'not json, ignored');
    assert.deepEqual(checkSettingsForSend(opts).problems, [{ file: join(managed, 'managed-settings.d', '10-x.json'), reason: 'allow_send_tool' }]);
    await writeFile(join(managed, 'managed-settings.d', '10-x.json'), '{broken');
    assert.deepEqual(checkSettingsForSend(opts).problems.map((p) => p.reason), ['unreadable']);
  } finally { await e.cleanup(); }
});

test('preflight: [send] SEC13 any allow rule with the mcp__plugin_ prefix is refused', async () => {
  for (const rule of ['mcp__plugin_engineering_asana', 'mcp__plugin_', 'mcp__plugin_*', ' mcp__plugin_x_y__tool ', 'mcp__plugin_x_y__*(a)']) {
    const e = await env();
    try {
      await e.put('cwd', 'settings.json', { permissions: { allow: [rule] } });
      const r = checkSettingsForSend({ home: e.home, cwd: e.cwd, managedDir: null });
      assert.equal(r.ok, false, rule);
      assert.deepEqual(r.problems.map((p) => p.reason), ['allow_plugin_tool']);
      assert.ok(!JSON.stringify(r).includes('plugin_x_y'));
    } finally { await e.cleanup(); }
  }
});

test('preflight: [send] SEC16 a glob of many consecutive "*" is linear (< 200 ms) and still matches like a single "*"', () => {
  const t0 = process.hrtime.bigint();
  assert.equal(ruleCoversTool(`${'*'.repeat(5000)}#`, VK), false);
  assert.equal(ruleCoversTool(`mcp__${'*'.repeat(5000)}__messenger-send-message`, VK), true);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 200, `${ms.toFixed(1)} ms`);
});

test('preflight: [send] SEC15 regexp metacharacters in a rule are literal and the glob is anchored', () => {
  assert.equal(ruleCoversTool('mcp__mcp-workspace-assistant__messenger-send-messag.*', VK), false, '"." is not a wildcard');
  assert.equal(ruleCoversTool('mcp__(a|b)__x', 'mcp__a__x'), false, 'group is not a group');
  assert.equal(ruleCoversTool('mcp__(a|b)__x', 'mcp__(a|b)__x'), true, 'but matches itself literally');
  assert.equal(ruleCoversTool('messenger-send-*', VK), false, 'no mcp__ prefix: anchored at the start');
  assert.equal(ruleCoversTool('*messenger-send-message', VK), true, 'explicit leading star still works');
});
