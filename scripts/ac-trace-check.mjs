#!/usr/bin/env node
// Сверка трассировки AC-001..AC-029. AC считается покрытым, только если он назван
//   - в имени теста: test('... AC-012 ...') / it('...') в test/*.test.mjs, либо
//   - в закрытом пункте `- [x]` ручного чек-листа test/MANUAL-CHECKLIST.md.
// Незакрытые ручные пункты `- [ ]` выводятся отдельным списком «ждёт ручной проверки» и не валят проверку.
// Код 1 только если AC не упомянут нигде (ни в тестах, ни в чек-листе).
//   node scripts/ac-trace-check.mjs [--proposal <path>] [--files a.test.mjs,b.test.mjs] [--section <заголовок>]
// Без аргументов проверяются AC-001..AC-029 прежнего change по всем тестам и всему чек-листу.
//   --proposal  набор AC берётся из таблицы `| AC-NNN |` этого proposal.md
//   --files     тесты считаются только из перечисленных файлов (имена относительно test/)
//   --section   чек-лист считается только из раздела `## ...`, чей заголовок содержит этот текст
// Номера AC разных change пересекаются, поэтому для нового change нужны --files и --section.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = fileURLToPath(new URL('../test/', import.meta.url));
const AC_COUNT = 29;
const id = (n) => `AC-${String(n).padStart(3, '0')}`;
const AC_RE = /AC-(\d{3})/g;
const TEST_NAME_RE = /\b(?:test|it)\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

/** Список AC из таблицы требований proposal.md: строки вида `| AC-012 | ... |`. */
export function acsFromProposal(path) {
  const ids = new Set();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\|\s*(AC-\d{3})\s*\|/.exec(line);
    if (m) ids.add(m[1]);
  }
  return [...ids].sort();
}

/** Строки раздела `## ...` чек-листа, чей заголовок содержит `section`. Нет раздела: пустой список. */
function sectionLines(text, section) {
  const out = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (/^##\s/.test(line)) inside = line.includes(section);
    else if (inside) out.push(line);
  }
  return out;
}

/**
 * @param {string} dir
 * @param {{files?: string[]|null, section?: string|null}} [opts]
 * @returns {{covered: Map<string,Set<string>>, pending: Map<string,Set<string>>}}
 */
export function trace(dir = TEST_DIR, { files = null, section = null } = {}) {
  const covered = new Map();
  const pending = new Map();
  const add = (map, ac, file) => { if (!map.has(ac)) map.set(ac, new Set()); map.get(ac).add(file); };
  const wanted = (f) => f === 'MANUAL-CHECKLIST.md' || (f.endsWith('.test.mjs') && (!files || files.includes(f)));
  for (const file of readdirSync(dir).filter(wanted)) {
    const text = readFileSync(join(dir, file), 'utf8');
    if (file.endsWith('.test.mjs')) {
      for (const m of text.matchAll(TEST_NAME_RE)) for (const a of m[2].matchAll(AC_RE)) add(covered, a[0], file);
    } else if (file === 'MANUAL-CHECKLIST.md') {
      for (const line of section ? sectionLines(text, section) : text.split('\n')) {
        const item = /^\s*[-*]\s+\[([ xX])\]/.exec(line);
        if (!item) continue;
        for (const a of line.matchAll(AC_RE)) add(item[1] === ' ' ? pending : covered, a[0], file);
      }
    }
  }
  return { covered, pending };
}

/** @param {{acs?: string[]|null, files?: string[]|null, section?: string|null}} [opts] */
export function check(dir = TEST_DIR, { acs = null, files = null, section = null } = {}) {
  const { covered, pending } = trace(dir, { files, section });
  const list = acs ?? Array.from({ length: AC_COUNT }, (_, i) => id(i + 1));
  const missing = [];
  const waiting = [];
  for (const ac of list) {
    if (covered.has(ac)) continue;
    if (pending.has(ac)) waiting.push(ac);
    else missing.push(ac);
  }
  const manual = [...pending.keys()].filter((ac) => list.includes(ac)).sort();
  return { covered, pending, missing, waiting, manual, acs: list };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--proposal') o.proposal = argv[++i];
    else if (k === '--files') o.files = (argv[++i] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    else if (k === '--section') o.section = argv[++i];
    else throw new Error(`unknown argument: ${k}`);
  }
  return o;
}

function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  const r = check(TEST_DIR, {
    acs: a.proposal ? acsFromProposal(a.proposal) : null,
    files: a.files ?? null,
    section: a.section ?? null,
  });
  for (const ac of r.acs) {
    const files = r.covered.get(ac);
    if (files) console.log(`${ac}  ${[...files].join(', ')}`);
  }
  if (r.manual.length) console.log(`Ждёт ручной проверки (пункты [ ] чек-листа): ${r.manual.join(', ')}`);
  if (r.waiting.length) console.log(`Только ручные пункты, без теста: ${r.waiting.join(', ')}`);
  if (r.missing.length) {
    console.error(`Не сопоставлены ни тесту, ни ручному пункту: ${r.missing.join(', ')}`);
    return 1;
  }
  console.log(`Все ${r.acs.length} AC сопоставлены (покрыто тестами или закрытыми пунктами: ${r.acs.length - r.waiting.length}).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
