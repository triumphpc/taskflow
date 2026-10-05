#!/usr/bin/env node
// Сверка трассировки AC-001..AC-029. AC считается покрытым, только если он назван
//   - в имени теста: test('... AC-012 ...') / it('...') в test/*.test.mjs, либо
//   - в закрытом пункте `- [x]` ручного чек-листа test/MANUAL-CHECKLIST.md.
// Незакрытые ручные пункты `- [ ]` выводятся отдельным списком «ждёт ручной проверки» и не валят проверку.
// Код 1 только если AC не упомянут нигде (ни в тестах, ни в чек-листе).
//   node scripts/ac-trace-check.mjs

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = fileURLToPath(new URL('../test/', import.meta.url));
const AC_COUNT = 29;
const id = (n) => `AC-${String(n).padStart(3, '0')}`;
const AC_RE = /AC-(\d{3})/g;
const TEST_NAME_RE = /\b(?:test|it)\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

/** @returns {{covered: Map<string,Set<string>>, pending: Map<string,Set<string>>}} */
export function trace(dir = TEST_DIR) {
  const covered = new Map();
  const pending = new Map();
  const add = (map, ac, file) => { if (!map.has(ac)) map.set(ac, new Set()); map.get(ac).add(file); };
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.test.mjs') || f === 'MANUAL-CHECKLIST.md')) {
    const text = readFileSync(join(dir, file), 'utf8');
    if (file.endsWith('.test.mjs')) {
      for (const m of text.matchAll(TEST_NAME_RE)) for (const a of m[2].matchAll(AC_RE)) add(covered, a[0], file);
    } else if (file === 'MANUAL-CHECKLIST.md') {
      for (const line of text.split('\n')) {
        const item = /^\s*[-*]\s+\[([ xX])\]/.exec(line);
        if (!item) continue;
        for (const a of line.matchAll(AC_RE)) add(item[1] === ' ' ? pending : covered, a[0], file);
      }
    }
  }
  return { covered, pending };
}

export function check(dir = TEST_DIR) {
  const { covered, pending } = trace(dir);
  const missing = [];
  const waiting = [];
  for (let n = 1; n <= AC_COUNT; n++) {
    const ac = id(n);
    if (covered.has(ac)) continue;
    if (pending.has(ac)) waiting.push(ac);
    else missing.push(ac);
  }
  const manual = [...pending.keys()].sort();
  return { covered, pending, missing, waiting, manual };
}

function main() {
  const r = check();
  for (let n = 1; n <= AC_COUNT; n++) {
    const files = r.covered.get(id(n));
    if (files) console.log(`${id(n)}  ${[...files].join(', ')}`);
  }
  if (r.manual.length) console.log(`Ждёт ручной проверки (пункты [ ] чек-листа): ${r.manual.join(', ')}`);
  if (r.waiting.length) console.log(`Только ручные пункты, без теста: ${r.waiting.join(', ')}`);
  if (r.missing.length) {
    console.error(`Не сопоставлены ни тесту, ни ручному пункту: ${r.missing.join(', ')}`);
    return 1;
  }
  console.log(`Все ${AC_COUNT} AC сопоставлены (покрыто тестами или закрытыми пунктами: ${AC_COUNT - r.waiting.length}).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
