#!/bin/sh
# Запуск демона делегирования из launchd. Окружение (прокси, токены) берётся из env-файла 0600,
# значения не печатаются нигде: только имена переменных.
#   TASKFLOW_AGENT_ENV     путь к env-файлу (по умолчанию ~/.config/taskflow-agent/env)
#   TASKFLOW_AGENT_LAUNCH  fallback: запуск через `zsh -ic claude-paiw` (только если spike U1 провалился)
#   NODE_BIN               node (по умолчанию из PATH; у launchd PATH короткий, см. plist)
# Коды выхода: 78 — ошибка конфигурации; остальные — как у delegation-runner.mjs.
set -eu

ENV_FILE=${TASKFLOW_AGENT_ENV:-$HOME/.config/taskflow-agent/env}
REPO=$(cd "$(dirname "$0")/.." && pwd)

fail() { printf '{"event":"config_error","reason":"%s"}\n' "$1"; exit 78; }

[ -f "$ENV_FILE" ] || fail "env file not found"
MODE=$(stat -f %Lp "$ENV_FILE" 2>/dev/null || stat -c %a "$ENV_FILE" 2>/dev/null || echo unknown)
[ "$MODE" = 600 ] || fail "env file mode must be 600"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

if [ "${TASKFLOW_AGENT_LAUNCH:-}" = fallback ]; then
  REQUIRED="TASKFLOW_MCP_URL TASKFLOW_MCP_TOKEN"
else
  REQUIRED="TASKFLOW_MCP_URL TASKFLOW_MCP_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_CUSTOM_HEADERS AI_LAUNCHER_PAIW_DISABLED_ITEMS CLAUDE_BIN"
fi

MISSING=
for name in $REQUIRED; do
  eval "value=\${$name:-}"
  [ -n "$value" ] || MISSING="$MISSING $name"
done
if [ -n "$MISSING" ]; then
  printf '{"event":"config_error","missing":"%s"}\n' "${MISSING# }"
  exit 78
fi

# Каталог логов закрыт от других пользователей (C15); launchd создаёт файлы лога до запуска скрипта,
# поэтому основной способ создания каталога — README, здесь только страховка.
mkdir -p -m 700 "$HOME/Library/Logs/taskflow-agent" 2>/dev/null && chmod 700 "$HOME/Library/Logs/taskflow-agent" 2>/dev/null || true

exec "${NODE_BIN:-node}" "$REPO/agent/delegation-runner.mjs"
