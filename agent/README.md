# Демон делегирования задач агенту

Раз в минуту launchd запускает `run-delegation.sh`. Демон спрашивает у MCP TaskFlow очередь
(делегированные задачи на сегодня и просроченные), берёт до трёх задач, запускает для каждой
`claude --agent ai-space-assistant` (только чтение) и пишет результат в карточку: `review`,
`needs_info` или `failed`. Если Mac выключен, ничего не происходит, задачи остаются `delegated`.
Нет делегированных задач: модель не вызывается вовсе.

Установка выполняется вручную, ни один скрипт и ни один тест не ставит задание на машину.

## Что нужно

- Node 18+ (демон без зависимостей).
- Работающий MCP TaskFlow (`mcp.mjs`) и сервер синхронизации (`serve.mjs`).
- `claude` и окружение `claude-paiw` (прокси, заголовки, отключённые навыки).

## Установка

1. Env-файл с правами 0600. Либо экспортируйте нужные переменные в текущей оболочке и выполните

   ```sh
   TASKFLOW_MCP_URL=http://127.0.0.1:8788/mcp TASKFLOW_MCP_TOKEN=... sh agent/setup-env.sh
   ```

   либо создайте `~/.config/taskflow-agent/env` вручную по `agent/env.example` (`chmod 700` на каталог,
   `chmod 600` на файл). Скрипт выводит только имена переменных, значения не печатаются. Обязательные
   переменные: `TASKFLOW_MCP_URL`, `TASKFLOW_MCP_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`,
   `AI_LAUNCHER_PAIW_DISABLED_ITEMS`, `CLAUDE_BIN` (абсолютный путь к `claude`). Прокси-переменные
   (`HTTP_PROXY`, `NO_PROXY`) добавьте, если их задаёт `claude-paiw`.

> **Условие установки (I07).** Plist и `launchctl bootstrap` выполняйте только после того, как в
> `openspec/changes/archive/2026-10-05-add-agent-delegation/spike-u1-u5.md` стоит `U5: PASS` (и `U1: PASS` либо принят запасной способ).
> Пока там `PENDING` или `FAIL`, задание не устанавливается: списки инструментов не сверены с реальным составом.

2. Plist из шаблона (только после `U5: PASS`):

   ```sh
   mkdir -p -m 700 ~/Library/Logs/taskflow-agent && chmod 700 ~/Library/Logs/taskflow-agent
   mkdir -p ~/Library/LaunchAgents
   sed -e "s#__REPO__#$(pwd)#g" -e "s#__HOME__#$HOME#g" agent/com.taskflow.delegation.plist.template \
     > ~/Library/LaunchAgents/com.taskflow.delegation.plist
   ```

3. Загрузка задания и пробный прогон (только после `U5: PASS`):

   ```sh
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.taskflow.delegation.plist
   launchctl kickstart -k gui/$(id -u)/com.taskflow.delegation
   tail -n 20 ~/Library/Logs/taskflow-agent/delegation.out.log
   ```

   Логи: строки JSON без текстов задач и без секретов. Код выхода 78 означает ошибку конфигурации
   (в логе имена недостающих переменных или права env-файла не 600).

## Способы запуска claude

- Основной (ADR-003): `claude --agent ai-space-assistant ...` с окружением из env-файла 0600.
  Флаги и списки инструментов собирает `agent/lib/policy.mjs` (`buildClaudeArgs()`), это единственное место.
- Запасной, только если spike U1 провалился: `zsh -ic claude-paiw ...`. Включается строкой
  `export TASKFLOW_AGENT_LAUNCH=fallback` в env-файле; токен прокси тогда берётся из вашей оболочки.

## Права инструментов

`claude` запускается с `--permission-mode dontAsk`: всё, чего нет в `--allowedTools`, отклоняется без запроса,
а не решается пользовательскими `~/.claude/settings*.json` (изменено по ревью I01). Список инструментов
только на чтение; `--disallowedTools` сверх того закрывает запись и прод. `--strict-mcp-config` и
`--setting-sources` намеренно не используются: могут отрезать агента `ai-space-assistant` (user scope) и
MCP-серверы. Открытый пункт: spike проверяет, что инструменты вне allow недоступны.

Локальная файловая система закрыта целиком (security SEC01): в `--disallowedTools` входят `Read`, `Glob`, `Grep`,
`LS`, `NotebookRead`, `TodoWrite`, `Bash`, `Write`, `Edit`, `NotebookEdit`. Иначе под prompt injection агент мог бы прочитать
`~/.config/taskflow-agent/env` или `~/.ssh` и записать это в заметки агента (они неудаляемы и синхронизируются).
`Skill` и `Agent` оставлены в `--allowedTools` сознательно: `ai-space-assistant` делегирует субагентам через `Agent`.
Защита здесь — deny имеет приоритет над `allowed-tools` навыков и субагентов, плюс `dontAsk`; spike (пункт U5) проверяет,
что субагент через `Agent` наследует deny.

Рабочий каталог процесса `claude` — пустая песочница `~/.local/state/taskflow-agent/work` (создаётся с режимом 0700,
права проверяются при каждом запуске). `TASKFLOW_AGENT_CWD` может её переопределить, но не на домашний каталог (exit 78).
Окружение процесса — белый список: `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_*`, `TMPDIR`, `TERM`, `SHELL`, `ANTHROPIC_*`,
`AI_LAUNCHER_PAIW_*`, `HTTP(S)_PROXY`, `NO_PROXY` (оба регистра), `CLAUDE_CODE_*`, `CLAUDE_CONFIG_DIR`. `TASKFLOW_*` не передаются никогда;
в запасном `zsh -ic` они дополнительно снимаются после загрузки `.zshrc`. Повторный SIGTERM/SIGINT демону убивает группу
процессов claude (SIGKILL) и завершает демон сразу.

## Проверка запуска (spike U1 и U5)

Запускает пользователь, из корня репозитория. Временные serve/mcp с синтетической задачей и одно
временное задание launchd, всё удаляется при выходе; реальные данные и VPS не затрагиваются.
Каждый прогон `claude` ограничен бюджетом 1.00 USD.

```sh
SPIKE_MODE=env SPIKE_OUT="$HOME/Library/Logs/taskflow-spike" sh agent/spike/run-spike.sh
# если не заработало: проверка запасного способа
SPIKE_MODE=fallback SPIKE_OUT="$HOME/Library/Logs/taskflow-spike-fb" sh agent/spike/run-spike.sh
```

Вердикты (`U1`, `U5`, `SRC-35`) занесите в `openspec/changes/archive/2026-10-05-add-agent-delegation/spike-u1-u5.md`.

## Смена токена

Токен MCP или прокси сменился: пересоздайте env-файл (шаг 1) и выполните
`launchctl kickstart -k gui/$(id -u)/com.taskflow.delegation`.

## Откат

```sh
launchctl bootout gui/$(id -u)/com.taskflow.delegation
rm ~/Library/LaunchAgents/com.taskflow.delegation.plist
rm -rf ~/.config/taskflow-agent ~/.local/state/taskflow-agent
```

Делегированные задачи остаются в списке как есть; зависший `in_progress` через 20 минут сервер
переведёт в `failed` при следующем прогоне любого экземпляра демона либо снимите делегирование
галкой в карточке.

## Лимиты

Интервал 1 минута (пустая очередь проверяется без модели и ничего не стоит), до 3 задач за прогон последовательно, таймаут задачи 15 минут, `--max-turns 30`,
`--max-budget-usd 2.00`, опрос статуса раз в минуту (закрытие задачи останавливает процесс),
остановка SIGTERM, через 10 секунд SIGKILL. Автоповторов нет.

## Известные ограничения

- SEC03 (частично): в интерфейсе заметки агента показываются текстом, без кликабельных ссылок. `task_get` в `mcp.mjs`
  не менялся (контракт NFR-007/SRC-33), поэтому интерактивный клиент получает текст заметок как есть.
- SEC10: у веб-приложения нет Content-Security-Policy. Заголовок можно добавить в `serve.mjs`, но он требует проверки
  инлайн-стилей и service worker; пока не сделано.

- I07 (`agent/lib/lock.mjs:29-43`, race condition): захват stale-замка неатомарен. Два процесса, увидевшие мёртвый pid, могут оба сделать `rmSync(dir)`; второй сотрёт только что созданный каталог первого, и оба получат замок. Если pid мёртвого держателя переиспользован, замок считается живым бесконечно. При одном экземпляре launchd риск низкий. Возможное улучшение: атомарный `rename` каталога перед `mkdir` и сверка времени старта процесса.
- I10 (`mcp.mjs`, безопасность): служебные инструменты `agent_queue`/`agent_claim`/`agent_finish` видны любому MCP-клиенту с токеном, защита только текстом `description`. Интерактивная сессия может вызвать claim/finish, но только при совпадении claim-токена и состояния. Для демона `mcp__taskflow` закрыт в deny. Возможное улучшение: отдельный токен или путь (`/mcp-agent`) либо скрытие из `tools/list` для обычного токена.
- Режим `dontAsk` закрывает инструменты вне `--allowedTools`, но `--strict-mcp-config` и `--setting-sources`
  не включены (могут отрезать агента `ai-space-assistant` и MCP-серверы). Проверка вынесена в spike
  (`permission_mode_is_dontAsk`, `tools_outside_allow` в сводке), пункт открыт.
- Незакрытые ручные пункты `test/MANUAL-CHECKLIST.md` (жесты UI, установка plist, выкладка на реальных данных)
  скрипт `scripts/ac-trace-check.mjs` выводит как «ждёт ручной проверки»; задачи 6.1 и 7.3 в `tasks.md` не закрыты.
