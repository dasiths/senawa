#!/usr/bin/env bash
# Sensor contracts and evidence hygiene.
#
#   cli.mjs      explicit extension discovery, JSON Schema contracts for config,
#                input and output, and the doctor / list / info / run surface
#   hygiene.mjs  four real tools normalized to one findings shape, cost ordering
#                with short-circuit, fingerprint caching, and hostile output
#
# Inferential stability is measured separately by stability.sh, which spends
# credits. Everything here is offline.
set -euo pipefail
cd "$(dirname "$0")"

# eslint pulls in its own ajv, so a directory check would skip the install we need.
npm install --silent --no-audit --no-fund

echo "==> doctor"
node cli.mjs doctor

echo "==> sensor list"
node cli.mjs sensor list

echo "==> sensor info architecture-review"
node cli.mjs sensor info architecture-review --json | grep -E '"(description|inputSchema|outputSchema)"'

echo "==> sensor run syntax"
node cli.mjs sensor run syntax --json | grep -E '"(sensor|status|verdict)"'

echo "==> sensor run (all)"
ALL=$(node cli.mjs sensor run --json)
echo "$ALL" | grep -E '"(sensor|status|verdict|submissionAttempts)"'
echo "$ALL" | grep -q '"submissionAttempts": 2'

echo "==> doctor rejects malformed configuration"
if node cli.mjs doctor --config invalid-sensors.yaml >/tmp/senawa-sensors-doctor.out 2>&1; then
  echo "invalid configuration unexpectedly passed" >&2
  exit 1
fi
grep -E 'invalid config|not configured|unknown operator|no deterministic sensor' /tmp/senawa-sensors-doctor.out

echo
echo "==> normalization, ordering, caching, and hostile output"
node hygiene.mjs

echo
echo "==> sensors probe passed"
