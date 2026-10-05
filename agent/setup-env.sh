#!/bin/sh
# Разовая сборка env-файла демона из ТЕКУЩЕГО окружения оболочки. Запускает пользователь вручную.
#   ~/.config/taskflow-agent/env (каталог 0700, файл 0600), строки: export NAME='значение'
# На экран выводятся только имена записанных и пропущенных переменных, значения не печатаются.
# Переменные, которых нет в окружении, пропускаются: допишите их в файл вручную (см. agent/README.md).
#   TASKFLOW_AGENT_ENV  путь к файлу (по умолчанию ~/.config/taskflow-agent/env)
set -eu

ENV_FILE=${TASKFLOW_AGENT_ENV:-$HOME/.config/taskflow-agent/env}
DIR=$(dirname "$ENV_FILE")
NAMES="TASKFLOW_MCP_URL TASKFLOW_MCP_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_CUSTOM_HEADERS \
AI_LAUNCHER_PAIW_WORKSPACE AI_LAUNCHER_PAIW_DISABLED_ITEMS HTTP_PROXY HTTPS_PROXY NO_PROXY no_proxy \
CLAUDE_BIN TASKFLOW_AGENT_CWD"

umask 077
mkdir -p "$DIR"
chmod 700 "$DIR"
TMP=$(mktemp "$DIR/.env.XXXXXX")
trap 'rm -f "$TMP"' EXIT

WRITTEN=
SKIPPED=
for name in $NAMES; do
  value=$(printenv "$name" 2>/dev/null || true)
  if [ -z "$value" ] && [ "$name" = CLAUDE_BIN ]; then value=$(command -v claude 2>/dev/null || true); fi
  if [ -z "$value" ]; then SKIPPED="$SKIPPED $name"; continue; fi
  escaped=$(printf '%s' "$value" | sed "s/'/'\\\\''/g")
  printf "export %s='%s'\n" "$name" "$escaped" >> "$TMP"
  WRITTEN="$WRITTEN $name"
done

chmod 600 "$TMP"
mv "$TMP" "$ENV_FILE"
trap - EXIT
echo "env file: $ENV_FILE (mode 600)"
echo "written:${WRITTEN:- none}"
echo "skipped (not set in this shell):${SKIPPED:- none}"
