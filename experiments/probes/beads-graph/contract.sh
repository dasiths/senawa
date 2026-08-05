#!/usr/bin/env bash
# Beads contract - Does the bd JSON contract behave the way @senawa/graph needs?
#
# Validates, in order:
#   1. schema_version presence with and without BD_JSON_ENVELOPE
#   2. metadata round-trip for a nested `senawa` namespace + execution_* hints
#   3. bd set-state: does it really write an event bead AND a label?
#   4. dependency direction semantics (the mistake agents actually make)
#   5. bd ready --claim as a single atomic read+write
#   6. gate lifecycle: create -> blocks -> resolve -> unblocks
#   7. bd swarm validate as a plan-lint sensor
#   8. bd dep tree --format=mermaid for the run report
#   9. bd batch as the serialized-write primitive
#  10. per-command latency, because @senawa/graph calls bd constantly
#
# Spends no AI credits. Fully offline. Uses a throwaway database in $TMPDIR.
set -uo pipefail

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
git init -q .
git config user.email poc@example.com
git config user.name poc
git config beads.role maintainer
export BEADS_DIR="$WORK/.beads"
# bd init prompts "Contributing to someone else's repo? [y/N]" and blocks forever
# on a closed stdin unless told not to. Any automation calling bd MUST set this.
export BD_NON_INTERACTIVE=1
export DO_NOT_TRACK=1
unset BD_JSON_ENVELOPE

hdr() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }

bd init --quiet --stealth --non-interactive --role maintainer >/dev/null 2>&1 </dev/null
note "database at $BEADS_DIR"

# ---------------------------------------------------------------------------
hdr "1. schema_version presence"

EPIC=$(bd create "Refactor ingest" -t epic --json 2>/dev/null | jq -r '.id')
note "created epic $EPIC"

echo "   bd show, legacy mode      -> schema_version: $(bd show "$EPIC" --json 2>/dev/null | jq -r 'if type=="array" then .[0] else . end | .schema_version // "ABSENT"')"
echo "   bd ready, legacy mode     -> schema_version: $(bd ready --json 2>/dev/null | jq -r 'if type=="array" then "ABSENT (bare array)" else (.schema_version // "ABSENT") end')"
echo "   bd ready, BD_JSON_ENVELOPE -> $(BD_JSON_ENVELOPE=1 bd ready --json 2>/dev/null | jq -r 'if has("schema_version") then "schema_version=\(.schema_version), payload under .data" else "still no envelope" end')"

# ---------------------------------------------------------------------------
hdr "2. metadata round-trip"

T1=$(bd create "Split parse_batch into stages" -t task --parent "$EPIC" --json 2>/dev/null | jq -r '.id')
bd update "$T1" --metadata '{
  "senawa": {"state":"rework","attempt":2,"session_id":"0cb916db","last_reading":{"verdict":"fail","failed":["unit-tests"]}},
  "execution_agent_type":"worker",
  "execution_suggested_model":"claude-sonnet-4.6",
  "execution_reasoning_effort":"high",
  "execution_parallel_group":"ingest-adapters"
}' >/dev/null 2>&1

bd show "$T1" --json 2>/dev/null | jq -r '
  (if type=="array" then .[0] else . end) as $i |
  "   nested read back : " + ($i.metadata.senawa.last_reading.failed | tostring) +
  "\n   attempt (number?): " + ($i.metadata.senawa.attempt | type) +
  "\n   execution hints  : " + $i.metadata.execution_suggested_model + " / " + $i.metadata.execution_reasoning_effort'

note "filter by hint: $(bd list --metadata-field execution_parallel_group=ingest-adapters --json 2>/dev/null | jq -r 'length') issue(s) match --metadata-field"

# ---------------------------------------------------------------------------
hdr "3. bd set-state: event bead plus label?"

bd set-state "$T1" senawa=rework --reason "unit-tests red 2/3" >/dev/null 2>&1
note "labels now: $(bd show "$T1" --json 2>/dev/null | jq -rc 'if type=="array" then .[0] else . end | .labels')"
# Event beads are children of the issue and are EXCLUDED from `bd list --type event`.
# They only surface via `bd list --all`, which the journal reader must account for.
note "events via --type event: $(bd list --type event --json 2>/dev/null | jq -r 'length')"
note "events via --all       : $(bd list --all --json 2>/dev/null | jq -r '[.[]|select(.issue_type=="event")]|length')"
note "query by state label: $(bd list --label senawa:rework --json 2>/dev/null | jq -r 'length') issue(s)"

# ---------------------------------------------------------------------------
hdr "4. dependency direction"

T2=$(bd create "Extract retry policy" -t task --parent "$EPIC" --json 2>/dev/null | jq -r '.id')
# Requirement language: T2 needs T1  ==>  bd dep add <dependent> <blocker>
bd dep add "$T2" "$T1" >/dev/null 2>&1
note "added: $T2 depends on $T1"
note "ready now excludes T2? $(bd ready --json 2>/dev/null | jq -r --arg t "$T2" 'map(select(.id==$t)) | if length==0 then "yes, correctly blocked" else "NO - direction is inverted" end')"
note "blocked reports    : $(bd blocked --json 2>/dev/null | jq -rc --arg t "$T2" 'map(select(.id==$t) | {id, blocked_by}) | .[0] // "not blocked"')"

# ---------------------------------------------------------------------------
hdr "5. bd ready --claim atomicity (single call)"

CLAIMED=$(bd ready --claim --json 2>/dev/null | jq -r 'if type=="array" then .[0] else . end | .id // "none"')
note "claimed in one call: $CLAIMED"
bd show "$CLAIMED" --json 2>/dev/null | jq -r 'if type=="array" then .[0] else . end | "   status=\(.status) assignee=\(.assignee // "unset")"'

# ---------------------------------------------------------------------------
hdr "6. gate lifecycle"

GATE=$(bd gate create --type=human --blocks "$T2" --reason "human approves the plan" --json 2>/dev/null | jq -r '.id // .gate_id // "?"')
note "created human gate $GATE blocking $T2"
note "gate list open: $(bd gate list --json 2>/dev/null | jq -r 'length')"
bd gate resolve "$GATE" --reason "approved" >/dev/null 2>&1
note "after resolve, open gates: $(bd gate list --json 2>/dev/null | jq -r 'length')"

# ---------------------------------------------------------------------------
hdr "7. bd swarm validate as plan-lint"

bd swarm validate "$EPIC" 2>&1 | head -20 | sed 's/^/   /'

# ---------------------------------------------------------------------------
hdr "8. mermaid for the run report"

bd dep tree "$EPIC" --format=mermaid 2>&1 | head -12 | sed 's/^/   /'

# ---------------------------------------------------------------------------
hdr "9. bd batch as the serialized-write primitive"

# bd batch has its OWN grammar, unrelated to the normal CLI flags:
#   create <type> <priority> <title...>
# and `update` only accepts status, priority, title, assignee - NOT metadata.
printf 'create task 2 "batched one"\ncreate task 2 "batched two"\n' > batch.txt
bd batch -f batch.txt --json 2>&1 | head -8 | sed 's/^/   /'
note "can batch set metadata? $(printf 'update %s metadata={}\n' "$T1" | bd batch --json 2>&1 | head -c 90)"

# ---------------------------------------------------------------------------
hdr "10. per-command latency (matters: senawa shells out to bd constantly)"

time_ms() {
  local start end
  start=$(date +%s%N)
  "$@" >/dev/null 2>&1 </dev/null
  end=$(date +%s%N)
  echo $(( (end - start) / 1000000 ))
}
for cmd in "bd ready --json" "bd show $T1 --json" "bd list --json"; do
  best=999999
  for _ in 1 2 3; do
    t=$(time_ms $cmd); [ "$t" -lt "$best" ] && best=$t
  done
  printf '   %-28s %5s ms (best of 3)\n' "$cmd" "$best"
done

hdr "done"
