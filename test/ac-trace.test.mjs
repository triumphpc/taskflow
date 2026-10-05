import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check } from '../scripts/ac-trace-check.mjs';

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
