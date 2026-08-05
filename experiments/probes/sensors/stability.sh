#!/usr/bin/env bash
# Inferential stability: the same rubric against unchanged input, N times.
#
# Promotion from advisory to blocking needs a measurement rather than a promise.
# This runs one subject where the rubric has a clear structural answer and one
# where it is a judgment call, and counts how often the verdict agrees.
#
# SPENDS AI CREDITS: 2N short prompts (N defaults to 5 per subject).
set -euo pipefail
cd "$(dirname "$0")"

npm install --silent --no-audit --no-fund

echo "# a clear-cut violation"
SUBJECT=fixture/src/parse.ts node stability.mjs

echo
echo "# a judgment call"
SUBJECT=fixture/src/ambiguous.ts node stability.mjs
