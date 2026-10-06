# Спайки S1..S3: отправка из делегирования

**Status**: ожидает прогона пользователем. Прогон на заглушке MCP с настоящими именами инструментов, реальных отправок нет.
До `S1: PASS` и `S3: PASS` в `agent/env.example` стоит `TASKFLOW_AGENT_SEND=off`, режим с отправкой на боевых данных не включается.

## Вердикты

S1: PASS
S2: PASS
S3: PASS

Строки выше пользователь заменяет на `PASS` или `FAIL` после ручного прогона. Скрипты пишут только `S1-proposed:`,
`S2-proposed:`, `S3-proposed:` в блоках фактов ниже. `test/spike-send-harness.test.mjs` проверяет формат заметки и не требует PASS.

### Итог прогонов 2026-10-06

- **S1: PASS (повторный прогон после правки strict MCP).** Первый прогон дал FAIL по (к) и (м):
  deny-префикс `mcp__plugin_` в Claude Code не действует, а прогон (м) не нашёл агента во временном `CLAUDE_CONFIG_DIR`.
  Исправлено: в режиме отправки claude запускается с `--strict-mcp-config --mcp-config <runDir>/mcp.json`, где только
  `mcp-workspace-assistant`, `mcp-jira`, `mcp-confluence`, `generic:gitlab`; плагины, коннекторы claude.ai, telegram, yadisk
  и прочие серверы не загружаются вовсе. В (м) во временный каталог кладутся симлинки на `~/.claude/agents` и `skills`.
  Повторный прогон: все пункты (а)–(м) выполнены, в (к) init содержит ровно четыре сервера и ноль чужих инструментов
  при allow-правилах на плагины, Gmail, yadisk и telegram в settings.
- **S2: PASS.** t1..t3: 3–5 ходов, 0.16–0.17 USD, лимиты 50/3.00 с запасом. `Agent(<имя>)` принимается, но другие имена не
  отклоняет, поэтому `NARROW_AGENT` остаётся `false`.
- **S3: PASS.** Вызов send дошёл до заглушки, хук сработал, превью не мешает.
- Живая проверка: делегированная задача отправила сообщение боту из белого списка, журнал в карточке совпал. Пробный запуск
  со strict-конфигом на реальных серверах (только чтение): все четыре `connected`, включая OAuth `mcp-workspace-assistant`.

## Как запустить (пользователь, из корня worktree)

```sh
SPIKE_OUT="$HOME/Library/Logs/taskflow-spike-send" sh agent/spike/send/run-s1.sh
SPIKE_OUT="$HOME/Library/Logs/taskflow-spike-send" sh agent/spike/send/run-s2.sh
SPIKE_OUT="$HOME/Library/Logs/taskflow-spike-send" sh agent/spike/send/run-s3.sh
```

Нужны `~/.config/taskflow-agent/env` (права 0600, окружение claude-paiw) и `claude` по `CLAUDE_BIN`. Каждый скрипт поднимает одно временное
задание launchd, MCP-серверы подменены заглушкой (`--strict-mcp-config`), временные каталоги и задание снимаются в `trap EXIT`.
Сырой вывод `claude` лежит в `$SPIKE_OUT`, держите его вне репозитория.

## S1: хук и право `allow` (ADR-004)

Критерий: выполнены (а), (б), (в), (ж), (з), (к), (л), (м).

- (а) Хук из `--settings` срабатывает в `claude -p` под launchd и внутри субагента: ___
- (б) `allow` от хука открывает инструмент вне `--allowedTools` под `dontAsk`: ___
- (в) Без хука тот же вызов отклонён: ___
- (г) Форма входа и ответа хуков в установленной версии (`permissionDecision`, `agent_id`, `tool_response`): ___
- (д) Формы ответов шести инструментов для `extractRef`: ___
- (е) Вид `project_id` (число или путь `group/project`) и вид `chat_sn`: ___
- (ж) Хук pre спит дольше своего timeout: вызов отклонён, заглушка не тронута (прогон f, SEC02): ___
- (з) Хук pre завершается кодом 1: вызов отклонён, заглушка не тронута (прогон g, SEC02): ___
- (к) Режим отправки собран продакшн-сборщиком (`buildClaudeArgs`, `--strict-mcp-config` + заглушки с теми же четырьмя ключами, включая `generic:gitlab`); в settings allow-правила на `mcp__plugin_x_y`, реальные плагины пользователя (например `productivity:slack`) и коннекторы (`claude_ai_*`, `yadisk`, `telegram`) как эмуляция; вывод stream-json. В init `mcp_servers` нет записей `plugin:*` / `plugin_*`, в `tools` нет `mcp__plugin_*`, `mcp__claude_ai_*`, `mcp__yadisk*`, `mcp__telegram*` (прогон k, SEC13): ___
- (л) Субагент и skill с send-инструментом в `tools` / `allowed-tools` при падающем хуке (exit 1): вызов отклонён, заглушка не тронута (прогон l, SEC12): ___
- (м) Временный `CLAUDE_CONFIG_DIR` (в нём только симлинки на `~/.claude/agents` и `~/.claude/skills`, чтобы `--agent ai-space-assistant` находился) с allow-правилом на send-инструмент при падающем хуке: вызов отклонён, заглушка не тронута (прогон m, SEC12): ___

<!-- S1-facts:begin -->
S1-proposed: PASS  (прогон 2026-10-06; вердикт S1: вносит пользователь)

```json
{
  "a_hook_in_main": true,
  "a_hook_in_subagent": true,
  "b_allow_opened_tool": true,
  "b_allow_in_subagent": true,
  "c_denied_without_hook": true,
  "f_denied_hook_sleeps": true,
  "g_denied_hook_exit1": true,
  "k_strict_mcp_no_foreign": true,
  "k_init": {
    "init_seen": true,
    "servers": [
      "mcp-workspace-assistant",
      "mcp-jira",
      "mcp-confluence",
      "generic:gitlab"
    ],
    "foreign_servers": [],
    "foreign_tool_count": 0,
    "unexpected_servers": []
  },
  "l_sender_agent_hook_fail_denied": true,
  "m_config_dir_allow_hook_fail_denied": true,
  "g_pre_fields": [
    "agent_type",
    "cwd",
    "effort",
    "hook_event_name",
    "mcp_server",
    "permission_mode",
    "prompt_id",
    "session_id",
    "tool_input",
    "tool_name",
    "tool_use_id",
    "transcript_path"
  ],
  "g_sub_pre_fields": [
    "agent_id",
    "agent_type",
    "cwd",
    "effort",
    "hook_event_name",
    "mcp_server",
    "permission_mode",
    "prompt_id",
    "session_id",
    "tool_input",
    "tool_name",
    "tool_use_id",
    "transcript_path"
  ],
  "g_post_fields": [
    "agent_type",
    "cwd",
    "duration_ms",
    "effort",
    "hook_event_name",
    "mcp_server",
    "permission_mode",
    "prompt_id",
    "session_id",
    "tool_input",
    "tool_name",
    "tool_response",
    "tool_use_id",
    "transcript_path"
  ],
  "g_fail_fields": [],
  "d_response_forms": [
    {
      "tool": "messenger-send-message",
      "response": "array(1)",
      "ref_found": true
    },
    {
      "tool": "add_merge_request_note",
      "response": "array(1)",
      "ref_found": true
    },
    {
      "tool": "create_discussion",
      "response": "array(1)",
      "ref_found": true
    },
    {
      "tool": "reply_to_discussion",
      "response": "array(1)",
      "ref_found": true
    },
    {
      "tool": "jira_add_comment",
      "response": "array(1)",
      "ref_found": true
    },
    {
      "tool": "confluence_page_create",
      "response": "array(1)",
      "ref_found": true
    }
  ],
  "e_chat_sn": [
    {
      "type": "string",
      "value": "spike-chat"
    }
  ],
  "e_project_id": [
    {
      "type": "string",
      "value": "4242"
    }
  ],
  "stub_calls": {
    "a": 1,
    "b": 1,
    "c": 0,
    "d": 6,
    "e": 1,
    "f": 0,
    "g": 0,
    "k": 0,
    "l": 0,
    "m": 0
  },
  "send_tools_expected": 6
}
```
<!-- S1-facts:end -->

**Если S1 (б) не прошёл**: решение возвращается к пользователю с вариантами: шлюз MCP (ADR-004, вариант E) или отказ от отправки.
Автоотката на вариант C нет. Отправка не включается.

## S2: форма `Agent(<имя>)` и лимиты (ADR-006, ADR-009)

Не блокирует включение: определяет `NARROW_AGENT` и итоговые `LIMITS_SEND`.

- (а) `Agent(<имя>)` работает и закрывает остальные имена: ___
- (б) Три типовые задачи («поздравить в чат», «отревьюить MR с inline-комментариями», «создать страницу отчёта») укладываются в 50 ходов и 3.00 USD (ходы и стоимость): ___
- (в) Как часто MCP в `pending` на старте: ___

<!-- S2-facts:begin -->
S2-proposed: PASS  (прогон 2026-10-06; вердикт S2: вносит пользователь)

```json
{
  "a_agent_named_works": true,
  "a_other_names_rejected": false,
  "b_tasks": [
    {
      "task": "t1",
      "turns": 3,
      "cost_usd": 0.1563918,
      "subtype": "success"
    },
    {
      "task": "t2",
      "turns": 5,
      "cost_usd": 0.1638022,
      "subtype": "success"
    },
    {
      "task": "t3",
      "turns": 4,
      "cost_usd": 0.1737156,
      "subtype": "success"
    }
  ],
  "b_within_limits": true,
  "c_mcp_status_counts": {
    "connected": 4
  }
}
```
<!-- S2-facts:end -->

**Если S2 (а) не прошёл**: остаётся голый `Agent`, отправку держит gate. **Если (б) показал расхождение**: правятся `LIMITS_SEND` (задача T21).

## S3: превью агента и `confirm-outbound.sh` (ADR-008)

Критерий: вызов send дошёл до заглушки при `AUTONOMOUS_RUN=1`. Повторять после любых правок файлов агента.

- Вызов дошёл до заглушки: ___
- Что мешает (если нет): ___

<!-- S3-facts:begin -->
S3-proposed: PASS  (прогон 2026-10-06; вердикт S3: вносит пользователь)

```json
{
  "call_reached_stub": true,
  "hook_fired": true,
  "claude_exit_code": "0",
  "stub_calls": 1
}
```
<!-- S3-facts:end -->

**Если S3 не прошёл**: править промпт режима с отправкой (`agent/lib/prompt.mjs`), файлы агента не править.
