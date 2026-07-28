# Senawa proof-of-concept probes

Throwaway code. Each directory answers one question from
[the design](../docs/design/multi-agent-orchestration.md) with evidence, and is
independent of every other directory: no shared state, no ordering requirement,
no shared build. Delete any of them without consequence.

Findings are written up in [poc-findings.md](../docs/design/poc-findings.md).
That document is the durable output; this directory is the scaffolding that
produced it.

| Probe | Question | Cost |
|-------|----------|------|
| `01-hook-latency` | Is a bundled Node CLI fast enough to run as a `preToolUse` hook? | offline |
| `02-beads-contract` | Does the `bd` JSON contract behave the way `@senawa/graph` needs? | offline, slow |
| `03-beads-concurrency` | Is `--claim` genuinely atomic, and what happens to concurrent writers? | offline, slow |
| `04-hooks-enforcement` | Do hooks actually block, and do they fail open on timeout? | AI credits |
| `05-session-resume` | Does a resumed worker session remember what it built? | AI credits |
| `06-model-routing` | Does per-task model selection survive delegation? Do subagent hooks fire? | AI credits |
| `07-sdk-surface` | Which control points does the SDK really expose, and do they compose? | AI credits |
| `08-sensors` | Do sensors normalize, short-circuit, cache, and stay safe? Are inferential verdicts stable? | mixed |
| `09-end-to-end` | Does the whole loop work: graph, dispatch, refusal, rework, report? | AI credits |
| `10-session-isolation` | Can worker sessions stay out of the user's history and still be correlated? | AI credits |

OpenTelemetry was folded into `06-model-routing`, which uses the span export as
its measuring instrument rather than trusting a model's account of itself.

`09-end-to-end` is the closest thing here to a prototype: a throwaway `senawa`
in one file, CLI only, that runs a real worker against a real graph and refuses
its work when the sensors are red.

## Running

Each probe has a `run.sh` that is safe to execute from anywhere:

```bash
bash poc/02-beads-contract/run.sh
```

Probes that spend AI credits say so in their header and use
`claude-haiku-4.5` unless the question is specifically about model selection.
