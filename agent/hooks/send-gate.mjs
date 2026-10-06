#!/usr/bin/env node
// Gate отправки (M6): хук PreToolUse/PostToolUse/PostToolUseFailure из --settings процесса claude.
// Единственная точка, где решается, откроется ли send-инструмент (ADR-004). Fail-closed: любой сбой
// pre завершает процесс кодом 2, а команда хука ещё и оканчивается `|| exit 2`.
//   node send-gate.mjs pre  <runDir> <policyPath>   решение allow|deny
//   node send-gate.mjs post <runDir>                итог ok
//   node send-gate.mjs fail <runDir>                итог error
// Хук не читает окружение, ничего не пишет вне runDir и не меняет вход вызова (updatedInput не используется).
// Списки адресатов не попадают ни в stdout, ни в stderr, ни в журнал.

import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { SPECS, describeCall, contentRisk } from '../lib/send-targets.mjs';
import { loadSendPolicy } from '../lib/send-policy.mjs';
import { takeSlot } from '../lib/send-slots.mjs';
import { appendAudit, extractRef } from '../lib/audit.mjs';

export const STDIN_MAX_BYTES = 1024 * 1024;

const PHRASES = Object.freeze({
  policy: 'политика отправки не прочитана',
  target_missing: 'адресат не определён',
  not_allowed: 'адресат вне списка',
  limit: 'потолок исчерпан',
  quick_action: 'быстрое действие в тексте',
  macro: 'запрещённый макрос',
  gate_error: 'сбой проверки',
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Общие поля записи из входа хука. */
function baseRecord(input, now) {
  const rec = {
    ts: now,
    tool_use_id: typeof input?.tool_use_id === 'string' && input.tool_use_id !== '' ? input.tool_use_id : `noid-${now}-${randomUUID().slice(0, 8)}`,
  };
  if (typeof input?.agent_type === 'string' && input.agent_type) rec.agent_type = input.agent_type;
  if (input?.agent_id !== undefined && input?.agent_id !== null && input.agent_id !== '') rec.sub = true;
  return rec;
}

/** Вид и подпись вызова для записи, если их удалось определить. */
function describe(input) {
  const call = describeCall(input?.tool_name, input?.tool_input);
  const kind = call?.kind ?? (Object.hasOwn(SPECS, input?.tool_name) ? SPECS[input.tool_name].kind : undefined);
  return { call, fields: { ...(kind ? { kind } : {}), ...(call ? { target: call.target, snippet: call.snippet } : {}) } };
}

/**
 * Решение pre без процесса. Побочные эффекты: слот и строки аудита в runDir.
 * Порядок: политика прочитана, адресат определён, key в белом списке, слот занят, попытка записана.
 * @returns {{ decision: 'allow'|'deny', reason: string|null, record: object }}
 */
export function decidePre({ input, runDir, policyPath, now = Date.now(), uid }) {
  const base = baseRecord(input, now);
  let call = null;
  let fields = {};
  const block = (reason) => {
    const { snippet: _snippet, ...noSnippet } = fields;      // SEC09: у blocked текст вызова в журнал не идёт
    const record = { ...base, ...noSnippet, event: 'blocked', reason };
    try { appendAudit(runDir, record); } catch { /* журнал недоступен: решение всё равно deny */ }
    return { decision: 'deny', reason, record };
  };
  try {
    ({ call, fields } = describe(input));
    const loaded = loadSendPolicy(policyPath, uid === undefined ? undefined : { uid });
    if (!loaded.ok) return block('policy');
    if (!call) return block('target_missing');
    if (!loaded.policy.allow[call.list].has(call.key)) return block('not_allowed');
    const risk = contentRisk(input?.tool_name, input?.tool_input);
    if (risk) return block(risk);
    const slot = takeSlot(runDir, call.slot, loaded.policy.limits[call.slot], base.tool_use_id);
    if (!slot.ok) return block('limit');
    const record = { ...base, ...fields, event: 'attempt' };
    appendAudit(runDir, record);                       // сбой записи: исключение, deny gate_error; слот не возвращается
    return { decision: 'allow', reason: null, record };
  } catch {
    return block('gate_error');
  }
}

/**
 * Итог post (ok) или fail (error): пересчёт describeCall по tool_input и запись в аудит.
 * @returns {{ record: object }}
 */
export function recordPost({ input, runDir, event, now = Date.now() }) {
  const base = baseRecord(input, now);
  const { fields } = describe(input);
  const record = { ...base, ...fields, event };
  if (event === 'ok') {
    const ref = extractRef(input?.tool_response);
    if (ref) record.ref = ref;
  } else {
    const raw = typeof input?.error === 'string' ? input.error : isObj(input?.tool_response) ? input.tool_response.error : '';
    record.reason = oneLine(raw).slice(0, 80) || 'ошибка';
  }
  appendAudit(runDir, record);
  return { record };
}

const verdict = (decision, reason) => JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: decision,
    permissionDecisionReason: decision === 'allow' ? 'send-gate' : PHRASES[reason] ?? PHRASES.gate_error,
  },
});

async function readInput(readStdin) {
  const raw = await readStdin();
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > STDIN_MAX_BYTES) throw new Error('input too large');
  let input;
  try { input = JSON.parse(raw); } catch { throw new Error('input is not json'); }   // без текста исключения: оно цитирует вход
  if (!isObj(input)) throw new Error('input is not an object');
  return input;
}

/**
 * @param {string[]} argv аргументы после имени скрипта
 * @param {() => Promise<string>|string} readStdin весь stdin
 * @param {(s: string) => any} write запись в stdout
 * @param {(code: number) => any} exit завершение процесса
 */
export async function main(argv, readStdin, write, exit, { now = Date.now, uid } = {}) {
  const [mode, runDir, policyPath] = argv;
  try {
    if (mode === 'pre') {
      if (!runDir || !policyPath) throw new Error('usage: pre <runDir> <policyPath>');
      const input = await readInput(readStdin);
      const r = decidePre({ input, runDir, policyPath, now: now(), uid });
      if (r.reason === 'gate_error') throw new Error(PHRASES.gate_error);   // упали внутри: exit 2, не решение
      await write(verdict(r.decision, r.reason));
      await exit(0);
      return;
    }
    if (mode === 'post' || mode === 'fail') {
      // Итог необязателен: любой сбой оставляет в журнале attempt без итога («начато, итог не подтверждён»).
      try {
        if (!runDir) throw new Error('usage');
        const input = await readInput(readStdin);
        recordPost({ input, runDir, event: mode === 'post' ? 'ok' : 'error', now: now() });
      } catch { /* молча */ }
      await exit(0);
      return;
    }
    throw new Error('usage: send-gate.mjs pre|post|fail');
  } catch (err) {
    // Страховка: короткая причина без значений, код 2 (блокирующая ошибка для claude).
    if (mode === 'pre' && runDir && err?.message !== PHRASES.gate_error) {
      try { appendAudit(runDir, { ts: now(), tool_use_id: `gate-${now()}-${randomUUID().slice(0, 8)}`, event: 'blocked', reason: 'gate_error' }); } catch { /* ignore */ }
    }
    try { process.stderr.write(`send-gate: ${String(err?.message || 'error').slice(0, 80)}\n`); } catch { /* ignore */ }
    await exit(2);
  }
}

async function readAllStdin() {
  const chunks = [];
  let total = 0;
  for await (const c of process.stdin) {
    total += c.length;
    if (total > STDIN_MAX_BYTES) throw new Error('input too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(
    process.argv.slice(2), readAllStdin,
    (s) => new Promise((res) => process.stdout.write(s, res)),
    (code) => { process.exitCode = code; setImmediate(() => process.exit(code)); },
  );
}
