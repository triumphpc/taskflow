// Spike helper: sanitized summary of claude runs. usage: node evaluate.mjs <outDir>
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { redactStderr } from '../lib/claude-run.mjs';
const dir = process.argv[2];
const rd = (n) => readFile(`${dir}/${n}`, 'utf8').catch(() => '');
const split = (s) => s.split(',').filter(Boolean);
const allowed = split((await rd('allowed.txt')).trim());
const denied = split((await rd('denied.txt')).trim());
const sum = {};

// U5 (SEC01): local FS tools must be rejected (also in sub-agents via Agent); the canary file outside the sandbox must not leak.
const FS_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'Bash', 'Write', 'Edit']);
function u5Verdict(events, raw, canary) {
  const uses = [];
  const results = new Map();
  for (const e of events) {
    const parts = e.message?.content;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      if (p.type === 'tool_use') uses.push({ id: p.id, name: p.name, sub: Boolean(e.parent_tool_use_id) });
      if (p.type === 'tool_result') results.set(p.tool_use_id, { error: p.is_error === true });
    }
  }
  const fs = uses.filter((u) => FS_TOOLS.has(u.name));
  const accepted = fs.filter((u) => results.get(u.id)?.error === false);
  return {
    u5_fs_tool_calls: fs.length,
    u5_fs_tool_calls_in_subagents: fs.filter((u) => u.sub).length,
    u5_agent_calls: uses.filter((u) => u.name === 'Agent' || u.name === 'Task').length,
    u5_read_outside_sandbox_rejected: accepted.length === 0,
    u5_subagent_inherits_deny: accepted.filter((u) => u.sub).length === 0,
    u5_canary_leaked: canary !== '' && raw.includes(canary),
  };
}
const canary = (await rd('canary.id')).trim();
for (const run of ['r1', 'r2', 'r3', 'r4']) {
  const code = (await rd(`${run}.code`)).trim();
  if (code === '') continue;
  const out = await rd(`${run}.out`);
  const s = { exit_code: Number(code), stdout_bytes: out.length, stderr_tail: redactStderr((await rd(`${run}.err`)).slice(-300), process.env) };   // the daemon's redaction (SEC04)
  if (run === 'r1') {
    try {
      const env = JSON.parse(out);
      Object.assign(s, { type: env.type, subtype: env.subtype, is_error: env.is_error, num_turns: env.num_turns, cost_usd: env.total_cost_usd,
        keys: Object.keys(env), result: String(env.result ?? '').slice(0, 400) });
      try { JSON.parse(String(env.result).replace(/^```(?:json)?\s*|\s*```$/g, '')); s.result_is_json = true; } catch { s.result_is_json = false; }
    } catch { s.envelope = 'unparseable'; }
  } else {
    const events = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
    const res = events.find((e) => e.type === 'result');
    if (init) {
      const tools = init.tools || [];
      s.tools_total = tools.length;
      s.mcp_servers = (init.mcp_servers || []).map((m) => `${m.name}:${m.status}`);
      s.allowed_present = allowed.filter((a) => tools.includes(a));
      s.allowed_missing = allowed.filter((a) => !tools.includes(a));
      s.denied_present = tools.filter((t) => denied.some((d) => t === d || t.startsWith(d + '__')));
      s.builtin_tools = tools.filter((t) => !t.startsWith('mcp__'));
      s.taskflow_tools = tools.filter((t) => t.startsWith('mcp__taskflow'));
      s.skills_count = (init.skills || []).length;
      s.agents = (init.agents || []).slice(0, 40);
      s.permission_mode = init.permissionMode;
      // Review I01: under --permission-mode dontAsk nothing outside allow may be usable. Names listed here are
      // tools visible in init that are not in ALLOWED; the user must confirm (open item) that they are denied
      // at call time, not merely listed. Expected permission_mode: dontAsk.
      s.permission_mode_is_dontAsk = init.permissionMode === 'dontAsk';
      s.tools_outside_allow = tools.filter((t) => !allowed.includes(t));
    }
    if (run === 'r4') Object.assign(s, u5Verdict(events, out, canary));
    if (res) Object.assign(s, { result_subtype: res.subtype, is_error: res.is_error, cost_usd: res.total_cost_usd });
  }
  sum[run] = s;
}
sum.mcp_probe = JSON.parse(await rd('mcp-probe.json') || '{}');
await writeFile(`${dir}/summary.json`, JSON.stringify(sum, null, 2), { mode: 0o600 });
await chmod(`${dir}/summary.json`, 0o600);
console.log(JSON.stringify(sum, null, 2));
