import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, acsFromProposal } from '../scripts/ac-trace-check.mjs';

async function withDir(files, fn) {
  const d = await mkdtemp(join(tmpdir(), 'tf-ac-'));
  try {
    for (const [n, c] of Object.entries(files)) await writeFile(join(d, n), c);
    return await fn(d);
  } finally { await rm(d, { recursive: true, force: true }); }
}

test('ac-trace: an AC only in a comment or a test body is not covered (review I08)', async () => {
  await withDir({ 'a.test.mjs': "// AC-001\ntest('does a thing', () => { /* AC-002 */ });\ntest('named (AC-003)', () => {});\n" }, (d) => {
    const r = check(d);
    assert.ok(r.covered.has('AC-003'));
    assert.ok(!r.covered.has('AC-001') && !r.covered.has('AC-002'));
    assert.ok(r.missing.includes('AC-001') && r.missing.includes('AC-002'));
  });
});

test('ac-trace: [x] checklist items cover, [ ] items are listed as waiting and do not fail (review I08)', async () => {
  const md = '- [x] **[ручной]** AC-004 done\n- [ ] **[ручной]** AC-005 pending\n';
  await withDir({ 'MANUAL-CHECKLIST.md': md }, (d) => {
    const r = check(d);
    assert.ok(r.covered.has('AC-004'));
    assert.ok(!r.covered.has('AC-005') && r.pending.has('AC-005'));
    assert.ok(r.waiting.includes('AC-005'));
    assert.ok(!r.missing.includes('AC-005') && !r.missing.includes('AC-004'));
    assert.deepEqual(r.manual, ['AC-005']);
  });
});

test('ac-trace: the real repository has no AC without any trace', () => {
  assert.deepEqual(check().missing, []);
});

test('ac-trace: acsFromProposal reads the AC table of a proposal; check() with acs checks exactly that set', async () => {
  await withDir({ 'p.md': '| AC-001 | text | FR-1 |\n| AC-002 | text | FR-1 |\nno AC-009 here\n', 'a.test.mjs': "test('x AC-001', () => {});\n" }, async (d) => {
    const acs = acsFromProposal(join(d, 'p.md'));
    assert.deepEqual(acs, ['AC-001', 'AC-002']);
    const r = check(d, { acs });
    assert.deepEqual(r.missing, ['AC-002']);
  });
});

test('ac-trace: files and section narrow the sources so another change does not mask a gap', async () => {
  const md = '## Old change\n- [x] AC-001 old\n## New change\n- [x] AC-003 new\n- [ ] AC-004 waits\n';
  await withDir({
    'old.test.mjs': "test('old AC-001 AC-002', () => {});\n",
    'new.test.mjs': "test('new AC-002', () => {});\n",
    'MANUAL-CHECKLIST.md': md,
  }, (d) => {
    const acs = ['AC-001', 'AC-002', 'AC-003', 'AC-004'];
    const wide = check(d, { acs });
    assert.deepEqual(wide.missing, []);
    const narrow = check(d, { acs, files: ['new.test.mjs'], section: 'New change' });
    assert.deepEqual(narrow.missing, ['AC-001']);
    assert.deepEqual(narrow.waiting, ['AC-004']);
    assert.ok(narrow.covered.has('AC-002') && narrow.covered.has('AC-003'));
  });
});

test('ac-trace: CLI without arguments still reports the 29 AC of the previous change', () => {
  const out = execFileSync(process.execPath, ['scripts/ac-trace-check.mjs'], { encoding: 'utf8' });
  assert.match(out, /Все 29 AC сопоставлены/);
});
