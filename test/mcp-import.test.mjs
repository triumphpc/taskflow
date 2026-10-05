import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

test('mcp import has no side effects (no token file, no port)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-mcp-import-'));
  try {
    const code = `
      const m = await import(${JSON.stringify(join(ROOT, 'mcp.mjs'))});
      const names = ['normalizeTask', 'TOOLS', 'findTask'].filter((n) => !(n in m));
      if (names.length) { console.error('missing exports: ' + names.join(',')); process.exit(3); }
      process.exit(0);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { PATH: process.env.PATH, HOME: dir, TASKFLOW_DATA: join(dir, 'data'), PORT: '0' },
      timeout: 8000, encoding: 'utf8',
    });
    assert.equal(r.status, 0, `exit ${r.status} ${r.signal} ${r.stderr}`);
    assert.equal(existsSync(join(dir, 'data', 'mcp-token.txt')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
