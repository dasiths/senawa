#!/usr/bin/env bash
# Reproducible, no-credit benchmark for authoritative Beads runtime reads.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PROFILE=""
OUTPUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      PROFILE="${2:-}"
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

if [[ "$PROFILE" != "smoke" && "$PROFILE" != "full" ]]; then
  printf 'Usage: %s --profile smoke|full --output <path>\n' "$0" >&2
  exit 2
fi
if [[ -z "$OUTPUT" ]]; then
  printf '%s\n' '--output is required' >&2
  exit 2
fi

for dependency in node pnpm bd git timeout; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$dependency" >&2
    exit 1
  fi
done

TEMPORARY_DIRECTORY="$(mktemp -d)"
trap 'rm -rf "$TEMPORARY_DIRECTORY"' EXIT
BUNDLE="$TEMPORARY_DIRECTORY/fresh-read-benchmark.mjs"
TIME_LIMIT="120s"
if [[ "$PROFILE" == "full" ]]; then
  TIME_LIMIT="30m"
fi

cd "$REPOSITORY_ROOT"
pnpm exec esbuild experiments/probes/beads-graph/fresh-read-benchmark.ts \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node22 \
  --outfile="$BUNDLE"

timeout --signal=TERM "$TIME_LIMIT" node "$BUNDLE" \
  --profile "$PROFILE" \
  --output "$OUTPUT"