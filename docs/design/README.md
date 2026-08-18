---
title: Senawa Design
description: Index of the Senawa design set, its vocabulary, and the active execution records
ms.date: 2026-08-16
ms.topic: overview
---

The design set explains why Senawa exists, how its authority model works, and how
every component fits together, in enough depth to reason about the system without
reading the implementation log or the source.

## Design set

Read in this order for a first pass.

* [Design Overview](overview.md) covers the eight governing principles:
  deterministic authority, immutable context, proposal-only agents,
  evidence-backed transitions, intent before effect, durable recovery, bounded
  autonomous loops, and local-first control. Each principle states the problem it
  solves and the shortcut it forbids.
* [Architecture](architecture.md) covers the twelve components, their exact
  dependency edges, what each must never do, and whether each is browser-safe or
  Node only.
* [Authority Model](authority-model.md) covers the command path from submission
  to durable receipt, the per-run monotonic cursor, the effect path from
  persisted intent to committed outcome, run leases and task scope fences, and
  why projections stay derived.
* [Workflow Model](workflow-model.md) covers the canonical graph, typed edges,
  definition generations and supersession, completion accounting, evidence
  policy, sensors and gates, candidate and closure records, budgets and
  escalation, the derived phase lifecycle, and additive amendments.
* [Dataflow](dataflow.md) covers workflow input binding, phase attempts, JSON
  Pointer input mapping, schema-validated phase outputs, the
  `senawa_complete` correction loop, schema-selected fan-out, reviewed plan
  import, and iteration.
* [Durability](durability.md) covers the baseline schema, the current schema
  version, content addressing, transaction boundaries, crash-recovery
  guarantees, backup, restore, and integrity verification.
* [Extending Senawa](extending.md) covers adding an adapter, a sensor, a worker,
  or a transport, which contracts are stable versus internal, and the exact rules
  enforced by `scripts/check-boundaries.mjs`.

Every design page ends with a section naming the test files and scripts that
prove its central claims.

## Vocabulary

Each term is defined here once. A design page uses them without redefining them.

| Term | It means |
|---|---|
| Sensor | A bounded command senawa runs to measure a property of the work. It returns a reading, never a verdict |
| Reading | What one sensor measured, bound to the exact command that produced it |
| Gate | A rule over readings that resists progress while any blocking rule is red |
| Anchor | A deterministic reading. Every blocking gate needs one, or the harness is agreeing with whoever submitted the work |
| Backpressure | Completion granted rather than claimed. An agent requests it; senawa measures and either grants or returns reasons |
| Completion evidence | Attachments an agent offers with a completion. It can be argued with, so it feeds completion accounting and never a gate |
| Gate evidence | The gate definition, its readings, and the evaluation over them. Senawa's own record, which no agent supplies |
| Citation | A source inside an authored output. It informs a reader, not a decision senawa makes |
| Dispatch | One agent assignment: a frozen context, a rendered prompt, a scoped credential, and a task scope claim |
| Candidate | The claim that a phase is ready, naming the exact tasks, outputs, and digests it rests on |
| Closure | A candidate that passed its gate and any declared approval, with the outputs it accepted |
| Escalation | A handover to a person, built from recorded gate evidence rather than an agent's account of it |
| Attempt | One pass at a phase. A refusal starts the next one with the reasons the last was refused |
| Frozen set | Definitions a run may not change under itself. Changing one is an amendment, reviewed and recorded |

## References

* [CLI Reference](../reference/cli.md) for the complete alpha command surface.
* [Local supervisor HTTP](../reference/local-supervisor-http.md) for routes and
  the local security boundary.
* [Remote control plane](../reference/remote-control-plane.md) for enrollment,
  classified synchronization, and reference-server limits.

The [repository README](../../README.md) remains the shortest entry point to the
authority model, the package graph, and the command and effect lifecycle.

Senawa is alpha software. Git history preserves earlier designs; no compatibility
or historical design documents are maintained in the active tree.
