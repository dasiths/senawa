#!/usr/bin/env bash
# Workflow engine: can a blocking driver run a phased workflow that a human
# reviews, sends back, and adds to, with all runtime state held in beads?
#
# The narrative below is the design's target user experience, executed:
#   start -> approve define -> approve research -> REJECT plan -> approve v2
#         -> implement (with a driver crash and a refusal) -> verify
#         -> add tasks after verification -> implement again -> accept
#
# Along the way the derived cache is deleted to prove nothing depends on it.
#
# Fully offline. Agent turns and sensor readings are deterministic fakes so this
# probe measures orchestration semantics rather than a model.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
RUN="$WORK/.agents/.copilot-tracking/run"

cd "$HERE"
if [ ! -d node_modules/ajv ]; then
  npm install --silent --no-audit --no-fund
fi

mkdir -p "$WORK/definitions"
cp -r workflows schemas sensors.yaml request.json extra-tasks.json "$WORK/definitions/"
git -C "$WORK" init -q .
git -C "$WORK" config user.email poc@example.com
git -C "$WORK" config user.name poc
git -C "$WORK" config beads.role maintainer

senawa() {
  SENAWA_ROOT="$WORK" SENAWA_DEFINITIONS="$WORK/definitions" node "$HERE/engine.mjs" "$@"
}
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { echo "FAILED: $*" >&2; exit 1; }

step "doctor"
senawa doctor || fail "valid workflow rejected"

step "workflow info shows approvals and the completion condition"
senawa workflow info standard-delivery | grep -E '"(completesWhen|approval|iterationMax)"' | head -6
senawa workflow render standard-delivery | grep -q 'plan --> implement' || fail "render is wrong"

step "doctor rejects every deliberate violation at once"
if senawa doctor --workflow invalid-shapes >"$WORK/doctor.out" 2>&1; then
  fail "invalid workflow passed"
fi
sed 's/^/   /' "$WORK/doctor.out"
for want in 'cycle' 'missing gate' 'unknown approval' 'iteration.max' 'onUpstreamChange' \
            'reentrant applies' 'resumeAcrossIterations applies' 'completesWhen names unknown' 'finite rework'; do
  grep -q "$want" "$WORK/doctor.out" || fail "doctor missed: $want"
done

step "work start drives until it needs a human"
senawa work start "Refactor the ingest pipeline" --workflow standard-delivery --input "$WORK/definitions/request.json"

step "a second unfinished run is refused"
if senawa work start "Competing run" --workflow standard-delivery --input "$WORK/definitions/request.json" \
    >"$WORK/competing.out" 2>&1; then
  fail "second active run was accepted"
fi
grep -q 'active run already exists' "$WORK/competing.out" || fail "second start failed for the wrong reason"
echo "   repository active-run pointer kept the first run authoritative"

# The source definition changes after kickoff; the run must follow its snapshot.
sed -i 's/Define, research, plan, implement, and verify a change/CHANGED AFTER START/' \
  "$WORK/definitions/workflows/standard-delivery.yaml"

step "the graph, not a local file, knows a human is owed something"
BD_JSON_ENVELOPE=1 BEADS_DIR="$WORK/.beads" bd list --label senawa:awaiting_approval --json \
  | jq -r '.data | length' | grep -qv '^0$' || fail "no awaiting_approval label in the graph"
BD_JSON_ENVELOPE=1 BEADS_DIR="$WORK/.beads" bd gate list --json | jq -r 'length' | grep -qv '^0$' \
  || fail "no human gate blocking the phase"
echo "   a senawa:awaiting_approval label and an open human gate both exist"

step "approve define, then research"
senawa approve define
senawa work resume
senawa approve research

step "the plan comes back and you send it back"
senawa work resume
senawa reject plan --reason "no error handling on the adapter boundary; add tasks for it"

step "delete the derived cache; nothing may depend on it"
rm -f "$RUN/cache.json"

step "the planner resumes its own session and submits v2"
senawa work resume
[ -f "$RUN/cache.json" ] || fail "cache was not rebuilt"
grep -q 'add-error-handling' "$RUN/artifacts/plan/v2.json" || fail "iteration 2 did not address the rejection"
echo "   cache rebuilt from the graph, and plan v2 contains what the rejection asked for"
senawa approve plan

step "implementation, with the driver killed mid-dispatch"
SENAWA_CRASH_AT=after-work:implement-api senawa work resume
[ $? -eq 70 ] || fail "expected the injected crash"

step "resume reconciles the in-flight dispatch and carries on"
senawa work resume

step "verification is reached; add work instead of accepting"
senawa plan revise --add "$WORK/definitions/extra-tasks.json"

step "the frontier re-opens and the new task runs"
senawa work resume

step "accept the run"
senawa approve verify
senawa work resume
ACCEPTED=$?

step "final state"
SHOW=$(senawa work show)
echo "$SHOW"

[ "$ACCEPTED" -eq 0 ] || fail "run did not complete with acceptance"
python3 - "$SHOW" <<'PY' || exit 1
import json, sys
s = json.loads(sys.argv[1])
assert s["status"] == "finished", s["status"]
assert s["needs"] is None, s["needs"]
assert s["sourceChanged"] is True, "definition drift not reported"
plan = s["phases"]["plan"]
assert plan["iteration"] == 2, f"plan should have iterated twice, got {plan['iteration']}"
assert plan["version"] == 3, f"plan should be at v3 after revision, got v{plan['version']}"
keys = {t["key"]: t for t in s["tasks"]}
assert set(keys) == {"implement-api", "update-caller", "add-error-handling", "add-logging"}, keys
assert all(t["status"] == "closed" for t in s["tasks"]), keys
assert keys["implement-api"]["attempt"] == 2, "the refused task should have needed a second attempt"
assert keys["add-logging"]["attempt"] == 1, "revision task should pass first time"
assert s["phases"]["verify"]["iteration"] == 2, "verify should have run again after the revision"
assert s["isolatedSessions"] >= 4, "phase sessions should live under the isolated home"
print("   assertions passed")
PY

step "the graph agrees, and nothing leaked into a user session store"
EPIC=$(jq -r .epic "$RUN/work.json")
BD_JSON_ENVELOPE=1 BEADS_DIR="$WORK/.beads" bd show "$EPIC" --json | jq -r '.data[0].status' | grep -q closed \
  || fail "epic not closed in beads"
BD_JSON_ENVELOPE=1 BEADS_DIR="$WORK/.beads" bd show "$(jq -r .phaseBeads.plan "$RUN/work.json")" --json \
  | jq -e '.data[0].metadata.senawa.iteration == 2' >/dev/null \
  || fail "phase iteration is not stored in bead metadata"
[ -d "$RUN/.copilot-home/session-state" ] || fail "sessions were not created under the isolated home"
echo "   epic closed, phase iteration read back from bead metadata, sessions isolated"

step "work.json holds identity only"
jq -e 'keys == ["epic","fingerprint","input","phaseBeads","workflow"]' "$RUN/work.json" >/dev/null \
  || fail "work.json holds more than run identity: $(jq -r 'keys|join(",")' "$RUN/work.json")"
echo "   identity: workflow, epic, fingerprint, input, phase bead ids"

step "only one worker turn was ever in flight"
python3 - "$RUN/journal.jsonl" <<'PY' || exit 1
import json, sys
active = 0
peak = 0
for line in open(sys.argv[1], encoding="utf-8"):
    event = json.loads(line)["event"]
    if event == "task.dispatching":
        active += 1
        peak = max(peak, active)
    elif event == "task.dispatched":
        active -= 1
assert peak == 1, f"expected peak one in-flight worker turn, got {peak}"
assert active == 0, f"unfinished dispatch accounting: {active}"
print("   peak in-flight worker turns: 1")
PY
[ ! -e "$WORK/.agents/.copilot-tracking/active-run.json" ] \
  || fail "accepted run did not release the active-run pointer"

step "startup failure releases the singleton"
if SENAWA_FAIL_START_AT=after-acquire senawa work start "Broken startup" \
    --workflow standard-delivery --input "$WORK/definitions/request.json" \
    >"$WORK/startup-failure.out" 2>&1; then
  fail "injected startup failure unexpectedly succeeded"
fi
grep -q 'injected startup failure' "$WORK/startup-failure.out" \
  || fail "startup failed for the wrong reason"
[ ! -e "$WORK/.agents/.copilot-tracking/active-run.json" ] \
  || fail "startup failure stranded the active-run pointer"
echo "   singleton released because no run identity became durable"

step "a stuck run can end gracefully and a replacement can start"
senawa work start "Run to abandon" --workflow standard-delivery --input "$WORK/definitions/request.json"
[ -e "$WORK/.agents/.copilot-tracking/active-run.json" ] || fail "new run did not claim the repository"
senawa work end --reason "operator abandoned the stuck run"
ENDED=$(senawa work show)
echo "$ENDED" | jq -e '.status == "ended" and .needs == null' >/dev/null \
  || fail "ended run did not reach a terminal projection"
grep -q '"event":"work.ended"' "$RUN/journal.jsonl" || fail "work.ended was not journalled"
[ ! -e "$WORK/.agents/.copilot-tracking/active-run.json" ] \
  || fail "graceful end did not release the active-run pointer"

senawa work start "Replacement run" --workflow standard-delivery --input "$WORK/definitions/request.json"
grep -q 'Replacement run' "$RUN/work.json" || fail "replacement run did not start"
senawa work end --reason "probe cleanup"
[ -d "$WORK/.agents/.copilot-tracking/archive" ] || fail "previous runs were not archived"
echo "   ended run archived, replacement started, cleanup released the repository"

step "browser run console"
node "$HERE/web-console-test.mjs" || fail "browser run console probe failed"

step "workflow engine passed"
