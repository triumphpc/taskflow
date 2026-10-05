# Allow/deny lists under test. Generated from agent/lib/policy.mjs (single source of truth with the daemon).
# Sourced by run-spike.sh (needs $HERE).
ALLOWED=$(node "$HERE/print-lists.mjs" allowed)
DENIED=$(node "$HERE/print-lists.mjs" denied)
