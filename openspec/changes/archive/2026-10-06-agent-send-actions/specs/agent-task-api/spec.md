## MODIFIED Requirements

### Requirement: Служебные инструменты демона делегирования

Сервер SHALL предоставлять три дополнительных инструмента для демона делегирования:
`agent_queue`, `agent_claim`, `agent_finish`. Они SHALL работать через `/mcp` с тем же
Bearer-токеном, что и остальные инструменты. Описание каждого SHALL сообщать, что это служебный
инструмент демона и из диалога его вызывать не нужно. Новые инструменты SHALL добавляться
в конец списка, порядок прежних не меняется. Этот change не добавляет инструментов: число
и имена инструментов остаются прежними, меняются только необязательные поля ниже.

`task_id` в них MUST быть полным идентификатором задачи, фрагменты MUST NOT угадываться.

`agent_queue` SHALL принимать необязательные `today` (`YYYY-MM-DD`, по умолчанию дата
сервера) и `task_id`; результат: очередь, зависшие `in_progress` и, при указанном `task_id`,
состояние задачи (`exists`, `done`, `status`, `claimToken`), для несуществующей задачи
`exists: false`.

`agent_claim` (`task_id`, `today`) SHALL переводить `delegated → in_progress` и возвращать
`claimToken`. Рядом с `task` (не внутри него) ответ SHALL содержать ключ `journals`: блоки
журналов прежних попыток этой задачи с тем же сроком, от старых к новым, не больше трёх;
пустой массив, если их нет. Состав `task` MUST NOT меняться.

`agent_finish` (`task_id`, `claim_token`, `status`, `text`) SHALL переводить `in_progress`
в `review`, `needs_info` или `failed` и дописывать заметку; с `by_ttl: true` он SHALL
переводить зависший `in_progress` в `failed` без токена, только по истечении TTL.
`agent_finish` SHALL принимать необязательный аргумент `journal` (журнал действий прогона),
в том числе вместе с `by_ttl: true`. Сервер SHALL записывать `journal` в `agentNotes` первым
блоком результата, до текста, и применять к нему те же правила нормализации и слияния, что
к прочему тексту `agentNotes`. Если сервер принял непустой журнал, ответ SHALL содержать
`journalStored: true`; ответ на вызов без `journal` MUST NOT меняться. Непонятные записи журнала
отбрасываются и отказа не вызывают.

Все изменения контракта аддитивны: вызовы без `journal` работают как раньше, существующие ответы
без журнала не меняются, схема данных, набор статусов и допустимые переходы MUST NOT меняться.

Отказ SHALL возвращаться ошибкой инструмента с текстом `AGENT_REJECTED:<reason>`, где
`reason` из закрытого списка: `bad_request`, `not_found`, `closed`, `not_delegated`,
`not_due`, `not_in_progress`, `token_mismatch`, `bad_status`, `not_expired`.

#### Scenario: Очередь через MCP

- **WHEN** демон вызывает `agent_queue` с `today`
- **THEN** возвращаются делегированные задачи в статусе `delegated` со сроком сегодня или раньше
- **AND** задачи, зависшие в `in_progress` дольше TTL, перечислены отдельно

#### Scenario: Состояние удалённой задачи

- **WHEN** демон вызывает `agent_queue` с `task_id` удалённой задачи
- **THEN** в ответе `exists: false`

#### Scenario: Захват и завершение

- **WHEN** демон вызывает `agent_claim`, затем `agent_finish` с полученным токеном и статусом `review`
- **THEN** задача сначала `in_progress`, затем `review`
- **AND** текст добавлен в `agentNotes`

#### Scenario: Чужой токен

- **WHEN** `agent_finish` вызван с токеном, который не совпадает с токеном захвата
- **THEN** ответ — ошибка `AGENT_REJECTED:token_mismatch`
- **AND** задача не изменена

#### Scenario: Повторный захват

- **WHEN** `agent_claim` вызывается для задачи, уже взятой другим прогоном
- **THEN** ответ — ошибка `AGENT_REJECTED:not_delegated`

#### Scenario: Захват возвращает журналы прежних попыток

- **WHEN** демон вызывает `agent_claim` для задачи, у которой в `agentNotes` есть журналы с тем же сроком
- **THEN** ответ содержит `journals` рядом с `task`, не больше трёх блоков
- **AND** `task` по-прежнему состоит из `id`, `title`, `notes`, `due`

#### Scenario: Захват без журналов

- **WHEN** демон вызывает `agent_claim` для задачи без журналов
- **THEN** `journals` пустой массив

#### Scenario: Завершение с журналом

- **WHEN** демон вызывает `agent_finish` со статусом `review`, текстом и `journal`
- **THEN** в `agentNotes` журнал стоит первым блоком, за ним текст результата
- **AND** ответ содержит `journalStored: true`
- **AND** новых полей у задачи нет, `SCHEMA` равен `1`

#### Scenario: Завершение без журнала

- **WHEN** демон вызывает `agent_finish` без `journal`
- **THEN** поведение и ответ совпадают с прежними, `journalStored` в ответе нет
- **AND** контракт остальных инструментов MCP не затронут

#### Scenario: Журнал при переводе по TTL

- **WHEN** демон вызывает `agent_finish` с `by_ttl: true` и `journal` для зависшего `in_progress`
- **THEN** задача в `failed`, причина «TTL истёк»
- **AND** журнал записан в `agentNotes` под причиной, `journalStored: true`

#### Scenario: Перевод по TTL без журнала

- **WHEN** демон вызывает `agent_finish` с `by_ttl: true` без `journal`
- **THEN** поведение совпадает с прежним
