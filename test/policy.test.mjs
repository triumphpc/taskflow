import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_TOOLS, DISALLOWED_TOOLS, LIMITS_RUN, buildClaudeArgs, buildFallbackInvocation, FALLBACK_COMMAND, PRIMARY_COMMAND, AGENT_NAME } from '../agent/lib/policy.mjs';

const toolPart = (n) => n.split('__').slice(2).join('__');
const READ = /(^|[-_])(list|get|read|search|unread|find|resolve|info|children)([-_]|$)/;
const WRITE = /(^|[-_])(send|draft|save|schedule|mark|create|update|delete|add|set|move|copy|restore|run|assign|reply|join|leave|invalidate|rename|modify|remove|unsubscribe|append|attachment|discussion)([-_]|$)/;

test('policy: allow and deny do not intersect (AC-020)', () => {
  assert.deepEqual(ALLOWED_TOOLS.filter((t) => DISALLOWED_TOOLS.includes(t)), []);
  assert.equal(new Set(ALLOWED_TOOLS).size, ALLOWED_TOOLS.length);
  assert.equal(new Set(DISALLOWED_TOOLS).size, DISALLOWED_TOOLS.length);
});

test('policy: every allowed tool is a read tool (read verb, no write verb), full MCP names (AC-020)', () => {
  for (const t of ALLOWED_TOOLS.filter((x) => !['Skill', 'Agent'].includes(x))) {
    assert.match(t, /^mcp__[a-z_-]+__/, t);
    const tool = toolPart(t);
    assert.match(tool, READ, t);
    assert.doesNotMatch(tool, WRITE, t);
  }
});

test('policy: no TaskFlow, Bash, Write, Edit, WebFetch, WebSearch, Read in allow (AC-020)', () => {
  for (const t of ALLOWED_TOOLS) {
    assert.doesNotMatch(t, /taskflow/i);
    assert.ok(!['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Read'].includes(t), t);
  }
  assert.ok(ALLOWED_TOOLS.includes('Skill'));
});

test('policy: deny covers servers, builtins and write tools of mixed servers (AC-012)', () => {
  for (const must of ['mcp__taskflow', 'mcp__mcp-kubernetes', 'mcp__telegram', 'mcp__mcp-playwright', 'mcp__claude-in-chrome',
    'mcp__mcp-postgres-agent-core-demo', 'Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch',
    'mcp__mcp-workspace-assistant__messenger-send-message', 'mcp__mcp-workspace-assistant__mail-save-draft',
    'mcp__mcp-workspace-assistant__calendar-create-event', 'mcp__mcp-jira__jira_add_comment', 'mcp__generic_gitlab__run_job',
    'mcp__mcp-confluence__confluence_page_update']) assert.ok(DISALLOWED_TOOLS.includes(must), must);
  for (const t of DISALLOWED_TOOLS.filter((x) => x.split('__').length === 3)) assert.match(toolPart(t), WRITE, t);
});

test('policy: whole foreign servers are denied (SEC11) and get_project_from_git_remote is not allowed (SEC15)', () => {
  for (const server of ['mcp-codebase-memory', 'mcp-web-search', 'mcp-context7', 'mcp-memory', 'gemini-notebook-mcp', 'yadisk',
    'telegram', 'mcp-kubernetes', 'mcp-playwright', 'claude-in-chrome', 'claude_ai_Gmail', 'claude_ai_Google_Drive',
    'claude_ai_Google_Calendar', 'claude_ai_Claude_Docs', 'taskflow']) {
    assert.ok(DISALLOWED_TOOLS.includes(`mcp__${server}`), server);
    assert.ok(!ALLOWED_TOOLS.some((t) => t.startsWith(`mcp__${server}__`)), `${server} must not be allowed`);
  }
  assert.ok(!ALLOWED_TOOLS.includes('mcp__generic_gitlab__get_project_from_git_remote'));
  // a server deny never swallows an allowed tool: allowed servers are exactly the four we use
  const allowedServers = new Set(ALLOWED_TOOLS.filter((t) => t.startsWith('mcp__')).map((t) => t.split('__')[1]));
  assert.deepEqual([...allowedServers].sort(), ['generic_gitlab', 'mcp-confluence', 'mcp-jira', 'mcp-workspace-assistant']);
  for (const server of allowedServers) assert.ok(!DISALLOWED_TOOLS.includes(`mcp__${server}`), server);
});

test('policy: argv starts with the agent flag, limits are numbers, values are single elements (AC-009, AC-021)', () => {
  const a = buildClaudeArgs();
  assert.deepEqual(a.slice(0, 2), ['--agent', 'ai-space-assistant']);
  assert.equal(AGENT_NAME, 'ai-space-assistant');
  assert.equal(a[a.indexOf('--max-turns') + 1], '30');
  assert.equal(a[a.indexOf('--max-budget-usd') + 1], '2.00');
  assert.equal(a[a.indexOf('--allowedTools') + 1], ALLOWED_TOOLS.join(','));
  assert.equal(a[a.indexOf('--disallowedTools') + 1], DISALLOWED_TOOLS.join(','));
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
  assert.equal(ALLOWED_TOOLS.length, 24 + 5 + 8 + 6 + 2);
  assert.deepEqual(ALLOWED_TOOLS.slice(-2), ['Skill', 'Agent']);
});

test('policy: local filesystem tools are denied, Skill and Agent stay allowed (SEC01)', () => {
  for (const t of ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'NotebookEdit', 'Bash', 'Write', 'Edit']) {
    assert.ok(DISALLOWED_TOOLS.includes(t), t);
    assert.ok(!ALLOWED_TOOLS.includes(t), t);
  }
  assert.ok(ALLOWED_TOOLS.includes('Skill') && ALLOWED_TOOLS.includes('Agent'));
  assert.ok(!DISALLOWED_TOOLS.includes('Agent') && !DISALLOWED_TOOLS.includes('Skill'));
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
  assert.equal(allowed, ALLOWED_TOOLS.join(','));
  assert.equal(denied, DISALLOWED_TOOLS.join(','));
});
