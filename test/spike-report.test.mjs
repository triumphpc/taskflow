// Spike U1+U5 is a manual step (agent/spike/run-spike.sh). While the note says PENDING the verdict tests are
// skipped; a FAIL verdict fails the suite on purpose: it is the stop signal (T01).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const note = await readFile(new URL('../openspec/changes/archive/2026-10-05-add-agent-delegation/spike-u1-u5.md', import.meta.url), 'utf8');
const verdict = (name) => new RegExp(`^${name}: (\\S+)`, 'm').exec(note)?.[1];

test('spike: the note exists and carries U1, U5 and SRC-35 verdict lines', () => {
  assert.match(note, /^U1: (PASS|FAIL|PENDING)$/m);
  assert.match(note, /^U5: (PASS|FAIL|PENDING)$/m);
  assert.match(note, /^SRC-35: env-launch (PASS|FAIL|PENDING), fallback (PASS|FAIL|PENDING|n\/a)$/m);
});

test('spike: the note never refers to the real data file', () => {
  const code = note.replace(/`[^`]*`/g, '');
  assert.ok(!/data\/taskflow\.json/.test(code), 'prose must not mention real data');
  assert.ok(!/data\/taskflow\.json/.test(note.replace(/Реальные `data\/taskflow\.json`[^.]*\./g, '')), 'only the "not used" statement is allowed');
});

test('spike: no temporary launchd job is left behind', { skip: spawnSync('launchctl', ['list']).error && 'launchctl is not available' }, () => {
  const list = spawnSync('launchctl', ['list'], { encoding: 'utf8' }).stdout || '';
  assert.equal(list.split('\n').filter((l) => l.includes('taskflow.spike')).length, 0);
});

for (const name of ['U1', 'U5']) {
  test(`spike: ${name} verdict is PASS`, { skip: verdict(name) === 'PENDING' && 'manual spike not run yet (see agent/spike/run-spike.sh)' }, () => {
    assert.equal(verdict(name), 'PASS', `${name} must be PASS; FAIL means stop (fallback zsh -ic claude-paiw first, ADR-003)`);
  });
}

test('spike: harness files exist and the harness only runs in temp dirs with a trap cleanup', async () => {
  const sh = await readFile(new URL('../agent/spike/run-spike.sh', import.meta.url), 'utf8');
  assert.match(sh, /trap cleanup EXIT INT TERM/);
  assert.match(sh, /launchctl bootout/);
  assert.match(sh, /mktemp -d/);
  assert.match(sh, /--max-budget-usd|run r1 json 8 .* 1\.00/);
  assert.ok(!/echo .*\$\{?ANTHROPIC|printenv/.test(sh), 'values of variables are never printed');
});
