---
title: Senawa v1 implementation log
description: Narrative record of decisions, deviations, and validation across the v1 redesign
ms.date: 2026-08-16
ms.topic: concept-article
---

This is the narrative of the v1 redesign. It records what was decided, what was
deviated from, and what was learned, so the reasoning survives past the diff.
[The plan](plan.md) carries the checklist; this carries the story.

Entries are appended in order. Decisions are numbered `D-nnn` and referenced from
commit messages where they explain a choice.

## Status

| Phase | Title | State | Commit |
|---|---|---|---|
| 0 | Settle the shape | Complete | |
| 1 | An authored workflow becomes a run | In progress | |
| 2 | One phase runs a real agent end to end | Not started | |
| 3 | The consumer command line | Not started | |
| 4 | Sensors, gates, and anchors | Not started | |
| 5 | Human decisions and escalation | Not started | |
| 6 | Fan-out and fan-in | Not started | |
| 7 | Sessions and steering | Not started | |
| 8 | The portal earns its density | Not started | |
| 9 | Remove what the evidence condemns | Not started | |
| 10 | Name it v1 and document it | Not started | |
| 11 | Restore the loop engineering narrative | Not started | |

## Phase 0 log

### Decision D-001: Fan-out members become phases, and grouping needs no new concept

* Date: 2026-08-16
* Status: Accepted
* Decision: A fanned-out member is a phase parented to the fan-out phase, rather
  than a task. Grouping in the portal comes from the existing container layout.
* Alternatives: Keep members as tasks and add nesting, per-member gates,
  per-member approval, and per-member override as new task-level concepts.
* Rationale: All four capabilities already exist at phase level. A spike compiled
  five phases with three members parented to `implement` and rendered them
  through the portal's real layout: the parent was marked a container, its
  members drew inside it in dependency order, and the top-level sequence stayed
  `plan`, `implement`, `verify`. Nine nodes and twelve edges compiled with no
  kernel change, because `ContainsEdge` already admits a phase inside a phase and
  `PhaseDefinitionInput.parentId` already accepts a phase.
* Consequence: `containerAssignment` resolves to the outermost phase ancestor and
  the layout builds one member level, so depth 1 groups correctly and deeper
  structure flattens into the top group rather than failing. That matches the
  agreed bound of one level and makes deeper nesting a contained layout change
  rather than a graph model change.

### Decision D-002: Tasks survive beneath phases

* Date: 2026-08-16
* Status: Accepted
* Decision: A fan-out member is a phase that contains one reserved unit of
  executable work. The task layer is not removed.
* Alternatives: Remove tasks entirely and let phases carry criteria directly;
  or keep fan-out members as tasks and add nesting at task level.
* Rationale: The compiler already does this. A phase declaring an `agent`
  executor synthesises exactly one task keyed `phase-executor`, parented to the
  phase and carrying the phase's completion policy and criteria, with its source
  pointer rewritten so diagnostics still point at the authored line. An agent
  phase is therefore already a phase containing one task, and the author never
  writes it. Removing tasks would instead mean breaking `isTaskId` at three
  independent enforcement points and adding a `PhaseId -> CriterionId` edge the
  model does not have.
* Consequence: The `continue` failure policy falls out for free. Candidate
  formation selects a phase's tasks by direct parentage, so a member phase's task
  is invisible to the parent's candidate set and a failed member cannot block it.
  The runner needs no change at all: budgets are keyed by unit, capacity by
  resource, and claims by operation, none of them by task.
* Risk accepted: amendment quiescence computes affected task scopes with a
  single-level parent filter, so introducing a nesting level silently narrows the
  sweep. A member could then claim against a superseded definition, which is
  exactly what fencing exists to prevent. Phase 6 must make that descent
  transitive and cover it with a test. Recorded here so it is not discovered
  later.

### Decision D-003: Submission identity is a content digest senawa computes

* Date: 2026-08-16
* Status: Accepted
* Decision: `submissionId` becomes `submission_` followed by the SHA-256 of the
  canonical submission with its own identifier removed. Senawa computes it during
  admission. The agent never supplies it.
* Alternatives: An agent-supplied nonce, or a senawa-issued attempt ordinal handed
  out at dispatch.
* Rationale: The preimage already carries repository, run, dispatch, task,
  context, principal, and payload, so the identifier is cryptographically scoped
  to one dispatch without trusting the agent. This is the repository's existing
  style: `dispatchId` and both command bridge identifiers are already content
  digests. Exact replay becomes unconditional rather than depending on a client
  reproducing an opaque token. Both alternatives put a key in the model's hands,
  and submissions live in one flat map per state root, which would make an
  agent-chosen identifier a cross-dispatch squatting surface.
* Consequence: The submission-conflict branch becomes unreachable for derived
  identifiers, because different content is now a different key. It stays for
  durable rehydration and any wire-supplied identifier, and conflict detection
  moves to rules that already exist and are already tested. Two deliberately
  identical submissions collapse into one, which is benign except for a repeated
  question; that surfaces to the agent as already open rather than being papered
  over with a salt.

### Decision D-004: The authoring surface is three YAML documents

* Date: 2026-08-16
* Status: Accepted
* Decision: A consumer authors `agents.yaml`, `workflow.yaml`, and `sensors.yaml`,
  with schemas and input and output as JSON. Everything the current template makes
  an author write by hand is derived.
* Rationale: Proven by the `v1-authoring` probe rather than argued. 115 lines of
  YAML compile into a graph of 23 nodes and 29 edges that the kernel accepts,
  against 853 lines across 18 files with a nesting depth of 7 today. The author
  writes no JSON Pointer and no budget unit. A phase names `needs`, and the
  binding is the earlier phase's declared output; a phase names `forEach`, and
  members lower into grouped member phases.
* Consequence: Diagnostics must be part of the format rather than an afterthought.
  The probe already detects an unknown agent, an unknown gate, and a `forEach`
  that reads a phase the author forgot to declare in `needs`. That last one is the
  class of mistake the pointer-based format made impossible by making the author
  state everything twice, so deriving the binding means the compiler has to catch
  it instead.

### Validation

* `v1-authoring` probe: compiles clean, and reports all three seeded diagnostics
  when the authored workflow is deliberately broken.
* Nested phase spike: nine nodes and twelve edges compiled, parent rendered as a
  container with members inside in dependency order.

## Phase 1 log

### Decision D-005: One required budget unit, not six

* Date: 2026-08-17
* Status: Accepted
* Decision: `REQUIRED_WORK_BUDGETS` drops to `review-iteration` alone. The other
  five units remain declarable but are no longer demanded of every phase.
* Rationale: research established that only `review-iteration` is enforced at
  runtime. `dispatch-failure` has an implementation whose planner has no
  production caller, `integration-attempt` is superseded by a hard-coded
  constant, and `work-attempt`, `sensor-retry`, and `rebase-attempt` are never
  counted. Requiring six units made every phase declare seventy-two lines of
  limits that nothing reads.
* Consequence: authored workflows declare no budgets at all; the lowering emits
  the single enforced counter. Existing tests pass unchanged, which is the
  evidence that the other five were never load-bearing.

### Decision D-006: Prompt input paths are read from the template

* Date: 2026-08-17
* Status: Accepted
* Decision: The authoring layer derives a prompt's declared input paths by
  parsing the template the author already wrote.
* Rationale: the compiler validates declared input paths against the template's
  own placeholders, in both directions. The declaration therefore carries no
  information the template does not already have, and its only effect is to fail
  when an author updates one and forgets the other.
* Consequence: `lowerAuthoredWorkflow` needs the prompt texts, so the caller
  supplies them. This keeps the configuration package free of filesystem access.

### Deviation: the acceptance criterion measured the wrong artifact

The plan asked for a generated document under 150 lines at depth 3. The lowered
internal document is 714 lines at depth 7, and that is correct: it is machine
generated and no human reads it. What matters is the authored surface, which is
117 lines across three files against 853 across eighteen. The criterion was
rewritten to measure that instead, rather than being quietly marked as met.

### Deviation: an authored fan-out is refused rather than ignored

The lowering does not yet turn `forEach` into member phases, which is Phase 6
work. Lowering such a phase as an ordinary agent phase would compile cleanly
while silently discarding the collection the author asked to iterate. The
compiler now refuses it with a diagnostic naming the file and path, and the
probe's fan-out phase is commented out with a note pointing at Phase 6.

### Validation

* 6 new authoring tests, including that the lowered document survives the real
  compiler and that a wrong reference names its file, path, and reason.
* Full suite: 105 files and 1,330 tests passed with 2 skipped opt-in live tests.
* Typecheck, boundaries across 467 files, documentation links across 45 files.
* Biome: 33 warnings, all `noTemplateCurlyInString` on intentional prompt
  templates, two of them newly added by the authoring tests.

### Decision D-007: Authored documents are read through an allowlist

* Date: 2026-08-17
* Status: Accepted
* Decision: `RootScopedConfigurationResources` gains `readAuthoredDocument`,
  which accepts only the three fixed authored filenames and reads them through
  the same confined path as prompts and schemas.
* Alternatives: a general file read on the configuration directory.
* Rationale: prompts and schemas are confined by their namespaces, and the three
  authored documents sit at the configuration root where no namespace covers
  them. A fixed allowlist is the confinement, so no caller can widen this into a
  general read of the project.
* Consequence: adding a fourth authored document is a deliberate change in two
  places rather than an accident.

### Phase 1 outcome

The gap where `compileWorkflowConfiguration` had no production caller is closed.
`loadAuthoredWorkflow` reads a project directory, lowers the three documents, and
compiles them; `instantiateAuthoredRun` registers the snapshot and submits the
instantiation. An authored project now becomes a run, proven end to end from a
temporary directory rather than from fixtures.

### Validation

* 3 new end-to-end tests: an authored project compiles and instantiates with the
  receipt carrying the compiled graph revision; a wrong agent reference names its
  file and path; a missing authored document is refused by the allowlist.
* Full suite: 106 files and 1,333 tests passed with 2 skipped opt-in live tests.
* Typecheck, boundaries across 473 files, documentation links across 50 files.

## Phase 2 log

### Finding F-001: Multi-phase progression is blocked, and Phase 2 is honestly one phase

Research into the dispatch seam surfaced a dependency the plan did not account
for. A run's current phase is fixed at instantiation and no implemented intent
advances it: `start-phase-attempt` and `publish-phase-output` are declared in the
protocol but fall through to `unsupported-intent`, and completion submission
asserts the task belongs to the active phase. A second phase therefore cannot be
dispatched in the same run today.

Phase 2 can still deliver what it promises, because it promises one phase end to
end. Multi-phase progression is a real prerequisite for Phase 5 and Phase 6, and
belongs with the escalation work rather than being discovered there. This is the
same limit recorded as PE-004 in redesign-1, now with a concrete consequence.

### Decision D-008: Agent roles carry the protocol capabilities

* Date: 2026-08-17
* Status: Accepted
* Decision: the authored lowering grants every agent role the three worker
  submission capabilities alongside its own `<agent>-work` capability.
* Rationale: the broker denies a submission whose capability is absent from the
  dispatch, and a dispatch cannot widen what its context granted. A role-only
  capability list registers, renders, schedules, and dispatches successfully, and
  then fails at the agent's first submission with a capability denial. The
  failure arrives far from its cause, so the fix belongs where the capability set
  is built.
* Consequence: authors do not declare capabilities. If a workflow later needs a
  narrower agent, that becomes an explicit authored field rather than the default.

### Finding F-002: A worker credential reopens a path the SDK worker had closed

The recommended delivery for a scoped worker credential is a mode 0600 file whose
path travels in an environment variable, reusing the existing private runtime
directory helpers. It is revocable by unlinking, does not propagate implicitly to
descendants, and never appears in the process table.

The residual risk is worth stating plainly. The machine-wide operator credential
sits at a predictable path with mode 0600 owned by the same user the worker runs
as. Today the agent cannot read it because it has no shell and no general file
read tool. A worker command line necessarily reopens that capability, so the
scoped credential bounds what the worker's *own* identity can do while leaving
same-uid theft of the operator credential unaddressed. Phase 2 must not claim
otherwise.

Two smaller findings recorded for the phase that implements this: capability
denials are currently recorded nowhere, unlike asset-read denials which produce a
full audit receipt; and the durable event decoder has a closed name allowlist, so
any new denial event must be registered there or snapshot replay fails.

### Decision D-009: The credit ceiling is a dispatch input, not a workflow field

* Date: 2026-08-17
* Status: Accepted
* Decision: `maxAiCredits` is supplied when a dispatch is built rather than
  declared on an authored model route.
* Rationale: an attempt to let an authored agent declare `credits` was refused by
  the compiler with `unknown-field` at `/modelPolicies/0/routes/0/maxAiCredits`.
  The route contract has no such field, and widening it to carry a spend ceiling
  would put a cost control inside a document that is otherwise about routing.
* Consequence: the ceiling belongs on the command that starts a run, where a
  human is deciding to spend. Phase 3 should expose it as an argument. Until then
  the driver defaults to a ceiling of one credit, which is deliberately small:
  the zero it first used was refused because a ceiling of nothing is not a
  ceiling.

### Phase 2 progress: the dispatch driver exists

`dispatchPhase` composes the fifteen steps that were never composed: it starts a
phase attempt through the dataflow authority, builds the worker context, renders
the prompt pack against a provisional dispatch, rebuilds the dispatch with the
rendered digest, selects a model route, derives completion requirements, and
registers the dispatch with a task scope fence and an effect seed.

Three traps the specification called out were live and are now closed in code:

* A dispatch built from role capabilities alone can do nothing, because the
  broker denies every submission whose capability the dispatch lacks. The context
  and the dispatch carry the identical list.
* Omitting the effect seed registers a dispatch the scheduler silently skips,
  stranding the run with no error anywhere. The seed is not optional here.
* The prompt pack digest is an input to the dispatch, and the dispatch is an
  input to rendering the pack, so the first dispatch exists only to render
  against and is discarded.

### Validation

* A new end-to-end test compiles an authored project, instantiates a run, binds
  the workflow input, and registers a dispatch, then reads it back from the
  broker. It asserts the protocol capabilities are present, because their absence
  is the failure that arrives far from its cause.
* Full suite: 107 files and 1,334 tests passed with 2 skipped opt-in live tests.
* Typecheck, boundaries across 477 files.

### Decision D-010: A worker holds a per-dispatch credential delivered as a file

* Date: 2026-08-17
* Status: Accepted
* Decision: `WorkerCredentialStore` mints a 32-byte token per dispatch, written
  to a mode 0600 file under the private runtime directory, scoped to one
  repository, run, dispatch, context, and principal, with an explicit capability
  list, an expiry, and a submission budget. The worker receives the file path.
* Alternatives: passing the token in an environment variable or in argv, or
  letting the worker use the operator credential.
* Rationale: a worker must never hold the operator credential, because that would
  let it approve its own phase and make every gate decorative. Of the delivery
  mechanisms, a file is the only one that can be withdrawn from a process that
  has already started: an environment variable cannot be taken back and
  propagates to every descendant, and argv is world-readable through the process
  table. The file also reuses the existing private-directory and private-file
  checks rather than inventing new ones.
* Consequence: revocation is an unlink plus a map deletion, and it is covered by
  a test that asserts a previously valid token stops working.

### Finding F-003: The scheme bounds the worker, not the machine

Worth stating plainly rather than leaving implied. The scoped credential bounds
what the worker's own identity can do. It does not stop a worker that can read
arbitrary files from reading the operator credential, which sits at a predictable
path with mode 0600 owned by the same user. Today the SDK worker cannot do that
because it has no shell and no general file read. A worker command line reopens
that capability, so the honest statement is that this scheme prevents privilege
by identity, not privilege by theft. Narrowing that further needs a different
uid or a sandbox, which is beyond v1.

### Validation

* 6 credential tests: private file mode, capability permitted and denied,
  unknown token refused, submission budget exhaustion, expiry, and revocation
  withdrawing a token that was already read.
* Full suite: 108 files and 1,340 tests passed with 2 skipped opt-in live tests.
* Typecheck, boundaries across 481 files.

### Phase 2 progress: a worker-facing surface exists

Three routes now exist under `/api/v1alpha1/worker/{dispatchId}/`: `context`,
`output-schema`, and `submissions`. They are deliberately a separate namespace
from `/api/v1alpha1/commands`, which carries human authority. A worker route
resolves to a dispatch, and the scoped credential resolves to the same dispatch,
so the two must agree before anything is admitted.

The route tests assert the negative case as well as the positive one: there is no
route that resolves to approval, rejection, or any other human decision, so a
worker cannot reach one by guessing a path.

### Validation

* 4 route tests including a refused human-authority path and a malformed
  dispatch identity.
* Full suite: 109 files and 1,344 tests passed with 2 skipped opt-in live tests.
* Typecheck, boundaries across 483 files, documentation links across 50 files.

### Phase 2 progress: the whole start path is one call

`startAuthoredRun` takes a project directory and a request and returns a
dispatched phase: compile the three authored documents, instantiate the run, bind
the request against the root phase's declared input schema, and dispatch. After
it returns, the scheduler has work it can see.

Deriving the workflow input schema needed a correction. There is no `workflow`
field on a `ConfigurationSnapshot`, so the schema the request binds against is
read from the root phase's own declared input. That is the right source anyway:
the root phase is by definition the one that reads the workflow input, so a
separate declaration could only disagree with it.

The test asserts the dispatch carries an effect seed, because a dispatch without
one is skipped by the scheduler in silence and the run strands with no error.

### Validation

* 2 start tests: the full path from authored files to a durable dispatch, and a
  request the workflow input schema refuses.
* Full suite: 110 files and 1,346 tests passed with 2 skipped opt-in live tests.
* Typecheck, boundaries across 487 files.
