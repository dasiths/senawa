---
title: Senawa Design
description: Index of the Senawa alpha design set and active execution records
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
  `submit_phase_output` correction loop, schema-selected fan-out, reviewed plan
  import, and iteration.
* [Durability](durability.md) covers the thirteen migrations, the current schema
  version, content addressing, transaction boundaries, crash-recovery
  guarantees, backup, restore, and integrity verification.
* [Extending Senawa](extending.md) covers adding an adapter, a sensor, a worker,
  or a transport, which contracts are stable versus internal, and the exact rules
  enforced by `scripts/check-boundaries.mjs`.

Every design page ends with a section naming the test files and scripts that
prove its central claims.

## Execution records

* The [Comprehensive Alpha Implementation Plan](implementation-plan.md) is the
  active architecture and execution source.
* The [Implementation Log](implementation-log.md) records major choices,
  deviations, validation, commits, and pushes.
* [Production Enhancements](production-enhancements.md) records evidence-backed
  deferred hardening. Behavior listed there is not described as delivered
  anywhere in the design set.

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
