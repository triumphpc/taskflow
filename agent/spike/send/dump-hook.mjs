#!/usr/bin/env node
// Хук-«рентген» для спайка S1(г, д): пишет вход хука как есть в файл и ничего не решает.
//   node dump-hook.mjs <файл>
// Всегда exit 0 и без вывода, поэтому решения gate не меняет.
import { appendFileSync } from 'node:fs';

let raw = '';
for await (const c of process.stdin) raw += c;
try { appendFileSync(process.argv[2], `${raw.replace(/\n/g, ' ')}\n`); } catch { /* молча */ }
process.exit(0);
