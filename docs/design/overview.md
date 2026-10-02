# Design Overview

Senawa executes consumer-defined workflows as a deterministic state machine. A
run is a sequence of immutable, content-addressed records derived from exact
authority facts. Given the same facts, the same decision follows, which is what
makes a run replayable, auditable, and resumable from the boundary where it
stopped.

Eight principles govern the design. Each exists because a specific failure mode
would otherwise be unavoidable, and each forbids a class of shortcut that would
reintroduce it.

## Deterministic authority

The kernel is a pure decision function. It has no dependencies at all:
[packages/kernel/package.json](../../packages/kernel/package.json) declares no
`dependencies` field. It cannot read a clock, generate randomness, touch a
filesystem, open a socket, or spawn a worker.

The problem this solves is unreproducible decisions. When a decision function
can read ambient state, two identical inputs can produce two different outcomes,
and no audit can tell which one was correct. Senawa removes ambient state from
the decision path entirely: current time, allocated identifiers, and external
observations arrive as explicit facts through `AdmissionFacts` in
[packages/runtime/src/ports.ts](../../packages/runtime/src/ports.ts).

What it forbids:

* `Date.now`, `Math.random`, `process.*`, `fetch(`, and `Worker(` anywhere in
  kernel source.
* Any kernel import of an effect or adapter package.
* Node built-in imports in kernel, protocol, runtime, reporting, configuration,
  and portal production source.

These are not conventions. They are assertions in
[scripts/check-boundaries.mjs](../../scripts/check-boundaries.mjs), which also
self-tests each rule against a synthetic violating file before reporting
success.

## Immutable context

Every worker dispatch runs against a frozen context. A `WorkerContextBase`
carries the repository base, the prompt resources, the mapped inputs, the model
route, and the asset bindings that existed when the context was sealed, and it
is identified by a digest over that content. See
[packages/kernel/src/context.ts](../../packages/kernel/src/context.ts).

The problem this solves is the moving target. If an agent can observe the
workspace changing underneath it, its output describes a state that no longer
exists, and a reviewer cannot reconstruct what the agent actually saw. Sealing
the context makes the agent's view a durable, addressable fact.

What it forbids:

* Reading a repository asset without an explicit grant. Reads flow through the
  context broker in
  [packages/runtime/src/context-broker.ts](../../packages/runtime/src/context-broker.ts),
  which records an audit receipt for every attempt and every denial.
* Mutating a context after dispatch. A changed input produces a new context
  digest and a new dispatch, not an edit.
* Silent widening. A grant names one asset binding, one pointer, and one read
  mode, and a read outside those bounds is denied and recorded.

## Proposal-only agents

An agent never changes authority. It submits. The tool surface in
[packages/execution-host/src/copilot-worker.ts](../../packages/execution-host/src/copilot-worker.ts)
is seven authority tools plus four workspace tools. The submitting tools
(`submit_question`, `propose_asset`, `record_discovery`, `propose_amendment`,
`senawa_complete`) all route through the context
broker, which admits, defers, or refuses. `senawa_read_asset` reads only what a
grant permits, and every read attempt is audited.

An agent can propose an amendment to the workflow graph. It cannot apply one.
Application requires a recorded human decision followed by a separate
`apply-approved-amendment` command, as modelled in
[packages/kernel/src/amendments.ts](../../packages/kernel/src/amendments.ts).

The problem this solves is authority laundering. Model output is persuasive
text; treating it as a decision means a sufficiently confident hallucination
becomes system state. Senawa classifies model output, central receipts, and
prompt text as evidence.

What it forbids:

* A tool that writes an authority record directly.
* A prompt or model response that widens a capability. The compiler rejects
  `authority-widening` and `forbidden-role-prompt` documents at configuration
  time; see the diagnostic codes in
  [packages/configuration/src/contracts.ts](../../packages/configuration/src/contracts.ts).
* Unbounded submission. Route limits (`maxTurns`, `maxSubmissions`,
  `maxMillidollars`) are declared per model route and enforced per dispatch.

## Evidence-backed transitions

A phase does not advance because something reported success. It advances because
recorded facts satisfy a declared policy.

Task completion is assessed by `assessCompletionAccounting` in
[packages/kernel/src/completion.ts](../../packages/kernel/src/completion.ts),
which checks each declared criterion against a submitted disposition and checks
attached evidence against a `CompletionEvidencePolicy` whose mode is one of
`none`, `task`, `required-criteria`, or `all-satisfied`. Gate evaluation in
[packages/kernel/src/gates.ts](../../packages/kernel/src/gates.ts) reduces sensor
readings through a three-valued logic where the third value is `unknown`, and a
gate is accepted only when every blocking rule evaluates to `true`.

The problem this solves is optimistic closure. A binary pass or fail collapses
"the check failed" and "the check did not run" into the same answer. Senawa keeps
them distinct and treats absence of evidence as a rejection rather than a pass.

What it forbids:

* Treating an unread sensor as a passing sensor.
* Skipping a criterion marked `required`. That produces a `required-skip` error.
* Waiving a criterion without the declared waiver authority.

## Intent before effect

Before anything external happens, the runner writes an `EffectIntent` carrying
the command, the owning runner, the lease fence, and an attempt identifier. Only
then does it call the effect host. When the host returns, or fails to return, the
runner reconciles the observation before committing an `EffectOutcome`. The
contracts are in
[packages/runtime/src/runner.ts](../../packages/runtime/src/runner.ts).

The problem this solves is the crash window. A process that acts first and
records afterwards cannot distinguish "never started" from "started and died",
so recovery either duplicates the work or abandons it.

What it forbids:

* Committing an outcome that was never preceded by a persisted intent.
* Discarding an uncertain result. `EffectStatus` includes `unknown`, and the
  scheduler in `scheduleRunnerTransitions` keeps `active` and `unknown` effects
  in the reconcilable set until they settle.
* Acting without a fence. Every mutation path takes a `RunnerLeaseFact` with an
  `owner`, a monotonic `fence`, and an expiry.

## Durable recovery

State lives in SQLite with `journal_mode = WAL`, `synchronous = FULL`,
`foreign_keys = ON`, and `trusted_schema = OFF`, configured in
[packages/storage-sqlite/src/index.ts](../../packages/storage-sqlite/src/index.ts).
Authority mutations run inside `BEGIN IMMEDIATE` transactions and roll back on
any error.

Recovery is not best-effort. The storage and supervisor layers expose named
fault injection points (`SqliteFaultPoint`, `SupervisorFaultPoint`) that let
tests kill the process at each dangerous boundary and then assert that restart
converges on exactly one outcome.

The problem this solves is divergent restart. Without a single committing
authority, two components can hold two beliefs about the same command.

What it forbids:

* A mutable status column that a later write can overwrite. Phase state is
  projected, not stored; see [workflow-model.md](workflow-model.md).
* In-place repair of corrupt authority. `senawa repair plan` permits only
  restoration of a verified backup to a fresh state root.

## Bounded autonomous loops

Every loop that can run without a human carries a finite ledger. `BUDGET_UNITS`
in [packages/kernel/src/budgets.ts](../../packages/kernel/src/budgets.ts)
enumerates six units: `work-attempt`, `dispatch-failure`, `sensor-retry`,
`review-iteration`, `integration-attempt`, and `rebase-attempt`. Exhaustion
produces an `Escalation`, not a retry.

Only `review-iteration` is demanded of every phase. The other five remain
declarable, and an authored workflow states none of them.

Phase iteration follows the same shape. `planPhaseAttemptTransition` in
[packages/kernel/src/iteration.ts](../../packages/kernel/src/iteration.ts)
consumes one `review-iteration` unit per attempt and resolves to the declared
`exhaustion` disposition, `escalate` or `fail`, when the ledger runs out.

The problem this solves is the silent burn. An autonomous retry loop with no
ceiling converts a transient failure into unbounded cost.

What it forbids:

* Retry without accounting.
* An escalation that resolves itself. Allowance grants come from
  `grant-allowance` commands bound to an escalation digest and an expected
  current limit.

## Local-first control

The supervisor listens on a private Unix socket with a file-permission-scoped
credential, plus a session-authenticated loopback listener for the portal. See
[packages/supervisor/src/local-security.ts](../../packages/supervisor/src/local-security.ts)
and [packages/supervisor/src/session-security.ts](../../packages/supervisor/src/session-security.ts).
The outbound remote connector is disabled unless the daemon inherits both
`SENAWA_REMOTE_ENDPOINT` and `SENAWA_REMOTE_KEY_FILE`.

The problem this solves is remote capture. If a remote service can decide, then
losing the network means losing the ability to work, and trusting the network
means trusting it with source and credentials.

What it forbids:

* A remote peer deciding local authority. The reference server in
  [apps/control-plane](../../apps/control-plane) may depend only on
  `@senawa/protocol`; it holds no kernel and no storage.
* Unclassified synchronization. `RemoteSynchronizationDeclaration` sets a
  classification ceiling of `public` or `internal` and toggles receipt chain,
  events, projections, and synchronization state independently.
* Source or credential egress. See the
  [remote control-plane reference](../reference/remote-control-plane.md).

## Where the principles meet

The principles reinforce each other. Deterministic authority is only useful if
the facts it consumes are durable, so durable recovery exists. Durable recovery
is only safe if effects cannot duplicate, so intent precedes effect. Effects
cannot be trusted if an agent can widen its own authority, so agents propose.
Proposals need a decision rule, so transitions are evidence-backed. Evidence
takes work to produce, so loops are bounded. Bounded loops need somewhere to
escalate, so control stays local.

Read [architecture.md](architecture.md) for the component boundaries that carry
these rules, and [authority-model.md](authority-model.md) for the exact command
and effect lifecycle.

Behavior that is deliberately deferred is recorded in
[Production Enhancements](WIP/redesign-1/production-enhancements.md) rather than described here.

## How this is proven

* Boundary rules and their self-tests: [scripts/check-boundaries.mjs](../../scripts/check-boundaries.mjs).
* Deterministic kernel decisions: [packages/kernel/src/run.test.ts](../../packages/kernel/src/run.test.ts)
  and [packages/kernel/src/canonical.test.ts](../../packages/kernel/src/canonical.test.ts).
* Evidence-backed completion and gates: [packages/kernel/src/completion.test.ts](../../packages/kernel/src/completion.test.ts)
  and [packages/kernel/src/gates.test.ts](../../packages/kernel/src/gates.test.ts).
* Bounded loops and escalation: [packages/kernel/src/budgets.test.ts](../../packages/kernel/src/budgets.test.ts)
  and [packages/kernel/src/iteration.test.ts](../../packages/kernel/src/iteration.test.ts).
* Intent before effect and reconciliation: [packages/testing/src/runner-conformance.test.ts](../../packages/testing/src/runner-conformance.test.ts).
* Proposal-only agent surface: [packages/execution-host/src/copilot-worker.test.ts](../../packages/execution-host/src/copilot-worker.test.ts).
* Local transport trust: [packages/supervisor/src/http-security.test.ts](../../packages/supervisor/src/http-security.test.ts)
  and [packages/supervisor/src/session-security.test.ts](../../packages/supervisor/src/session-security.test.ts).
