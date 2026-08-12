# Design Working Record

This folder holds non-authoritative design work: proposed redesign research,
decision status, measured evidence, and rejected directions.

Start with the [design index](../README.md) for current implementation guidance.
Use this folder to mature a new idea, audit why a decision exists, or recover
context intentionally removed from the focused guides.

## Contents

| Document | Purpose | Authority |
|----------|---------|-----------|
| [Redesign Research](research/README.md) | Focused research for the software-factory redesign | Proposed direction; not current architecture |
| [Decision Log](decision-log.md) | Active proposals and their status from question through promotion | Working record; never current architecture by itself |
| [Probe Findings](probe-findings.md) | Measurements from the Copilot CLI, SDK, beads, sensor, workflow, and principal agent probes | Evidence record; authoritative for what each probe established |
| [Roads Not Taken](roads-not-taken.md) | Approaches tried and discarded, why they were attractive, and what evidence could revive them | Decision history; not a list of current alternatives |
| [Workflow State Machine Redesign](workflow-state-machine-redesign.md) | Compatibility pointer to the focused redesign research | Signpost only |
| [Multi-Agent Orchestration Design](multi-agent-orchestration.md) | Compatibility pointer for links to the superseded monolith | Signpost only |

## How ideas mature

1. Add a proposed entry to the decision log and identify the owning numbered
	guide.
2. State the evidence needed to choose between the credible options.
3. Reuse or create the smallest coherent probe that can disprove the idea.
4. Record the result in the probe README, findings record, and decision entry.
5. Promote an accepted result into a new authoritative guide when the
	implementation phase passes.
6. Record a rejected or superseded result in Roads Not Taken.

The log entry remains as the index to the evidence and final destination. It is
not itself a design contract.

## Reading order

Start with [Product Vision and Design
Principles](research/01-product-vision-and-principles.md), then follow the
[research index](research/README.md). These documents intentionally reconsider
old implementation decisions rather than treating them as constraints.

Read Probe Findings when a claim depends on measured behavior. Read Roads Not
Taken when evaluating a previously rejected approach. The decision log records
whether research has become a proposal, probe, accepted design, rejection, or
supersession.

The old monolithic narratives have been reduced to compatibility pointers. Their
durable principles are consolidated into the focused research set, measured
claims remain in Probe Findings, and rejected rationale remains in Roads Not
Taken.
