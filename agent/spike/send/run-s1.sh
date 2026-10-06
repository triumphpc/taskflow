#!/bin/sh
# Спайк S1 (ADR-004): хук gate под launchd, allow открывает инструмент вне --allowedTools, без хука отказ.
# Запускает пользователь из корня worktree:
#   SPIKE_OUT="$HOME/Library/Logs/taskflow-spike-send" sh agent/spike/send/run-s1.sh
# Прогоны (на заглушках MCP, бюджет каждого 3.00 USD по LIMITS_SEND):
#   a  главный агент шлёт сообщение в чат из белого списка: хук сработал, вызов дошёл до заглушки (а, б, г, д)
#   b  то же через субагента: хук срабатывает внутри субагента, во входе agent_id (а, г)
#   c  без gate-хука (только dontAsk): вызов отклонён, заглушка не тронута (в)
#   d  шесть send-инструментов подряд: формы tool_response (д)
#   f  хук спит дольше timeout: вызов отклонён, заглушка не тронута (SEC02)
#   g  хук завершается кодом 1: вызов отклонён, заглушка не тронута (SEC02)
#   k  strict-конфиг из 4 заглушек (ключи как в боевом, сборка через buildClaudeArgs) и allow-правила на плагины и коннекторы
#      (plugin_x_y, реальные установленные плагины пользователя как эмуляция) в settings; stream-json: в init mcp_servers нет
#      plugin:*, в tools нет mcp__plugin_*, mcp__claude_ai_*, mcp__yadisk*, mcp__telegram* (к, SEC13)
#   l  субагент и skill с send-инструментом в tools/allowed-tools при падающем хуке: вызов отклонён (л)
#   m  CLAUDE_CONFIG_DIR (временный, с симлинками на ~/.claude/agents и ~/.claude/skills) с allow-правилом на send-инструмент
#      при падающем хуке: вызов отклонён (м, SEC12)
#   e  MR-комментарий к проекту «group/proj» (id 4242): вид project_id и chat_sn (е)
# Результат: факты и строка `S1-proposed: PASS|FAIL` в заметке; вердикт `S1: PASS|FAIL` вносит пользователь.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/common.sh"

P="$T/prompts"; mkdir -p "$P"
# (м): временный CLAUDE_CONFIG_DIR; в нём только симлинки на агентов и навыки пользователя (ничего не копируется,
# ~/.claude не меняется), чтобы --agent ai-space-assistant находился. rm -rf "$T" в trap снимает сами ссылки, не цели.
CFG_M="$T/cfg-m"; mkdir -p -m 700 "$CFG_M"
for d in agents skills; do if [ -d "$HOME/.claude/$d" ]; then ln -s "$HOME/.claude/$d" "$CFG_M/$d"; fi; done
cat > "$P/a.txt" <<'EOF2'
Это проверка. Вызови инструмент messenger-send-message ровно один раз: chat_sn "spike-chat", text "spike a". Потом верни JSON {"status":"review","text":"готово"}.
EOF2
cat > "$P/b.txt" <<'EOF2'
Это проверка. Передай субагенту ai-space-comms задачу: вызвать messenger-send-message один раз с chat_sn "spike-chat" и text "spike b". После ответа верни JSON {"status":"review","text":"готово"}.
EOF2
cat > "$P/d.txt" <<'EOF2'
Это проверка. По одному разу вызови каждый из шести инструментов: messenger-send-message (chat_sn "spike-chat"), add_merge_request_note, create_discussion (file_path "a.go", new_line 3), reply_to_discussion (discussion_id "d1") для проекта "group/proj" и MR 7, jira_add_comment (issueKey "SPIKE-1"), confluence_page_create (space_key "SPK"). Тексты любые короткие. Верни JSON {"status":"review","text":"готово"}.
EOF2
cat > "$P/e.txt" <<'EOF2'
Это проверка. Оставь комментарий «spike e» в MR 7 проекта group/proj (его числовой id 4242) инструментом add_merge_request_note. Передай project_id так, как считаешь правильным. Верни JSON {"status":"review","text":"готово"}.
EOF2
cat > "$P/k.txt" <<'EOF2'
Это проверка. Ничего не вызывай. Верни JSON {"status":"review","text":"готово"}.
EOF2
cat > "$P/l.txt" <<'EOF2'
Это проверка. Передай субагенту spike-sender задачу отправить сообщение chat_sn "spike-chat", text "spike l"; если субагента нет, вызови skill spike-send. Потом верни JSON {"status":"review","text":"готово"}.
EOF2
{
  spike_run_line a "$P/a.txt" --dump
  spike_run_line b "$P/b.txt" --dump
  spike_run_line c "$P/a.txt" --dump --no-gate
  spike_run_line d "$P/d.txt" --dump
  spike_run_line e "$P/e.txt" --dump
  spike_run_line f "$P/a.txt" --hook-sleep
  spike_run_line g "$P/a.txt" --hook-fail
  spike_run_line k "$P/k.txt" --plugin --format stream-json
  spike_run_line l "$P/l.txt" --hook-fail --sender-agent
  spike_run_line m "$P/a.txt" --hook-fail --config-dir-allow --cfg "$CFG_M"
} > "$T/body.sh"
spike_job "$T/body.sh"
"$NODE" "$HERE/evaluate-send.mjs" s1 "$OUT" --write-note "$NOTE"
