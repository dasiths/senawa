---
title: Production Enhancements
description: Evidence-backed deferred hardening for the Senawa alpha
ms.date: 2026-08-15
ms.topic: reference
---

Every entry records observed evidence, the current pragmatic behavior, its risk
and tradeoff, why it is deferred, the trigger for revisiting it, and a concrete
acceptance test. This log cannot defer a correctness, authority, data-loss,
secret-exposure, or unbounded-cost defect. Anything in those classes is repaired
in the phase that discovers it.

The governing source remains the [Comprehensive Alpha Implementation
Plan](implementation-plan.md), with decisions in the [Implementation
Log](implementation-log.md).

## PE-001: Staged canonical output assets survive a refused submission

Observed evidence
: The Phase 14I proof shows that `submit_phase_output` installs the
content-addressed canonical asset before the broker admits the submission. A
schema-valid submission that conflicts with an already accepted output slot
therefore leaves its bytes in the `phase_output_assets` staging table while
publication is refused.

Current behavior
: Staged bytes are content-addressed, bounded by the declared slot ceiling and
the global 256 KiB output ceiling, and reachable only by an exact validation
receipt digest. No projection, report, portal view, or remote synchronization
exposes an unreferenced staged asset. Every refused admission now records a
durable rejected attempt, so the finite per-slot attempt budget bounds how many
distinct bodies one dispatch can stage.

Risk and tradeoff
: A model can consume bounded local storage with distinct valid-but-conflicting
outputs, capped by the attempt budget multiplied by the output ceiling.
Installing after admission instead would reintroduce the failure mode that
Decision D-033 rejected, where a committed descriptor can name absent bytes.

Deferral reason
: The behavior is bounded, unreferenced, and never observable as authority. A
collector is an operational feature rather than a correctness repair.

Trigger
: Any deployment where the phase output ceiling multiplied by `maxSubmissions`
approaches the operator's storage budget, or the first request for asset
storage accounting.

Acceptance test
: Install a bounded number of conflicting outputs, run the collector, and prove
that every asset not referenced by an accepted submission, a publication, or a
report is removed while every referenced asset is retained byte for byte.

## PE-002: One accepted output slot per dispatch

Observed evidence
: `createTools` builds `submit_phase_output` from the first declared entry in
`context.phaseOutputDeclarations`. A context declaring more than one slot
exposes only the first.

Current behavior
: The standard delivery workflow declares exactly one output per agent phase, so
the limit is not reachable through the shipped template. Additional declarations
are inert rather than silently mixed.

Risk and tradeoff
: A consumer workflow that declares two outputs for one phase receives a tool
for only one of them, and the second can never be submitted by an agent. One
tool per slot would multiply tool count and prompt size per dispatch.

Deferral reason
: No implemented workflow needs it, and a partial implementation would create a
surface that reports and portal views cannot yet explain.

Trigger
: The first consumer workflow that declares more than one output for a single
agent phase, or a template change that needs two outputs.

Acceptance test
: Declare two output slots for one phase, prove one tool exists per slot with
distinct generated parameters, prove each slot validates against its own
schema, prove attempt budgets are counted per slot, and prove closure requires
both accepted outputs.

## PE-003: Model correction behavior is unproven without credits

Observed evidence
: The Phase 14G probe proves the pinned SDK returns a structured failure to the
model verbatim, preserves `resultType`, and permits a corrected second call in
the same session. It does not prove that any particular model chooses to
correct its call.

Current behavior
: Senawa guarantees the correction channel exists, is bounded, and is durably
attributable. Exhaustion follows the declared phase iteration or escalation
policy rather than retrying forever.

Risk and tradeoff
: A model that ignores the feedback consumes its finite attempt budget and
escalates. That is the intended fail-closed outcome, but it means adoption
quality depends on model behavior that no offline test can measure.

Deferral reason
: Measuring it requires paid inference, which the default validation lane must
never require.

Trigger
: Preparing a release note that recommends a specific model, or an operator
report of repeated exhaustion.

Acceptance test
: Run the explicitly opted-in live probe with an accepted schema, an
intentionally invalid first call, and a bounded credit ceiling. Record whether
the model corrected within its budget, and publish the measured model, date, and
attempt count.

## PE-004: One command-driven lifecycle phase per run

Observed evidence
: `instantiate-run` fixes the run's lifecycle phase, and `submit-completion`,
`evaluate-gate`, `record-authority-decision`, and `close-phase` all apply to it.
Decision D-090 records that the consolidated acceptance journey binds that phase
to `implement` and closes the other phases through kernel records.

Current behavior
: Multi-phase workflows execute correctly, but only one phase's lifecycle is
driven by protocol commands within a single run. Phase-keyed lifecycle records
already exist in runtime authority.

Risk and tradeoff
: A consumer that wants command-driven closure for every phase must currently
compose kernel records for the remaining phases. Adding a phase transition
command changes authority surface and needs its own staleness and concurrency
rules.

Deferral reason
: The alpha proves the complete transition chain for the phase that carries the
highest execution risk. A phase-selection command is a new authority contract
rather than a repair.

Trigger
: The first workflow that requires command-driven gate, approval, and closure
for more than one phase in the same run.

Acceptance test
: Add an exact phase transition command, prove it refuses a stale graph
revision, prove it cannot skip an unclosed phase, prove projections follow the
current phase, and prove restart converges on the recorded current phase.
