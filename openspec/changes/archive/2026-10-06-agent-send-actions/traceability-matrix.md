# Traceability Matrix: agent-send-actions

**Gate**: G2 (Spec Validator), итерация 2, depth standard
**Verdict**: APPROVED (SPEC_VALIDATED), critical/high gaps: 0
**Источник истины**: `requirements-source.md` (SRC-1..SRC-19, SRC-Q1..Q8). AC в источнике не заданы (раздел «Acceptance Criteria из источника» пуст), поэтому `SRC-AC-n` отсутствуют.
**Предыдущая итерация**: итерация 1, CHANGES_REQUESTED (G1 high: tasks, NFR-007 и AC-031..034; G2 medium: design, NFR-007; G3 medium: ADR-007 drives). G1 и G2 закрыты, G3 оставлен как warning (см. W3).

Статус «OK» означает, что цепочка SRC -> FR/NFR -> дизайн -> задача связна по существу и отражена в трассировочных таблицах `design.md` и `tasks.md`.

## SRC -> FR/NFR -> ADR -> Дизайн -> Задачи -> AC

| SRC | Требование (кратко) | FR/NFR | ADR | Дизайн | Задачи | AC | Статус |
|---|---|---|---|---|---|---|---|
| SRC-1 | открыть выполнение агентом, не только чтение | FR-001 | ADR-004, ADR-008 | M1, M6, M8, M10 | T01, T07, T08, T14, T15 | AC-001 | OK |
| SRC-2 | «auto mode»: выполнять без подтверждения | FR-001, NFR-001 | ADR-004 | M1 (`dontAsk`, gate) | T01, T07 | AC-001, AC-021 | OK (допущение 1 в proposal, см. W2) |
| SRC-3 | результат на проверку, «отправил сообщение» | FR-010, FR-011 | ADR-007, ADR-009 | M5, M9 (`composeNote`), State Machines | T05, T09, T10 | AC-015, AC-016, AC-017 | OK |
| SRC-4 | сообщения VK Teams | FR-002 | ADR-004 | M2 `describeCall(messenger-send-message)`, M1 deny | T02, T07, T15 | AC-004 | OK |
| SRC-5 | комментарии в MR | FR-003 | ADR-004 | M2 (3 инструмента GitLab), M1 deny (resolve, update MR) | T02, T21 | AC-005 | OK |
| SRC-6 | комментарии в Jira | FR-004 | ADR-004 | M2 `jira_add_comment` | T02 | AC-006 | OK |
| SRC-7 | создавать отчёты и страницы Confluence | FR-005 | ADR-004 | M2 `confluence_page_create`, M1 `CONVERTER_TOOL` | T01, T02 | AC-007, AC-008 | OK |
| SRC-8 | прод/kubernetes, merge, удаление запрещены | FR-006, NFR-001 | ADR-004 | M1 `DISALLOWED_TOOLS` | T01 | AC-009 | OK |
| SRC-9 | явный список под dontAsk | FR-001, NFR-001 | ADR-004 | M1 argv | T01 | AC-021 | OK (см. W1) |
| SRC-10 | все делегированные задачи | FR-001, NFR-006 | ADR-008 | M8 (`task_data`), M6 по параметрам | T07, T08, T15 | AC-002, AC-029 | OK |
| SRC-11 | обязательный журнал действий | FR-010, NFR-003, NFR-007 | ADR-007 | M5, M9, M10 (шаги 7-9), M11 | T05, T09, T10, T11, T12, T14 | AC-015, AC-025, AC-031, AC-034 | OK |
| SRC-12 | отмена «только черновик», смысл `review` | FR-011 | ADR-008 | M8, M9, State Machines | T08, T09, T10 | AC-018 | OK |
| SRC-13 | потолки 3/20/3/2 | FR-007, NFR-002 | ADR-005, ADR-006 | M3 `LIMIT_DEFAULTS`, M4 `takeSlot`, M6 шаг 4, M9 | T03, T04, T07, T09, T15, T21 | AC-010, AC-011, AC-023, AC-034 | OK |
| SRC-14 | белый список адресатов | FR-002..FR-005, FR-008, NFR-002 | ADR-005 | M2, M3, M6 шаги 1-3 | T02, T03, T07 | AC-012 | OK |
| SRC-15 | без пометки об авторстве | FR-009 | ADR-007, ADR-008 | M6 (без `updatedInput`), M8 п. 3 | T07, T08 | AC-014 | OK |
| SRC-16 | передавать журнал при повторе | FR-012, NFR-006, NFR-007 | ADR-007 | M8 `previous_attempts`, M9 `extractJournals`, M11 `journals` | T08, T10, T11, T12, T14 | AC-019, AC-020, AC-032 | OK |
| SRC-17 | явный allow send-инструментов, не auto | NFR-001 | ADR-004 | M1 | T01 | AC-021 | OK (см. W1) |
| SRC-18 | пустой белый список = блокировка | FR-008 | ADR-005 | M3 (`loadSendPolicy` fail-closed), M12 | T03, T07, T16 | AC-013 | OK |
| SRC-19 | обратная совместимость, kill-switch, журнал от процесса, fail-closed | NFR-002..NFR-005, NFR-007 | ADR-004..ADR-007 | M1, M5, M6, M9, M11, M12 | T01, T03..T05, T07, T09..T12, T14, T16 | AC-022..AC-028, AC-030..AC-033 | OK |

## FR/NFR -> дизайн -> задачи (фактическая проверка)

| FR/NFR | Строка в `design.md` Requirements Traceability | Реализуется по существу | Строка в `tasks.md` Requirements Coverage | Реализуется задачами по существу | Статус |
|---|---|---|---|---|---|
| FR-001..FR-012 | есть | да | есть | да | OK |
| NFR-001..NFR-006 | есть | да | есть | да | OK |
| NFR-007 | есть (M9, M10 шаги 5, 7-9, M11; AC-031, AC-032) | да | есть (T10, T11, T12, T14; AC-032) | да | OK (закрыт G1/G2 итерации 1) |

Фактическое число: 12 FR + 7 NFR = 19.

## AC-001..AC-034 (приёмка и тесты)

| AC | Суть | Дизайн / Test Strategy | Задачи | Статус |
|---|---|---|---|---|
| AC-001..AC-029 | см. proposal | есть в Requirements Traceability и Test Strategy | в `Covers` задач и таблице Requirements Coverage | OK |
| AC-030 | автотесты на заглушке MCP, без реальных отправок | Test Strategy, C16 | T13, T15, T23 | OK |
| AC-031 | TTL-reap: `failed` «TTL истёк» + журнал под ней; без журнала перевод идёт без него | M9/M10, строка «Демон» в Test Strategy, абзац «Поздние критерии AC-031..AC-034» | T10 (критерии «reap с журналом» и «без журнала»), T11 (`by_ttl` + `journal`), T14; тест `[send] AC-031` | OK |
| AC-032 | `agent_claim.journals` рядом с `task`; `agent_finish.journal`, `journalStored`, в том числе при `by_ttl` | M11, API Contracts, строка «Сервер и MCP» в Test Strategy | T11, T12; тест `[send] AC-032` | OK |
| AC-033 | `env.example` с `TASKFLOW_AGENT_SEND=off`; отправка только при `on` (без переменной только чтение, SEC03); пустой список блокирует; правила в README | M1 `isSendEnabled`, M12, C8; строка «Демон» в Test Strategy | T01, T07, T16; тест `[send] AC-033` | OK |
| AC-034 | строку «Не всё выполнено» строит `composeNote` из журнала, текст модели не влияет | M9; строка «Заметка и журнал» в Test Strategy | T09 (критерий «один журнал при разных текстах модели даёт одну строку»); тест `[send] AC-034` | OK |

Приёмка T23: «Для каждого AC-001..AC-034 найден тест с `[send] AC-0NN` или ручной пункт в чек-листе», с явным перечнем AC-031..AC-034. Разрыв итерации 1 (AC-031..034 вне приёмки) закрыт.

## Обратная трассировка (task/design -> FR)

- Все задачи с непустым `Covers` (T01..T05, T07..T12, T14..T16, T21, T23) ссылаются на FR/NFR.
- Без привязки к FR, с обоснованием: T06, T13, T17..T20, T22 (раздел «Задачи без привязки к FR» в tasks.md); в design: M7, защита от старого сервера (M10), журнал при TTL-reap, `journalStored` (раздел «Элементы дизайна без привязки к FR»). Обоснования приняты.
- Все FR/NFR ссылаются на SRC; `[derived]` помечены (конвертер FR-005, блокировка вне потолка как «не всё выполнено», граница серии при повторе).
- Out-of-scope из источника (прод, kubernetes, merge, удаление) присутствует в Non-goals proposal.md.
- Superseded SRC-12/SRC-24 прошлого change отражены в proposal (таблица Superseded) и в delta-спеках `agent-delegation`, `agent-delegation-runner`.

## Verify claimed coverage

| Источник заявления | Заявлено | Фактически | Расхождение |
|---|---|---|---|
| system_designer | 19/19, NFR-007 добавлен, AC-031..034 в Test Strategy | 19/19; строка NFR-007 в Requirements Traceability; AC-031..034 в Test Strategy и в абзаце-раскладке | нет |
| task_planner | 19/19, AC-001..034, T23 приёмка AC-001..034 | 19/19; строка NFR-007 и таблица AC-030..034 в Requirements Coverage; T23 с AC-001..034 | нет |

## Итоги

| Метрика | Значение |
|---|---|
| source_to_fr | 19/19 (100%) |
| fr_to_design | 19/19 (100%) |
| fr_to_tasks | 19/19 (100%) |
| end_to_end (SRC дошёл до задачи) | 19/19 |
| AC в трассировке задач | 34/34 |
| claimed vs actual | совпадает |

## Gaps

Critical/high: нет. Medium (не блокируют): G3 из итерации 1, переведён в warning W3.

## Warnings

- W1: SRC-9/SRC-17 дословно: «явный allow конкретных send-инструментов под dontAsk». NFR-001 и ADR-004 сознательно кладут send-инструменты вне `--allowedTools`, право выдаёт gate-хук. Механизм ограничения SRC-19 передал на архитектуру, отклонение зафиксировано в proposal и ADR-004; по смыслу «явный список, не auto mode» сохранён. Человек решает, принимать ли такое прочтение.
- W2: допущения proposal (auto mode = «без подтверждения», Confluence только создание, MR без resolve) закрывают SRC-Q1..Q4, Q6, Q8 консервативным толкованием без подтверждения пользователя (гейты отменены).
- W3 (бывший G3, medium): в шапке ADR-007 `Drives` нет NFR-007 и AC-031..AC-034; `by_ttl`-журнал и `journalStored` в ADR-007 не упомянуты. Обоснование зафиксировано в `design.md` («расширение ADR-007 на `by_ttl`», «Элементы дизайна без привязки к FR»); решение не противоречит ADR-007. Оркестратор решил ADR не править.
- W4: `scripts/ac-trace-check.mjs` (`AC_COUNT = 29`) не видит AC-030..AC-034 и не различает номера AC двух change; трассировка этих AC ручная в T23 по префиксу `[send]`. Принято в tasks.md («Известное пересечение AC»).
- W5: отправка на боевых данных блокирована ручным гейтом пользователя: спайки S1 и S3 (T18, T20) и T22; если `allow` от хука под `dontAsk` не подтвердится (S1 п. б), вопрос возвращается пользователю, автооткат запрещён.
- W6: источник не имеет `jira_ref` (текстовый якорь), проверка свежести по Jira неприменима.

---

*Created by Spec Validator (G2), итерация 2. Read-only gate: входные артефакты не изменялись.*
