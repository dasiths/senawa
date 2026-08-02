#!/usr/bin/env bash
# Beads concurrency - Is --claim genuinely atomic, and what do concurrent writers do?
#
# The design asserts two things that decide the parallelism story:
#   A. `bd ready --claim` is atomic, so N workers pulling the same queue each
#      get a DIFFERENT task and none is handed out twice.
#   B. Embedded Dolt is a single writer, so concurrent `bd` writes contend -
#      which is why senawa serializes them rather than letting workers call bd.
#
# If A fails, the frontier is unsafe. If B is benign, the serialization seam is
# less urgent than the design claims.
#
# Spends no AI credits. Fully offline.
set -uo pipefail

N=${N:-6}
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
git init -q .
git config user.email poc@example.com
git config user.name poc
git config beads.role maintainer
export BEADS_DIR="$WORK/.beads" BD_NON_INTERACTIVE=1 DO_NOT_TRACK=1

hdr() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }

bd init --quiet --stealth --non-interactive --role maintainer </dev/null >/dev/null 2>&1
note "seeding $N independent tasks"
for i in $(seq "$N"); do
  bd create "task $i" -t task --json >/dev/null 2>&1
done
note "ready: $(bd ready --json 2>/dev/null | jq -r 'length')"

# ---------------------------------------------------------------------------
hdr "A. $N concurrent 'bd ready --claim' - does anyone get the same task twice?"

for i in $(seq "$N"); do
  ( bd ready --claim --json 2>/dev/null | jq -r 'if type=="array" then .[0] else . end | .id // "NONE"' > "claim.$i" ) &
done
wait

cat claim.* | sort > claims.txt
note "claims returned : $(grep -vc NONE claims.txt) of $N"
note "distinct ids    : $(grep -v NONE claims.txt | sort -u | wc -l)"
if [ "$(grep -v NONE claims.txt | wc -l)" -eq "$(grep -v NONE claims.txt | sort -u | wc -l)" ]; then
  note "RESULT: no task was handed out twice - claim is atomic under contention"
else
  note "RESULT: DUPLICATE CLAIMS - the frontier is not safe for parallel pull"
  grep -v NONE claims.txt | sort | uniq -d | sed 's/^/     dup: /'
fi
note "ids: $(tr '\n' ' ' < claims.txt)"

# ---------------------------------------------------------------------------
hdr "B. $N concurrent writers - do they contend, fail, or serialize?"

start=$(date +%s%N)
for i in $(seq "$N"); do
  ( bd create "concurrent $i" -t task --json >"w.$i.out" 2>"w.$i.err"; echo $? > "w.$i.rc" ) &
done
wait
end=$(date +%s%N)

ok=0; fail=0
for i in $(seq "$N"); do
  if [ "$(cat "w.$i.rc")" = "0" ]; then ok=$((ok+1)); else fail=$((fail+1)); fi
done
note "succeeded: $ok   failed: $fail   wall: $(( (end-start)/1000000 )) ms for $N writers"
if [ "$fail" -gt 0 ]; then
  note "first failure message:"
  head -3 w.*.err 2>/dev/null | grep -v '^$' | head -4 | sed 's/^/     /'
fi

# sequential baseline for comparison
start=$(date +%s%N)
for i in $(seq "$N"); do bd create "sequential $i" -t task --json >/dev/null 2>&1; done
end=$(date +%s%N)
note "sequential baseline: $(( (end-start)/1000000 )) ms for $N writers"

note "total issues now: $(bd list --json 2>/dev/null | jq -r 'length')  (expect $((N*3)) if nothing was lost)"

hdr "done"
