// Файл политики отправки (M3): белые списки адресатов и потолки. Читается заново на каждом вызове gate,
// кеша нет (C4). Любое отклонение даёт отказ с причиной: gate превращает его в deny (fail-closed).
// Значения списков нигде не печатаются.

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LIMIT_DEFAULTS = Object.freeze({ vk: 3, gitlab_comment: 20, jira: 3, confluence: 2 });
export const LIST_MAX = 200;
export const POLICY_FILE_MAX_BYTES = 64 * 1024;
export const LIST_KEYS = Object.freeze(['vk_chats', 'gitlab_projects', 'jira_projects', 'confluence_spaces']);
export const defaultPolicyPath = (home = homedir()) => join(home, '.config', 'taskflow-agent', 'send-policy.json');

/** @typedef {{ allow: Record<string, Set<string>>, limits: Record<string, number> }} SendPolicy */
/** @typedef {'missing'|'not_file'|'mode'|'owner'|'size'|'json'|'version'|'shape'} PolicyReason */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (reason) => ({ ok: false, reason });

function readSafe(path, uid) {
  let fd;
  try {
    // O_NOFOLLOW: симлинк не открывается; O_NONBLOCK: FIFO не подвешивает хук.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    return fail(err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? 'missing' : err?.code === 'ELOOP' ? 'not_file' : 'not_file');
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return fail('not_file');
    if (uid !== undefined && st.uid !== uid) return fail('owner');
    if ((st.mode & 0o177) !== 0) return fail('mode');
    if (st.size > POLICY_FILE_MAX_BYTES) return fail('size');
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = readSync(fd, buf, got, st.size - got, got);
      if (n <= 0) break;
      got += n;
    }
    return { ok: true, text: buf.subarray(0, got).toString('utf8') };
  } catch {
    return fail('not_file');
  } finally {
    try { closeSync(fd); } catch { /* уже закрыт */ }
  }
}

function validate(doc) {
  if (!isObj(doc)) return fail('shape');
  if (doc.version !== 1) return fail('version');
  for (const k of Object.keys(doc)) if (!['version', 'allow', 'limits'].includes(k)) return fail('shape');
  const allow = Object.fromEntries(LIST_KEYS.map((k) => [k, new Set()]));
  if (doc.allow !== undefined) {
    if (!isObj(doc.allow)) return fail('shape');
    for (const [k, list] of Object.entries(doc.allow)) {
      if (!LIST_KEYS.includes(k)) return fail('shape');
      if (!Array.isArray(list) || list.length > LIST_MAX) return fail('shape');
      for (const v of list) if (typeof v !== 'string' || v === '') return fail('shape');
      allow[k] = new Set(list);
    }
  }
  const limits = { ...LIMIT_DEFAULTS };
  if (doc.limits !== undefined) {
    if (!isObj(doc.limits)) return fail('shape');
    for (const [k, n] of Object.entries(doc.limits)) {
      if (!Object.hasOwn(LIMIT_DEFAULTS, k)) return fail('shape');
      if (!Number.isSafeInteger(n) || n < 1) return fail('shape');
      limits[k] = Math.min(n, LIMIT_DEFAULTS[k]);       // поднять потолок файлом нельзя (ADR-005)
    }
  }
  return { ok: true, policy: { allow, limits } };
}

/** @returns {{ ok: true, policy: SendPolicy } | { ok: false, reason: PolicyReason }} */
export function loadSendPolicy(path, { uid = process.getuid?.() } = {}) {
  const r = readSafe(path, uid);
  if (!r.ok) return r;
  let doc;
  try { doc = JSON.parse(r.text); } catch { return fail('json'); }
  return validate(doc);
}

/** Для лога демона, без значений. */
export function policyState(path, opts) {
  const r = loadSendPolicy(path, opts);
  if (!r.ok) return r.reason === 'missing' ? 'missing' : 'invalid';
  return LIST_KEYS.every((k) => r.policy.allow[k].size === 0) ? 'empty' : 'ok';
}
