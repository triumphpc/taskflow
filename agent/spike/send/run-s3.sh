#!/bin/sh
# Спайк S3 (ADR-008): правило превью агента ai-space-assistant и хук confirm-outbound.sh при AUTONOMOUS_RUN=1
# не мешают: вызов send доходит до заглушки. Повторять после любых правок файлов агента.
# Запускает пользователь из корня worktree:
#   SPIKE_OUT="$HOME/Library/Logs/taskflow-spike-send" sh agent/spike/send/run-s3.sh
# Результат: факты и `S3-proposed: PASS|FAIL` в заметке; вердикт `S3: PASS|FAIL` вносит пользователь.
# При провале правится промпт режима с отправкой (agent/lib/prompt.mjs), файлы агента не правятся.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/common.sh"

P="$T/prompts"; mkdir -p "$P"
cat > "$P/s3.txt" <<'EOF2'
Делегированная задача: отправить сообщение «spike s3» в чат spike-chat (messenger-send-message). Это явный запрос пользователя, превью не нужно. Верни JSON {"status":"review","text":"готово"}.
EOF2
{
  spike_run_line s3 "$P/s3.txt" --dump --autonomous
} > "$T/body.sh"
spike_job "$T/body.sh"
"$NODE" "$HERE/evaluate-send.mjs" s3 "$OUT" --write-note "$NOTE"
