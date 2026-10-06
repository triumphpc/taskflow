#!/usr/bin/env node
// Разбор сырого вывода спайков S1..S3: факты и предложенный вердикт. Вердикт `S1: PASS` вносит пользователь.
//   node evaluate-send.mjs s1|s2|s3 <SPIKE_OUT> [--write-note <spike-s1-s3.md>]
// В заметку и в сводку идут формы данных заглушки (имена полей, типы, счётчики), тексты и значения окружения не попадают.

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractRef } from '../../lib/audit.mjs';
import { SEND_TOOLS } from '../../lib/policy.mjs';

const lines = (file) => {
  try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
};
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const shape = (v) => (v === null ? 'null' : Array.isArray(v) ? `array(${v.length})` : typeof v === 'object' ? `{${Object.keys(v).join(',')}}` : typeof v);
const run = (dir, name) => ({
  calls: lines(join(dir, name, 'calls.jsonl')),
  pre: lines(join(dir, name, 'hook-PreToolUse.jsonl')),
  post: lines(join(dir, name, 'hook-PostToolUse.jsonl')),
  fail: lines(join(dir, name, 'hook-PostToolUseFailure.jsonl')),
  out: join(dir, name, 'out'),
  code: (() => { try { return readFileSync(join(dir, name, 'code'), 'utf8').trim(); } catch { return null; } })(),
});
const isVk = (c) => c.tool === 'messenger-send-message';

export function evaluateS1(dir) {
  const a = run(dir, 'a'); const b = run(dir, 'b'); const c = run(dir, 'c'); const d = run(dir, 'd'); const e = run(dir, 'e');
  const f = run(dir, 'f'); const g = run(dir, 'g'); const k = run(dir, 'k'); const l = run(dir, 'l'); const m = run(dir, 'm');
  const ran = (r) => { try { return statSync(r.out).size > 0 && r.code !== null; } catch { return false; } };
  const facts = {
    a_hook_in_main: a.pre.length > 0,
    a_hook_in_subagent: b.pre.some((x) => x.agent_id !== undefined),
    b_allow_opened_tool: a.calls.some(isVk),
    b_allow_in_subagent: b.calls.some(isVk),
    c_denied_without_hook: c.calls.length === 0 && c.code !== null,
    f_denied_hook_sleeps: f.calls.length === 0 && f.code !== null,
    g_denied_hook_exit1: g.calls.length === 0 && g.code !== null,
    k_plugin_allow_denied: k.calls.length === 0 && ran(k),
    l_sender_agent_hook_fail_denied: l.calls.length === 0 && ran(l),
    m_config_dir_allow_hook_fail_denied: m.calls.length === 0 && ran(m),
    g_pre_fields: a.pre[0] ? Object.keys(a.pre[0]).sort() : [],
    g_sub_pre_fields: b.pre.find((x) => x.agent_id !== undefined) ? Object.keys(b.pre.find((x) => x.agent_id !== undefined)).sort() : [],
    g_post_fields: a.post[0] ? Object.keys(a.post[0]).sort() : [],
    g_fail_fields: d.fail[0] ? Object.keys(d.fail[0]).sort() : [],
    d_response_forms: d.post.map((p) => ({ tool: String(p.tool_name).split('__').slice(2).join('__'), response: shape(p.tool_response), ref_found: extractRef(p.tool_response) !== null })),
    e_chat_sn: a.calls.filter(isVk).map((x) => ({ type: typeof x.args?.chat_sn, value: x.args?.chat_sn })),
    e_project_id: e.calls.filter((x) => x.tool === 'add_merge_request_note').map((x) => ({ type: typeof x.args?.project_id, value: x.args?.project_id })),
    stub_calls: { a: a.calls.length, b: b.calls.length, c: c.calls.length, d: d.calls.length, e: e.calls.length, f: f.calls.length, g: g.calls.length, k: k.calls.length, l: l.calls.length, m: m.calls.length },
    send_tools_expected: SEND_TOOLS.length,
  };
  const pass = facts.a_hook_in_main && facts.a_hook_in_subagent && facts.b_allow_opened_tool && facts.c_denied_without_hook
    && facts.f_denied_hook_sleeps && facts.g_denied_hook_exit1
    && facts.k_plugin_allow_denied && facts.l_sender_agent_hook_fail_denied && facts.m_config_dir_allow_hook_fail_denied;
  return { name: 'S1', facts, proposed: pass ? 'PASS' : 'FAIL' };
}

/** stream-json: события построчно; нужны init (статусы MCP), tool_use/tool_result по Agent и итог result. */
function stream(file) {
  const ev = lines(file);
  const init = ev.find((x) => x.type === 'system' && x.subtype === 'init');
  const result = [...ev].reverse().find((x) => x.type === 'result');
  const uses = []; const results = new Map();
  for (const x of ev) {
    for (const part of x.message?.content || []) {
      if (part.type === 'tool_use' && /^(Agent|Task)$/.test(part.name)) uses.push({ id: part.id, sub: part.input?.subagent_type ?? part.input?.agent ?? null });
      if (part.type === 'tool_result') results.set(part.tool_use_id, part.is_error === true);
    }
  }
  return { init, result, agents: uses.map((u) => ({ sub: u.sub, rejected: results.get(u.id) ?? null })) };
}

export function evaluateS2(dir) {
  const narrow = stream(join(dir, 'narrow', 'out'));
  const tasks = ['t1', 't2', 't3'].map((n) => {
    const s = stream(join(dir, n, 'out'));
    return { task: n, turns: s.result?.num_turns ?? null, cost_usd: s.result?.total_cost_usd ?? null, subtype: s.result?.subtype ?? null };
  });
  const statuses = (narrow.init?.mcp_servers || []).map((m) => m.status);
  const comms = narrow.agents.find((x) => x.sub === 'ai-space-comms');
  const other = narrow.agents.find((x) => x.sub && x.sub !== 'ai-space-comms');
  const facts = {
    a_agent_named_works: comms ? comms.rejected === false : null,
    a_other_names_rejected: other ? other.rejected === true : null,
    b_tasks: tasks,
    b_within_limits: tasks.every((t) => t.subtype === 'success' && t.turns !== null && t.turns <= 50 && (t.cost_usd ?? 0) <= 3),
    c_mcp_status_counts: statuses.reduce((m, s) => ({ ...m, [s]: (m[s] || 0) + 1 }), {}),
  };
  return { name: 'S2', facts, proposed: facts.b_within_limits ? 'PASS' : 'FAIL' };
}

export function evaluateS3(dir) {
  const r = run(dir, 's3');
  const facts = {
    call_reached_stub: r.calls.some(isVk),
    hook_fired: r.pre.length > 0,
    claude_exit_code: r.code,
    stub_calls: r.calls.length,
  };
  return { name: 'S3', facts, proposed: facts.call_reached_stub ? 'PASS' : 'FAIL' };
}

const EVALUATORS = { s1: evaluateS1, s2: evaluateS2, s3: evaluateS3 };

/** Заменяет блок между маркерами <!-- S1-facts:begin --> и <!-- S1-facts:end -->. */
export function renderFacts(note, result, when = new Date().toISOString().slice(0, 10)) {
  const tag = result.name;
  const block = [`<!-- ${tag}-facts:begin -->`, `${tag}-proposed: ${result.proposed}  (прогон ${when}; вердикт ${tag}: вносит пользователь)`, '', '```json', JSON.stringify(result.facts, null, 2), '```', `<!-- ${tag}-facts:end -->`].join('\n');
  const re = new RegExp(`<!-- ${tag}-facts:begin -->[\\s\\S]*?<!-- ${tag}-facts:end -->`);
  if (!re.test(note)) throw new Error(`в заметке нет маркеров ${tag}-facts`);
  return note.replace(re, () => block);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [which, dir] = process.argv.slice(2);
  if (!EVALUATORS[which] || !dir) { console.error('usage: evaluate-send.mjs s1|s2|s3 <dir> [--write-note <file>]'); process.exit(64); }
  const result = EVALUATORS[which](dir);
  console.log(`${result.name}-proposed: ${result.proposed}`);
  console.log(JSON.stringify(result.facts, null, 2));
  const i = process.argv.indexOf('--write-note');
  if (i > 0 && existsSync(process.argv[i + 1])) {
    writeFileSync(process.argv[i + 1], renderFacts(readFileSync(process.argv[i + 1], 'utf8'), result));
    console.log(`facts written to ${process.argv[i + 1]}; set "${result.name}: PASS|FAIL" there yourself`);
  }
}
