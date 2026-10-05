// Политика запуска claude: только чтение, жёсткие лимиты. Процесс claude запускается ТОЛЬКО через
// buildClaudeArgs() (C9); любое изменение списков сопровождается правкой test/policy.test.mjs.
// Имена инструментов MCP полные: mcp__<сервер>__<инструмент>. Сверка с реальным составом — spike U5
// (agent/spike/run-spike.sh).

import { SYSTEM_PROMPT } from './prompt.mjs';

export const AGENT_NAME = 'ai-space-assistant';

export const LIMITS_RUN = Object.freeze({
  MAX_TASKS_PER_RUN: 3,
  TASK_TIMEOUT_MS: 15 * 60_000,
  POLL_MS: 60_000,
  KILL_GRACE_MS: 10_000,
  MAX_TURNS: 30,
  MAX_BUDGET_USD: '2.00',
  STDOUT_CAP_BYTES: 1_048_576,
});

const WS = 'mcp__mcp-workspace-assistant__';
const JIRA = 'mcp__mcp-jira__';
const GL = 'mcp__generic_gitlab__';
const CF = 'mcp__mcp-confluence__';
const names = (prefix, list) => list.map((n) => prefix + n);

/** Только чтение внешних систем. Ни TaskFlow, ни Bash, Write, Edit, Read/Glob/Grep/LS, WebFetch, WebSearch. */
export const ALLOWED_TOOLS = Object.freeze([
  ...names(WS, ['mail-list-folders', 'mail-list-threads', 'mail-read-thread', 'mail-search', 'mail-unread',
    'messenger-get-chat-info', 'messenger-get-current-user', 'messenger-list-chats', 'messenger-list-folders',
    'messenger-list-messages', 'messenger-search', 'messenger-search-entities', 'messenger-search-summaries',
    'messenger-resolve-message-url', 'messenger-get-message-reactions',
    'calendar-list-events', 'calendar-list-calendars', 'calendar-find-free-slots',
    'orgstructure-get-root', 'orgstructure-search', 'orgstructure-unit-get', 'orgstructure-unit-staff-get',
    'orgstructure-unit-subunits-get', 'orgstructure-users-get']),
  ...names(JIRA, ['jira_get_issue', 'jira_get_comments', 'jira_search_issues', 'jira_get_project', 'jira_get_projects']),
  ...names(GL, ['get_merge_request', 'get_merge_request_discussions', 'get_merge_request_approvals', 'get_branch_diff',
    'get_commits', 'get_repository_file_raw', 'get_project_info', 'list_merge_requests']),
  ...names(CF, ['confluence_page_get', 'confluence_page_get_by_title', 'confluence_search', 'confluence_search_cql',
    'confluence_comment_list', 'confluence_page_children']),
  // Решение оркестратора (security SEC01): ai-space-assistant делегирует субагентам через Agent, навыки — через Skill.
  // Защита: deny имеет приоритет над allowed-tools навыков и субагентов, плюс --permission-mode dontAsk.
  'Skill', 'Agent',
]);

/** Отправка, запись, прод. Приоритет над любыми allow из пользовательских настроек. */
export const DISALLOWED_TOOLS = Object.freeze([
  // целые серверы
  'mcp__mcp-kubernetes', 'mcp__taskflow', 'mcp__mcp-playwright', 'mcp__claude-in-chrome', 'mcp__telegram',
  'mcp__mcp-postgres-agent-core-demo',
  // SEC11: остальные серверы пользовательской установки закрыты целиком (память, поиск, облачные коннекторы, K8s и т. д.)
  'mcp__mcp-codebase-memory', 'mcp__mcp-web-search', 'mcp__mcp-context7', 'mcp__mcp-memory', 'mcp__gemini-notebook-mcp',
  'mcp__yadisk', 'mcp__claude_ai_Gmail', 'mcp__claude_ai_Google_Drive', 'mcp__claude_ai_Google_Calendar',
  'mcp__claude_ai_Claude_Docs',
  // встроенные
  'Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch',
  // чтение локальной ФС закрыто целиком (SEC01): секреты ~/.config, ~/.ssh не должны попадать в agentNotes
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite',
  // смешанные серверы: всё, что пишет
  ...names(WS, ['messenger-send-message', 'messenger-draft-message', 'messenger-mark-as-read', 'messenger-create-chat',
    'messenger-create-thread', 'messenger-create-folder', 'messenger-delete-folder', 'messenger-rename-folder',
    'messenger-modify-folder-chats', 'messenger-add-chat-members', 'messenger-remove-chat-members',
    'messenger-join-chat', 'messenger-leave-chat', 'messenger-invalidate-session',
    'mail-save-draft', 'mail-schedule', 'mail-mark-message', 'mail-unsubscribe',
    'calendar-create-event', 'calendar-update-event', 'calendar-delete-event', 'calendar-update-recurrence',
    'calendar-append-attendees', 'calendar-delete-attendees']),
  ...names(JIRA, ['jira_create_issue', 'jira_update_issue', 'jira_delete_issue', 'jira_add_comment', 'jira_assign_issue']),
  ...names(GL, ['add_merge_request_note', 'create_discussion', 'reply_to_discussion', 'resolve_discussion',
    'create_merge_request', 'update_merge_request', 'run_job']),
  ...names(CF, ['confluence_attachment_add', 'confluence_attachment_delete', 'confluence_blog_create',
    'confluence_blog_delete', 'confluence_blog_update', 'confluence_comment_add', 'confluence_comment_delete',
    'confluence_comment_update', 'confluence_label_add', 'confluence_label_remove', 'confluence_page_copy',
    'confluence_page_create', 'confluence_page_delete', 'confluence_page_move', 'confluence_page_restore',
    'confluence_page_update', 'confluence_permissions_set', 'confluence_space_create']),
]);

/** argv без команды и без текста задачи: промпт идёт через stdin, каждое значение — один элемент. */
export function buildClaudeArgs() {
  return [
    '--agent', AGENT_NAME,
    '-p',
    '--output-format', 'json',
    '--max-turns', String(LIMITS_RUN.MAX_TURNS),
    '--max-budget-usd', LIMITS_RUN.MAX_BUDGET_USD,
    // Всё вне --allowedTools отклоняется без запроса (изменено по ревью I01): иначе инструменты вне
    // allow/deny решаются пользовательскими ~/.claude/settings*.json (defaultMode auto).
    '--permission-mode', 'dontAsk',
    '--allowedTools', ALLOWED_TOOLS.join(','),
    '--disallowedTools', DISALLOWED_TOOLS.join(','),
    '--append-system-prompt', SYSTEM_PROMPT,
  ];
}

/** Основной способ запуска (ADR-003): бинарь claude с окружением из env-файла. */
export const PRIMARY_COMMAND = 'claude';

/**
 * Запасной способ, только если spike U1 провалился: `zsh -ic claude-paiw ...`.
 * По умолчанию не используется. Окружение (токен прокси) тогда берётся из пользовательской оболочки.
 */
export const FALLBACK_COMMAND = Object.freeze({ command: 'zsh', shellFunction: 'claude-paiw' });

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function buildFallbackInvocation() {
  // Оболочка читает .zshrc и может вернуть TASKFLOW_*: после загрузки rc явно снимаем их (SEC07).
  const unset = 'for v in ${(k)parameters[(I)TASKFLOW_*]}; do unset $v; done';
  const line = [`${unset}; ${FALLBACK_COMMAND.shellFunction}`, ...buildClaudeArgs().map(shQuote)].join(' ');
  return { command: FALLBACK_COMMAND.command, args: ['-ic', line] };
}
