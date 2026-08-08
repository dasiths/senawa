#!/usr/bin/env bash
# Worker sessions: durable identity for the rework loop, and isolation from the
# human's session history.
#
#   resume.sh      --session-id, --resume, --share, and JSONL event shape
#   isolation.mjs  baseDirectory and COPILOT_HOME keep worker sessions hidden
#
# SPENDS AI CREDITS: five short claude-haiku-4.5 turns.
set -euo pipefail
cd "$(dirname "$0")"

printf '%s\n' \
  "LIVE PROBE COST: this script spends AI credits on five short claude-haiku-4.5 turns." \
  "It does not run the no-credit tmux substrate probe."
if [[ ${SENAWA_LIVE_PROBE_APPROVED:-0} != 1 ]]; then
  printf '%s\n' \
    "REFUSED: explicit opt-in is required." \
    "After reviewing the cost, set SENAWA_LIVE_PROBE_APPROVED=1 and rerun this script."
  exit 2
fi

if [[ ! -d node_modules/@github/copilot-sdk ]]; then
  echo "==> Installing @github/copilot-sdk"
  npm install --silent --no-audit --no-fund
fi

bash resume.sh
node isolation.mjs
