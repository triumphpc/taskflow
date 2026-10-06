import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ALLOWED_TOOLS, DISALLOWED_TOOLS, SEND_EXTRA_DISALLOWED, READONLY_ALLOWED, READONLY_DISALLOWED, SEND_TOOLS, CONVERTER_TOOL, SUBAGENTS, NARROW_AGENT,
  LIMITS_RUN, LIMITS_SEND, SEND_SWITCH, isSendEnabled, buildGateSettings, buildClaudeArgs, buildFallbackInvocation,
  FALLBACK_COMMAND, PRIMARY_COMMAND, AGENT_NAME,
} from '../agent/lib/policy.mjs';
import { SYSTEM_PROMPT, SYSTEM_PROMPT_SEND } from '../agent/lib/prompt.mjs';

// Эталон режима «только чтение», снятый до change agent-send-actions.
const BASE = JSON.parse(readFileSync(new URL('./fixtures/readonly-baseline.json', import.meta.url), 'utf8'));
const MCP_PATH = '/state/runs/t1-1/mcp.json';
const GATE = { nodePath: '/usr/bin/node', gatePath: '/repo/agent/hooks/send-gate.mjs', runDir: '/state/runs/t1-1', policyPath: '/cfg/send-policy.json' };

const toolPart = (n) => n.split('__').slice(2).join('__');
const READ = /(^|[-_])(list|get|read|search|unread|find|resolve|info|children)([-_]|$)/;
const WRITE = /(^|[-_])(send|draft|save|schedule|mark|create|update|delete|add|set|move|copy|restore|run|assign|reply|join|leave|invalidate|rename|modify|remove|unsubscribe|append|attachment|discussion)([-_]|$)/;

test('policy: allow and deny do not intersect (AC-020)', () => {
  assert.deepEqual(READONLY_ALLOWED.filter((t) => READONLY_DISALLOWED.includes(t)), []);
  assert.equal(new Set(READONLY_ALLOWED).size, READONLY_ALLOWED.length);
  assert.equal(new Set(READONLY_DISALLOWED).size, READONLY_DISALLOWED.length);
});

test('policy: every allowed tool is a read tool (read verb, no write verb), full MCP names (AC-020)', () => {
  for (const t of READONLY_ALLOWED.filter((x) => !['Skill', 'Agent'].includes(x))) {
    assert.match(t, /^mcp__[a-z_-]+__/, t);
    const tool = toolPart(t);
    assert.match(tool, READ, t);
    assert.doesNotMatch(tool, WRITE, t);
  }
});

test('policy: no TaskFlow, Bash, Write, Edit, WebFetch, WebSearch, Read in allow (AC-020)', () => {
  for (const t of READONLY_ALLOWED) {
    assert.doesNotMatch(t, /taskflow/i);
    assert.ok(!['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Read'].includes(t), t);
  }
  assert.ok(READONLY_ALLOWED.includes('Skill'));
});

test('policy: deny covers servers, builtins and write tools of mixed servers (AC-012)', () => {
  for (const must of ['mcp__taskflow', 'mcp__mcp-kubernetes', 'mcp__telegram', 'mcp__mcp-playwright', 'mcp__claude-in-chrome',
    'mcp__mcp-postgres-agent-core-demo', 'Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch',
    'mcp__mcp-workspace-assistant__messenger-send-message', 'mcp__mcp-workspace-assistant__mail-save-draft',
    'mcp__mcp-workspace-assistant__calendar-create-event', 'mcp__mcp-jira__jira_add_comment', 'mcp__generic_gitlab__run_job',
    'mcp__mcp-confluence__confluence_page_update']) assert.ok(READONLY_DISALLOWED.includes(must), must);
  for (const t of READONLY_DISALLOWED.filter((x) => x.split('__').length === 3)) assert.match(toolPart(t), WRITE, t);
});

test('policy: whole foreign servers are denied (SEC11) and get_project_from_git_remote is not allowed (SEC15)', () => {
  for (const server of ['mcp-codebase-memory', 'mcp-web-search', 'mcp-context7', 'mcp-memory', 'gemini-notebook-mcp', 'yadisk',
    'telegram', 'mcp-kubernetes', 'mcp-playwright', 'claude-in-chrome', 'claude_ai_Gmail', 'claude_ai_Google_Drive',
    'claude_ai_Google_Calendar', 'claude_ai_Claude_Docs', 'taskflow']) {
    assert.ok(READONLY_DISALLOWED.includes(`mcp__${server}`), server);
    assert.ok(!READONLY_ALLOWED.some((t) => t.startsWith(`mcp__${server}__`)), `${server} must not be allowed`);
  }
  assert.ok(!READONLY_ALLOWED.includes('mcp__generic_gitlab__get_project_from_git_remote'));
  // a server deny never swallows an allowed tool: allowed servers are exactly the four we use
  const allowedServers = new Set(READONLY_ALLOWED.filter((t) => t.startsWith('mcp__')).map((t) => t.split('__')[1]));
  assert.deepEqual([...allowedServers].sort(), ['generic_gitlab', 'mcp-confluence', 'mcp-jira', 'mcp-workspace-assistant']);
  for (const server of allowedServers) assert.ok(!READONLY_DISALLOWED.includes(`mcp__${server}`), server);
});

test('policy: argv starts with the agent flag, limits are numbers, values are single elements (AC-009, AC-021)', () => {
  const a = buildClaudeArgs();
  assert.deepEqual(a.slice(0, 2), ['--agent', 'ai-space-assistant']);
  assert.equal(AGENT_NAME, 'ai-space-assistant');
  assert.equal(a[a.indexOf('--max-turns') + 1], '30');
  assert.equal(a[a.indexOf('--max-budget-usd') + 1], '2.00');
  assert.equal(a[a.indexOf('--allowedTools') + 1], READONLY_ALLOWED.join(','));
  assert.equal(a[a.indexOf('--disallowedTools') + 1], READONLY_DISALLOWED.join(','));
  assert.ok(a.includes('-p') && a.includes('--append-system-prompt'));
  assert.equal(a[a.indexOf('--output-format') + 1], 'json');
  assert.equal(PRIMARY_COMMAND, 'claude');
  assert.equal(LIMITS_RUN.MAX_TASKS_PER_RUN, 3);
  assert.equal(LIMITS_RUN.TASK_TIMEOUT_MS, 900_000);
  assert.equal(LIMITS_RUN.POLL_MS, 60_000);
  assert.equal(LIMITS_RUN.KILL_GRACE_MS, 10_000);
  assert.ok(Object.isFrozen(LIMITS_RUN));
});

test('policy: argv runs in dontAsk mode, never bypasses permissions and has no task text (review I01)', () => {
  const a = buildClaudeArgs();
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(a.filter((x) => x === '--permission-mode').length, 1);
  const joined = a.join('\n');
  for (const bad of ['bypassPermissions', '--dangerously-skip-permissions', 'acceptEdits', 'auto']) assert.ok(!a.includes(bad), bad);
  assert.ok(!joined.includes('bypassPermissions'));
  assert.ok(buildFallbackInvocation().args[1].includes(`'--permission-mode' 'dontAsk'`));
  assert.ok(!buildFallbackInvocation().args.join('\n').includes('--dangerously-skip-permissions'));
});

test('policy: fallback `zsh -ic claude-paiw` is a separate constant with the same flags, not the default (AC-009)', () => {
  assert.deepEqual({ ...FALLBACK_COMMAND }, { command: 'zsh', shellFunction: 'claude-paiw' });
  const f = buildFallbackInvocation();
  assert.equal(f.command, 'zsh');
  assert.equal(f.args[0], '-ic');
  assert.match(f.args[1], /; claude-paiw '--agent' 'ai-space-assistant' '-p'/);
  assert.ok(f.args[1].includes(`'--max-turns' '30'`));
  assert.notEqual(PRIMARY_COMMAND, FALLBACK_COMMAND.command);
});

test('policy: the allowlist is pinned (any change needs a test edit, C9)', () => {
  assert.equal(READONLY_ALLOWED.length, 24 + 5 + 8 + 6 + 2);
  assert.deepEqual(READONLY_ALLOWED.slice(-2), ['Skill', 'Agent']);
});

test('policy: local filesystem tools are denied, Skill and Agent stay allowed (SEC01)', () => {
  for (const t of ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'NotebookEdit', 'Bash', 'Write', 'Edit']) {
    assert.ok(READONLY_DISALLOWED.includes(t), t);
    assert.ok(!READONLY_ALLOWED.includes(t), t);
  }
  assert.ok(READONLY_ALLOWED.includes('Skill') && READONLY_ALLOWED.includes('Agent'));
  assert.ok(!READONLY_DISALLOWED.includes('Agent') && !READONLY_DISALLOWED.includes('Skill'));
});

test('policy: fallback line unsets TASKFLOW_* after the shell rc is loaded (SEC07)', () => {
  const line = buildFallbackInvocation().args[1];
  assert.match(line, /^for v in \$\{\(k\)parameters\[\(I\)TASKFLOW_\*\]\}; do unset \$v; done; claude-paiw /);
});

test('policy: spike allowlists are generated from policy.mjs (SEC01/SEC02)', async () => {
  const { spawnSync } = await import('node:child_process');
  const sh = spawnSync('sh', ['-c', 'HERE=agent/spike; . agent/spike/allowlists.sh; printf "%s\\n%s" "$ALLOWED" "$DENIED"'], { encoding: 'utf8' });
  assert.equal(sh.status, 0, sh.stderr);
  const [allowed, denied] = sh.stdout.split('\n');
  assert.equal(allowed, READONLY_ALLOWED.join(','));
  assert.equal(denied, READONLY_DISALLOWED.join(','));
});

// ---------- режим с отправкой (agent-send-actions) ----------

const SEND_NAMES = [
  'mcp__mcp-workspace-assistant__messenger-send-message', 'mcp__generic_gitlab__add_merge_request_note',
  'mcp__generic_gitlab__create_discussion', 'mcp__generic_gitlab__reply_to_discussion',
  'mcp__mcp-jira__jira_add_comment', 'mcp__mcp-confluence__confluence_page_create',
];
const inter = (a, b) => a.filter((x) => b.includes(x));

test('policy: [send] AC-008 AC-021: SEND_TOOLS is exactly the six tools and sits outside allow and deny of the send mode (C1)', () => {
  assert.deepEqual([...SEND_TOOLS], SEND_NAMES);
  assert.ok(Object.isFrozen(SEND_TOOLS));
  assert.deepEqual(inter(SEND_TOOLS, ALLOWED_TOOLS), []);
  assert.deepEqual(inter(SEND_TOOLS, DISALLOWED_TOOLS), []);
  assert.deepEqual(inter(ALLOWED_TOOLS, DISALLOWED_TOOLS), []);
  assert.ok(ALLOWED_TOOLS.includes(CONVERTER_TOOL));
  assert.ok(!READONLY_ALLOWED.includes(CONVERTER_TOOL));
  assert.equal(CONVERTER_TOOL, 'mcp__mcp-confluence__confluence_content_from_markdown');
  assert.equal(new Set(ALLOWED_TOOLS).size, ALLOWED_TOOLS.length);
  assert.equal(new Set(DISALLOWED_TOOLS).size, DISALLOWED_TOOLS.length);
});

test('policy: read-only lists equal the send lists except the send tools and the converter (C1)', () => {
  assert.deepEqual(READONLY_DISALLOWED.filter((t) => !SEND_TOOLS.includes(t)), DISALLOWED_TOOLS.filter((t) => !SEND_EXTRA_DISALLOWED.includes(t)));
  assert.deepEqual([...READONLY_DISALLOWED].sort(), [...DISALLOWED_TOOLS.filter((t) => !SEND_EXTRA_DISALLOWED.includes(t)), ...SEND_TOOLS].sort());
  assert.deepEqual([...READONLY_ALLOWED], ALLOWED_TOOLS.filter((t) => t !== CONVERTER_TOOL));
  assert.equal(NARROW_AGENT, false);
  assert.ok(ALLOWED_TOOLS.includes('Agent') && ALLOWED_TOOLS.includes('Skill'));
  assert.deepEqual([...SUBAGENTS], ['ai-space-comms', 'ai-space-knowledge', 'ai-space-delivery', 'ai-space-context-collector']);
});

test('policy: [send] AC-009 deny keeps mail, calendar, chat creation, members, resolve, merge, deletes, page edits, builtins, kubernetes, taskflow', () => {
  for (const must of [
    'mcp__mcp-workspace-assistant__mail-schedule', 'mcp__mcp-workspace-assistant__mail-save-draft',
    'mcp__mcp-workspace-assistant__calendar-create-event', 'mcp__mcp-workspace-assistant__messenger-create-chat',
    'mcp__mcp-workspace-assistant__messenger-add-chat-members', 'mcp__mcp-workspace-assistant__messenger-remove-chat-members',
    'mcp__generic_gitlab__resolve_discussion', 'mcp__generic_gitlab__update_merge_request', 'mcp__generic_gitlab__create_merge_request',
    'mcp__mcp-jira__jira_delete_issue', 'mcp__mcp-jira__jira_create_issue', 'mcp__mcp-jira__jira_update_issue',
    'mcp__mcp-confluence__confluence_page_update', 'mcp__mcp-confluence__confluence_page_move', 'mcp__mcp-confluence__confluence_page_delete',
    'mcp__mcp-confluence__confluence_comment_add', 'mcp__mcp-confluence__confluence_label_add', 'mcp__mcp-confluence__confluence_attachment_add',
    'Bash', 'Read', 'Glob', 'Grep', 'LS', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'mcp__mcp-kubernetes', 'mcp__taskflow',
  ]) assert.ok(DISALLOWED_TOOLS.includes(must), must);
  for (const t of ALLOWED_TOOLS.filter((x) => x.startsWith('mcp__'))) assert.doesNotMatch(t, /taskflow|kubernetes/);
});

test('policy: [send] AC-021: send argv is dontAsk with explicit lists, LIMITS_SEND and --settings, no bypass in any mode (C2)', () => {
  const a = buildClaudeArgs({ send: true, gate: GATE, mcpConfigPath: MCP_PATH });
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(a.filter((x) => x === '--permission-mode').length, 1);
  assert.equal(a[a.indexOf('--allowedTools') + 1], ALLOWED_TOOLS.join(','));
  assert.equal(a[a.indexOf('--disallowedTools') + 1], DISALLOWED_TOOLS.join(','));
  assert.equal(a[a.indexOf('--max-turns') + 1], '50');
  assert.equal(a[a.indexOf('--max-budget-usd') + 1], '3.00');
  assert.deepEqual({ ...LIMITS_SEND }, { ...LIMITS_RUN, MAX_TURNS: 50, MAX_BUDGET_USD: '3.00' });
  assert.equal(a[a.indexOf('--append-system-prompt') + 1], SYSTEM_PROMPT_SEND);
  assert.deepEqual(JSON.parse(a[a.indexOf('--settings') + 1]), buildGateSettings(GATE));
  assert.deepEqual(a.slice(0, 2), ['--agent', 'ai-space-assistant']);
  for (const argv of [a, buildClaudeArgs(), buildFallbackInvocation({ send: true, gate: GATE, mcpConfigPath: MCP_PATH }).args, buildFallbackInvocation().args]) {
    const joined = argv.join('\n');
    for (const bad of ['bypassPermissions', '--dangerously-skip-permissions', 'acceptEdits']) assert.ok(!joined.includes(bad), bad);
    assert.ok(!argv.includes('auto'));
    assert.ok(!/--permission-mode'? '?auto/.test(joined));
  }
  for (const t of SEND_TOOLS) assert.ok(!a[a.indexOf('--allowedTools') + 1].includes(t), `${t} is not in --allowedTools`);
});

test('policy: send:true without a gate throws TypeError (M1 error mode)', () => {
  assert.throws(() => buildClaudeArgs({ send: true }), TypeError);
  assert.throws(() => buildClaudeArgs({ send: true, gate: GATE }), TypeError, 'send mode without mcpConfigPath: fail-closed');
  assert.throws(() => buildClaudeArgs({ send: true, gate: GATE, mcpConfigPath: '' }), TypeError);
  assert.throws(() => buildClaudeArgs({ send: true, gate: { nodePath: 'n' } }), TypeError);
  assert.throws(() => buildFallbackInvocation({ send: true }), TypeError);
});

test('policy: [send] AC-027 read-only mode argv, fallback and prompts equal the pre-change baseline byte for byte', () => {
  assert.deepEqual(buildClaudeArgs(), BASE.args);
  assert.deepEqual(buildClaudeArgs({ send: false }), BASE.args);
  assert.deepEqual(buildClaudeArgs({ send: false, gate: GATE }), BASE.args);
  assert.deepEqual(buildFallbackInvocation(), BASE.fallback);
  assert.equal(SYSTEM_PROMPT, BASE.systemPrompt);
  assert.equal(JSON.stringify(buildClaudeArgs()).includes('--settings'), false);
});

test('policy: [send] AC-033 SEC03 isSendEnabled is opt-in: only "on" means send, no variable or anything else is read-only', () => {
  assert.equal(SEND_SWITCH, 'TASKFLOW_AGENT_SEND');
  assert.equal(isSendEnabled({}), false, 'no variable: read-only');
  assert.equal(isSendEnabled({ TASKFLOW_AGENT_SEND: undefined }), false);
  assert.equal(isSendEnabled({ TASKFLOW_AGENT_SEND: 'on' }), true);
  for (const v of ['off', '', 'ON ', 'On', 'true', '1', 'of', 'offf', ' on']) assert.equal(isSendEnabled({ TASKFLOW_AGENT_SEND: v }), false, JSON.stringify(v));
});

test('policy: gate settings: three hooks, anchored escaped matcher, quoted paths, `|| exit 2` on pre, timeout 10 (C3)', () => {
  const s = buildGateSettings(GATE);
  assert.deepEqual(Object.keys(s.hooks), ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
  const matchers = new Set(Object.values(s.hooks).map((h) => h[0].matcher));
  assert.equal(matchers.size, 1);
  const re = new RegExp([...matchers][0]);
  for (const t of SEND_TOOLS) assert.ok(re.test(t), t);
  for (const t of [CONVERTER_TOOL, 'x' + SEND_TOOLS[0], SEND_TOOLS[0] + 'x', 'mcp__mcp-jira__jira_get_issue', 'Bash']) assert.ok(!re.test(t), t);
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, `'/usr/bin/node' '/repo/agent/hooks/send-gate.mjs' pre '/state/runs/t1-1' '/cfg/send-policy.json' || exit 2`);
  assert.equal(s.hooks.PostToolUse[0].hooks[0].command, `'/usr/bin/node' '/repo/agent/hooks/send-gate.mjs' post '/state/runs/t1-1'`);
  assert.equal(s.hooks.PostToolUseFailure[0].hooks[0].command, `'/usr/bin/node' '/repo/agent/hooks/send-gate.mjs' fail '/state/runs/t1-1'`);
  for (const h of Object.values(s.hooks)) { assert.equal(h[0].hooks[0].timeout, 10); assert.equal(h[0].hooks[0].type, 'command'); }
  assert.ok(!/\|\| exit 2/.test(s.hooks.PostToolUse[0].hooks[0].command));
});

test('policy: gate paths with quotes and spaces are shell-quoted', () => {
  const s = buildGateSettings({ ...GATE, runDir: "/state/it's here/run" });
  assert.ok(s.hooks.PreToolUse[0].hooks[0].command.includes(`'/state/it'\\''s here/run'`));
});

test('policy: the fallback invocation carries the settings JSON quoted', () => {
  const f = buildFallbackInvocation({ send: true, gate: GATE, mcpConfigPath: MCP_PATH });
  assert.equal(f.command, 'zsh');
  assert.match(f.args[1], /'--settings' '\{"hooks":/);
  assert.match(f.args[1], /'--max-turns' '50'/);
});

test('policy: spike send lists are generated from policy.mjs', async () => {
  const { spawnSync } = await import('node:child_process');
  const out = (w) => spawnSync(process.execPath, ['agent/spike/print-lists.mjs', w], { encoding: 'utf8' }).stdout;
  assert.equal(out('allowed-send'), ALLOWED_TOOLS.join(','));
  assert.equal(out('denied-send'), DISALLOWED_TOOLS.join(','));
});

test('policy: [send] SEC07 send mode closes every plugin server and sequential-thinking by prefix; read-only argv is unchanged', () => {
  for (const must of ['mcp__plugin_', 'mcp__mcp-sequential-thinking']) {
    assert.ok(DISALLOWED_TOOLS.includes(must), must);
    assert.ok(!READONLY_DISALLOWED.includes(must), `${must} must not leak into the read-only baseline`);
  }
  assert.deepEqual([...SEND_EXTRA_DISALLOWED], ['mcp__plugin_', 'mcp__mcp-sequential-thinking']);
  assert.deepEqual(ALLOWED_TOOLS.filter((t) => SEND_EXTRA_DISALLOWED.some((p) => t.startsWith(p))), []);
});
