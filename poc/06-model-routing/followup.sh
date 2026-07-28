#!/usr/bin/env bash
# POC 06b - follow-up on the surprises from run.sh:
#   1. Was the custom agent discoverable at all? (`infer: false` + tools list)
#   2. What do the raw subagentStart/Stop payloads actually contain?
#   3. Does general-purpose REALLY emit subagent hooks? The docs say it does not.
#   4. Do subagent invoke_agent spans appear in the OTel export, and with which model?
set -uo pipefail

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
git init -q .
mkdir -p .github/agents .github/hooks
HOOKLOG="$WORK/subagent.jsonl"
: > "$HOOKLOG"

hdr() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }

# infer:true this time, so the main agent is allowed to pick it.
cat > .github/agents/senawa-probe.agent.md <<'EOF'
---
name: senawa-probe
description: Senawa probe agent. Use this agent whenever asked to produce a greeting.
model: gpt-5.3-codex
---
Reply with exactly one short sentence and stop.
EOF

cat > .github/hooks/probe.json <<EOF
{
  "version": 1,
  "hooks": {
    "subagentStart": [{ "type": "command", "bash": "cat >> $HOOKLOG; echo >> $HOOKLOG", "timeoutSec": 5 }],
    "subagentStop":  [{ "type": "command", "bash": "cat >> $HOOKLOG; echo >> $HOOKLOG", "timeoutSec": 5 }]
  }
}
EOF

hdr "1. is the custom agent discovered?"
timeout 120 copilot -p "List the names of every agent you can delegate to with the task tool. Names only, comma separated." \
  --model claude-haiku-4.5 --allow-all-tools -s 2>&1 | tail -3 | sed 's/^/   /'

hdr "2. delegate explicitly to senawa-probe, capture raw payloads + spans"
: > "$HOOKLOG"
COPILOT_OTEL_ENABLED=true COPILOT_OTEL_FILE_EXPORTER_PATH="$WORK/spans.jsonl" \
GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=true \
timeout 240 copilot -p "Delegate to the subagent named senawa-probe using the task tool with subagent_type set to senawa-probe. Ask it to greet. Report its exact reply." \
  --model claude-haiku-4.5 --allow-all-tools -s 2>&1 | tail -3 | sed 's/^/   agent: /'

note "raw hook payloads:"
sed 's/^/     /' "$HOOKLOG" | cut -c1-220 | head -6

note "agent names seen in hooks: $(jq -rs '[.[]|.agentName // .agent_name] | unique | join(", ")' "$HOOKLOG" 2>/dev/null)"

hdr "3. every invoke_agent span in the export"
if [ -s "$WORK/spans.jsonl" ]; then
  jq -r '.. | objects | select(.name? == "invoke_agent") | (.attributes // {}) as $a |
    "   name=" + (($a["gen_ai.agent.name"] // "(top-level)")|tostring) +
    " id=" + (($a["gen_ai.agent.id"] // "-")|tostring) +
    " model=" + (($a["gen_ai.request.model"] // "?")|tostring) +
    " aiu=" + (($a["github.copilot.aiu"] // "-")|tostring)' "$WORK/spans.jsonl" | sort -u
  note "attribute keys present on invoke_agent spans:"
  jq -r '.. | objects | select(.name? == "invoke_agent") | (.attributes // {}) | keys[]' "$WORK/spans.jsonl" 2>/dev/null | sort -u | sed 's/^/     /' | head -25
else
  note "(otel file empty - spans may not be written in -p mode)"
fi

hdr "done"
