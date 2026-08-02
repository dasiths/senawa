#!/usr/bin/env bash
# Workflow engine: can a declarative workflow be validated, previewed, frozen,
# compiled into real beads state, and advanced by restart-safe bounded ticks?
#
# Fully offline. Agent turns and sensor readings are deterministic fakes so this
# probe measures orchestration semantics and CLI usability rather than a model.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$HERE"
if [ ! -d node_modules/ajv ]; then
  npm install --silent --no-audit --no-fund
fi

mkdir -p "$WORK/definitions"
cp -r workflows schemas sensors.yaml request.json "$WORK/definitions/"
git -C "$WORK" init -q .
git -C "$WORK" config user.email poc@example.com
git -C "$WORK" config user.name poc
git -C "$WORK" config beads.role maintainer

senawa() {
  SENAWA_ROOT="$WORK" SENAWA_DEFINITIONS="$WORK/definitions" node "$HERE/engine.mjs" "$@"
}

echo "==> doctor"
senawa doctor

echo "==> workflow discovery and preview"
senawa workflow list | grep -E 'standard-delivery|Define, research'
senawa workflow info standard-delivery | grep -E '"(name|phases|executor|gate)"'
senawa workflow render standard-delivery | grep -E 'define --> research|plan --> implement|implement --> verify'

echo "==> doctor rejects a cycle, missing gate, and unbounded frontier"
if senawa doctor --workflow invalid-cycle >/tmp/senawa-poc12.out 2>&1; then
  echo "invalid workflow unexpectedly passed" >&2
  exit 1
fi
grep -E 'cycle|missing gate|no finite' /tmp/senawa-poc12.out

echo "==> start workflow"
START=$(senawa work start "Refactor the ingest pipeline" --workflow standard-delivery --input "$WORK/definitions/request.json")
echo "$START" | grep -E '"workflow":"standard-delivery"|"frontier":\["define"\]'

# Active work must use the snapshot rather than following mutable definitions.
sed -i 's/Define, research, plan, implement, and verify a change/CHANGED AFTER START/' "$WORK/definitions/workflows/standard-delivery.yaml"

echo "==> tick from fresh processes"
for _ in 1 2 3 4 5 6 7 8 9; do
  RESULT=$(senawa tick)
  echo "$RESULT"
  if echo "$RESULT" | grep -q 'work-finished'; then break; fi
done

echo "==> final state"
SHOW=$(senawa work show)
echo "$SHOW" | grep -E '"(status|sourceChanged|phaseCount|attempt|journalEvents)"'
echo "$SHOW" | grep -q '"status": "finished"'
echo "$SHOW" | grep -q '"sourceChanged": true'
echo "$SHOW" | grep -q '"phaseCount": 5'
echo "$SHOW" | grep -q '"attempt": 2'

echo "==> real beads graph closed by the engine"
BD_JSON_ENVELOPE=1 BEADS_DIR="$WORK/.beads" bd show "$(echo "$SHOW" | jq -r .epic)" --json | jq -r '.data[0].status' | grep -q closed

echo "==> workflow engine passed"
