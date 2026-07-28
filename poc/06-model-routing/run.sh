#!/usr/bin/env bash
# POC 06 - Does per-task model selection survive delegation, and do subagent
#          hooks fire? Uses the OTel file exporter as the measuring instrument,
#          because asking a model what model it is produces confident fiction.
#
# Checks:
#   A. A custom agent profile's `model` is honoured when dispatched with --agent
#   B. subagentStart / subagentStop fire for a NAMED custom agent
#   C. ...and do NOT fire for the built-in general-purpose agent
#   D. The Auto trap: with the session model set to auto, does the subagent
#      still get the model its profile asked for?
#   E. What invoke_agent spans actually carry (aiu, cost, agent name)
#
# SPENDS AI CREDITS: four short delegating prompts.
set -uo pipefail

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
git init -q .

hdr() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }

mkdir -p .github/agents .github/hooks
HOOKLOG="$WORK/subagent.log"
: > "$HOOKLOG"

cat > .github/agents/senawa-probe.agent.md <<'EOF'
---
name: senawa-probe
description: Probe agent used by a senawa proof of concept. Answers one trivial question and stops.
model: gpt-5.3-codex
tools: ["view", "glob", "grep"]
infer: false
---
You are a probe. Reply with exactly one short sentence and stop. Do not use tools.
EOF

cat > .github/hooks/probe.json <<EOF
{
  "version": 1,
  "hooks": {
    "subagentStart": [
      { "type": "command", "bash": "cat >> $HOOKLOG; echo >> $HOOKLOG", "timeoutSec": 5 }
    ],
    "subagentStop": [
      { "type": "command", "bash": "cat >> $HOOKLOG; echo >> $HOOKLOG", "timeoutSec": 5 }
    ]
  }
}
EOF

run_with_otel() { # $1 = otel file, $2.. = copilot args
  local otel="$1"; shift
  COPILOT_OTEL_ENABLED=true \
  COPILOT_OTEL_FILE_EXPORTER_PATH="$otel" \
  GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=true \
  timeout 240 copilot "$@" --allow-all-tools -s 2>&1 | tail -2
}

# span model per agent name, from the OTel file export
spans() { # $1 = otel file
  [ -s "$1" ] || { echo "   (no spans written)"; return; }
  jq -r '
    .. | objects | select(.name? == "invoke_agent") |
    (.attributes // {}) as $a |
    "   agent=" + (($a["gen_ai.agent.name"] // "(top-level)")|tostring) +
    "  model=" + (($a["gen_ai.request.model"] // "?")|tostring) +
    "  aiu=" + (($a["github.copilot.aiu"] // "?")|tostring) +
    "  cost=" + (($a["github.copilot.cost"] // "?")|tostring)
  ' "$1" 2>/dev/null | sort -u | head -12
}

# ---------------------------------------------------------------------------
hdr "A. --agent honours the profile model (profile says gpt-5.3-codex)"
run_with_otel "$WORK/a.jsonl" -p "Say hello in one sentence." --agent senawa-probe >/dev/null
spans "$WORK/a.jsonl"

# ---------------------------------------------------------------------------
hdr "B. subagentStart/Stop for a NAMED custom agent"
: > "$HOOKLOG"
run_with_otel "$WORK/b.jsonl" -p "Use the task tool to delegate to the senawa-probe agent, asking it to say hello. Then report its reply." --model claude-haiku-4.5 >/dev/null
note "hook events captured: $(grep -c . "$HOOKLOG")"
jq -r '"   " + (.hook_event_name // "camelCase") + " agentName=" + (.agentName // .agent_name // "?")' "$HOOKLOG" 2>/dev/null | head -4 \
  || sed 's/^/   raw: /' "$HOOKLOG" | head -4
spans "$WORK/b.jsonl"

# ---------------------------------------------------------------------------
hdr "C. subagentStart/Stop for the built-in general-purpose agent"
: > "$HOOKLOG"
run_with_otel "$WORK/c.jsonl" -p "Use the task tool with the general-purpose agent to answer: what is 2+2? Report its reply." --model claude-haiku-4.5 >/dev/null
note "hook events captured: $(grep -c . "$HOOKLOG")  (design predicts 0)"
spans "$WORK/c.jsonl"

# ---------------------------------------------------------------------------
hdr "D. the Auto trap: session model auto, subagent profile says gpt-5.3-codex"
: > "$HOOKLOG"
run_with_otel "$WORK/d.jsonl" -p "Use the task tool to delegate to the senawa-probe agent, asking it to say hello. Then report its reply." --model auto >/dev/null
spans "$WORK/d.jsonl"
note "if the subagent row shows a model other than gpt-5.3-codex, the profile was overridden"

hdr "done"
