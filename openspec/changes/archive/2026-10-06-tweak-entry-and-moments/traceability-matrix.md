# Traceability Matrix: tweak-entry-and-moments

**Gate**: G2 (Spec Validator), итерация 1
**Verdict**: APPROVED (SPEC_VALIDATED), 0 critical / 0 high, 2 warning
**Якорь**: `requirements-source.md` (SRC-1..SRC-13, `SRC-AC-n` в источнике нет)
**ADR**: нет (`skip_architect`); решения зафиксированы в `hld.md` и `design.md`

## Сквозная таблица

| SRC | Требование (кратко) | FR/NFR | ADR | Дизайн | Задачи | AC | Статус |
|---|---|---|---|---|---|---|---|
| SRC-1 | Форма закрывается после создания | FR-001, FR-002 | — | M3 `submit` (`ui.close()`, тост) | T04 | AC-001..AC-004 | OK |
| SRC-2 | Шаг «во сколько» только при «Сегодня» | FR-003 | — | M1 `needsTimeStep`, M2 `render` | T02, T03 | AC-005, AC-006 | OK |
| SRC-3 | Другой день: сразу задача без времени | FR-004, FR-006 | — | M1 `timeAfterDayPick`, M2 `setDate` | T02, T03 | AC-006..AC-013 | OK |
| SRC-4 | Анимация при запуске Moments | FR-007, FR-011, FR-013 | — | M4, M5, M6 | T05, T07, T08 | AC-014, AC-018, AC-020 | OK |
| SRC-5 | Бильярдная пирамида | FR-007, FR-008 | — | M4 `rackRows`/`slotCenters`/`buildIntro`, M5 | T05, T07, T08 | AC-014, AC-015 | OK |
| SRC-6 | Цвет по приоритету, номера на шарах | FR-008, FR-012, NFR-005 | — | M4 `ballColorVar`, M7 токен `--ball-none` | T05, T06 | AC-015, AC-019 | OK |
| SRC-7 | ~1,5 с | NFR-001 | — | M4 `INTRO_TOTAL_MS=1500`, M5 `setTimeout(total)` | T05 | AC-021 | OK |
| SRC-8 | Тап пропускает | FR-009 | — | M5 `click` + `keydown` capture | T07 | AC-016 | OK |
| SRC-9 | reduced motion: пропуск | FR-010 | — | M5 `introAllowed`, M6 ветка | T07, T08 | AC-017 | OK |
| SRC-10 | Правило п. 2 для формы, карточки, календаря | FR-005, FR-006 | — | M2 `setDate` общий для 4 хостов | T02, T03 | AC-008..AC-012 | OK |
| SRC-11 | Отмена требования task-entry, изменение task-scheduling, `js/moments.js` | FR-001, FR-005 | — | M3, M2, M6; delta-спеки (RENAMED + MODIFIED) | T03, T04, T08 | AC-001, AC-011 | OK |
| SRC-12 | Обратная совместимость и сохранность задач | NFR-002 | — | C10 (модули данных не меняются) | T10, T12 | AC-022 | OK |
| SRC-13 | Vanilla JS, `sw.js` версия кэша, `node:test` | NFR-003, NFR-004 | — | M8, M1/M4 чистые | T01, T09, T11, T12 | AC-023 | OK |

## Выведенные пункты ([derived], без прямого SRC)

| ID | Привязка | Обоснование в proposal | Дизайн | Задачи | AC |
|---|---|---|---|---|---|
| FR-012 | SRC-6 | вход без приоритета (`js/moments.js`) | M4, M7 | T05, T06 | AC-019 |
| FR-013 | SRC-4 | R4 в research.md | M5, M6 | T07, T08 | AC-020 |
| NFR-005 | SRC-6 | R8 в research.md | M4, M7 | T05, T06 | AC-019 |

## Задачи без привязки к FR/NFR (с обоснованием)

| Задача | Обоснование | Оценка гейта |
|---|---|---|
| T01 | Prefactoring: `ac-trace-check.mjs` держит AC прошлого change (C8 дизайна) | OK, обоснование есть |
| T10 | Регрессионный щит под NFR-002 (Covers: NFR-002) | OK |
| T12 | Итоговый гейт (Covers: NFR-002/003/004) | OK |

## Счётчики

| Звено | total | covered | % |
|---|---|---|---|
| SRC → FR/NFR | 13 | 13 | 100 |
| FR/NFR → design | 18 | 18 | 100 |
| FR/NFR → tasks | 18 | 18 | 100 |
| SRC → task (end-to-end) | 13 | 13 | 100 |
| AC (proposal) → задача/проверка | 23 | 22 прямо, 1 неявно (AC-002) | см. warning W1 |

`claimed_coverage` сверен: 13 SRC, 13 FR + 5 NFR, 23 AC, M1..M8, T01..T12, 20 SP: расхождений нет.

## Warnings

- **W1 (medium)**: AC-002 («Enter на неготовой форме не создаёт задачу и не закрывает окно») назначен T04 в таблице Requirements Coverage и в acceptance-критериях, но не назван ни в списке тестов Verification T04 (`AC-001 AC-003 AC-004`), ни в пунктах чек-листа T11 (`AC-001, AC-003, AC-005..AC-010, AC-014..AC-023`). Проверка `ac-trace-check` в T12 не найдёт следа AC-002 и упадёт. Рекомендация для Planner (05): добавить `AC-002` в имена тестов T04 или в пункты чек-листа T11.
- **W2 (low)**: пометки `[дефолт Q1..Q5]` в proposal (FR-002, FR-003, FR-006, FR-008 и т.д.) ссылаются на нумерацию вопросов `research.md`, а раздел Open Questions самого proposal нумерует вопросы иначе (его Q1 про отсутствующий пункт 3, в research это SRC-Q1). Путаница в чтении, на трассировку не влияет.

## Проверки, не давшие дефектов

- Все FR/NFR ссылаются на SRC или помечены `[derived]`.
- Заявленных out-of-scope SRC нет; Non-goals (пункт 3 исходного сообщения, SRC-Q1) присутствуют в proposal.
- Семантика FR против дословных SRC: расхождений по смыслу нет. Расширения (любая клавиша и Esc в FR-009, допуск ±0,3 с в NFR-001) помечены как уточнения и не ослабляют источник.
- Delta-спеки (`task-entry`: RENAMED + MODIFIED, `task-scheduling`: MODIFIED + ADDED, `moments-intro`: ADDED) согласованы с FR/AC; RENAMED FROM существует в `openspec/specs/task-entry/spec.md`; требования «Разбор входящего» и «Добавление доступно после ответа на оба шага» новому правилу не противоречат.
- Источник: `jira_ref: null`, проверка свежести не применима.
