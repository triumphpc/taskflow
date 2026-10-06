# Общее для run-s1.sh, run-s2.sh, run-s3.sh (подключается через `. common.sh`, нужен $HERE).
# Временное окружение: каталог $T, одно временное задание launchd (label taskflow.spike.send.<rand>), заглушки MCP.
# Реальных отправок нет: claude получает ТОЛЬКО заглушки (--strict-mcp-config). Реальные MCP, реальные
# данные TaskFlow, VPS и файл политики пользователя не используется. Всё снимается в trap EXIT.
#   SPIKE_OUT   каталог сырого вывода claude (обязателен, вне репозитория или в .gitignore)
#   SPIKE_ENV_FILE  env-файл с окружением claude-paiw (по умолчанию ~/.config/taskflow-agent/env, права 0600)
#   SPIKE_NOTE  заметка с результатами (по умолчанию openspec/changes/archive/2026-10-06-agent-send-actions/spike-s1-s3.md)
set -eu
umask 077
[ -n "${SPIKE_OUT:-}" ] || { echo "SPIKE_OUT is required (e.g. \$HOME/Library/Logs/taskflow-spike-send)" >&2; exit 78; }
REPO=$(cd "$HERE/../../.." && pwd)
ENVF=${SPIKE_ENV_FILE:-$HOME/.config/taskflow-agent/env}
NOTE=${SPIKE_NOTE:-$REPO/openspec/changes/archive/2026-10-06-agent-send-actions/spike-s1-s3.md}
[ -f "$ENVF" ] && [ "$(stat -f %Lp "$ENVF")" = 600 ] || { echo "env file must exist with mode 600: $ENVF" >&2; exit 78; }
NODE=$(command -v node)
UIDN=$(id -u)
LABEL=taskflow.spike.send.$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
T=$(mktemp -d "${TMPDIR:-/tmp}/taskflow-spike-send.XXXXXX")
OUT=$SPIKE_OUT
mkdir -p -m 700 "$OUT"
chmod 700 "$OUT"
OUT_ABS=$(cd "$OUT" && pwd -P)
REPO_ABS=$(cd "$REPO" && pwd -P)
case "$OUT_ABS/" in
  "$REPO_ABS"/*)
    if ! git -C "$REPO_ABS" check-ignore -q "$OUT_ABS/probe" 2>/dev/null; then
      echo "SPIKE_OUT is inside the repository and not ignored by git: $OUT_ABS" >&2
      exit 78
    fi ;;
esac
cleanup() {
  launchctl bootout "gui/$UIDN/$LABEL" >/dev/null 2>&1 || true
  rm -rf "$T"
}
trap cleanup EXIT INT TERM

# spike_run <name> <prompt-file> <flags...>: одна строка inner-скрипта, запуск claude через launch-claude.mjs
# в своём каталоге $OUT/<name>/ (calls.jsonl, hook-*.jsonl, out, err, code).
spike_run_line() {
  name=$1; prompt=$2; shift 2
  printf 'mkdir -p -m 700 "%s/%s"; STUB_CALLS="%s/%s/calls.jsonl" "%s" "%s/launch-claude.mjs" --work "%s/%s" %s < "%s" > "%s/%s/out" 2> "%s/%s/err"; echo $? > "%s/%s/code"\n' \
    "$OUT" "$name" "$OUT" "$name" "$NODE" "$HERE" "$OUT" "$name" "$*" "$prompt" "$OUT" "$name" "$OUT" "$name" "$OUT" "$name"
}

# spike_job <inner-body-file>: запускает тело под временным launchd и ждёт файл $OUT/done.
spike_job() {
  body=$1
  rm -f "$OUT/done"
  {
    echo '#!/bin/sh'
    echo 'set -u'
    echo 'umask 077'
    echo "set -a; . \"$ENVF\"; set +a"
    echo "export SPIKE_NODE=\"$NODE\""
    echo "export PATH=\"/opt/homebrew/bin:/usr/local/bin:\$HOME/.local/bin:\$PATH\""
    cat "$body"
    echo "touch \"$OUT/done\""
  } > "$T/inner.sh"
  chmod 700 "$T/inner.sh"
  cat > "$T/job.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>$T/inner.sh</string></array>
<key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>StandardOutPath</key><string>$T/job.out</string>
<key>StandardErrorPath</key><string>$T/job.err</string>
</dict></plist>
PLIST
  launchctl bootstrap "gui/$UIDN" "$T/job.plist"
  echo "job $LABEL started"
  i=0; until [ -f "$OUT/done" ]; do i=$((i+1)); [ $i -lt 450 ] || { echo "timeout waiting for the job" >&2; break; }; sleep 2; done
}
