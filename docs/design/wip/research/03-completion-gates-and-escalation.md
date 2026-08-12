# Completion, Gates, Escalation, and Closure

This document records proposed redesign research. It separates completion
accounting, evidence, measurement, authority, and closure so an agent cannot
collapse them into one claim of success.

## Executive finding

Senawa needs seven non-interchangeable durable records:

1. Completion submission
2. Accounting assessment
3. Evidence attachments
4. Sensor readings
5. Gate evaluation
6. Authority decision
7. Closure record

Mutable statuses such as `closed`, `accepted`, and `finished` should be rebuildable
projections of those records. They are not proof by themselves.

## Semantic boundaries

| Record | Question answered | Author |
|--------|-------------------|--------|
| Completion submission | What outcome does the responsible actor assert? | Worker or authorized human |
| Accounting assessment | Did the submission explicitly address every obligation? | Deterministic reducer |
| Evidence attachment | What material does the actor cite in support? | Attributed producer |
| Sensor reading | What external condition was observed for this candidate? | Sensor runner |
| Gate evaluation | Do exact readings satisfy frozen policy? | Deterministic evaluator |
| Approval or waiver | Did an authorized principal accept this exact object or exception? | Human or named policy authority |
| Closure | Are all required accounts, gates, approvals, and replacement chains resolved? | Deterministic reducer |

Evidence attachment does not imply truth. Schema validity does not imply
relevance. A passing sensor does not imply human approval. Human approval does
not rewrite a failed gate unless the workflow explicitly permits a scoped
waiver.

## Kernel accounting floor

The kernel should require:

* One explicit terminal disposition per task generation
* A non-empty completion summary
* One explicit outcome for every declared criterion
* Stable criterion identities with no duplicates or omissions
* An attributed submission bound to task, attempt, dispatch, and context basis

The workflow decides where evidence is mandatory:

* Every satisfied criterion
* Required criteria only
* Once per task
* At phase aggregation
* Nowhere beyond the summary and account

An evidence requirement may constrain kind, schema, minimum count, scope,
freshness, sensitivity, and waiver authority. Missing required evidence fails
accounting. Senawa does not claim that attached evidence proves the account.

## Task dispositions

The initial disposition set should distinguish:

| Disposition | Meaning |
|-------------|---------|
| `completed` | Actor claims the work and applicable criteria are satisfied |
| `blocked` | Actor cannot continue within current authority or information |
| `waived` | An authorized exception releases an obligation |
| `skipped` | Optional work is intentionally not performed |
| `superseded` | A replacement generation owns the remaining obligation |

Required work cannot be skipped. A required waiver needs exact authority and a
reason. Optional work still needs an explicit disposition. Supersession counts
only when an acyclic replacement chain reaches accepted terminal work.

`blocked` should escalate immediately rather than wasting rework attempts. The
submission names the blocker, attempted actions, required decision or capability,
and relevant evidence.

## Task completion sequence

```text
dispatch result
  -> completion submission
  -> deterministic accounting assessment
  -> configured task sensors and gate
  -> accepted disposition or bounded rework
  -> integrated result when repository changes exist
  -> closed projection
```

Every step binds to exact input, task-contract, context, repository, sensor,
gate-policy, and result digests. A stale result remains evidence but cannot close
the current task generation.

## Phase completion candidate

A phase must not complete by querying whether every mutable task row says
`closed`. Senawa creates an immutable phase candidate containing:

* Phase definition and generation
* Exact selected task-set revision
* Effective task generations and dispositions
* Completion submissions and accounting assessments
* Dependency and integration barrier digests
* Phase criteria and evidence requirements
* Gate-policy revision
* Candidate digest and creation event

Sensors associated with the phase exit gate run against that candidate and the
candidate's repository or artifact state. A passing gate makes the candidate
eligible for any configured approval. It does not itself approve the phase.

Any relevant task, asset, repository result, or policy change makes the old
candidate stale. Its readings and decisions remain in history.

Credible candidate structures are:

1. Pre-gate candidate plus separate gate, approval, and closure records
2. Staged `accounted`, `evaluated`, and `approvable` candidate generations
3. One closure bundle assembled after all conditions

The first form avoids digest cycles and is the current working recommendation.

## Sensors and conditions

A sensor performs a bounded measurement and returns either:

* A valid positive or negative assessment
* An execution error with retryability information

A reading records sensor and configuration digests, input candidate, host or
model identity, attempts, timestamps, duration, evidence references, and output
digest.

A condition is a pure three-valued predicate: `true`, `false`, or `unknown`.
Blocking `unknown` fails closed. The initial condition tree can support `all`,
`any`, `not`, existence, typed comparison, and named aggregate predicates. It
must not become a general programming language over arbitrary runtime state.

Readings may be cached when their complete dependency identity is known. Gate
evaluations are recomputed against current policy and are not cached as truth.
Execution errors are not cached.

## Gate consequences

Gates decide whether conditions hold. Workflow nodes decide consequences:

```yaml
exit:
  gate: implementation-ready
  onFailure:
    action: rework
    attempts: 3
  approval: human
```

The syntax is illustrative. The separation is the contract:

* Gate policy does not choose retries or authority
* Workflow policy does not fabricate readings
* Approval does not masquerade as a reading
* A worker claim does not become a gate result

## Error taxonomy

Different failures consume different budgets.

| Class | Durable treatment | Budget |
|-------|-------------------|--------|
| Invalid definition or command | Refuse before effects | None |
| Dispatch or transport failure | Retry or escalate infrastructure | Dispatch failures |
| Malformed or incomplete account | Return findings for correction | Work attempts |
| Valid negative sensor reading | Gate refusal and workflow consequence | Gate or work attempts |
| Sensor launch failure or timeout | `unknown`, fail closed | Sensor retries |
| Human rejection | Create another candidate iteration | Review iterations |
| Stale or superseded result | Preserve, refuse acceptance, rebase | No logical rework charge |
| Integration conflict | Block integration and preserve branches | Integration attempts |
| Invariant failure or corruption | Pause for repair | No automatic work retry |
| Spend or time exhaustion | Stop before another effect | Corresponding monotonic budget |

Usage and elapsed time remain recorded even when staleness does not consume a
logical attempt. Missing usage is `unreported`, never zero.

## First-class escalation

Exhaustion creates an immutable escalation containing:

* Owner phase or task
* Trigger and exhausted budget
* Context, candidate, gate, and policy digests
* Attempts and dispatch history
* Unresolved criteria
* Failed or unknown readings
* Blocker statement and evidence
* Workflow-permitted human actions

Possible actions include:

* Retry with an exact additional allowance
* Reassign the role or start a fresh session
* Escalate model tier within capability ceilings
* Approve a graph amendment
* Apply an authorized waiver
* Supersede the work item
* End the run

Resuming an escalation is itself an exact authority command and receipt. A
generic `resume` must not silently reset counters.

## Parallel failure behavior

A failed sibling normally blocks its dependency path and phase completion but
does not cancel unrelated siblings. Their outputs remain useful and attributed.
The workflow may request fail-fast behavior, but cancellation is best-effort and
late-result fencing remains authoritative.

Task completion, repository integration, phase aggregation, and downstream
readiness remain separate. Individually passing task gates do not prove the
combined integration target passes.

## Illustrative policy

```yaml
completion:
  summary: required
  criteria: explicit
  evidence:
    requiredFor: required-criteria
  gate: checks-pass
  approval: human

limits:
  workAttempts: 3
  dispatchFailures: 2
  sensorRetries: 1
  integrationAttempts: 1
  onExhausted: escalate
```

This example expresses semantics only. Field names, nesting, defaults, and
whether policy is phase-level or task-level remain open.

## Current implementation findings

Current task completion already has valuable pieces:

* Per-criterion submissions and deterministic assessments
* Separate pre-gate and final assessment stages
* Repository delta and sensor evidence
* Gate-driven closure rather than worker-controlled status
* Separate task-attempt and dispatch-failure counters
* Escalated task state and operator steering recovery

The current behavior diverges from the proposed model:

* Satisfied claims may carry no evidence.
* Optional omissions can become implicit waivers.
* The task-frontier phase accepts when every runtime task status is `closed`.
* There is no immutable phase candidate or closure record.
* Phase iteration exhaustion has no first-class escalation.
* Status projection does not expose an actionable escalation need.
* Gate schema consequence fields and driver consequence logic diverge.
* Sensor retryability is recorded but does not drive a separate retry policy.
* Run-wide spend enforcement is absent.
* Completion acceptance lacks an atomic semantic-context freshness guard.

Historical implementation anchors were
`packages/domain/src/task-completion.ts`,
`packages/application/src/run-services.ts`, and
`packages/application/src/projections.ts`.

## Open decisions

* Kernel evidence floor and workflow override rules
* Candidate staging model
* Waiver and skip authorities
* Task gates versus phase-only gates
* Sensor `unknown` and retry policy
* Default finite budgets
* Permitted escalation actions
* Approval and waiver identity requirements
* Verification represented as task, phase, sensor, or composition
* Closure command versus automatic final transition

## Required probes

* Build one exact candidate, gate, approval, and closure chain.
* Test duplicate, missing, waived, skipped, superseded, and stale submissions.
* Exercise each failure class and prove it consumes only its own budget.
* Recover an escalation across process restart without resetting counters.
* Compare status-based and candidate-based phase completion and report every
  disagreement.
* Prove stale completion cannot close amended work.