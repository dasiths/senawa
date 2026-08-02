#!/usr/bin/env bash
# Hook latency - Is a bundled Node CLI fast enough to be a preToolUse hook?
#
# The design asserts ~34 ms bundled and ~137 ms unbundled, and treats the
# bundled number as the thing that makes hook-based gating viable at all.
# A hook that exceeds its timeout fails OPEN, so this number is load bearing.
#
# Spends no AI credits. Offline after the first install.
set -euo pipefail
cd "$(dirname "$0")"

RUNS=${RUNS:-20}

if [ ! -d node_modules ]; then
  echo "==> Installing dependencies"
  npm install --silent --no-audit --no-fund
fi

echo "==> Bundling with esbuild"
# execa v9 is ESM-only so the output format must be ESM, but commander is CJS and
# esbuild's ESM output cannot `require` node builtins. The createRequire banner is
# mandatory for any mixed graph; without it the bundle throws at import time.
npx --no-install esbuild src/cli.mjs \
  --bundle --platform=node --format=esm --target=node22 \
  --banner:js="import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" \
  --outfile=dist/cli.mjs --log-level=warning
printf '    bundle size: %s\n' "$(du -h dist/cli.mjs | cut -f1)"

echo "==> Bundling the minimal hot path (no zod, no execa, no commander)"
npx --no-install esbuild src/hot-path.mjs \
  --bundle --platform=node --format=esm --target=node22 \
  --banner:js="import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" \
  --outfile=dist/hot-path.mjs --log-level=warning
printf '    bundle size: %s\n' "$(du -h dist/hot-path.mjs | cut -f1)"

# best-of-N wall time in milliseconds for a single invocation
bench() {
  local label="$1"; shift
  local best=999999
  for _ in $(seq "$RUNS"); do
    local start end elapsed
    start=$(date +%s%N)
    "$@" >/dev/null 2>&1 </dev/null
    end=$(date +%s%N)
    elapsed=$(( (end - start) / 1000000 ))
    [ "$elapsed" -lt "$best" ] && best=$elapsed
  done
  printf '%-46s %4s ms\n' "$label" "$best"
}

echo
echo "==> Best of $RUNS runs"
bench "/bin/true (process floor)" /bin/true
bench "node -e '' (V8 floor)" node -e ''
bench "bundled hot path" node dist/hot-path.mjs --selftest
bench "bundled full CLI, single file" node dist/cli.mjs --selftest
bench "unbundled full CLI, node_modules resolution" node src/cli.mjs --selftest

echo
echo "==> Functional check: does it actually deny a commit?"
for target in dist/cli.mjs dist/hot-path.mjs; do
  printf '  %-20s ' "$target"
  printf '%s' '{"sessionId":"s","cwd":"/tmp","toolName":"bash","toolArgs":{"command":"git commit -m wip"}}' \
    | node "$target"
  echo
  printf '  %-20s ' "$target (allow)"
  printf '%s' '{"sessionId":"s","cwd":"/tmp","toolName":"bash","toolArgs":{"command":"ls"}}' \
    | node "$target"
  echo
done
