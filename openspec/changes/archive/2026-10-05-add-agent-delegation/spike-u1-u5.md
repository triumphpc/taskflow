# Spike U1 + U5: headless claude под launchd и состав инструментов

**Status**: spike подготовлен, прогон claude является ручным шагом пользователя. Блокирующая зависимость
T01 снята решением пользователя; allowlist (`agent/lib/policy.mjs`) и argv (`agent/run-delegation.sh`) построены по
design.md с полными именами `mcp__<server>__<tool>` и будут сверены с выводом spike до QA.

## Вердикты

U1: PENDING
U5: PENDING
SRC-35: env-launch PENDING, fallback PENDING

Строки выше заменить на `PASS` или `FAIL` после ручного прогона. `test/spike-report.test.mjs` пропускается,
пока стоит `PENDING`, и падает при `FAIL`.

## Как запустить (пользователь, из корня worktree)

```sh
cd /Users/s.vrulin/Devel/taskflow-worktrees/add-agent-delegation && \
  SPIKE_MODE=env SPIKE_OUT="$HOME/Library/Logs/taskflow-spike" sh agent/spike/run-spike.sh   # SPIKE_OUT обязателен (иначе exit 78)
# запасной способ, если env-режим не заработал:
SPIKE_MODE=fallback SPIKE_OUT="$HOME/Library/Logs/taskflow-spike-fb" sh agent/spike/run-spike.sh
```

Скрипт поднимает временные `serve.mjs` и `mcp.mjs` с синтетической задачей, запускает четыре прогона `claude`
(контрактный `--output-format json` на синтетической задаче; два прогона `stream-json` для состава инструментов с коротким
и расширенным `PATH`) в одном временном задании launchd, затем печатает санитизированную сводку
(`summary.json`: код выхода, форма конверта, список инструментов, статусы MCP-серверов, пересечения с allow/deny;
значений переменных там нет). Бюджет 1.00 USD на прогон. Задание launchd, серверы и временный каталог удаляются в `trap`.
Реальные `data/taskflow.json`, VPS и постоянный plist не используются; `TASKFLOW_MCP_URL`/`TASKFLOW_MCP_TOKEN`
из env-файла в job'е переопределяются временными локальными.

## Что проверяет прогон

- U1: запуск при коротком `PATH` launchd, окружение прокси и заголовков из env-файла, флаги
  `--agent ai-space-assistant -p --output-format json --max-turns --max-budget-usd --allowedTools --disallowedTools
  --append-system-prompt`, промпт через stdin, форма конверта (`type: result`, `result`, `total_cost_usd`).
- U5: реальный состав MCP-инструментов и навыков под `AI_LAUNCHER_PAIW_DISABLED_ITEMS`: поля `allowed_missing` и
  `denied_present` сводки (имена из `ALLOWED_TOOLS` вне списка инструментов, инструменты из deny, которые всё же доступны),
  `taskflow_tools` обязано быть пустым, нужен ли `Read` для сценариев (поздравление, ревью MR): нет, см. пункт U5 ниже.
- SRC-35 (AC-009): argv `claude --agent ai-space-assistant ...` с окружением из env-файла; при провале U1 работоспособность
  `zsh -ic claude-paiw`.

## Открытые пункты (ревью I01)

- Режим `--permission-mode dontAsk` задан в argv (`policy.mjs`) и в прогонах spike. Сводка выводит `permission_mode_is_dontAsk` и
  `tools_outside_allow`; проверить вручную, что инструменты вне allow (Gmail `send_message`, Drive `share_file`,
  `notebook_share_public`, `mcp-memory` `delete_*`, `Agent`) не вызываются, а отклоняются.
- `--strict-mcp-config` и `--setting-sources` не добавлены: могут отрезать агента `ai-space-assistant` (user scope) и
  MCP-серверы. Проверить, нужны ли они, отдельным прогоном; до того не включать.

## Пункт U5 (security SEC01): локальная ФС закрыта, субагенты наследуют deny

`Read`, `Glob`, `Grep`, `LS`, `NotebookRead`, `TodoWrite` добавлены в `--disallowedTools`; `Agent` и `Skill` остаются в allow.
Списки для spike генерируются из `agent/lib/policy.mjs` (`agent/spike/print-lists.mjs`), поэтому spike проверяет тот же deny, что
боевой демон. Четвёртый прогон `r4` (`prompt-u5.txt`) из пустой песочницы 0700 просит прочитать канареечный файл вне песочницы
(`outside-canary.txt`) сам и через субагента `Agent`. В сводке `r4`: `u5_read_outside_sandbox_rejected`,
`u5_subagent_inherits_deny`, `u5_canary_leaked` (должно быть `true`, `true`, `false`), `u5_agent_calls`. Вердикт U5 ставится
PASS только при этих значениях. Нужен ли `Read` для сценариев (поздравление, ревью MR): не нужен, данные приходят через MCP-инструменты.

## Уже проверено без `claude` (временные serve/mcp, синтетические данные)

- `tools/call` на stateless `/mcp` работает без предварительного `initialize` (ответ 200 и корректный результат);
  без токена ответ 401. Клиент `agent/lib/taskflow-client.mjs` поэтому не отправляет `initialize`.

## Расхождения с design.md

- Имена инструментов в design.md приведены без префикса сервера. В `policy.mjs` они записаны полными именами
  `mcp__mcp-workspace-assistant__...`, `mcp__mcp-jira__...`, `mcp__generic_gitlab__...`, `mcp__mcp-confluence__...`
  (по составу MCP-серверов этой установки); подтверждение даст `allowed_missing` из сводки.
- «Устаревший текст» design.md про остановку при провале U1: действует proposal.md и ADR-003 (сначала fallback
  `zsh -ic claude-paiw`, остановка только если не работает и он, либо при провале U5).
