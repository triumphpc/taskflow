// Синтетический user-scope `.claude.json` для тестов режима с отправкой: четыре сервера из allowlist и два лишних.
// Настоящий ~/.claude.json в тестах не читается никогда: HOME (или CLAUDE_CONFIG_DIR) всегда временный.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Выдуманные значения для проверки утечек: ищем их в логах, argv и stderr. */
export const FAKE_VALUES = Object.freeze({
  jira: 'jira-fake-value-AAA111',
  confluence: 'conf-fake-value-BBB222',
  gitlab: 'gitlab-fake-value-CCC333',
  header: 'header-fake-value-DDD444',
  foreign: 'foreign-fake-value-EEE555',
});

export const userClaudeJson = (over = {}) => ({
  numStartups: 7,
  mcpServers: {
    'mcp-workspace-assistant': { type: 'http', url: 'https://ws.example/mcp', headers: { 'X-Test': FAKE_VALUES.header } },
    'mcp-jira': { type: 'stdio', command: 'jira-mcp', args: ['--serve'], env: { JIRA_VAR: FAKE_VALUES.jira } },
    'mcp-confluence': { type: 'stdio', command: 'confluence-mcp', args: [], env: { CONFLUENCE_VAR: FAKE_VALUES.confluence } },
    'generic:gitlab': { type: 'stdio', command: 'gitlab-mcp', args: ['--stdio'], env: { GITLAB_VAR: FAKE_VALUES.gitlab } },
    telegram: { type: 'stdio', command: 'tg-mcp', args: [], env: { TG_VAR: FAKE_VALUES.foreign } },
    'mcp-kubernetes': { type: 'stdio', command: 'kube-mcp', args: [] },
  },
  ...over,
});

/** Пишет `<root>/.claude.json` (root: временный HOME или CLAUDE_CONFIG_DIR). */
export const writeUserClaudeJson = (root, doc = userClaudeJson()) => writeFile(join(root, '.claude.json'), typeof doc === 'string' ? doc : JSON.stringify(doc), { mode: 0o600 });
