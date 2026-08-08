#!/usr/bin/env bash
# Reproducible, no-credit measurement of Beads commit cost.
#
# Proves that an unchanged commit costs the same regardless of graph size.
# Before convergence skipping, every commit rewrote every phase and task.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TASKS="12"
OUTPUT="${TMPDIR:-/tmp}/senawa-beads-commit-cost.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tasks)
      TASKS="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT="${2:-}"
      shift 2
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

for dependency in node pnpm bd git timeout; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$dependency" >&2
    exit 1
  fi
done

TEMPORARY_DIRECTORY="$(mktemp -d)"
trap 'rm -rf "$TEMPORARY_DIRECTORY"' EXIT
BUNDLE="$TEMPORARY_DIRECTORY/commit-cost-benchmark.mjs"

cd "$REPOSITORY_ROOT"
pnpm exec esbuild experiments/probes/beads-graph/commit-cost-benchmark.ts \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node22 \
  --outfile="$BUNDLE"

timeout --signal=TERM 15m node "$BUNDLE" --tasks "$TASKS" --output "$OUTPUT"
