#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v tmux >/dev/null 2>&1; then
  printf '%s\n' \
    "SKIP: tmux is not installed; install tmux and rerun:" \
    "  bash experiments/probes/worker-sessions/run.sh"
  exit 0
fi

probe_root=$(mktemp -d "${TMPDIR:-/tmp}/senawa-worker-sessions.XXXXXX")
socket="senawa-probe-$(basename "$probe_root" | tr -cd 'a-zA-Z0-9_-')"

cleanup() {
  tmux -L "$socket" kill-server >/dev/null 2>&1 || true
  rm -rf "$probe_root"
}
trap cleanup EXIT INT TERM

printf '%s\n' "==> Credit-free browser-terminal fixture test"
node --test browser-terminal.test.mjs
printf '%s\n' "==> Credit-free tmux substrate probe"
node run-no-credit.mjs "$(command -v tmux)" "$probe_root" "$socket"

cleanup
cleanup
trap - EXIT INT TERM
printf '%s\n' "PASS: isolated tmux server and temporary probe state were cleaned up idempotently"