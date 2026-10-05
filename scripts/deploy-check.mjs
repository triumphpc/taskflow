#!/usr/bin/env node
// Проверки перед и после выкладки: бэкап данных и сверка, что ни одна задача не потеряна.
//   node scripts/deploy-check.mjs backup <dataDir> [--keep 5]  копия в <dataDir>/backups/taskflow-<UTC>.json (0600)
//   node scripts/deploy-check.mjs counts <file>                числа {total, open, done, deleted}
//   node scripts/deploy-check.mjs compare <before> <after>     код 1, если id из before нет ни в tasks, ни в deleted after
//   node scripts/deploy-check.mjs check-snapshot <file>        нормализация не теряет задач и не добавляет agent там, где его не было
// Только чтение исходного файла: данные не меняются, бэкап пишется рядом. Без зависимостей.

import { copyFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeTask } from '../js/store.js';

const DATA_FILE = 'taskflow.json';

function load(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return {
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    deleted: Array.isArray(parsed.deleted) ? parsed.deleted : [],
  };
}

export function counts(file) {
  const { tasks, deleted } = load(file);
  const done = tasks.filter((t) => t && t.done).length;
  return { total: tasks.length, open: tasks.length - done, done, deleted: deleted.length };
}

/** Метка UTC, сортируемая как строка: 20261004T091500123Z. */
const stamp = (d = new Date()) => d.toISOString().replace(/[-:.]/g, '');

export function backup(dataDir, { keep = 5, now = new Date() } = {}) {
  if (!Number.isInteger(keep) || keep < 1) throw new RangeError('--keep must be an integer >= 1');   // до любых действий
  const src = join(dataDir, DATA_FILE);
  const dir = join(dataDir, 'backups');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `taskflow-${stamp(now)}.json`);
  copyFileSync(src, file);
  chmodSync(file, 0o600);
  // Только что созданный бэкап не удаляем никогда, даже если его метка старше прочих: из остальных оставляем keep-1 новейших.
  const others = readdirSync(dir).filter((f) => /^taskflow-.*\.json$/.test(f) && join(dir, f) !== file).sort();
  for (const old of others.slice(0, Math.max(0, others.length - (keep - 1)))) rmSync(join(dir, old), { force: true });
  return { file, ...counts(file) };
}

/** @returns {{ok:boolean, missing:string[]}} */
export function compare(before, after) {
  const b = load(before);
  const a = load(after);
  const present = new Set([...a.tasks.map((t) => t.id), ...a.deleted.map((d) => d.id)]);
  const missing = b.tasks.map((t) => t.id).filter((id) => !present.has(id));
  return { ok: missing.length === 0, missing };
}

/** @returns {{ok:boolean, problems:string[], total:number}} */
export function checkSnapshot(file) {
  const { tasks } = load(file);
  const problems = [];
  const normalized = tasks.map((t) => normalizeTask(t));
  if (normalized.length !== tasks.length) problems.push('count changed');
  const ids = new Set(normalized.map((t) => t.id));
  for (const t of tasks) if (!ids.has(t.id)) problems.push(`id lost: ${t.id}`);
  tasks.forEach((raw, i) => {
    const once = normalized[i];
    if (JSON.stringify(normalizeTask(once)) !== JSON.stringify(once)) problems.push(`not idempotent: ${raw.id}`);
    const hadAgent = raw.agent !== undefined && raw.agent !== null && typeof raw.agent === 'object' && !Array.isArray(raw.agent);
    if (!hadAgent && 'agent' in once) problems.push(`agent key appeared: ${raw.id}`);
  });
  return { ok: problems.length === 0, problems, total: tasks.length };
}

function main(argv) {
  const [cmd, a, b, c] = argv;
  try {
    if (cmd === 'backup' && a) {
      let keep = 5;
      if (b !== undefined) {
        if (b !== '--keep' || !/^\d+$/.test(c ?? '') || Number(c) < 1) throw new RangeError('--keep must be an integer >= 1');
        keep = Number(c);
      }
      console.log(JSON.stringify(backup(a, { keep })));
      return 0;
    }
    if (cmd === 'counts' && a) { console.log(JSON.stringify(counts(a))); return 0; }
    if (cmd === 'compare' && a && b) {
      const r = compare(a, b);
      console.log(JSON.stringify(r));
      return r.ok ? 0 : 1;
    }
    if (cmd === 'check-snapshot' && a) {
      const r = checkSnapshot(a);
      console.log(JSON.stringify(r));
      return r.ok ? 0 : 1;
    }
    console.error('usage: deploy-check.mjs backup <dataDir> [--keep N] | counts <file> | compare <before> <after> | check-snapshot <file>');
    return 2;
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
