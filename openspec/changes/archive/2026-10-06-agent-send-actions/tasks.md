# Tasks: agent-send-actions

**Date**: 2026-10-06
**Planner**: task-planner
**Status**: Accepted (Gate A и Gate B отменены пользователем: сразу tasks.md, вопросы по гранулярности закрыты планировщиком, см. «Принятые решения»)
**Revision**: rework 1 по spec_validation (G1): добавлена трассировка NFR-007 и AC-031..AC-034
**Design**: `openspec/changes/agent-send-actions/design.md`
**HLD**: `openspec/changes/agent-send-actions/hld.md`
**Proposal**: `openspec/changes/agent-send-actions/proposal.md`
**ADRs**: `openspec/changes/agent-send-actions/adrs/004..009`

## Overview

Декомпозиция дизайна (M1..M12) в 23 задачи. Порядок: чистые строительные блоки gate (политика запуска, разбор адресата, файл политики, слоты, аудит, каталог прогона), сам gate, затем промпт, клиентское ядро `js/agent.js` с доставкой журнала через sync и MCP, демон, E2E на подставном `claude`, конфиг и документация, спайки на заглушке MCP (запускает пользователь), приёмка и гейт включения на боевых данных.

Правило среза: каждая задача оставляет `node --test test/*.test.mjs` зелёным и отвечает на вопрос «что стало проверяемым». Чистые модули (M2..M5, M7) не имеют зависимостей между собой, кроме импорта `SEND_TOOLS`; они идут первыми, чтобы gate и демон собирались из проверенных частей. Вертикальный срез «адресат из белого списка → `allow` → журнал → заметка» замыкается на T07 (gate), T14 (демон) и T15 (E2E).

**Total tasks**: 23 (из них 3 запускает пользователь: T18, T19, T20, и 1 гейт пользователя: T22)
**Total effort**: 43 story points (S=1, M=2, L=3)

> Каждая задача несёт поле `Verification`: команду, чей exit code отвечает на вопрос «задача сделана». До реализации команда падает (нет модуля или теста), после проходит. Для задач роли «Пользователь» verification — это запись вердикта в заметку и тест, который читает её.

### Общие правила для всех задач

- Работа только в worktree `/Users/s.vrulin/Devel/taskflow-worktrees/agent-send-actions`. Без атрибуции Claude/ИИ в коммитах и файлах. `.workflow-state.yaml` не трогать. `proposal.md` и `specs/` правит RA, эти файлы не менять.
- Автотесты не запускают реальный `claude`, не вызывают реальные MCP и не делают реальных отправок (C16, AC-030). Только временные каталоги (`fs.mkdtemp`), синтетические фикстуры, подставной `claude` и заглушка MCP. Реальный `data/taskflow.json` не читается и не пишется.
- Конвенция имён тестов: `test('[send] AC-0NN: ...')` для каждого AC этого change. Нумерация AC пересекается с `add-agent-delegation` (AC-001..AC-029), префикс `[send]` отделяет их (см. «Известное пересечение AC»).
- Все ограничения C1..C17 из `design.md` обязательны. Привязка к задачам: C1, C2 → T01; C3, C4, C6, C7 → T07 (C4 также T03, C7 также T04); C5 → T02; C8 → T16, T22; C9 → T06; C10 → T09; C11, C12 → T10, T11; C13, C14, C15 → T14; C16 → T13, T15; C17 → T08.
- Прошлые тесты (паритет нормализации, sync, контракт MCP, golden девяти инструментов) проходят без правок (C12, AC-028). Любая правка существующего теста, кроме явно названных (`policy.test.mjs`, `prompt.test.mjs`), — повод остановиться и разобраться.
- Тексты промптов (M8) и README (T16) читает человек: перед фиксацией пройти через скилл `humanizer-ru`, смысл пунктов не менять (C17).

## Принятые решения (вместо вопросов Gate A)

| Вопрос | Решение |
|---|---|
| Гранулярность gate | Пять чистых модулей (T02..T06) отдельными срезами, сам gate (T07) собирает их; так ошибка в gate локализуется по проваленному тесту модуля |
| `js/agent.js`: один срез или два | Два: T09 (`normalizeJournal`, `composeNote`, сжатие), T10 (`applyAgentTransition`, `extractJournals`); T09 не зависит от серверных частей |
| Подставной `claude` для send | Отдельная задача T13 (режим `send` в `fake-claude.mjs` и заглушка MCP): без неё демон и E2E не проверить, а это самый хрупкий кусок тестовой инфраструктуры |
| Спайки S1..S3 | Скрипты и заглушка MCP с полными именами инструментов готовит агент (T17); прогон делает пользователь (T18, T19, T20, роль «Пользователь»). Задача-гейт T22: боевые данные только после S1 и S3 PASS |
| Применение результатов спайков | Одна условная задача T21: `NARROW_AGENT`, `LIMITS_SEND`, формы ответов для `extractRef`, форма `project_id`. Если расхождений нет, закрывается пометкой без правок |
| `scripts/ac-trace-check.mjs` | Параметризация сделана в другом change (`tweak-entry-and-moments`, не смержен). В этой ветке скрипт не меняется; пересечение номеров AC фиксируется как известное (см. ниже), чтобы не получить конфликт при мерже |
| Порядок раскатки | Сервер (T10, T11) раньше демона (T14) в графе задач и при выкладке (C15) |

## Известное пересечение AC

`scripts/ac-trace-check.mjs` в этой ветке работает как есть: `AC_COUNT = 29`, имена тестов ищутся по регулярному выражению `AC-NNN` без различения change. У `agent-send-actions` свои AC-001..AC-034, которые пересекаются по номерам с архивными AC-001..AC-029. Последствия, принятые сознательно:

- AC-030..AC-034 новой нумерации скриптом не проверяются (выходят за `AC_COUNT = 29`); их покрывают тесты с префиксом `[send]`: AC-030 — T13, T15; AC-031 — T10, T14; AC-032 — T11, T12; AC-033 — T01, T07, T16; AC-034 — T09. Плюс ручная сверка в T23.
- Тест с именем `[send] AC-010` формально «закрывает» и архивный AC-010 в отчёте скрипта. Это не ломает проверку: архивные AC уже покрыты своими тестами.
- Реальная трассировка AC-001..AC-034 этого change делается вручную в T23 по префиксу `[send]`.
- Не дублировать параметризацию из `tweak-entry-and-moments`: она приходит из другого change (не смержен), при его мерже скрипт получит параметр, и имена с префиксом `[send]` продолжат работать. После этого мержа T23 может использовать `--proposal` для проверки AC этого change; до него сверка ручная.

## Task Graph

```mermaid
graph LR
    T01[T01 policy.mjs] --> T02[T02 send-targets]
    T01 --> T07[T07 send-gate]
    T02 --> T07
    T03[T03 send-policy] --> T07
    T04[T04 send-slots] --> T07
    T05[T05 audit] --> T07
    T07 --> T13[T13 fake-claude send + stub MCP]
    T09[T09 composeNote] --> T10[T10 transitions + extractJournals]
    T10 --> T11[T11 sync + mcp]
    T11 --> T12[T12 taskflow-client]
    T01 --> T14[T14 delegation-runner]
    T03 --> T14
    T05 --> T14
    T06[T06 run-dir] --> T14
    T08[T08 prompt] --> T14
    T12 --> T14
    T13 --> T14
    T14 --> T15[T15 E2E]
    T14 --> T16[T16 env + README]
    T07 --> T17[T17 spike harness]
    T08 --> T17
    T01 --> T17
    T17 --> T18[T18 S1 user]
    T17 --> T19[T19 S2 user]
    T17 --> T20[T20 S3 user]
    T18 --> T21[T21 apply spike results]
    T19 --> T21
    T15 --> T23[T23 acceptance]
    T16 --> T23
    T18 --> T22[T22 gate: go live]
    T20 --> T22
    T21 --> T22
    T23 --> T22
```

## Progress checklist (для apply)

- [x] 1.1 T01 policy.mjs: списки SEND_TOOLS, режимы, настройки хуков
- [x] 1.2 T02 send-targets.mjs: адресат и подпись шести инструментов
- [x] 1.3 T03 send-policy.mjs: файл политики с проверками (fail-closed)
- [x] 1.4 T04 send-slots.mjs: слоты потолков через O_EXCL
- [x] 1.5 T05 audit.mjs: строки аудита, склейка, журнал, извлечение ссылки
- [x] 1.6 T06 run-dir.mjs: каталог прогона
- [x] 2.1 T07 send-gate.mjs: хук pre/post/fail
- [x] 3.1 T08 prompt.mjs: промпт режима с отправкой и previous_attempts
- [x] 3.2 T09 js/agent.js: normalizeJournal и composeNote с журналом
- [x] 3.3 T10 js/agent.js: finish/reap с журналом и extractJournals
- [x] 3.4 T11 sync.mjs и mcp.mjs: journal в agent_finish, journals в agent_claim
- [x] 3.5 T12 taskflow-client.mjs: journal в finish и reap
- [x] 4.1 T13 Подставной claude (режим send) и заглушка MCP
- [x] 4.2 T14 delegation-runner: режим с отправкой
- [x] 4.3 T15 E2E: отправка, блокировка, инъекция, потолок
- [x] 5.1 T16 env.example, шаблон политики и README
- [x] 6.1 T17 Harness спайков S1..S3 на заглушке MCP
- [ ] 6.2 T18 S1: прогон пользователем (хук, allow под dontAsk, формы ответов)
- [ ] 6.3 T19 S2: прогон пользователем (Agent(<имя>), лимиты, pending MCP)
- [ ] 6.4 T20 S3: прогон пользователем (превью агента и confirm-outbound.sh)
- [ ] 6.5 T21 Применить результаты спайков (условная)
- [x] 7.1 T23 Итоговая приёмка автоматикой
- [ ] 7.2 T22 Гейт: включение отправки на боевых данных (пользователь)

## Tasks

### T01: policy.mjs: списки SEND_TOOLS, режимы, настройки хуков

**Role**: GO
**Effort**: M
**Blocked by**: []
**Covers**: FR-005 (конвертер в allow), FR-006, NFR-001, NFR-004 (режим `send:false` побайтно прежний), AC-008, AC-009, AC-021, AC-027 (аргументы), AC-033 (`isSendEnabled`: нет переменной — режим с отправкой)

**What to build**:
Расширить `agent/lib/policy.mjs` по M1. Константы `SEND_TOOLS` (шесть имён), `CONVERTER_TOOL`, `ALLOWED_TOOLS` и `DISALLOWED_TOOLS` режима с отправкой, `READONLY_ALLOWED` и `READONLY_DISALLOWED` (равны нынешним), `SUBAGENTS`, `NARROW_AGENT = false`, `LIMITS_SEND` (50 ходов, 3.00 USD), `SEND_SWITCH`, `isSendEnabled(env)` (нет переменной или `on` — режим с отправкой; всё остальное, включая пустую строку и опечатку, — «только чтение»), `buildGateSettings(gate)` (три хука, якорный экранированный matcher, пути в `shQuote`, `|| exit 2` у `pre`, таймаут 10 с), `buildClaudeArgs({send, gate})` и `buildFallbackInvocation`. `send:true` без `gate` бросает `TypeError`. `send:false` возвращает аргументы побайтно как сейчас. Переписать `test/policy.test.mjs`: прежний контракт «только чтение» остаётся одним из случаев.

**Acceptance criteria**:
- [x] `SEND_TOOLS` — ровно шесть имён из M1; пересечения `SEND_TOOLS ∩ ALLOWED_TOOLS`, `SEND_TOOLS ∩ DISALLOWED_TOOLS`, `ALLOWED_TOOLS ∩ DISALLOWED_TOOLS` пусты; `CONVERTER_TOOL` есть в `ALLOWED_TOOLS` и нет в `READONLY_ALLOWED` (AC-008, AC-021)
- [x] В deny остаются письма, календарь, создание чатов, участники, resolve, merge, удаления, правка и перенос страниц, комментарии, метки и вложения Confluence, `Bash`, `Read`, kubernetes, taskflow (AC-009)
- [x] argv с `send:true`: `--permission-mode dontAsk`, `--allowedTools`, `--disallowedTools`, `--settings <json>`, лимиты `LIMITS_SEND`; нет `auto`, `bypassPermissions`, `--dangerously-skip-permissions` ни в каком режиме (C2)
- [x] argv с `send:false` совпадает с эталоном, снятым до правки (AC-027)
- [x] `isSendEnabled`: нет переменной и `on` — true; `off`, пустая строка, `ON `, `true`, опечатка — false; тест `[send] AC-033` закрепляет «при отсутствии переменной режим с отправкой включён» (AC-033)
- [x] Matcher в `--settings` якорный и экранирован; команда `pre` оканчивается `|| exit 2`

**Verification**:
```bash
node --test test/policy.test.mjs
```
Падает, пока нет `SEND_TOOLS` и `isSendEnabled`.

**Files** (estimated):
- `agent/lib/policy.mjs` — списки, режимы, настройки хуков
- `test/policy.test.mjs` — переписывается

---

### T02: send-targets.mjs: адресат и подпись шести инструментов

**Role**: GO
**Effort**: M
**Blocked by**: [T01]
**Covers**: FR-002, FR-003, FR-004, FR-005, AC-004, AC-005, AC-006, AC-007, AC-012 (ключ для белого списка)

**What to build**:
`agent/lib/send-targets.mjs` по M2: `SPECS` (ключи равны `SEND_TOOLS`) и чистая `describeCall(toolName, toolInput)`, которая возвращает `{ kind, slot, list, key, target, snippet }` или `null`. Точные имена параметров из «Проверенных схем» (C5): `chat_sn`, `project_id`, `merge_request_iid`, `file_path`, `new_line`, `discussion_id`, `issueKey` (ключ проекта Jira — префикс до дефиса по шаблону `^([A-Z][A-Z0-9_]*)-[0-9]+$`), `space_key`, `title`. Ключевые поля — непустые строки без управляющих символов; сравнение точное. `snippet` — первые 100 символов с схлопнутыми пробелами и переводами строк. Функция не бросает исключений.

**Acceptance criteria**:
- [x] Для каждого из шести инструментов: верный вход даёт ожидаемые `key`, `target`, `slot`, `list`; пропущенное обязательное поле, неверный тип и пустая строка дают `null`
- [x] `project_id` числом превращается в строку; `merge_request_iid` целое > 0, `new_line` целое ≥ 1
- [x] Лишние поля (`parse_mode`, `old_line`, `parent_id`) игнорируются
- [x] `issueKey` без шаблона (`ops-1`, `OPS`, `OPS-x`) даёт `null`; `key` не содержит переводов строк
- [x] Неизвестный инструмент и `null`/строка вместо входа дают `null` без исключения
- [x] Ключи `SPECS` совпадают с `SEND_TOOLS` (тест)

**Verification**:
```bash
node --test test/send-targets.test.mjs
```
Падает, пока нет модуля.

**Files** (estimated):
- `agent/lib/send-targets.mjs`
- `test/send-targets.test.mjs`

---

### T03: send-policy.mjs: файл политики с проверками (fail-closed)

**Role**: GO
**Effort**: M
**Blocked by**: []
**Covers**: FR-008, NFR-002, AC-012, AC-013, AC-022

**What to build**:
`agent/lib/send-policy.mjs` по M3. `LIMIT_DEFAULTS` (vk 3, gitlab_comment 20, jira 3, confluence 2), `LIST_MAX = 200`, `POLICY_FILE_MAX_BYTES = 64 KiB`, `defaultPolicyPath()`, `loadSendPolicy(path, { uid })` с проверками `lstat` (нет файла `missing`, не обычный файл или симлинк `not_file`, чужой владелец `owner`, `mode & 0o177` `mode`, размер `size`, JSON `json`, `version !== 1` `version`, неизвестный ключ на любом уровне, не массив непустых строк, длина > 200, лимит не положительное целое — `shape`), `policyState(path)` (`ok|empty|invalid|missing`). Эффективный потолок `min(файл, LIMIT_DEFAULTS)`. Файл читается заново на каждом вызове, значения списков не печатаются (C4).

**Acceptance criteria**:
- [x] Каждая из причин отказа воспроизводится тестом, включая симлинк, права `0644`, `0700`, чужой uid, битый JSON, `version: 2`, неизвестный ключ, строка вместо массива, 201 элемент
- [x] Пустые списки: `loadSendPolicy` возвращает `ok`, `policyState` — `empty`; отсутствующий ключ `allow.*` равен пустому списку (AC-013)
- [x] Потолки поднять файлом нельзя: значение выше дефолта сводится к дефолту; ниже — принимается (AC-010 поддержка)
- [x] Изменение файла между двумя вызовами видно без перезапуска (нет кеша) (AC-013)
- [x] Ни один вызов не пишет значения списков в stdout или stderr

**Verification**:
```bash
node --test test/send-policy.test.mjs
```
Падает, пока нет модуля.

**Files** (estimated):
- `agent/lib/send-policy.mjs`
- `test/send-policy.test.mjs`

---

### T04: send-slots.mjs: слоты потолков через O_EXCL

**Role**: GO
**Effort**: S
**Blocked by**: []
**Covers**: FR-007, NFR-002, AC-010, AC-023

**What to build**:
`agent/lib/send-slots.mjs` по M4: `takeSlot(runDir, slot, limit, toolUseId)` создаёт `<runDir>/slots/<slot>-<n>` флагом `wx` для `n` от 1 до `limit` с правами `0600`, внутрь пишет `tool_use_id`. Первый успех — слот. `{ ok: false }`, когда потолок исчерпан; любая ошибка, кроме `EEXIST`, пробрасывается. Слот не возвращается никогда.

**Acceptance criteria**:
- [x] Последовательно: потолок 3 даёт слоты 1, 2, 3, четвёртый вызов — `{ ok: false }`
- [x] Параллельно: N процессов `node` на потолок 3 занимают ровно 3 слота, остальные получают `ok: false` (AC-023)
- [x] Виды слотов независимы (`vk` не расходует `jira`)
- [x] Ошибка файловой системы (каталога нет, не-`EEXIST`) пробрасывается, а не превращается в `ok: false`

**Verification**:
```bash
node --test test/send-slots.test.mjs
```
Падает, пока нет модуля.

**Files** (estimated):
- `agent/lib/send-slots.mjs`
- `test/send-slots.test.mjs`

---

### T05: audit.mjs: строки аудита, склейка, журнал, извлечение ссылки

**Role**: GO
**Effort**: M
**Blocked by**: []
**Covers**: FR-010, NFR-003, AC-015, AC-016, AC-024, AC-025

**What to build**:
`agent/lib/audit.mjs` по M5: `appendAudit` (одна строка за один `appendFileSync`, не длиннее 4 КиБ, поля обрезаются до записи; `blocked` сверх `AUDIT_BLOCKED_MAX = 200` дописывает байт в `audit.overflow`), `readAudit` (битые строки пропускаются и считаются), `buildJournal(read, { due })` (склейка по `tool_use_id`: итог `ok`/`error` побеждает `attempt`, `attempt` без итога даёт `started`, одиночный `blocked` даёт `blocked`; порядок по `ts`; все не-`blocked` записи сохраняются, `blocked` — до `JOURNAL_ENTRIES_MAX = 100`, остаток и `audit.overflow` идут в `hidden.blocked`), `extractRef(toolResponse)` (строка, `{content:[{type:'text',text}]}` или массив блоков; порядок: URL, затем поля `web_url`/`url`/`link`, затем `id`/`key`; обрезка до 200).

**Acceptance criteria**:
- [x] Склейка трёх исходов: `attempt+ok`, `attempt+error`, `attempt` без итога (`started`), одиночный `blocked` (AC-015, AC-016)
- [x] Запись журнала не зависит от текста модели: журнал строится только из файла (AC-025)
- [x] Поток из 250 блокировок: в файле 200 строк `blocked`, журнал содержит до 100 записей, остаток в `hidden.blocked`, записи `ok`/`error`/`started` не вытесняются
- [x] Битые и обрезанные строки не роняют `readAudit`, счётчик `badLines` растёт
- [x] Параллельная дозапись из нескольких процессов не перемешивает строки
- [x] `extractRef` на трёх формах ответа (строка, объект, массив) и на пустом ответе (`null`) (AC-015)

**Verification**:
```bash
node --test test/audit.test.mjs
```
Падает, пока нет модуля.

**Files** (estimated):
- `agent/lib/audit.mjs`
- `test/audit.test.mjs`

---

### T06: run-dir.mjs: каталог прогона

**Role**: GO
**Effort**: S
**Blocked by**: []
**Covers**: — (инфраструктура слотов и журнала: ADR-006, ADR-007; обеспечивает FR-007, NFR-002, NFR-003)

**What to build**:
`agent/lib/run-dir.mjs` по M7: `createRunDir({ stateDir, taskId, due, now })` создаёт `runs/<id>-<ms>/` (`0700`), `slots/` (`0700`), `meta.json` (`0600`, `{ v:1, taskId, due, startedAt }`); `id` очищается до `[A-Za-z0-9_-]`, не длиннее 40. `findLatestRunDir({ stateDir, taskId, now })` возвращает последний каталог задачи не старше 14 суток по `meta.taskId`, иначе `null`. `pruneRunDirs` удаляет каталоги старше `keepMs`, трогает только обычные каталоги с именем по шаблону внутри `runs/`, симлинки не удаляет и не разыменовывает; `runs/` создаётся с `0700`.

**Acceptance criteria**:
- [x] Права каталогов `0700`, файлов `0600` (C9)
- [x] Имя с `../`, пробелами и кириллицей очищается; результат внутри `runs/`
- [x] `findLatestRunDir` выбирает самый свежий из нескольких каталогов одной задачи и игнорирует чужие
- [x] `pruneRunDirs` не удаляет свежие каталоги, симлинк внутри `runs/`, обычный файл и каталог с чужим именем; возвращает число удалённых

**Verification**:
```bash
node --test test/run-dir.test.mjs
```
Падает, пока нет модуля.

**Files** (estimated):
- `agent/lib/run-dir.mjs`
- `test/run-dir.test.mjs`

---

### T07: send-gate.mjs: хук pre/post/fail

**Role**: GO
**Effort**: L
**Blocked by**: [T01, T02, T03, T04, T05]
**Covers**: FR-001 (`allow`), FR-007, FR-008, FR-009, NFR-001, NFR-002, NFR-004, NFR-006, AC-010, AC-011 (блокировка и пометка в журнале), AC-012, AC-013, AC-014, AC-022, AC-023, AC-029 (адресат вне списка не проходит), AC-033 (пустой белый список блокирует любое действие при включённой отправке)

**What to build**:
`agent/hooks/send-gate.mjs` по M6. Три режима командной строки `pre <runDir> <policyPath>`, `post <runDir>`, `fail <runDir>`. Экспорты `decidePre`, `recordPost`, `main(argv, readStdin, write, exit)`. Порядок проверок `pre`: политика прочитана, адресат определён, `key` в `allow[list]`, слот занят, попытка записана; любой сбой даёт `deny`, `blocked` с причиной (`policy`, `target_missing`, `not_allowed`, `limit`, `gate_error`) и короткую фразу из M6 без списка и номера слота. Блокировки на шагах 1..3 слот не расходуют. `updatedInput` не используется. `post` и `fail` пересчитывают `describeCall`, дописывают `ok` (с `extractRef`) или `error` (причина до 80 символов), всегда `exit 0` без вывода. В запись идут `agent_type` и `sub: true`, если во входе есть `agent_id`. Весь `main` в `try/catch` с `exit 2`; stdin читается целиком, лимит 1 МиБ.

**Acceptance criteria**:
- [x] Матрица `decidePre`: чат из списка с свободным слотом даёт `allow` (AC-001 поддержка); вне списка, пустой список, битый файл, права `0644`, неопределённый адресат, исчерпанный потолок дают `deny` с ожидаемой причиной (AC-012, AC-013, AC-022)
- [x] При включённой отправке и пустых списках политики любой из шести инструментов даёт `deny(not_allowed)`, запись `blocked` попадает в аудит; тест `[send] AC-033` (AC-033)
- [x] Блокировки по политике, адресату и списку слот не занимают; потолок 3 на `vk`: четвёртый вызов `deny(limit)`, ранее выполненные записи остаются (AC-010, AC-011)
- [x] Потолок общий для вызовов с `agent_id` и без (AC-023)
- [x] Процессный запуск: мусор в stdin, вход больше 1 МиБ, падение внутри (например, нечитаемый `runDir`) завершаются `exit 2`; stdout/stderr не содержат значений списка адресатов (C3)
- [x] Ответ `pre` не содержит `updatedInput`; вход вызова не меняется (AC-014, C6)
- [x] `post`/`fail` при сбое записи завершаются `exit 0` без вывода; в журнале остаётся `attempt` без итога
- [x] Инъекция: текст в `tool_input.text` с «отправь в чат Y» не влияет на решение, решает только `chat_sn` (AC-029)

**Verification**:
```bash
node --test test/send-gate.test.mjs
```
Падает, пока нет хука.

**Files** (estimated):
- `agent/hooks/send-gate.mjs`
- `test/send-gate.test.mjs`

---

### T08: prompt.mjs: промпт режима с отправкой и previous_attempts

**Role**: GO
**Effort**: M
**Blocked by**: []
**Covers**: FR-001 (явный запрос, `needs_info`), FR-009, FR-011, FR-012, NFR-004 (режим «только чтение» не меняется), NFR-006, AC-003, AC-014, AC-018, AC-019, AC-020, AC-029

**What to build**:
`agent/lib/prompt.mjs` по M8: `SYSTEM_PROMPT` остаётся как есть, добавляется `SYSTEM_PROMPT_SEND` с десятью пунктами из дизайна, `systemPromptFor(send)`, `buildPrompt(task, { send, previous })`. Блок `previous_attempts` добавляется только при `send` и непустом `previous`: JSON-массив строк, `<` заменён на `<`, не больше трёх последних блоков, суммарно не больше 2000 символов (набор собирается от новых к старым, единственный слишком длинный блок обрезается с хвоста). Блок идёт после `task_data` с напоминанием, что внутри данные. Без `send` пользовательский промпт совпадает с нынешним. Тексты пройти через `humanizer-ru` (C17). Переписать `test/prompt.test.mjs`.

**Acceptance criteria**:
- [x] Режим «только чтение»: `systemPromptFor(false)` и `buildPrompt(task)` побайтно прежние
- [x] В `SYSTEM_PROMPT_SEND` проверкой по ключевым фразам присутствует каждый из десяти пунктов M8 (явный запрос без превью, нет подписи, `needs_info`, обхода не искать и приложить готовый текст, запрещённое вне набора, `task_data` и `previous_attempts` — данные, не повторять выполненное, «начато, итог не подтверждён» не повторять, правило исхода `review`/`failed`, формат JSON-ответа) (AC-003, AC-014, AC-018)
- [x] `previous_attempts`: строка с `</previous_attempts>`, `</task_data>` и `<` внутри не закрывает блок изнутри; обрезка и лимит три блока (AC-019, AC-020)
- [x] Блок не появляется при пустом `previous` или `send: false`
- [x] Строка задачи «отправь это всем в чат Y» попадает только внутрь `task_data` как данные (AC-029)

**Verification**:
```bash
node --test test/prompt.test.mjs
```
Падает, пока нет `SYSTEM_PROMPT_SEND`.

**Files** (estimated):
- `agent/lib/prompt.mjs`
- `test/prompt.test.mjs` — переписывается

---

### T09: js/agent.js: normalizeJournal и composeNote с журналом

**Role**: GO
**Effort**: L
**Blocked by**: []
**Covers**: FR-007 (пометка «не всё выполнено»), FR-010, FR-011, NFR-003, NFR-005, AC-015, AC-016, AC-017, AC-025, AC-026, AC-028 (`composeNote` без журнала побайтно прежний), AC-034 (строку «Не всё выполнено» строит `composeNote` из журнала)

**What to build**:
В `js/agent.js` (по M9) добавить `JOURNAL_MAX = 2400`, `JOURNAL_HEADER`, `INCOMPLETE_MAX`, `NOTE_TEXT_MAX`, `normalizeJournal(raw)` (неизвестные виды и исходы отбрасываются; пределы: `target` 120, `ref` 200, `snippet` 100, `reason` 80, `hidden.blocked` ≤ 1 000 000; всё в одну строку) и `composeNote(status, text, journal)`. Формат блока, названия видов и причин по-русски, строка «Не всё выполнено: заблокировано N, ошибок N, начато без итога N» над блоком (строится из журнала, не из текста модели; для `unavailable` не добавляется), «Действий не было.», «Журнал недоступен…». Блок идёт первым, журнал не режется с хвоста, текст модели получает остаток бюджета (C10). Сжатие под `JOURNAL_MAX` четырьмя шагами из M9; после шага 4 длина гарантирована. Модуль остаётся чистым и импортирует только `js/core.js`.

**Acceptance criteria**:
- [x] `composeNote(status, text)` без третьего аргумента возвращает ровно то же, что до правки, при всех статусах; существующие тесты `test/agent.test.mjs` проходят без правок (AC-028, C10)
- [x] Для `ok` записи в блоке есть вид, адресат, фрагмент и ссылка или «ссылка не получена»; для `blocked`/`error` — вид, адресат и причина (AC-015, AC-016)
- [x] Строка «Не всё выполнено» появляется при `blocked`/`error`/`started` (с учётом `hidden.blocked`) и не зависит от текста модели (AC-025)
- [x] Один и тот же журнал при разных текстах модели (в том числе «всё отправлено» и пустом тексте) даёт одну и ту же строку «Не всё выполнено: заблокировано N, ошибок N, начато без итога N»; при журнале без `blocked`/`error`/`started` строки нет даже если текст модели говорит «не всё выполнено»; тест `[send] AC-034` (AC-034)
- [x] Длинный текст модели не вытесняет записи журнала: блок идёт первым, журнал целиком в пределах `JOURNAL_MAX`; общая длина не больше `NOTE_TEXT_MAX` при любом входе (AC-026)
- [x] Сжатие: набор из 100 записей разных видов укладывается в `JOURNAL_MAX` без потери записей `error` и `started` до последнего шага
- [x] `needs_info` и `failed` содержат блок журнала при непустых записях или `unavailable`
- [x] `normalizeJournal(null)` и мусор возвращают `null`/пустой журнал без исключения; переводы строк в полях убраны
- [x] Статус `review` остаётся с `done: false` на уровне композиции заметки (AC-017 проверяется в T10 на переходе)

**Verification**:
```bash
node --test test/agent.test.mjs
```
Падает, пока нет новых экспортов (новые тесты добавляются в этот же файл, существующие не правятся).

**Files** (estimated):
- `js/agent.js`
- `test/agent.test.mjs` — дополняется

---

### T10: js/agent.js: finish/reap с журналом и extractJournals

**Role**: GO
**Effort**: M
**Blocked by**: [T09]
**Covers**: FR-010, FR-011, FR-012, NFR-003, NFR-005, NFR-007 (`journal` в `finish`/`reap`, `extractJournals` для `journals`), AC-017, AC-019, AC-024 (журнал при `failed` и TTL-reap), AC-028, AC-031 (TTL-reap: «TTL истёк» и журнал под ней, без журнала перевод идёт без него)

**What to build**:
`applyAgentTransition` принимает необязательный `req.journal` для `finish` и `reap`, пропускает его через `normalizeJournal` и передаёт в `composeNote`; гарантии токена, `done`, сохранность пользовательских полей не меняются; для `reap` текст «TTL истёк» остаётся, журнал дописывается под ним. Добавить `extractJournals(agentNotes, { due, max = 3 })`: блок журнала ищется в первых трёх строках заметки, учитываются только блоки со сроком, равным `due`; результат от старых к новым; не бросает исключений на заметках без блока и мусоре.

**Acceptance criteria**:
- [x] `finish` с `journal` для статусов `review`, `needs_info`, `failed` кладёт блок в `agentNotes` первым; без `journal` результат прежний (AC-024, AC-028)
- [x] После `review` задача остаётся `done: false` (AC-017)
- [x] `reap` по TTL с журналом: `failed`, текст «TTL истёк» и журнал под ним; тест `[send] AC-031` (AC-031)
- [x] `reap` по TTL без журнала (`journal` не передан, `null` или мусор): перевод идёт как раньше, только «TTL истёк» (AC-031)
- [x] `extractJournals`: берёт блок со срезом `due`, пропускает блоки с другим сроком; поддельный заголовок «Журнал действий» вне первых трёх строк не считается (AC-019); не больше трёх, от старых к новым
- [x] Заметки без блока, `undefined`, число, огромная строка не вызывают исключений

**Verification**:
```bash
node --test test/agent.test.mjs test/model-agent.test.mjs
```
Падает, пока нет `extractJournals` и обработки `req.journal`.

**Files** (estimated):
- `js/agent.js`
- `test/agent.test.mjs` — дополняется

---

### T11: sync.mjs и mcp.mjs: journal в agent_finish, journals в agent_claim

**Role**: GO
**Effort**: M
**Blocked by**: [T10]
**Covers**: FR-010, FR-012, NFR-003, NFR-005, NFR-007 (аддитивный контракт MCP: `journals`, `journal`, `journalStored`), AC-019, AC-026, AC-028, AC-031 (`agent_finish` с `by_ttl` и `journal`), AC-032

**What to build**:
По M11. `sync.mjs#transition`: `claim` добавляет `journals = extractJournals(cur.agentNotes, { due: cur.due })`; `finish` и `reap` добавляют `journalStored: normalizeJournal(req.journal) !== null`. `mcp.mjs`: в `inputSchema` инструмента `agent_finish` добавляется `journal`; ответ остаётся `{ ok, status }`, при принятом непустом журнале добавляется `journalStored: true`; `agent_claim` возвращает `journals` рядом с `task` (`task` остаётся ровно `{ id, title, notes, due }`); `by_ttl` принимает `journal` и передаёт его в `op: 'reap'`. Если сервер ключ не вернул, `mcp.mjs` его не придумывает. `SCHEMA` остаётся `1`, поля задачи не добавляются.

**Acceptance criteria**:
- [x] Запрос `agent_finish` без `journal` даёт ответ побайтно прежний; golden девяти инструментов проходят без правок (C11, C12, AC-028, AC-032)
- [x] `agent_finish` с `journal`: заметка содержит блок первым, ответ содержит `journalStored: true` (AC-026)
- [x] `agent_claim`: `journals` — массив рядом с `task` (не более трёх); `task` остаётся ровно `{ id, title, notes, due }`; пустой массив, если блоков нет; блоки прежних попыток только с тем же сроком (AC-019, AC-032)
- [x] `agent_finish` с `by_ttl: true` и `journal`: заметка `failed` с «TTL истёк» и журналом под ней, ответ с `journalStored: true`; без журнала ответ прежний (AC-031, AC-032)
- [x] Новые проверки названы `[send] AC-032` (контракт `journals`/`journal`/`journalStored`) и `[send] AC-031` (`by_ttl`) (AC-031, AC-032)
- [x] HTTP `/api/agent/transition` для `finish`/`reap` принимает `journal`, коды ответов прежние
- [x] Снимок существующего `data/taskflow.json` (синтетический) читается без миграции, `SCHEMA === 1`

**Verification**:
```bash
node --test test/mcp-agent-tools.test.mjs test/serve-http.test.mjs test/mcp-contract.test.mjs test/store-parity.test.mjs
```
Падает на новых проверках; прежние проходят и до, и после.

**Files** (estimated):
- `sync.mjs`
- `mcp.mjs`
- `test/mcp-agent-tools.test.mjs`, `test/serve-http.test.mjs` — дополняются

---

### T12: taskflow-client.mjs: journal в finish и reap

**Role**: GO
**Effort**: S
**Blocked by**: [T11]
**Covers**: FR-010, FR-012, NFR-003, NFR-007 (клиентская сторона контракта), AC-032

**What to build**:
`agent/lib/taskflow-client.mjs`: `finish` и `reap` принимают необязательный `journal` и передают его как аргумент `journal` инструмента только если он задан; `claim` возвращает ответ целиком, включая `journals`; `finish` возвращает разобранный ответ (с `journalStored`). Старые вызовы без `journal` формируют тот же запрос, что и раньше.

**Acceptance criteria**:
- [x] Без `journal` запрос к MCP побайтно прежний
- [x] С `journal`: аргумент уходит в запросе `finish` и `reap`
- [x] `claim` возвращает `journals`, если сервер его отдал, и не придумывает при отсутствии
- [x] `finish` возвращает `journalStored` из ответа
- [x] Новые проверки названы `[send] AC-032` (AC-032)

**Verification**:
```bash
node --test test/taskflow-client.test.mjs
```
Падает на новых проверках.

**Files** (estimated):
- `agent/lib/taskflow-client.mjs`
- `test/taskflow-client.test.mjs` — дополняется

---

### T13: Подставной claude (режим send) и заглушка MCP

**Role**: QA
**Effort**: M
**Blocked by**: [T07]
**Covers**: — (тестовая инфраструктура для AC-030 и C16: без неё демон и E2E не проверяются на заглушке)

**What to build**:
Режим `send` в `test/helpers/fake-claude.mjs`: читает свои аргументы, берёт из `--settings` команды хуков, запускает их с подготовленным входом (сценарий задаётся через `FAKE_CLAUDE_SEND_PLAN`: список вызовов с `tool_name`, `tool_input`, опционально `agent_id`), «вызывает» заглушку MCP только если `pre`-хук ответил `allow` (заглушка дописывает вызов в файл `FAKE_CLAUDE_MCP_OUT`), затем запускает `post` (или `fail` по плану). Выдаёт конверт с итоговым `result`. Поддержать сбой хука (`exit 2` и отсутствие ответа). Прежние режимы `ok`, `needs_info`, `hang` и остальные работают без изменений. Тест на сам помощник.

**Acceptance criteria**:
- [x] Запуск с `allow` от `pre`: заглушка пишет вызов, `post` пишет `ok` в `audit.jsonl`
- [x] Запуск с `deny` и с `exit 2`: заглушка не вызывается (счётчик вызовов равен нулю)
- [x] Вызов с `agent_id` проходит тем же gate (для AC-023 в T15)
- [x] Прежние режимы fake-claude и их тесты (`claude-run`, `runner`) проходят без правок

**Verification**:
```bash
node --test test/fake-claude-send.test.mjs test/claude-run.test.mjs test/runner.test.mjs
```
Падает, пока нет режима `send` и нового теста.

**Files** (estimated):
- `test/helpers/fake-claude.mjs`
- `test/helpers/` — заглушка MCP (файл вызовов)
- `test/fake-claude-send.test.mjs`

---

### T14: delegation-runner: режим с отправкой

**Role**: GO
**Effort**: L
**Blocked by**: [T01, T03, T05, T06, T08, T12, T13]
**Covers**: FR-001, FR-010, FR-012, NFR-002, NFR-003, NFR-004, NFR-007 (демон читает `journals`, передаёт `journal`, проверяет `journalStored`), AC-001 (демон передаёт право без подтверждения), AC-017, AC-019, AC-024, AC-025, AC-027, AC-031 (reap зависшей задачи с журналом из каталога прогона)

**What to build**:
`agent/delegation-runner.mjs` и `main()` по M10. Новые необязательные параметры `runOnce`: `send` (по умолчанию `isSendEnabled(env)`), `stateDir`, `policyPath` (`env.TASKFLOW_AGENT_SEND_POLICY` или `defaultPolicyPath()`), `nodePath`, `gatePath`, `runDirs`, `audit`. Порядок: перед `reap` зависшей задачи в режиме с отправкой читается журнал из `findLatestRunDir` и передаётся в `client.reap`; один раз за вызов `pruneRunDirs` и в лог `{ event: 'send_mode', send, policy: policyState }`; после `claim` без массива `journals` задача получает `failed` «Сервер не поддерживает журнал действий», `claude` не запускается (C15); `createRunDir` (ошибка даёт `failed` «Не удалось подготовить каталог прогона»); аргументы `buildClaudeArgs({ send: true, gate })`; промпт `buildPrompt(task, { send, previous })`; окружение получает `AUTONOMOUS_RUN=1` и шаблон `^AUTONOMOUS_RUN$` в `passEnv` только в режиме с отправкой (C14); после любого исхода, кроме `aborted`, читается аудит и собирается журнал (ошибка чтения даёт `{ unavailable: true }` и лог `journal_unavailable`); `client.finish({ ..., journal })`; без `journalStored: true` в лог `journal_not_stored`; в лог `finished` счётчики журнала. В логе только состояния и счётчики (C13). Режим `read` ведёт себя как до change.

**Acceptance criteria**:
- [x] `TASKFLOW_AGENT_SEND=off`: argv, промпт и окружение как до change, `journal` в `finish` не передаётся, `AUTONOMOUS_RUN` не выставлен (AC-027, C14)
- [x] Режим с отправкой: argv содержит `--settings` и `LIMITS_SEND`; `AUTONOMOUS_RUN=1` есть в окружении `claude`, `TASKFLOW_*` по-прежнему нет
- [x] `journal` уходит в `finish` при `review`, `needs_info`, `failed`, таймауте и `spawn_error` (AC-024)
- [x] `aborted`: `finish` не вызывается, в лог идёт число записей аудита по исходам
- [x] `claim` без `journals`: `failed` с нужной причиной, `claude` не запускался (C15)
- [x] Ошибка `createRunDir` не прерывает цикл: эта задача `failed`, следующие обрабатываются
- [x] `reap` зависшей задачи уходит с `by_ttl` и журналом из последнего каталога прогона; нет каталога или аудит нечитаем — без журнала, перевод идёт; тест `[send] AC-031` (AC-031)
- [x] В лог не попадают идентификаторы чатов, ссылки и тексты (C13); проверка по строке лога
- [x] Блок журналов прежних попыток из `claim.journals` попадает в промпт как `previous_attempts` (AC-019)

**Verification**:
```bash
node --test test/runner.test.mjs
```
Падает на новых проверках режима с отправкой.

**Files** (estimated):
- `agent/delegation-runner.mjs`
- `test/runner.test.mjs` — дополняется

---

### T15: E2E: отправка, блокировка, инъекция, потолок

**Role**: QA
**Effort**: M
**Blocked by**: [T14]
**Covers**: FR-001, FR-002, FR-007, FR-008, FR-010, FR-011, NFR-002, NFR-003, NFR-006, AC-001, AC-002, AC-010, AC-011, AC-012, AC-013, AC-015, AC-016, AC-017, AC-023, AC-025, AC-029, AC-030

**What to build**:
Дополнить `test/e2e-delegation.test.mjs`: полный путь на временном экземпляре `serve.mjs`, настоящем демоне, подставном `claude` (режим `send`, T13) и заглушке MCP. Сценарии: (1) «напиши в чат из списка» — вызов дошёл до заглушки, задача `review`, в `agentNotes` журнал первым блоком со ссылкой, задача остаётся `done: false`; (2) «чат вне списка» — заглушка не вызвана, `review` с «Не всё выполнено» и готовым текстом; (3) инъекция в тексте задачи — отправки вне списка нет; (4) потолок: четвёртое сообщение блокируется, три выполненных остаются в журнале; (5) пустой список политики блокирует всё, после заполнения файла без перезапуска отправка проходит; (6) вызов из субагента (`agent_id`) делит потолок; (7) журнал записан при `failed` и таймауте; (8) отправка из задачи любого происхождения без различий (AC-002); (9) все автотесты не используют реальные MCP.

**Acceptance criteria**:
- [x] Счётчик вызовов заглушки подтверждает: вне списка, при пустом списке и сверх потолка ничего не ушло
- [x] Журнал в `agentNotes` соответствует вызовам заглушки, даже если текст модели про отправку молчит (AC-025)
- [x] Задача после `review` закрывается обычной галкой, автоотправки по галке нет (AC-017)
- [x] Имена тестов содержат `[send] AC-0NN` для перечисленных AC
- [x] Весь набор `node --test test/*.test.mjs` проходит, реальный `claude` не запускается (C16, AC-030)

**Verification**:
```bash
node --test test/e2e-delegation.test.mjs
```
Падает на новых сценариях.

**Files** (estimated):
- `test/e2e-delegation.test.mjs` — дополняется

---

### T16: env.example, шаблон политики и README

**Role**: Infra
**Effort**: M
**Blocked by**: [T14]
**Covers**: FR-008 (шаблон и порядок заполнения), NFR-004 (выключатель и аварийная процедура), AC-013, AC-027, AC-033 (`env.example` с `off`, правила описаны в README)

**What to build**:
По M12. `agent/send-policy.example.json` (пустые списки, `limits` показан), `agent/env.example`: строка `TASKFLOW_AGENT_SEND=off` (поставляется выключенной до S1 и S3, C8) и закомментированная `TASKFLOW_AGENT_SEND_POLICY`. `agent/README.md`: включение отправки, формат и права файла политики (`0600`, владелец), что писать в белый список (значения копируются из строк журнала «заблокировано»), выключатель и аварийная процедура (очистить списки в `send-policy.json`), прямо: «при отсутствии переменной режим с отправкой включён» (C8), границы повтора по сроку, порядок раскатки сервер → демон, спайки S1..S3. Тексты пройти через `humanizer-ru`. Тест на файлы поставки.

**Acceptance criteria**:
- [x] `env.example` содержит `TASKFLOW_AGENT_SEND=off` и не содержит значений секретов; тест `[send] AC-033` (AC-033)
- [x] `send-policy.example.json` проходит `loadSendPolicy` как формат (пустые списки, `ok`), прав и значений не содержит
- [x] README описывает все пункты M12; в нём есть предупреждение про отсутствие переменной (при отсутствии переменной режим с отправкой включён) и правило «пустой белый список блокирует любое действие, задача уходит в `review` с пометкой «не всё выполнено»»; тест `[send] AC-033` проверяет эти фразы (AC-033)
- [x] `test/launchd-files.test.mjs` и прочие тесты поставки проходят

**Verification**:
```bash
node --test test/launchd-files.test.mjs test/send-delivery.test.mjs
```
Падает, пока нет шаблона и нового теста поставки.

**Files** (estimated):
- `agent/env.example`
- `agent/send-policy.example.json`
- `agent/README.md`
- `test/send-delivery.test.mjs`

---

### T17: Harness спайков S1..S3 на заглушке MCP

**Role**: Infra
**Effort**: L
**Blocked by**: [T01, T07, T08]
**Covers**: — (проверка осуществимости ADR-004, ADR-008, ADR-009; обеспечивает C8)

**What to build**:
Скрипты и заметка-шаблон в `agent/spike/send/`: заглушка MCP-сервера с теми же полными именами инструментов (`mcp__mcp-workspace-assistant__messenger-send-message` и остальные пять, плюс конвертер), которая ничего не отправляет и пишет вызовы в файл; вывод форм ответов и входа хуков. Скрипт `run-s1.sh`: (а) хук из `--settings` срабатывает в `claude -p` под временным launchd и внутри субагента; (б) `allow` от хука открывает инструмент вне `--allowedTools` под `dontAsk`; (в) без хука тот же вызов отклонён; (г) форма входа и ответа хуков (`permissionDecision`, `agent_id`, `tool_response`); (д) формы ответов для `extractRef`; (е) в каком виде агент передаёт `project_id` и какой вид у `chat_sn`. `run-s2.sh`: форма `Agent(<имя>)`; три типовые задачи против 50 ходов и 3.00 USD; частота `pending` MCP на старте. `run-s3.sh`: правило превью агента и `confirm-outbound.sh` при `AUTONOMOUS_RUN=1`. Каждый скрипт пишет в `openspec/changes/agent-send-actions/spike-s1-s3.md` строки `S1: PASS|FAIL`, `S2: ...`, `S3: ...` и фактические данные. Временные каталоги и задачи launchd снимаются в `trap EXIT`. Реальные отправки и реальные MCP не используются.

**Acceptance criteria**:
- [x] Заглушка отдаёт полные имена шести инструментов и конвертера, фиксирует каждый вызов в файле и не имеет сетевых побочных эффектов
- [x] Скрипты работают только во временных каталогах; при сбое временная задача launchd снята, временный `serve.mjs` остановлен
- [x] Шаблон заметки содержит поля для всех пунктов S1 (а..е), S2 (а..в), S3 и инструкцию «что делать при FAIL» из design.md (S1 б провален: возврат к пользователю, автоотката на вариант C нет)
- [x] Тест проверяет формат заметки (разбор строк `S1:`/`S2:`/`S3:`) и отсутствие реальных данных, но не требует PASS: вердикты вносит пользователь

**Verification**:
```bash
node --test test/spike-send-harness.test.mjs
```
Тест проверяет заглушку (имена и запись вызовов) и разбор шаблона заметки. Падает, пока нет harness.

**Files** (estimated):
- `agent/spike/send/stub-mcp.mjs`
- `agent/spike/send/run-s1.sh`, `run-s2.sh`, `run-s3.sh`
- `openspec/changes/agent-send-actions/spike-s1-s3.md` — шаблон
- `test/spike-send-harness.test.mjs`

---

### T18: S1: прогон пользователем (хук, allow под dontAsk, формы ответов)

**Role**: Пользователь
**Effort**: M
**Blocked by**: [T17]
**Covers**: — (гейт ADR-004; NFR-001, NFR-002 осуществимость)

**What to build**:
Пользователь запускает `agent/spike/send/run-s1.sh` на заглушке MCP (реальных отправок нет) и вносит вердикт в `openspec/changes/agent-send-actions/spike-s1-s3.md`. Критерий: пункты (а), (б), (в) выполнены. Если пункт (б) не выполнен: вопрос возвращается пользователю с вариантами (шлюз MCP, ADR-004 вариант E, или отказ от отправки); автоотката на вариант C нет. Записать формы ответов (д) и вид `project_id` и `chat_sn` (е): они идут в T21.

**Acceptance criteria**:
- [ ] В заметке стоит `S1: PASS` с подтверждёнными (а), (б), (в) либо `S1: FAIL` с записанным решением пользователя
- [ ] Заметка содержит фактические формы `tool_response` для шести инструментов и формат `project_id`/`chat_sn`
- [ ] Заметка содержит форму входа хука в установленной версии `claude` (имена полей `permissionDecision`, `agent_id`, `tool_response`)

**Verification**:
```bash
grep -q '^S1: PASS' openspec/changes/agent-send-actions/spike-s1-s3.md
```
Падает, пока пользователь не внёс вердикт.

**Files** (estimated):
- `openspec/changes/agent-send-actions/spike-s1-s3.md`

---

### T19: S2: прогон пользователем (Agent(<имя>), лимиты, pending MCP)

**Role**: Пользователь
**Effort**: M
**Blocked by**: [T17]
**Covers**: — (гейт ADR-006, ADR-009; NFR-002, FR-007 лимиты прогона)

**What to build**:
Пользователь запускает `agent/spike/send/run-s2.sh` на заглушке MCP и вносит вердикт: (а) работает ли `Agent(<имя>)` и закрывает ли остальные имена; (б) три типовые задачи («поздравить в чат», «отревьюить MR с inline-комментариями», «создать страницу отчёта») укладываются в 50 ходов и 3.00 USD; (в) как часто MCP в `pending` на старте. S2 не блокирует включение, он определяет `NARROW_AGENT` и итоговые `LIMITS_SEND`.

**Acceptance criteria**:
- [ ] В заметке `S2: PASS|FAIL` с ответами (а), (б), (в) и фактическими значениями ходов и стоимости

**Verification**:
```bash
grep -qE '^S2: (PASS|FAIL)' openspec/changes/agent-send-actions/spike-s1-s3.md
```
Падает, пока пользователь не внёс результат.

**Files** (estimated):
- `openspec/changes/agent-send-actions/spike-s1-s3.md`

---

### T20: S3: прогон пользователем (превью агента и confirm-outbound.sh)

**Role**: Пользователь
**Effort**: S
**Blocked by**: [T17]
**Covers**: — (гейт ADR-008; FR-001 осуществимость)

**What to build**:
Пользователь запускает `agent/spike/send/run-s3.sh` на заглушке MCP: правило превью агента `ai-space-assistant` и хук `confirm-outbound.sh` при `AUTONOMOUS_RUN=1` не мешают, вызов send доходит до заглушки. Повторять после любых правок файлов агента. При провале правится промпт режима с отправкой (T08), файлы агента не правятся.

**Acceptance criteria**:
- [ ] В заметке `S3: PASS` с подтверждением, что вызов дошёл до заглушки, либо `S3: FAIL` с описанием, что мешает

**Verification**:
```bash
grep -q '^S3: PASS' openspec/changes/agent-send-actions/spike-s1-s3.md
```
Падает, пока пользователь не внёс вердикт.

**Files** (estimated):
- `openspec/changes/agent-send-actions/spike-s1-s3.md`

---

### T21: Применить результаты спайков (условная)

**Role**: GO
**Effort**: S
**Blocked by**: [T18, T19]
**Covers**: FR-003, FR-007, NFR-002 (уточнения по фактическим данным спайков; AC-010, AC-023)

**What to build**:
По заметке спайков: (1) если S2(а) PASS, `NARROW_AGENT = true` и в allow вместо `Agent` идут `Agent(<имя>)` для `SUBAGENTS` (тест `policy.test.mjs`); (2) если S2(б) выявил расхождение, правятся `LIMITS_SEND`; (3) формы `tool_response` из S1(д) вносятся как фикстуры в `test/audit.test.mjs`, при необходимости правится `extractRef`; (4) форма `project_id` из S1(е) отражается в README и в тестах `send-targets`; (5) расхождения формата входа хука (S1 г) исправляются в `send-gate.mjs` и `buildGateSettings`. Если расхождений нет, задача закрывается пометкой в заметке без правок кода.

**Acceptance criteria**:
- [ ] Каждый пункт (1)..(5) либо исполнен с тестом, либо отмечен в заметке «расхождений нет»
- [ ] Весь набор тестов проходит

**Verification**:
```bash
node --test test/policy.test.mjs test/audit.test.mjs test/send-gate.test.mjs test/send-targets.test.mjs
```
Проходит до и после, если расхождений нет; при расхождениях новые проверки сначала падают.

**Files** (estimated):
- `agent/lib/policy.mjs`, `agent/lib/audit.mjs`, `agent/hooks/send-gate.mjs` — по необходимости
- `test/policy.test.mjs`, `test/audit.test.mjs` — фикстуры
- `agent/README.md` — по необходимости

---

### T23: Итоговая приёмка автоматикой

**Role**: QA
**Effort**: S
**Blocked by**: [T15, T16]
**Covers**: все FR/NFR (сквозная проверка), приёмка AC-001..AC-034, AC-028, AC-030

**What to build**:
Прогнать `node --test test/*.test.mjs` целиком; `node scripts/ac-trace-check.mjs` (как есть, без правок; пересечение AC известно); вручную сверить трассировку AC-001..AC-034 по префиксу `[send]` и по этому tasks.md (таблица «Requirements Coverage»); AC-030..AC-034 вне `AC_COUNT = 29` скрипта, поэтому только вручную (после мержа `tweak-entry-and-moments` можно подключить `--proposal`); пройти регрессию прошлого change (паритет нормализации, sync, golden MCP, `check-snapshot` на синтетике); добавить в `test/MANUAL-CHECKLIST.md` раздел «Отправка из делегирования» с ручными пунктами: S1, S2, S3 (T18..T20), живой dry-run на заглушке, ручная проверка отправленного пользователем в один чат из списка (реальную отправку для проверки делает пользователь, AC-030 вне автотестов), `TASKFLOW_AGENT_SEND=off` возвращает черновик. Пункты со ссылкой на AC оформляются как `- [x] **[ручной]** AC-0NN: ...`.

**Acceptance criteria**:
- [x] Весь набор тестов зелёный; `ac-trace-check` завершается кодом 0
- [x] Для каждого AC-001..AC-034 найден тест с `[send] AC-0NN` или ручной пункт в чек-листе; в том числе `[send] AC-031` (T10, T14), `[send] AC-032` (T11, T12), `[send] AC-033` (T01, T07, T16), `[send] AC-034` (T09); список непокрытых пуст
- [x] Прошлые тесты проходят без правок (кроме `policy.test.mjs`, `prompt.test.mjs`)
- [x] Чек-лист дополнен ручными пунктами (S1, S2, S3, dry-run, `off`)

**Verification**:
```bash
node --test test/*.test.mjs && node scripts/ac-trace-check.mjs
```
Падает, пока предыдущие задачи не закрыты.

**Files** (estimated):
- `test/MANUAL-CHECKLIST.md`

---

### T22: Гейт: включение отправки на боевых данных (пользователь)

**Role**: Пользователь
**Effort**: S
**Blocked by**: [T18, T20, T21, T23]
**Covers**: — (C8; гейт включения; NFR-001, NFR-002, NFR-004)

**What to build**:
Решение пользователя, не код. Включать отправку на боевых данных можно только если в `spike-s1-s3.md` стоят `S1: PASS` и `S3: PASS`, T21 закрыта, приёмка T23 пройдена. Шаги: создать `~/.config/taskflow-agent/send-policy.json` с правами `0600`, внести первый адрес (значение из строки журнала «заблокировано» после dry-run), убрать `TASKFLOW_AGENT_SEND=off` в env-файле, раскатить сервер до демона (C15), перезапустить задание launchd, провести одну реальную отправку вручную. Если S1 не пройден, `TASKFLOW_AGENT_SEND=off` остаётся, отправка не включается.

**Acceptance criteria**:
- [ ] `S1: PASS` и `S3: PASS` в заметке спайков
- [ ] Файл политики с правами `0600` создан, первый адрес добавлен из журнала блокировок
- [ ] Сервер обновлён раньше демона; демон перезапущен
- [ ] Одна реальная отправка проверена пользователем; журнал в `agentNotes` соответствует факту

**Verification**:
```bash
grep -q '^S1: PASS' openspec/changes/agent-send-actions/spike-s1-s3.md && grep -q '^S3: PASS' openspec/changes/agent-send-actions/spike-s1-s3.md && stat -f '%Lp' ~/.config/taskflow-agent/send-policy.json | grep -qx 600
```
Падает, пока не выполнены условия гейта.

**Files** (estimated):
- `~/.config/taskflow-agent/send-policy.json` — вне репозитория
- `~/.config/taskflow-agent/env` — вне репозитория

---

## Tracer-bullet порядок

1. **T01** — policy.mjs (набор, режимы, хуки)
2. **T03**, **T04**, **T05**, **T06** — чистые модули без зависимостей (параллельно)
3. **T02** — send-targets (после T01)
4. **T07** — gate (после T01..T05)
5. **T08** — промпт; **T09 → T10 → T11 → T12** — клиентское ядро, sync, MCP, клиент демона (параллельно с 4)
6. **T13** — подставной claude и заглушка MCP
7. **T14** — демон
8. **T15** — E2E; **T16** — env, README
9. **T17** — harness спайков
10. **T18, T19, T20** — прогоны пользователя (параллельно)
11. **T21** — применение результатов
12. **T23** — приёмка автоматикой
13. **T22** — гейт включения на боевых данных

Рекомендуемая последовательность для одного исполнителя: T01, T03, T04, T05, T06, T02, T07, T08, T09, T10, T11, T12, T13, T14, T15, T16, T17, T23; затем T18..T21 и T22 по ходу прогонов пользователя.

## Requirements Coverage

| FR/NFR | Source | Задачи | AC |
|---|---|---|---|
| FR-001 | SRC-1, SRC-2, SRC-9, SRC-10, SRC-17 | T07, T08, T14, T15 | AC-001, AC-002, AC-003 |
| FR-002 | SRC-4, SRC-14 | T02, T07, T15 | AC-004 |
| FR-003 | SRC-5, SRC-14 | T02, T21 | AC-005 |
| FR-004 | SRC-6, SRC-14 | T02 | AC-006 |
| FR-005 | SRC-7, SRC-14 | T01, T02 | AC-007, AC-008 |
| FR-006 | SRC-8, SRC-19 | T01 | AC-009 |
| FR-007 | SRC-13 | T04, T07, T09, T15, T21 | AC-010, AC-011, AC-034 |
| FR-008 | SRC-14, SRC-18 | T03, T07, T16 | AC-012, AC-013 |
| FR-009 | SRC-15 | T07, T08 | AC-014 |
| FR-010 | SRC-3, SRC-11 | T05, T09, T10, T11, T12, T14 | AC-015, AC-016 |
| FR-011 | SRC-3, SRC-12 | T08, T09, T10 | AC-017, AC-018 |
| FR-012 | SRC-16 | T08, T10, T11, T12, T14 | AC-019, AC-020 |
| NFR-001 | SRC-8, SRC-9, SRC-17 | T01, T07 | AC-021 |
| NFR-002 | SRC-13, SRC-14, SRC-18, SRC-19 | T03, T04, T07, T14, T15 | AC-022, AC-023 |
| NFR-003 | SRC-11, SRC-19 | T05, T09, T10, T14 | AC-024, AC-025, AC-026, AC-031, AC-034 |
| NFR-004 | SRC-19 | T01, T07, T08, T14, T16 | AC-027, AC-033 |
| NFR-005 | SRC-19 | T09, T10, T11 | AC-028 |
| NFR-006 | SRC-10, SRC-16 | T07, T08, T15 | AC-029 |
| NFR-007 | SRC-11, SRC-16, SRC-19 | T10, T11, T12, T14 | AC-032 |

Трассировка AC-030..AC-034 (вне `AC_COUNT` скрипта, сверка вручную в T23):

| AC | Родитель | Задачи |
|---|---|---|
| AC-030 | NFR-001..NFR-004 | T13, T15, T23 |
| AC-031 | NFR-003 | T10, T11, T14 |
| AC-032 | NFR-007 | T11, T12 |
| AC-033 | NFR-004 | T01, T07, T16 |
| AC-034 | FR-007, NFR-003 | T09 |

**Coverage**: 19 из 19 FR/NFR закрыты задачами (FR-001..FR-012, NFR-001..NFR-007); AC-001..AC-034 покрыты, непокрытых нет.

**Задачи без привязки к FR** (обоснование):
- T06 — каталог прогона: инфраструктура слотов и журнала (ADR-006, ADR-007).
- T13 — тестовая инфраструктура (C16, AC-030).
- T17, T18, T19, T20 — спайки S1..S3 (ADR-004, ADR-008, ADR-009), гейт перед включением.
- T22 — гейт включения на боевых данных (C8).

## Effort Summary

| Task | Role | Effort | SP |
|---|---|---|---|
| T01 | GO | M | 2 |
| T02 | GO | M | 2 |
| T03 | GO | M | 2 |
| T04 | GO | S | 1 |
| T05 | GO | M | 2 |
| T06 | GO | S | 1 |
| T07 | GO | L | 3 |
| T08 | GO | M | 2 |
| T09 | GO | L | 3 |
| T10 | GO | M | 2 |
| T11 | GO | M | 2 |
| T12 | GO | S | 1 |
| T13 | QA | M | 2 |
| T14 | GO | L | 3 |
| T15 | QA | M | 2 |
| T16 | Infra | M | 2 |
| T17 | Infra | L | 3 |
| T18 | Пользователь | M | 2 |
| T19 | Пользователь | M | 2 |
| T20 | Пользователь | S | 1 |
| T21 | GO | S | 1 |
| T22 | Пользователь | S | 1 |
| T23 | QA | S | 1 |
| **Total** | | | **43** |

## References

- Requirements Source: `openspec/changes/agent-send-actions/requirements-source.md`
- Proposal: `openspec/changes/agent-send-actions/proposal.md`
- Design: `openspec/changes/agent-send-actions/design.md`
- HLD: `openspec/changes/agent-send-actions/hld.md`
- ADRs: `openspec/changes/agent-send-actions/adrs/004-send-gate-mechanism.md`, `005-send-policy-and-killswitch.md`, `006-subagents-shared-counter.md`, `007-audit-journal.md`, `008-explicit-request.md`, `009-run-limits-and-partial-mcp.md`
- Прошлый change: `openspec/changes/archive/2026-10-05-add-agent-delegation/`

---

*Created by Task Planner agent. Gate A и Gate B отменены пользователем.*
