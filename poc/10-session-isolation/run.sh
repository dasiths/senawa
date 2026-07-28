#!/usr/bin/env bash
# POC 10 - Can worker sessions be kept out of the user's session history,
#          and can they still be correlated into one distributed trace?
#
# Dispatching one session per task would otherwise put an entry in the human's
# Copilot session picker for every task senawa runs, which makes their own
# history unusable.
#
# SPENDS AI CREDITS: two short claude-haiku-4.5 turns.
set -uo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "==> Installing @github/copilot-sdk"
  npm install --silent --no-audit --no-fund
fi

node probe.mjs
