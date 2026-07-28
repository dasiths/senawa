#!/usr/bin/env bash
# POC 08 - Does the sensor model hold up?
#
#   runner.mjs      four real tools normalized to one findings[] shape,
#                   cost ordering with short-circuit, fingerprint caching,
#                   and hostile-output hygiene.       (offline)
#
#   inferential.mjs the same rubric run N times against UNCHANGED input, to
#                   measure whether an inferential verdict is stable enough to
#                   promote from advisory to blocking.  (spends AI credits)
set -uo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "==> Installing eslint, typescript, yaml"
  npm install --silent --no-audit --no-fund
fi

node runner.mjs

echo
echo "############ inferential stability ############"
echo "# a clear-cut violation"
SUBJECT=fixture/src/parse.ts node inferential.mjs

echo
echo "# a judgment call"
SUBJECT=fixture/src/ambiguous.ts node inferential.mjs
