#!/usr/bin/env bash
# POC 09 - the whole loop, CLI only, throwaway.
#
#   work start  -> real beads graph with execution hints
#   task next   -> atomic claim, hints read BEFORE dispatch
#   dispatch    -> real `copilot -p` worker at a caller-chosen session id
#   task done   -> sensors run, gate REFUSES with findings
#   rework      -> the SAME session is resumed with the failures
#   close       -> only the orchestrator may close the bead
#   report      -> rendered from the journal
#
# The worker is told it cannot close its own task and cannot edit the test.
# The brief deliberately understates the problem: the sensor knows more than
# the brief does, which is what makes the refusal meaningful rather than staged.
#
# SPENDS AI CREDITS: up to 3 short claude-haiku-4.5 turns.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

hdr() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }

# --- scratch repo -----------------------------------------------------------
cd "$WORK"
git init -q .
git config user.email poc@example.com
git config user.name poc
git config beads.role maintainer
cp -r "$HERE/fixture/." .

# senawa must be on the worker's PATH, and `bd` must NOT be.
# POC 04 showed --deny-tool is not containment; absence is. So the worker's
# environment is CONSTRUCTED rather than filtered: a bin directory containing
# exactly the executables it is allowed to reach, and nothing else.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/senawa" <<EOF
#!/usr/bin/env bash
exec node "$HERE/senawa.mjs" "\$@"
EOF
chmod +x "$WORK/bin/senawa"

NPM_BIN=/usr/local/share/npm-global/bin
for exe in "$NPM_BIN"/*; do
  name="$(basename "$exe")"
  [ "$name" = "bd" ] && continue          # the graph is not the worker's to touch
  ln -sf "$exe" "$WORK/bin/$name"
done

COPILOT_BIN="$NPM_BIN/copilot"
WORKER_PATH="$WORK/bin:/usr/local/bin:/usr/bin:/bin"
export SENAWA_ROOT="$WORK"

# The orchestrator keeps its normal PATH: it is the only thing allowed to call bd.
senawa() { node "$HERE/senawa.mjs" "$@"; }

note "worker can reach senawa? $(PATH="$WORKER_PATH" command -v senawa >/dev/null 2>&1 && echo yes || echo NO)"
note "worker can reach bd?     $(PATH="$WORKER_PATH" command -v bd >/dev/null 2>&1 && echo 'YES - leak' || echo no)"

# --- 0. init ----------------------------------------------------------------
hdr "0. senawa init: bd init, non-interactively"
senawa init | sed 's/^/   /'

# --- 1. start ----------------------------------------------------------------
hdr "1. work start: pour the graph"
IDS=$(senawa work start "throwaway end to end")
EPIC=$(echo "$IDS" | jq -r .epic); TASK=$(echo "$IDS" | jq -r .task)
note "epic=$EPIC task=$TASK"

hdr "2. task next: claim atomically and read execution hints BEFORE dispatch"
NEXT=$(senawa task next)
MODEL=$(echo "$NEXT" | jq -r '.metadata.execution_suggested_model // "claude-haiku-4.5"')
EFFORT=$(echo "$NEXT" | jq -r '.metadata.execution_reasoning_effort // "medium"')
note "claimed $(echo "$NEXT" | jq -r .id) -> model=$MODEL effort=$EFFORT"

hdr "3. baseline: the sensors are red before anyone touches anything"
senawa internal gate | jq -r '"   accepted=\(.accepted) failed=\(.readings|map(select(.verdict=="fail"))|map(.sensor)|join(","))"'

# --- 2. the loop -------------------------------------------------------------
SID=$(cat /proc/sys/kernel/random/uuid)
ATTEMPT=1
MAX=3
ACCEPTED=false

# FINDING: passing --effort to a model that does not support reasoning effort is
# a HARD ERROR ("Model claude-haiku-4.5 does not support reasoning effort
# configuration"), which kills the dispatch before the worker starts. The beads
# convention treats execution_reasoning_effort as a portable hint, so senawa must
# drop it rather than forward it blindly.
EFFORT_ARGS=()
case "$MODEL" in
  gpt-*|*-codex) EFFORT_ARGS=(--effort "$EFFORT") ;;
  *) note "model $MODEL does not accept --effort; dropping the hint" ;;
esac

while [ "$ATTEMPT" -le "$MAX" ]; do
  hdr "4.$ATTEMPT dispatch worker (session $SID, attempt $ATTEMPT/$MAX)"

  if [ "$ATTEMPT" -eq 1 ]; then
    PROMPT="$(senawa task brief)"
    senawa internal emit task.dispatched "{\"task\":\"$TASK\",\"attempt\":1,\"session_id\":\"$SID\",\"actor\":{\"role\":\"implementor\",\"model\":\"$MODEL\",\"effort\":\"$EFFORT\"}}"
    # NOTE: the worker is NOT given shell(node:*). It cannot run the sensors
    # itself, so every reading it gets comes from the harness. Given the ability
    # to run the tests directly it simply self-corrects and the gate never has to
    # refuse anything, which makes for a nice demo and proves nothing.
    OUT=$(cd "$WORK" && env PATH="$WORKER_PATH" timeout 240 "$COPILOT_BIN" -p "$PROMPT" \
      --session-id "$SID" --model "$MODEL" "${EFFORT_ARGS[@]}" \
      --allow-tool 'write' --allow-tool 'shell(senawa:*)' \
      --deny-tool 'shell(git commit)' --deny-tool 'shell(git push)' \
      --no-ask-user -s 2>&1 | tail -3)
  else
    OUT=$(cd "$WORK" && env PATH="$WORKER_PATH" timeout 240 "$COPILOT_BIN" --resume="$SID" -p "$REWORK" \
      --allow-tool 'write' --allow-tool 'shell(senawa:*)' \
      --no-ask-user -s 2>&1 | tail -3)
  fi
  echo "$OUT" | sed 's/^/   worker: /'

  # The orchestrator's gate run is authoritative. Whether or not the worker
  # remembered to call `senawa task done`, the harness decides.
  hdr "5.$ATTEMPT gate: senawa decides, not the worker"
  GATE=$(senawa internal gate)
  echo "$GATE" | jq -r '"   accepted=\(.accepted)  failed=[\(.readings|map(select(.verdict=="fail"))|map(.sensor)|join(","))]"'

  if [ "$(echo "$GATE" | jq -r .accepted)" = "true" ]; then ACCEPTED=true; break; fi

  echo "$GATE" | jq -r '.readings[] | select(.verdict=="fail") | .findings[]? | "     finding: " + .message' | head -4
  REWORK=$(echo "$GATE" | jq -r .next_prompt)
  senawa internal bump
  ATTEMPT=$((ATTEMPT+1))
done

# --- 3. close and report -----------------------------------------------------
hdr "6. outcome"
if [ "$ACCEPTED" = true ]; then
  senawa internal close
  note "task accepted after $ATTEMPT attempt(s); bead closed BY THE HARNESS"
else
  note "attempt budget exhausted; would escalate"
fi

note "bead status: $(BD_JSON_ENVELOPE=1 BEADS_DIR=$WORK/.beads bd show "$TASK" --json 2>/dev/null | jq -r '.data[0].status')  (only the orchestrator can set this)"
note "was test.mjs tampered with? $(diff -q "$HERE/fixture/test.mjs" "$WORK/test.mjs" >/dev/null && echo 'no' || echo 'YES - sensor was edited')"
note "final sum.mjs:"
sed 's/^/     /' "$WORK/src/sum.mjs"

hdr "7. run report"
REPORT=$(senawa work report)
sed 's/^/   /' "$REPORT"
