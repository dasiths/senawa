#!/usr/bin/env bash
# POC 07 - see probe.mjs for what this checks and why.
# SPENDS AI CREDITS: three short claude-haiku-4.5 turns.
set -uo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "==> Installing @github/copilot-sdk"
  npm install --silent --no-audit --no-fund
  npm install --silent --no-audit --no-fund zod
fi

node probe.mjs
