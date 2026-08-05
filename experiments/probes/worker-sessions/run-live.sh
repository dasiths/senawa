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

if [ ! -d node_modules/@github/copilot-sdk ]; then
  echo "==> Installing @github/copilot-sdk"
  npm install --silent --no-audit --no-fund
fi

bash resume.sh
node isolation.mjs
