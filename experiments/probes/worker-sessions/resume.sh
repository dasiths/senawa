#!/usr/bin/env bash
# Session resume - Does a resumed worker session actually remember what it built?
#
# The rework loop is the core of Topology B1: rather than restarting a fresh
# agent that has to rediscover the change, senawa resumes the SAME session and
# hands it the sensor failures. That only pays off if resume genuinely restores
# the worker's own memory of its work.
#
# Also checks the plumbing senawa dispatch depends on:
#   - --session-id creates a session at a caller-chosen UUID
#   - --resume=<id> continues it non-interactively
#   - --share writes a transcript senawa can file under tasks/<id>/
#   - --output-format json emits parseable JSONL
#
# SPENDS AI CREDITS: three short claude-haiku-4.5 prompts.
set -uo pipefail

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
git init -q .

hdr() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }

SID=$(cat /proc/sys/kernel/random/uuid)
TOKEN="ZEPHYR-$RANDOM"
note "session id: $SID"
note "secret token the worker will invent a use for: $TOKEN"

# ---------------------------------------------------------------------------
hdr "1. first turn: create a session at a caller-chosen UUID and do some work"

timeout 180 copilot -p "Create a file called widget.txt whose only contents are the word $TOKEN. Then briefly say what you did." \
  --session-id "$SID" \
  --model claude-haiku-4.5 \
  --allow-all-tools \
  --share "$WORK/transcript.md" \
  -s 2>&1 | tail -3 | sed 's/^/   agent: /'

note "file written?    $([ -f widget.txt ] && cat widget.txt || echo MISSING)"
note "transcript file? $([ -f "$WORK/transcript.md" ] && wc -c < "$WORK/transcript.md" || echo MISSING) bytes"

# ---------------------------------------------------------------------------
hdr "2. resume the SAME session and test recall (the rework loop)"

# Deliberately does not repeat the token. If resume works, the worker knows it.
RECALL=$(timeout 180 copilot --resume="$SID" \
  -p "Without reading any file, what exact word did you put in widget.txt? Answer with just that word." \
  --allow-all-tools -s 2>&1 | tail -3)
echo "$RECALL" | sed 's/^/   agent: /'

if echo "$RECALL" | grep -q "$TOKEN"; then
  note "RESULT: resume restored the worker's own memory"
else
  note "RESULT: resume did NOT restore memory - rework would need re-briefing"
fi

# ---------------------------------------------------------------------------
hdr "3. a fresh session must NOT know it (control)"

FRESH=$(timeout 180 copilot -p "Without reading any file, what exact word did you put in widget.txt? If you do not know, say UNKNOWN." \
  --model claude-haiku-4.5 --allow-all-tools -s 2>&1 | tail -3)
echo "$FRESH" | sed 's/^/   agent: /'
echo "$FRESH" | grep -q "$TOKEN" \
  && note "RESULT: leaked across sessions (unexpected)" \
  || note "RESULT: correctly isolated"

# ---------------------------------------------------------------------------
hdr "4. --output-format json shape"

timeout 180 copilot -p "say ok" --model claude-haiku-4.5 --allow-all-tools \
  --output-format json 2>/dev/null | head -4 | cut -c1-160 | sed 's/^/   /'
note "distinct event types: $(timeout 180 copilot -p 'say ok' --model claude-haiku-4.5 --allow-all-tools --output-format json 2>/dev/null | jq -r '.type // .event // empty' 2>/dev/null | sort -u | tr '\n' ' ')"

hdr "done"
