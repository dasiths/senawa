# Design WIP Archive

This folder preserves the working documents that produced the current design.
They contain measurements, abandoned directions, unresolved arguments, and the
original monolithic architecture narrative.

These files are evidence and history, not current implementation guidance. Start
with the [design index](../README.md) and follow the numbered guides. Use this
archive when you need to audit why a decision exists or recover context that was
intentionally removed from the focused guides.

## Contents

| Document | Purpose | Authority |
|----------|---------|-----------|
| [Multi-Agent Orchestration Design](multi-agent-orchestration.md) | Original end-to-end design, including rationale, examples, implementation detail, and open questions | Historical snapshot; superseded by the numbered guides |
| [Proof-of-Concept Findings](poc-findings.md) | Measurements from the Copilot CLI, SDK, beads, sensor, workflow, and principal agent probes | Evidence record; authoritative for what each probe established |
| [Roads Not Taken](roads-not-taken.md) | Approaches tried and discarded, why they were attractive, and what evidence could revive them | Decision history; not a list of current alternatives |

## How to use the archive

Read the findings when a current guide says a behavior is measured. Read the
monolith when a concise guide omits rationale needed for an implementation
decision. Read Roads Not Taken before proposing a previously discarded shape.

When new evidence changes the design:

1. Update the owning probe and its local README.
2. Record the measurement in the findings document.
3. Update the affected numbered guide.
4. Move displaced rationale into Roads Not Taken.

Do not add new current-state architecture to the monolith. It remains a snapshot
of the design before the documentation split.
