# Model Routing Probe

## Goal

Senawa assigns a model and a reasoning effort per task, so it needs to know
whether those choices survive delegation and how to observe what actually ran.
Asking a model which model it is produces confident fiction, so this probe uses
the OpenTelemetry file exporter as its measuring instrument.

## What it proves

Custom agents are discovered and delegated to correctly. A profile in
`.github/agents/` appeared alongside the built-ins, and both `subagentStart` and
`subagentStop` fired with the profile's name. The payloads also carry `agentId`,
`agentType`, `agentDisplayName`, and `agentDescription`, which is more than the
reference documents describe.

The built-in `general-purpose` agent emitted both hooks as well, contradicting
documentation that says it emits neither. The rule to always dispatch a named
custom agent still stands, but it should be justified by uniformity rather than
by that documented claim.

OpenTelemetry does not deliver per-role cost in `-p` mode. Only the top-level
`invoke_agent` span was exported, so cost per dispatched session must come from
the JSONL event stream instead.

The AIU attribute is `github.copilot.nano_aiu`. There is no
`github.copilot.aiu`. Also present and useful: `github.copilot.cost`,
`github.copilot.agent.type`, `github.copilot.context.custom_agent_names`,
`github.copilot.git.branch`, and `gen_ai.usage.reasoning.output_tokens`.

## What it does not prove

The Auto trap remains open, and it is the highest-value unvalidated claim in the
project. With the session model set to `auto`, the top-level span recorded
`auto`, and because no subagent spans are exported there was no way to observe
which model the subagent actually received. The rule to pin an explicit model on
the principal session currently rests on documentation alone. Settling it needs
an SDK-hosted session or a real OTLP collector.

## Layout

| Path          | Role                                                                     |
|---------------|---------------------------------------------------------------------------|
| `run.sh`      | Profile model, named-agent hooks, `general-purpose` hooks, the Auto case, span attributes |
| `followup.sh` | Raw hook payloads, agent discoverability, and every exported `invoke_agent` span |

## Running

```bash
bash experiments/probes/model-routing/run-live.sh        # spends AI credits
bash experiments/probes/model-routing/followup.sh   # spends AI credits
```

## Change log

| Date       | Change                                                                                                                                    |
|------------|-----------------------------------------------------------------------------------------------------------------------------------------------|
| 2026-07-28 | First run. Confirmed profile model routing and named-agent subagent hooks. Found that `general-purpose` also emits them, that no subagent spans are exported in `-p`, and that the AIU attribute name in the design was wrong. Left the Auto trap unresolved. |
| 2026-08-02 | Renamed from `06-model-routing` during probe consolidation. No behavioural change.                                                        |
