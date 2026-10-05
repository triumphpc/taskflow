# Traceability Matrix: add-agent-delegation

**Gate**: G2 (Spec Validator), iteration 2
**Verdict**: APPROVED (0 critical, 0 high, 0 medium-gap; 3 warnings)
**Источник истины**: `requirements-source.md` (SRC-1..SRC-35)

Цепочка: SRC → FR/NFR (proposal.md) → ADR → дизайн (hld.md, design.md) → задачи (tasks.md) → AC.
Статусы: OK, PARTIAL (обоснованно), SUPERSEDED.

## Итоги трассировки

| Звено | Итог |
|---|---|
| source → FR | 35 из 35 (32 covered, SRC-7/SRC-8 partial с обоснованием, SRC-17 out-of-scope в Non-goals), 100% |
| FR/NFR → design | 23 из 23 (14 FR, 9 NFR), 100% |
| FR/NFR → tasks | 23 из 23, 100% |
| AC → tasks | 29 из 29 |
| end-to-end | 35 из 35 SRC доходят до задачи или обоснованно исключены |

## Закрытие замечаний итерации 1

| ID | Статус | Evidence |
|---|---|---|
| G1 (SRC-31 vs ADR-003) | закрыт | Новый SRC-35 в requirements-source.md (выбор D3 с условием fallback); proposal.md FR-006, AC-009, Clarification 12 и Source Coverage (строки SRC-31, SRC-35) приведены к ADR-003; tasks T01, T12, T16 несут SRC-35 и AC-009, fallback `zsh -ic claude-paiw` покрыт |
| G2 (MCP-сброс agent) | закрыт | design.md M7 (строки 241, 259) и M1 `reconcileAgent` (стр. 72); M3 вызывает его (стр. 154); T05 строит, T09 и T10 используют, ребро T05 -> T10 в `Blocked by`; тест `test/mcp-agent-tools.test.mjs` в T10 |
| G3 (счётчик модулей) | закрыт | design.md стр. 627: «Модулей 14: M1..M13 и M14 (тесты)», M14 присутствует (стр. 421) |

## Сквозная таблица

| SRC | Требование (кратко) | FR/NFR | ADR | Дизайн | Задачи | AC | Статус |
|---|---|---|---|---|---|---|---|
| SRC-1 | Отдельный чекбокс в списке | FR-001 | — | M4 `delegateToggle`, M3 `setDelegation`, M1 `isDelegable` | T04, T09, T15 | AC-001 | OK |
| SRC-2 | Особый цвет, висит в списке | FR-002 | — | M4 `agentBadge`, `--ag-*`, M1 `AGENT_TONE` | T04, T15 | AC-003 | OK |
| SRC-3 | Подхватывает `claude-paiw --agent ai-space-assistant` | FR-006, FR-013 | ADR-003 | M9 `buildClaudeArgs`, M7 | T01, T10, T12, T16 | AC-009, AC-018 | OK (G1 закрыт) |
| SRC-4 | Автоматический режим | FR-005, NFR-002 | ADR-002, ADR-003 | M10 `runOnce`, M11 plist | T12, T13, T14, T16 | AC-008, AC-021 | OK |
| SRC-5 | Результат в задачу, статус | FR-008 | ADR-002 | M1 `finish`, `composeNote` | T05, T14 | AC-011 | OK |
| SRC-6 | «Выполнена агентом» как статус, закрывает человек | FR-003, FR-010 | — | M1 таблица переходов | T04, T05, T09, T15 | AC-005, AC-015 | OK |
| SRC-7 | Поздравление, «отправляет» в чат | FR-008 | — | M9 `ALLOWED/DISALLOWED`, `finish` | T12, T14 | AC-012 | PARTIAL (обоснованно: SRC-12, SRC-24) |
| SRC-8 | Ревью MR, «добавляет комменты» | FR-008 | — | то же | T12, T14 | AC-012 | PARTIAL (обоснованно: SRC-12, SRC-24) |
| SRC-9 | launchd-демон на Mac | FR-005 | ADR-003 | M11 plist, `run-delegation.sh` | T16 | AC-008 | OK |
| SRC-10 | Каждые 30 минут | FR-005 | ADR-003 | M11 `StartInterval 1800` | T14, T16 | AC-008 | OK |
| SRC-11 | Один агент, без роутера | FR-006 | ADR-003 | M9 argv | T12 | AC-009 | OK |
| SRC-12 | Черновик, ждёт «ок» | FR-008, NFR-001 | ADR-003 | M9 policy, `finish` | T12, T14 | AC-012, AC-020 | OK |
| SRC-13 | Не трогать прод | NFR-001 | ADR-003 | M9 deny (`mcp-kubernetes` и др.) | T12, T13, T16 | AC-020 | OK |
| SRC-14 | Непонятно: «нужно уточнение» + вопрос | FR-009, FR-003 | ADR-002 | M9 `parseClaudeOutput`, `composeNote` | T05, T12, T14 | AC-013 | OK |
| SRC-15 | Набор статусов | FR-003, FR-009, FR-013 | ADR-002 | M1 переходы, M7 | T05, T08, T10, T12, T14 | AC-006, AC-014 | OK |
| SRC-16 | Доработка сам, без цикла | FR-010 | — | C16, отсутствие цикла | T09, T15 | AC-015 | OK |
| SRC-17 | Нельзя прерывать (заменён SRC-29) | — | — | — | — | — | SUPERSEDED, в Non-goals (proposal.md:160) |
| SRC-18 | Повтор сохраняет делегирование | FR-012 | — | M3 `resetBlock` | T04, T09 | AC-017 | OK |
| SRC-19 | Результат в `agentNotes` | FR-008 | ADR-001 | M1 `mergeAgentNotes`, `agentFeed` | T05, T14 | AC-011 | OK |
| SRC-20 | Заголовок и описание как ТЗ | FR-007 | — | M9 `buildPrompt` | T12 | AC-010 | OK |
| SRC-21 | Только «Сегодня» | FR-001, FR-004 | — | M1 `isDelegable`, `buildQueue` | T04, T05, T09, T15 | AC-002 | OK |
| SRC-22 | Чекбокс в списке | FR-001, FR-002 | — | M4 | T15 | AC-001, AC-004 | OK |
| SRC-23 | Нет фильтра и уведомления | FR-010 | — | C16 | T09, T15 | AC-015 | OK |
| SRC-24 | Агент ничего не отправляет | FR-008, NFR-001 | ADR-003 | M9 policy | T12, T14 | AC-012 | OK |
| SRC-25 | Просроченные берём | FR-001, FR-004 | — | M1 `buildQueue` | T05, T14 | AC-002, AC-007 | OK |
| SRC-26 | Время задачи игнорируется | FR-004 | — | M1 `buildQueue`, C8 | T05, T14 | AC-007 | OK |
| SRC-27 | Невзятые остаются в очереди | FR-004 | — | M1 `buildQueue` | T05, T14 | AC-007 | OK |
| SRC-28 | Закрыть «в работе» можно | FR-011 | ADR-002 | M3 `toggleDone`, M10 | T09, T14 | AC-016 | OK |
| SRC-29 | Прерывание при закрытии/снятии | FR-011, NFR-003 | ADR-002 | M10 `shouldAbort`, M1 `finish` | T05, T08, T13, T14 | AC-016, AC-022 | OK |
| SRC-30 | Разные цвета по статусам | FR-002 | — | M1 `AGENT_TONE`, M4 | T04, T15 | AC-003 | OK |
| SRC-31 | Обязательно `claude-paiw` | FR-006 | ADR-003 | M9 argv (`claude`), M11 env-файл | T01, T12, T16 | AC-009 | OK (G1 закрыт) |
| SRC-32 | Mac выключен: просто ждут | FR-014 | ADR-002 | M10, таблица «Ошибки» | T14, T16 | AC-019 | OK |
| SRC-33 | Обратная совместимость | NFR-004, NFR-006, NFR-007, NFR-009 | ADR-001 | M2, M5, M6, M7, M13 | T02, T03, T06, T07, T08, T10, T15, T18 | AC-023..AC-027, AC-029 | OK (см. G3) |
| SRC-34 | Не потерять ни одной задачи | NFR-004, NFR-005, NFR-006, NFR-008 | ADR-001 | M1 `mergeTaskRecord`, M5 `#merge`, M12 | T04, T06, T07, T17, T18 | AC-023, AC-025, AC-026, AC-028 | OK (см. W2) |
| SRC-35 | D3: обёртка и env-файл 0600, `claude` с окружением `claude-paiw` = выполнение SRC-31; fallback `zsh -ic claude-paiw` при провале U1 | FR-006 | ADR-003 | M9 `buildClaudeArgs`, M11 env-файл | T01, T12, T16 | AC-009 | OK |

## Детальная трасса SRC-33 и SRC-34

SRC-33 (обратная совместимость), цепочка до задач и тестов:

| Аспект | FR/NFR | Дизайн | Задача | Тест |
|---|---|---|---|---|
| Данные читаются без миграции, `SCHEMA = 1` | NFR-004 | M2 `normalizeAgent`, ключ `agent` только при наличии | T06 | `test/store-parity.test.mjs` (AC-023, AC-024) |
| Девять MCP-инструментов не меняются | NFR-007 | M7: новые инструменты в конец `TOOLS`, только добавления в выводе | T02, T03, T10 | golden-файлы, `test/mcp-contract.test.mjs` (AC-027) |
| Старый PWA с новым сервером | NFR-006 | M5 серверная защита (ADR-001), M13 кэш | T07, T15, T18 | `test/client-compat.test.mjs` (AC-026) |
| Новый клиент со старыми данными | NFR-006 | M2, M3 | T18 | `test/client-compat.test.mjs` |
| `serve.mjs` без `npm install` | NFR-009 | M5, M6 импортируют только `js/agent.js` и `node:*` | T07, T08 | `test/serve-http.test.mjs` в каталоге без `node_modules` (AC-029) |

SRC-34 (не потерять ни одной задачи), цепочка до задач и тестов:

| Аспект | FR/NFR | Дизайн | Задача | Тест |
|---|---|---|---|---|
| Слияние не удаляет задачу и не затирает `agent`/`agentNotes` | NFR-005 | M1 `mergeAgent`, `mergeAgentNotes`, `mergeTaskRecord`; M5 `#merge`; ADR-001 | T04, T07 | `test/sync-merge.test.mjs` (AC-025) |
| Офлайн-правка старым клиентом | NFR-005, NFR-006 | M5 | T18 | `test/client-compat.test.mjs` (AC-026) |
| Реальный снимок читается без потерь | NFR-004 | M12 `check-snapshot` | T17 | синтетика в `test/deploy-check.test.mjs`; реальный снимок вручную на выкладке (AC-023) |
| Бэкап и сверка числа до и после | NFR-008 | M12 `backup`, `counts`, `compare` | T17 | `test/deploy-check.test.mjs` (AC-028) |
| Откат без потери задач | NFR-008 | M12 (свежий `backup` перед откатом) | T17 (README) | ручной шаг |

Обрывов цепочки у SRC-33 и SRC-34 нет. Две оговорки вынесены в warnings (W2, G3).

## Gaps

Критических, высоких и средних разрывов нет.

## Warnings (не блокируют)

- W1: design.md стр. 636 («Отклонения»): устаревшая формулировка «AC-009 требует запуск командой `claude-paiw`» (AC-009 в proposal.md уже обновлён по SRC-35) и «change останавливается» при провале U1 без оговорки, что сначала берётся fallback `zsh -ic claude-paiw`, а стоп только если не работает и он (так в ADR-003 и proposal.md). Строка трассировки FR-006 (стр. 608) и заголовок «Source» ADR-003 не упоминают SRC-35. Смысловых противоречий в требованиях нет, рекомендация: 04 поправить текст.
- W2: AC-023 для реального `data/taskflow.json` и AC-028 для выкладки на VPS выполняются вручную при выкладке (T17, T19 чек-лист). Остановку при расхождении обеспечивает код возврата `compare` и README.
- W3: пункты proposal.md «[дефолт RA — подтвердить на Gate 2]» и `[derived]` FR-013, NFR-002, NFR-009 остаются на подтверждение человека; определение «прод» (SRC-Q5) остаётся дефолтом RA. SRC-7/SRC-8 `partial` фактически заменены ответами SRC-12 и SRC-24 (статус `superseded` был бы точнее).
- W4: Источник без Jira (`jira_ref: null`), свежесть не проверялась.

## Проверка claimed_coverage

RA: 35 SRC, 32 covered + 2 partial + 1 out-of-scope: совпадает (подсчёт строк в Source Coverage Matrix). Designer: 23/23, модулей 14: совпадает. Planner: 23/23, 29/29 AC, 19 задач (T01..T19), SRC-35 в T01/T12/T16, reconcileAgent в T05/T09/T10, ребро T05 -> T10: совпадает.
