# Senawa Proof-of-Concept Probes

## Overview

Throwaway code with a durable purpose. Each folder answers one question from
[the design](../docs/design/README.md) with evidence you can
reproduce, and every folder carries a README stating its goal, what it proved,
what it did not prove, and a dated change log.

Findings are consolidated in
[the POC findings](../docs/design/wip/poc-findings.md). That document
is the cross-cutting evidence record; these folders are the machinery that
produced it. Current architecture lives in the numbered design guides.

| Probe                                            | Question                                                                        | Cost         |
|--------------------------------------------------|---------------------------------------------------------------------------------|--------------|
| [hook-latency](hook-latency/README.md)           | Is a bundled Node CLI fast enough to run as a `preToolUse` hook?                | offline      |
| [hook-enforcement](hook-enforcement/README.md)   | Do hooks genuinely block a tool call, and how do they fail?                      | AI credits   |
| [beads-graph](beads-graph/README.md)             | Does the `bd` contract behave the way the graph adapter needs, under contention? | offline      |
| [worker-sessions](worker-sessions/README.md)     | Do worker sessions resume with their own memory and stay out of the user's history? | AI credits |
| [model-routing](model-routing/README.md)         | Does per-task model selection survive delegation, and what does telemetry report? | AI credits |
| [sdk-surface](sdk-surface/README.md)             | Which control points does the SDK expose, and do they compose safely?            | AI credits   |
| [sensors](sensors/README.md)                     | Do sensor contracts, evidence hygiene, and inferential trust hold up?            | mixed        |
| [orchestration](orchestration/README.md)         | Can the harness own the task loop, run a workflow from durable state, and be driven by an agent? | mixed |

## How these probes are maintained

One folder per subject, and the count stays small on purpose. When new research
changes our understanding, amend the probe that owns that subject and add a
dated entry to its change log rather than adding another folder. A probe folder
should always describe the current solution shape; its README carries the
history that explains how the shape got there.

Two conventions keep that workable. `run.sh` is the safe default entry point for
a folder and never spends AI credits unless its header says so, and anything
that does spend credits lives in a separately named script. Superseded code is
either deleted or renamed to describe the evidence it still provides, so nothing
in a folder is left implying a mechanism we no longer intend to build.

## Running

Every probe is runnable from anywhere in the repository:

```bash
bash poc/sensors/run.sh
```

Offline probes need no Copilot subscription. Probes that spend credits say so in
their header and use `claude-haiku-4.5` unless the question is specifically
about model selection.
