# Design Working Record

This folder holds non-authoritative design work: proposed decisions, measured
evidence, rejected directions, and the original monolithic architecture
narrative.

Start with the [design index](../README.md) for current implementation guidance.
Use this folder to mature a new idea, audit why a decision exists, or recover
context intentionally removed from the focused guides.

## Contents

| Document | Purpose | Authority |
|----------|---------|-----------|
| [Decision Log](decision-log.md) | Active proposals and their status from question through promotion | Working record; never current architecture by itself |
| [Multi-Agent Orchestration Design](multi-agent-orchestration.md) | Original end-to-end design, including rationale, examples, implementation detail, and open questions | Historical snapshot; superseded by the numbered guides |
| [Probe Findings](probe-findings.md) | Measurements from the Copilot CLI, SDK, beads, sensor, workflow, and principal agent probes | Evidence record; authoritative for what each probe established |
| [Roads Not Taken](roads-not-taken.md) | Approaches tried and discarded, why they were attractive, and what evidence could revive them | Decision history; not a list of current alternatives |

## How ideas mature

1. Add a proposed entry to the decision log and identify the owning numbered
	guide.
2. State the evidence needed to choose between the credible options.
3. Reuse or create the smallest coherent probe that can disprove the idea.
4. Record the result in the probe README, findings record, and decision entry.
5. Promote an accepted result into the owning numbered guide.
6. Record a rejected or superseded result in Roads Not Taken.

The log entry remains as the index to the evidence and final destination. It is
not itself a design contract.

## Historical context

Read the findings when a current guide says a behavior is measured. Read the
monolith when a concise guide omits rationale needed for an implementation
decision. Read Roads Not Taken before proposing a previously discarded shape.

Do not update the monolith with current architecture. It remains a snapshot of
the design before the documentation split. The decision log, findings, and Roads
Not Taken continue to evolve.
