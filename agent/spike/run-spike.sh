#!/bin/sh
# Spike U1+U5 (T01). Run by the user (NOT by the agent), from the worktree root:
#
#   cd /Users/s.vrulin/Devel/taskflow-worktrees/add-agent-delegation && \
#     SPIKE_MODE=env SPIKE_OUT="$HOME/Library/Logs/taskflow-spike" sh agent/spike/run-spike.sh
#   # fallback check (only if env mode fails):
#   SPIKE_MODE=fallback SPIKE_OUT="$HOME/Library/Logs/taskflow-spike-fb" sh agent/spike/run-spike.sh
#
# SPIKE_OUT holds raw claude output: keep it OUTSIDE the repository. The script refuses a SPIKE_OUT
# that is inside the repository and not ignored by git.
#
# SPIKE_MODE=env      the job sources ~/.config/taskflow-agent/env (override: SPIKE_ENV_FILE, mode 0600
#                     required) and runs `$CLAUDE_BIN --agent ai-space-assistant ...` (ADR-003).
# SPIKE_MODE=fallback the job runs `zsh -ic claude-paiw ...` (credentials from the user's own shell).
#
# Temporary only: serve.mjs/mcp.mjs on free ports with a synthetic task and a throwaway data dir,
# one temporary launchd job (label taskflow.spike.<rand>), everything removed in a trap.
# Real data/taskflow.json, the VPS and a permanent plist are never touched. TASKFLOW_MCP_URL and
# TASKFLOW_MCP_TOKEN from the env file are overridden with the temporary local ones.
# Values of variables are never printed or copied: the summary (summary.json) has names, counts
# and statuses only. Claude runs only on the synthetic task, budget 1.00 USD per run.
#
# Afterwards the verdicts (U1/U5/SRC-35) go to openspec/changes/archive/2026-10-05-add-agent-delegation/spike-u1-u5.md
# and `node --test test/spike-report.test.mjs` checks them.
set -eu
umask 077
# SPIKE_OUT is mandatory (SEC04): raw claude output must go to a directory the user chose, never to a default.
[ -n "${SPIKE_OUT:-}" ] || { echo "SPIKE_OUT is required (e.g. \$HOME/Library/Logs/taskflow-spike)" >&2; exit 78; }
MODE=${SPIKE_MODE:-env}
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
ENVF=${SPIKE_ENV_FILE:-$HOME/.config/taskflow-agent/env}
if [ "$MODE" = env ]; then
  [ "$(stat -f %Lp "$ENVF")" = 600 ] || { echo "env file must have mode 600" >&2; exit 78; }
fi
UIDN=$(id -u)
LABEL=taskflow.spike.$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
T=$(mktemp -d "${TMPDIR:-/tmp}/taskflow-spike.XXXXXX")
OUT=$SPIKE_OUT
mkdir -p -m 700 "$OUT" "$T/data" "$T/work"
chmod 700 "$OUT" "$T/work"
OUT_ABS=$(cd "$OUT" && pwd -P)
REPO_ABS=$(cd "$REPO" && pwd -P)
case "$OUT_ABS/" in
  "$REPO_ABS"/*)
    if ! git -C "$REPO_ABS" check-ignore -q "$OUT_ABS/probe" 2>/dev/null; then
      echo "SPIKE_OUT is inside the repository and not ignored by git: $OUT_ABS" >&2
      echo "use e.g. SPIKE_OUT=\$HOME/Library/Logs/taskflow-spike" >&2
      exit 78
    fi ;;
esac
SERVE_PID=; MCP_PID=
cleanup() {
  launchctl bootout "gui/$UIDN/$LABEL" >/dev/null 2>&1 || true
  [ -z "$SERVE_PID" ] || kill "$SERVE_PID" >/dev/null 2>&1 || true
  [ -z "$MCP_PID" ] || kill "$MCP_PID" >/dev/null 2>&1 || true
  rm -rf "$T"
}
trap cleanup EXIT INT TERM

free_port() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
SP=$(free_port); MP=$(free_port)
ST=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n'); MT=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
env -i PATH="$PATH" HOME="$T" TASKFLOW_DATA="$T/data" TASKFLOW_TOKEN="$ST" PORT="$SP" node "$REPO/serve.mjs" >"$T/serve.log" 2>&1 & SERVE_PID=$!
env -i PATH="$PATH" HOME="$T" TASKFLOW_DATA="$T/data" TASKFLOW_TOKEN="$ST" TASKFLOW_MCP_TOKEN="$MT" \
  TASKFLOW_API="http://127.0.0.1:$SP" PORT="$MP" node "$REPO/mcp.mjs" >"$T/mcp.log" 2>&1 & MCP_PID=$!
i=0; until curl -fsS "http://127.0.0.1:$SP/api/ping" >/dev/null 2>&1 && curl -s -o /dev/null "http://127.0.0.1:$MP/mcp"; do
  i=$((i+1)); [ $i -lt 50 ] || { echo "servers did not start" >&2; exit 1; }; sleep 0.2; done
node "$HERE/prep.mjs" "http://127.0.0.1:$SP" "$ST" "http://127.0.0.1:$MP/mcp" "$MT" "$OUT"
. "$HERE/allowlists.sh"
printf '%s' "$ALLOWED" > "$OUT/allowed.txt"; printf '%s' "$DENIED" > "$OUT/denied.txt"

cat > "$T/inner.sh" <<INNER
#!/bin/sh
set -u
umask 077
export ALLOWED='$ALLOWED' DENIED='$DENIED'
export SYSP='Ты работаешь без человека и только читаешь. Не отправляй, не публикуй, не планируй. Верни ровно один JSON-объект {"status","text"}.'
export TASKFLOW_MCP_URL="http://127.0.0.1:$MP/mcp" TASKFLOW_MCP_TOKEN="$MT"
run() {
  name=\$1; fmt=\$2; turns=\$3; prompt=\$4; budget=\$5; v=
  [ "\$fmt" = stream-json ] && v=--verbose
  if [ "$MODE" = env ]; then
    "\$CLAUDE_BIN" --agent ai-space-assistant -p --output-format "\$fmt" \$v --max-turns "\$turns" --max-budget-usd "\$budget" \\
      --permission-mode dontAsk --allowedTools "\$ALLOWED" --disallowedTools "\$DENIED" --append-system-prompt "\$SYSP" < "\$prompt" > "$OUT/\$name.out" 2> "$OUT/\$name.err"
  else
    FMT="\$fmt" TURNS="\$turns" BUDGET="\$budget" V="\$v" /bin/zsh -ic 'claude-paiw --agent ai-space-assistant -p --output-format "\$FMT" \$V --max-turns "\$TURNS" --max-budget-usd "\$BUDGET" --permission-mode dontAsk --allowedTools "\$ALLOWED" --disallowedTools "\$DENIED" --append-system-prompt "\$SYSP"' < "\$prompt" > "$OUT/\$name.out" 2> "$OUT/\$name.err"
  fi
  echo \$? > "$OUT/\$name.code"
}
if [ "$MODE" = env ]; then
  set -a; . "$ENVF"; set +a
  export TASKFLOW_MCP_URL="http://127.0.0.1:$MP/mcp" TASKFLOW_MCP_TOKEN="$MT"
  echo "\$PATH" > "$OUT/job-path.txt"
  [ -x "\$CLAUDE_BIN" ] && echo yes > "$OUT/claude-bin-ok.txt"
fi
cd "$T/work"        # empty 0700 sandbox, like the daemon (SEC01)
run r1 json 8 "$OUT/prompt-task.txt" 1.00
run r2 stream-json 1 "$OUT/prompt-ok.txt" 1.00
run r4 stream-json 6 "$OUT/prompt-u5.txt" 1.00     # U5: Read outside the sandbox must be rejected, also via Agent
if [ "$MODE" = env ]; then
  export PATH="/opt/homebrew/bin:/usr/local/bin:\$HOME/.local/bin:\$PATH"
  run r3 stream-json 1 "$OUT/prompt-ok.txt" 1.00
fi
touch "$OUT/done"
INNER
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
echo "job $LABEL started (mode=$MODE)"
i=0; until [ -f "$OUT/done" ]; do i=$((i+1)); [ $i -lt 300 ] || { echo "timeout waiting for job" >&2; break; }; sleep 2; done
# evaluate.mjs redacts stderr with the same redactStderr as the daemon; the env file values count as secrets
( [ "$MODE" != env ] || { set -a; . "$ENVF"; set +a; }; node "$HERE/evaluate.mjs" "$OUT" > "$OUT/summary.txt" ) || true
# sanitized only: summary.json has names, counts and statuses, never variable values
cat "$OUT/summary.txt"
