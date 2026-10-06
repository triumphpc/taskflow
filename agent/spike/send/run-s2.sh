#!/bin/sh
# Спайк S2 (ADR-006, ADR-009): форма Agent(<имя>), лимиты 50 ходов и 3.00 USD, частота pending у MCP.
# Запускает пользователь из корня worktree:
#   SPIKE_OUT="$HOME/Library/Logs/taskflow-spike-send" sh agent/spike/send/run-s2.sh
# Прогоны на заглушках MCP (реальных отправок нет): narrow (allow Agent(<имя>)), t1..t3 (три типовые задачи).
# Результат: факты и `S2-proposed: PASS|FAIL` в заметке; вердикт `S2: PASS|FAIL` вносит пользователь.
# S2 не блокирует включение: он определяет NARROW_AGENT и итоговые LIMITS_SEND.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/common.sh"

P="$T/prompts"; mkdir -p "$P"
cat > "$P/narrow.txt" <<'EOF2'
Это проверка. Сначала передай субагенту ai-space-comms задачу ответить словом «ок». Затем попробуй передать такую же задачу субагенту general-purpose. Верни JSON {"status":"review","text":"что получилось с каждым"}.
EOF2
cat > "$P/t1.txt" <<'EOF2'
Поздравь Олега с днём рождения в чате «spike-chat»: два предложения, отправь. Верни JSON {"status":"review","text":"готово"}.
EOF2
cat > "$P/t2.txt" <<'EOF2'
Отревьюй MR 7 проекта group/proj (инструменты чтения могут быть недоступны, это заглушки): оставь два inline-комментария create_discussion к файлам a.go:3 и b.go:9 и общую заметку add_merge_request_note. Верни JSON {"status":"review","text":"готово"}.
EOF2
cat > "$P/t3.txt" <<'EOF2'
Создай в пространстве SPK страницу «Отчёт spike» с коротким текстом: переведи markdown конвертером confluence_content_from_markdown, затем confluence_page_create. Верни JSON {"status":"review","text":"готово"}.
EOF2
{
  spike_run_line narrow "$P/narrow.txt" --dump --narrow-agent --format stream-json
  spike_run_line t1 "$P/t1.txt" --format stream-json
  spike_run_line t2 "$P/t2.txt" --format stream-json
  spike_run_line t3 "$P/t3.txt" --format stream-json
} > "$T/body.sh"
spike_job "$T/body.sh"
"$NODE" "$HERE/evaluate-send.mjs" s2 "$OUT" --write-note "$NOTE"
