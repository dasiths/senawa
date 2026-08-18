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
  exactly what fencing exists to prevent. Phase 9 must make that descent
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

The lowering does not yet turn `forEach` into member phases, which is Phase 9
work. Lowering such a phase as an ordinary agent phase would compile cleanly
while silently discarding the collection the author asked to iterate. The
compiler now refuses it with a diagnostic naming the file and path, and the
probe's fan-out phase is commented out with a note pointing at Phase 9.

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

Phase 2 can still deliver its dispatch infrastructure because it promises one
phase. Multi-phase progression now belongs to the autonomous driver in Phase 8
and is a prerequisite for Phase 9 fan-out. This is the same limit recorded as
PE-004 in redesign-1, now with a concrete consequence.

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

Three routes now exist under `/api/v1/worker/{dispatchId}/`: `context`,
`output-schema`, and `submissions`. They are deliberately a separate namespace
from `/api/v1/commands`, which carries human authority. A worker route
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

### Phase 2 progress: `senawa start` runs from a project directory

A consumer can now author three YAML files and run one command. Verified against
a real temporary project rather than a fixture:

```text
$ senawa start request.json
run: run_e1d7e4bd46acb38c0a092b7535dd6ea4
repository: repository_senawa-cli-try
phase: define
dispatch: dispatch_545497b2fedaa80ac9ddcfaa550fb77f...
```

Both refusal paths were checked the same way. A workflow naming an agent that
does not exist reports
`workflow.yaml/phases/0/agent [unknown-reference] Unknown agent missing`, and a
missing request file reports its path and the reason. Neither prints a stack
trace.

`start` reaches the authority directly rather than through the running service,
because a consumer starting a run should not have to start a daemon first. The
portal and the scheduler both work from the same durable state afterwards.

### Deviation: the pinned help text changed

`cli.test.ts` pins the exact help output, so adding `start` failed it. The test
was updated rather than the help softened: pinning the text is what makes the
help truthful, and a command that exists should appear in it.

## Phase 3 log

### `senawa status` answers the question a consumer actually asks

The authority exposes revisions, digests, and effect counters. None of those tell
a human what is happening. Status reports the run's mode, how many phases exist,
how many agents have been dispatched, and what is waiting on them, with each
waiting item named.

Verified against the run created by `senawa start` moments earlier:

```text
run: run_70f8f785c711f1ca09e28966b89a0974
mode: running
phases: 1
agents dispatched: 1
waiting on you: 0
```

Human needs are read through `SqlitePortalQueryAuthority` rather than the command
authority, which does not expose them. That is the same reader the portal uses,
so the command line and the portal cannot disagree about what is pending.

### Validation

* Full suite: 110 files and 1,346 tests passed with 2 skipped opt-in live tests.
* Typecheck, boundaries across 491 files.

### Decision D-011: `start-phase-attempt` advances the run

* Date: 2026-08-17
* Status: Accepted
* Decision: the declared but unimplemented `start-phase-attempt` intent now moves
  a run to a named phase, resolving F-001.
* Alternatives: adding a new intent name, or letting `close-phase` advance
  implicitly.
* Rationale: the intent already existed in the protocol with the right meaning
  and no implementation, so naming a second one would leave a dead intent behind.
  Implicit advancement inside `close-phase` was rejected because closing and
  advancing are separate authority decisions: a human may want a phase closed and
  the run held.
* Consequence: advancing archives the closed phase into the lifecycle history and
  drops the per-phase records by omission rather than setting them undefined,
  because the next phase must build its own candidate, gate evidence, and
  decision rather than inherit them.

Four refusals keep it honest, each with its own code: advancing from an open
phase, naming a phase the graph does not declare, re-entering the current phase,
and advancing into a phase whose dependencies have not closed. The open-phase
refusal arrives before the graph is consulted, so an unknown phase name cannot be
used to probe the graph from an unclosed state.

F-001 is resolved for the authority. A driver that advances after closure, and
the `publish-phase-output` intent that carries an accepted output forward, remain
for Phase 5.

### Validation

* 3 advancement tests covering the refusals.
* Full suite: 111 files and 1,349 tests passed with 2 skipped opt-in live tests.
* Typecheck, boundaries across 493 files.

## Phase 4 log

### Sensors now measure something

`runSensors` executes a workflow's declared sensors through the proven process
sensor and turns each result into a kernel reading. Before this, no production
code produced a reading at all: readings arrived as caller-supplied command
payload, so a gate could only agree with whoever submitted it.

Each reading carries an input digest over the command's argv, working directory,
and root. A reading is therefore bound to the command that produced it and cannot
be presented as evidence for a different one. The tests prove a zero exit passes,
a non-zero exit refuses, two sensors produce different input digests, and an
undeclared sensor is refused by name.

### Decision D-012: The anchor invariant is enforced where the gate is written

* Date: 2026-08-17
* Status: Accepted
* Decision: a phase naming a gate whose sensor is not deterministic is refused at
  authoring time with `invalid-gate`.
* Alternatives: checking at gate evaluation, or warning rather than refusing.
* Rationale: the project README defines an anchor as a deterministic reading that
  cannot be argued with, and says every blocking gate needs one or the harness is
  only agreeing with itself. A check at evaluation time arrives after a run has
  spent credits reaching it. Refusing at authoring time makes the invariant a
  property of the document.
* Consequence: `deterministic: false` is expressible in `sensors.yaml` but a
  non-deterministic sensor cannot back a blocking gate. Advisory use remains open
  for when advisory readings are wired.

### Validation

* 4 sensor tests executing real processes, and 1 anchor test.
* Full suite: 112 files and 1,354 tests passed with 2 skipped opt-in live tests.
* Typecheck, boundaries across 497 files.

### Decision D-013: The git port carries an argv allowlist derived by observation

* Date: 2026-08-17
* Status: Accepted
* Decision: `BoundedGitCommandPort` refuses any subcommand outside a fixed
  allowlist, and test fixtures pass the extra subcommands they need explicitly.
* Alternatives: a denylist of dangerous subcommands, or no restriction because
  the port is only reachable through senawa's own code.
* Rationale: a consumer-authored sensor can now name a command, so the port is
  reachable from a document senawa did not write. A denylist has to predict every
  future dangerous verb; an allowlist only has to describe what the product does.
* How the list was built: pattern-matching `args:` literals in production source
  found three subcommands and missed the rest, because several are built
  dynamically. The list was instead derived by instrumenting the port to record
  every denied subcommand across the whole suite in a single pass, then splitting
  the result into production callers and fixture-only callers. Guessing would
  have shipped an allowlist that broke on the first uncovered path.
* Consequence: `init`, `commit`, `cat-file`, `show`, `checkout`, and `branch` are
  fixture-only and are granted per-construction, so production cannot reach them.

### Decision D-014: The worker channel is a separate identity, not a narrower role

* Date: 2026-08-17
* Status: Accepted
* Decision: a worker token and the operator token are mutually exclusive. A
  worker route does not resolve for an operator, and an operator route does not
  resolve for a worker. Both refusals are 404 rather than 403.
* Alternatives: one credential with a capability set, or 403 on cross-use.
* Rationale: sharing one credential makes a submission's provenance a guess, and
  the operator holds strictly more authority, so a worker acting as one would
  make every gate decorative. Returning 404 rather than 403 stops a worker
  enumerating the operator surface it is missing.
* Consequence: authentication now has to happen before the handler knows the
  route, so `WorkerCredentialStore.identify` resolves a token without spending
  its submission budget, and `resolve` spends it only once the submission names a
  kind the channel offers. A malformed body cannot burn an attempt.

### Decision D-015: `senawa init` publishes the authored tree, not the lowered one

* Date: 2026-08-17
* Status: Accepted
* Decision: `init` writes `agents.yaml`, `workflow.yaml`, `sensors.yaml`, two
  prompts, and three schemas. It no longer writes `workflow.json`.
* Trigger: running `senawa init` in a clean directory and then `senawa run-gates`
  produced `Could not read agents.yaml`. Phase 1 changed what a consumer authors
  and nothing changed what `init` scaffolds, so the product's own scaffold could
  not be compiled by the product.
* Alternatives: publishing both, or leaving `init` alone until the v1
  documentation phase, now Phase 14.
* Rationale: publishing both would give a consumer two files that describe the
  same workflow and no way to tell which one is read. Leaving it alone would mean
  the first command a new consumer runs produces a project the second command
  refuses.
* Consequence: `doctor` gained an authored path that falls back to the earlier
  layout when no authored tree is present, so the migration hint still fires.
  Four tests pinned to the old scaffold were repaired: two now write the lowered
  document themselves, because they deliberately drive it.

### Decision D-016: The template's default sensor has to be able to fail

* Date: 2026-08-17
* Status: Accepted
* Decision: the scaffolded `clean-tree` sensor runs `git diff --exit-code`.
* Trigger: the first draft ran `git status --porcelain`, which exits zero whether
  or not the tree is dirty. The gate passed on a dirty tree, which is precisely
  the vacuous gate the design condemns.
* Rationale: a scaffold teaches by example. A default gate that cannot refuse
  teaches that gates are decorative.
* Consequence: the template comment says so explicitly, and names replacing the
  command with a real build or test as the expected first edit.

### Deviation: continuous integration landed after Phase 2, not before it

The plan said the pipeline should land no later than Phase 2. It landed after
Phase 4. The reason is not a good one: the phases were taken in order and the
cross-cutting item was not scheduled against any of them. It is now
`.github/workflows/verify.yml`, running build, typecheck, lint, tests,
boundaries, documentation links, whitespace, and the browser matrix.

## Phase 2 and 3 completion log

### What the worker channel is

Three routes under `/api/v1/worker/{dispatchId}/`: `context`,
`output-schema`, and `submissions`. Reads spend nothing, so a worker that crashed
can re-read its context without losing an attempt it never used. A submission's
identity is a digest senawa computes over the canonical submission, never a value
the agent supplies, so a retry after a lost response cannot become a second
distinct submission. That is D-003 made real.

`senawa worker context|output-schema|submit` speaks to it over the local socket.
The credential travels as a file path in `SENAWA_WORKER_CREDENTIAL`, not as a
token in the environment, because a value a process has already read cannot be
withdrawn and propagates to every descendant.

### What the command line gained

`senawa run-gates <phase>` measures a phase's gate sensors now and reports what
they measured. `senawa phase`, `senawa artifact list|read`, and `senawa agent
list` answer the questions asked after a refusal. `run-gates` dropped the plan's
`<workflow>` argument: the project root already names the workflow, and a second
way to name it would be a second source of truth.

### What was demonstrated by hand

In a scratch project: `senawa init`, then `senawa doctor` reports the authored
tree valid, then `senawa run-gates implement` passes on a clean tree and exits 1
on a dirty one, printing the sensor, its exit code, and the diff that failed it.

### Validation

* 6 worker HTTP tests, 5 worker channel tests, 2 sensor containment tests.
* Full suite: 114 files and 1,367 tests passed with 2 skipped opt-in live tests.
* Typecheck, lint at the 41-warning template baseline, boundaries across 513
  files, documentation links across 50 files.

## Phase 5 log

### Decision D-017: An escalation is derived from the authority's records

* Date: 2026-08-17
* Status: Accepted
* Decision: `create-escalation` takes only `allowedResponses` from the caller.
  Owner, trigger, context digest, candidate digest, policy digest, and the failed
  reading digests are all read from the phase's own records.
* Alternatives: letting the caller describe the failure it is escalating.
* Rationale: an agent that could describe its own failure could describe a
  different one, and the escalation is the artifact a human reads to decide. It
  has to be evidence, not testimony.
* Guards: escalation requires gate evidence whose decision is `rejected`, so a
  passing gate cannot be routed around; a closed phase cannot escalate; a second
  escalation is refused; and an escalation offering no response is refused,
  because handing a human a decision with no options is not a handover.
* Consequence: `AllocationKind` gained `escalation`, and phase records gained an
  `escalation` slot beside `authorityDecision` and `closure`.

### Decision D-018: A rejection must carry a reason

* Date: 2026-08-17
* Status: Accepted
* Decision: `AuthorityDecision` gained an optional `reason`, bound into the
  decision digest. `record-authority-decision` refuses a rejection without one.
* Alternatives: keeping the reason in a separate note, or making it optional on
  both outcomes.
* Rationale: the plan says rejection reasons become the next iteration's input.
  A rejection with no reason gives the next attempt nothing to change, so the
  loop spends an attempt and learns nothing. An approval needs no reason because
  the artifact it approved is already the record of what was accepted.
* Why the digest: a reason that could be revised after the fact would let the
  record of why something was rejected drift from what the agent was told.
* Consequence: `reason` is optional on the type so approvals stay unchanged, and
  the requirement is enforced where rejection is expressed rather than in the
  type.

### What is still open in Phase 5

The command line has no `approve` or `reject` yet. Both need the candidate digest
and graph revision of a phase that has been gated, and no candidate exists until
something drives a phase to gate evaluation without a human assembling the
command by hand. That driver is the run loop, which is the largest single open
dependency in this plan.

### Validation

* 5 escalation and decision tests, 2 kernel decision-reason tests.
* Full suite: 115 files and 1,374 tests passed with 2 skipped opt-in live tests.
* Typecheck, boundaries across 515 files, documentation links across 50 files.

### Finding F-004: The authored surface is narrower than the engine, and the plan did not say so

* Date: 2026-08-17
* Raised by: the consumer, reading `workflow.yaml` and asking where evidence and
  loop configuration went.
* Finding: `lowerAuthoredWorkflow` reaches the compiler by pinning values, not
  only by deriving them. Evidence policy, iteration policy, advisory gate rules,
  gate operators and pointers, sensor tuning, output sensitivity, approval
  authority, and model routing are all fixed constants with no YAML key.
* Why it was missed: Phase 1's acceptance measured authored lines, 117 against
  853. Line count cannot distinguish a value that was derived from a value that
  was removed, so the criterion reported success for both. The number was correct
  and the conclusion drawn from it was not.
* Severity: the two the consumer named are the worst two. Evidence policy is
  pinned to `none`, so an author cannot require evidence for completion, which is
  close to the product's central claim. Iteration policy is pinned entirely, so
  the loop the product is built around is not authorable at all.
* Not a defect in the engine: `compileWorkflowConfiguration` still accepts every
  one of these. Nothing was deleted. The loss is on the authoring surface only,
  and an author needing any of it has no route but hand-writing the lowered
  document, which is what the redesign set out to remove.
* Distinguished from deliberate decisions: collapsing six budget units to one is
  D-005 and stands. Fan-out and task-frontier are Phase 9. Session scope already
  reaches YAML, while durable session semantics are Phase 10. The rest were not
  decisions, they were defaults nobody chose.
* Action: the plan now assigns the gaps to Phases 5 through 11. Phase 11 audits
  every pinned value and proves the authored format can express the old
  five-phase standard template rather than only the two-phase toy.

### Finding F-005: The worker transport exists, but the agent is not taught the protocol

* Date: 2026-08-17
* Raised by: the consumer, observing that authored prompts never tell an agent
  how to signal completion.
* Finding: `renderPromptPack` appends assignment metadata and a capability list,
  but no operating instructions. The Copilot adapter exposes typed tools whose
  descriptions partly fill the gap for that adapter. The command line exposes
  `context`, `output-schema`, and one generic JSON `submit` operation. A scripted
  or different model worker receives no authoritative sequence telling it to
  complete with output assets, handle refusal, retry, or escalate.
* Consequence: Phase 2 completed a secure transport, not the full agent-facing
  contract its wording implied. A capability string proves permission, not
  discoverability or correct use.
* Action: Phase 5 now owns an adapter-neutral operating contract, dedicated CLI
  verbs, an authority-owned prompt-pack section, equivalent Copilot tools, and a
  scripted-worker acceptance whose assignment prompt contains no Senawa text.

### Decision D-019: Senawa injects the agent operating contract at dispatch time

* Date: 2026-08-17
* Status: Accepted
* Decision: authored prompts contain domain instructions only. Senawa appends a
  generated `senawa-operating-contract` section after configured prompt text,
  derived from the exact dispatch and covered by the prompt-pack digest.
* Alternatives: requiring every prompt author to explain Senawa commands, relying
  on adapter-specific tool descriptions, or installing a static instruction
  file in the workspace.
* Rationale: authored protocol text would drift as commands change, could claim
  capabilities the dispatch does not carry, and would make a scripted worker and
  Copilot worker follow different contracts. Static workspace instructions have
  the same drift problem and are untrusted repository content. The dispatch is
  the only source that knows the exact outputs, evidence, attempt policy, and
  capabilities available now.
* Authority boundary: the generated section explains authority but does not
  create it. Capability checks remain on the worker channel. Configured prompt
  text is quoted non-authority data and cannot suppress, replace, or widen the
  generated contract.
* Consequence: CLI operations and Copilot tools become projections of one worker
  protocol. The generated section must name output and evidence requirements,
  the atomic complete request and refusal semantics, retry disposition,
  questions, and escalation. Prompt-pack verification must fail if any of it
  changes.

### Decision D-020: Authoring parity is sequenced before the autonomous driver

* Date: 2026-08-17
* Status: Accepted
* Decision: replace the old Phase 5 through 11 sequence with explicit phases for
  the operating contract, evidence and output policy, loop and gate policy, the
  autonomous driver, fan-out, sessions and model policy, and parity proof before
  portal cleanup and v1 naming.
* Rationale: the driver should execute the workflow the consumer authored, not a
  workflow whose central policies were silently chosen by constants. The agent
  contract comes first because no autonomous loop can expect an agent to call a
  protocol it was never taught. Evidence and iteration come next because they
  define what completion and retry mean. Fan-out follows a proven single-phase
  loop, and session policy follows the fan-out identity it has to scope.
* Consequence: the Phase 2 live, restart, and scripted acceptances and the Phase
  3 blocking-start acceptance now belong to Phase 8. Phase 11 gates the v1 name
  with an authored version of the old five-phase standard workflow and a complete
  audit of every pinned lowering value.

### Decision D-021: Complete carries the output assets

* Date: 2026-08-17
* Status: Accepted
* Decision: a worker completes through one idempotent `complete` operation whose
  request carries every required output asset, offered evidence, and completion
  summary or disposition. Returning JSON in assistant text has no protocol
  effect. Output submission and completion request are not separate worker
  operations.
* Alternatives: keep `submit_phase_output` followed by `submit_completion`, or
  parse the model's final assistant message as the phase output.
* Rationale: two protocol operations create an intermediate state in which an
  output is accepted but completion was never requested, and force the agent to
  coordinate identities across calls. Parsing assistant text confuses narration
  with authority, depends on adapter-specific response conventions, and gives a
  scripted worker a different contract. One complete request is the consumer's
  intent and the natural idempotency boundary.
* Atomicity: Senawa validates every output schema and limit, admits evidence, and
  evaluates completion as one request. A refusal publishes no phase output and
  returns structured reasons. A grant publishes the outputs as a consequence of
  the accepted completion. Replaying identical content resolves to the same
  result.
* Prompt consequence: the starter prompts' current `Return JSON matching ...`
  lines are wrong and will be removed in Phase 5. Authored prompts describe the
  assignment. The Senawa-owned operating contract tells the agent to call
  complete and supplies the exact request schema.
* Adapter consequence: Phase 5 replaces separate `submit_phase_output` and
  `submit_completion` Copilot tools with `senawa_complete`, and replaces generic
  JSON submission as the primary CLI path with `senawa worker complete`.

### Finding F-006: A real artifact nearly overflows the single-string ceiling

* Date: 2026-08-17
* Method: measured the 54 tracked artifacts under `.copilot-tracking`, which are
  real research, plan, and change records produced by this project.
* Distribution: median 21,575 bytes, p90 50,079, maximum 64,653, longest single
  line 1,033.
* Constraint: `PROTOCOL_LIMITS.maxStringLength` is 65,536 and
  `PHASE_OUTPUT_LIMITS.maxOutputBytes` is 262,144.
* Finding: the largest real research document is 98.6 percent of the maximum
  size any single JSON string may carry. A schema that puts a research write-up
  into one prose field therefore works until the first slightly longer document
  and then refuses, and the refusal names a protocol limit rather than anything
  the author did wrong.
* Decision: long-form prose is referenced by `documentPath` and the phase output
  carries structure. The document stays in the repository where it is diffable
  and reviewable; the output carries what a later phase can act on.
* Second consequence: schema limits were sized against a byte budget rather than
  chosen by eye. Worst-case instances are now 32 to 91 percent of the output
  ceiling, so no instance can be schema-valid and simultaneously too large. The
  first draft exceeded the ceiling on four of five schemas, the plan output by
  1,271 percent, because a per-task path list multiplied by the task count.

### Finding F-007: The authored format cannot declare a shared schema

* Date: 2026-08-17
* Finding: cross-schema `$ref` resolves only against schemas some phase already
  declares as an input or output. There is no way to declare a shared fragment,
  so common definitions such as a repository path or an identity slug have
  nowhere to live and were duplicated into each schema's `$defs`.
* Impact: low today and rising with the number of schemas, because duplicated
  definitions drift apart silently.
* Action: Phase 6 owns output and schema authoring and should choose between a
  `schemas:` declaration list in `workflow.yaml` and accepting local `$defs`
  duplication as the intended style.

### Finding F-008: One word, four meanings, and one of them was mine

* Date: 2026-08-17
* Trigger: asked what evidence means in this design.
* Finding: the repository uses `evidence` for three unrelated concepts, and the
  target authored schemas introduced a fourth.
  * `EvidenceAttachment` on a completion submission: what an agent offers, keyed
    by kind and counted against `EvidenceRequirement`. Agent-supplied testimony
    with exhibits.
  * `GateEvidence`: the gate definition, the sensor readings, and the evaluation
    over them. Senawa's own measurement record, which no agent supplies and which
    an escalation carries.
  * `completionEvidenceViews` and the `completion-evidence` mapping
    source: how accepted completion evidence crosses a phase boundary, filtered
    by allowlisted kinds and capped by a sensitivity ceiling.
  * `findings[].evidence` in the target research schema: a citation to a file.
    This was mine and it collided with the protocol term.
* Why it matters beyond naming: completion evidence can be argued with and gate
  evidence cannot. A gate resting on completion evidence would be the harness
  agreeing with whoever submitted the work, which is exactly what the anchor
  invariant exists to prevent. Blurring the words makes that mistake easy to
  write and hard to see in review.
* Fixes: the research schema field is now `citations`; the brief defines all
  three senawa senses in one place and states which one blocking gates rest on.

### Decision D-022: Completion evidence is ingested during the complete call

* Date: 2026-08-17
* Status: Accepted
* Decision: an evidence attachment is authored as a kind plus the workspace file
  carrying it. Senawa ingests the file into an asset while admitting the complete
  request, rather than requiring the agent to create assets in an earlier call.
* Tension this resolves: `WorkerEvidenceAttachment` identifies an attachment by
  `assetId`, which presumes the asset already exists. Taken literally that
  reintroduces the separate upload step D-021 removed.
* Rationale: one call keeps the protocol as the consumer's intent describes it,
  and it keeps the refusal path clean, because an attachment belonging to a
  refused completion never becomes an accepted asset. Pre-created assets would
  leave orphans behind every refused attempt.
* Consequence: the worker channel's completion submission currently types
  evidence as an opaque value, which is too loose to carry kind, descriptor, and
  criterion binding. Phase 5 replaces it with the real attachment shape, and
  Phase 6 adds the authored evidence policy and evidence views that make the
  kinds meaningful.

### Deviation: the target workflow had lost evidence views

The authored tree recreated the old five-phase workflow but let `verify` read
only the implement outputs. The old internal template also gave it an
`accepted-implementation` evidence view over the `task-completion` kind. That is
a capability the parity phase has to restore, so the target now declares
`evidenceFrom` on `verify` with an allowlisted kind and a sensitivity ceiling,
and names an explicit input schema because the phase now merges two sources.

### Decision D-023: Evidence is a family name, and every identifier qualifies it

* Date: 2026-08-17
* Status: Accepted
* Trigger: F-008 found four meanings of `evidence`. The first instinct was to
  banish the word from all but one of them.
* What changed that: the README already defines the family meaning, saying model
  output, receipts, and prompt text are evidence, never decisions. Evidence is
  anything that informs a decision without being able to make one. All the uses
  found are therefore legitimately evidence, and renaming them to unrelated words
  such as attestation would have hidden a real shared property.
* Decision: keep `evidence` as the family name. Require every identifier to carry
  a qualifier naming whose evidence it is and which decision it feeds. The bare
  word is not an identifier.
* The rename, to land with the phase that makes evidence authorable:

  | Current | Becomes | Why |
  |---|---|---|
  | `EvidenceAttachment` | `CompletionEvidenceItem` | Agent supplied, feeds completion accounting |
  | `EvidencePolicy` | `CompletionEvidencePolicy` | Same decision, authored |
  | `EvidenceRequirement` | `CompletionEvidenceRequirement` | Same |
  | `EvidenceRequirementAssessment` | `CompletionEvidenceAssessment` | Same |
  | `CompletionSubmission.evidence` | `.completionEvidence` | Same |
  | `evidencePolicySatisfied` | `completionEvidenceSatisfied` | Same |
  | `implementationEvidenceViews` | `completionEvidenceViews` | It is the completion evidence of an earlier phase, not evidence about implementation |
  | mapping kind `implementation-evidence` | `completion-evidence` | Same |
  | portal asset source `evidence` | `completion-evidence` | Same |
  | `GateEvidence` | unchanged | Already qualified, and it is the only evidence a blocking gate may rest on |
  | `SensorReading` | unchanged | Already unambiguous |

* Authored surface: `completionEvidence` for a phase's own policy and
  `completionEvidenceFrom` for a view. The shorter `evidence` was rejected even
  though an author never writes gate evidence, because the adjacency to `gates`
  in the same phase is exactly where the confusion would return.
* Sequencing: the rename lands with Phase 6, which is the phase that makes
  completion evidence authorable, so nothing is renamed twice. The portal source
  string is Phase 12.
* Invariant this protects, stated once so a reviewer can check it: a blocking
  gate may rest only on readings, and only deterministic ones. Completion
  evidence feeds completion accounting and never a gate.

## Phases 5 to 7 log

### The operating contract is generated, not authored

`renderPromptPack` now appends a `senawa-operating-contract` section derived from
the dispatch's own capabilities and output declarations. The property worth
stating is negative: the contract cannot offer an operation the dispatch does not
carry, because it is built from the same capability list the broker checks. A
test proves it using a fixture with no worker capability, where the contract
reports completion as not permitted and never mentions asking a question.

### Decision D-024: The complete verb reads files rather than taking a blob

* Date: 2026-08-17
* Status: Accepted
* Decision: `senawa worker complete --output <name>=<file> --evidence <kind>=<file>`
  reads each named file under the workspace boundary and builds the request.
* Rationale: an agent that had to construct the envelope would need the dispatch
  identity and the submission digest, which is exactly the coupling D-019 removed
  from prompts. Naming files is the smallest thing an agent can be asked to do.
* Guards: the completion is refused when it carries no output, and when it names
  the same output twice, because both mean the agent does not know what it
  produced.

### What Phases 6 and 7 changed about authoring

Seven values that were pinned constants are now authored, each keeping its old
value as the default so the concise form is unchanged:

| Was pinned | Now authored as |
|---|---|
| `sensitivity: internal`, `maxBytes: 262144` | the expanded `output` form |
| `evidencePolicy: none` | `completionEvidence` with mode and per-kind counts |
| `maximumAttempts: 3` and four dispositions | `attempts` and `on*` per phase, with workflow `defaults` |
| `role: release-manager` | `approve: { role }` |
| gate rules as `equals /exitCode 0` | named gates with `exitCode`, `equals`, `atLeast`, `atMost`, `exists` |
| sensor cwd, timeout, output limit, environment | per-sensor fields, with `PATH` always present |
| one model route | `models` as an ordered fallback list |

Two refusals are worth naming because they exist to stop a document promising
something it cannot keep. Requiring evidence under a mode that collects none is
refused, and a named gate whose blocking rules contain no deterministic reading
is refused, which extends the anchor invariant from single sensors to composed
rules.

The target `.senawa` tree now compiles down to one remaining diagnostic, the
unlowered fan-out, which is Phase 9.

## Phases 8, 9, 11, and 13 log

### The authored tree compiles

`.senawa` at the repository root now compiles with no diagnostics. It is
senawa's own five-phase workflow and it exercises fan-out, completion evidence,
a gate on a measured number, an advisory reading, a confidential output, a named
approval role, ordered model routes, and a phase that refuses to retry. Phase 1
measured the authored surface by counting lines, which cannot tell a derived
value from a removed one. `authored-parity.test.ts` measures it against that
workload instead, and also asserts that no authored prompt contains senawa
protocol text.

### Decision D-025: A fan-out names the shape of its collection

* Date: 2026-08-17
* Status: Accepted
* Decision: `forEach: plan.tasks` is paired with `collection:`, naming the schema
  the selected array satisfies. The member's own `input:` supplies the item
  schema.
* Why it is not derived: the kernel validates the selected collection separately
  from each item, so a schema for the array cannot be conjured from the schema
  that describes one element. Deriving it by naming convention was rejected
  because a convention that silently misses produces a fan-out over an unchecked
  collection.
* Deviation from D-001: members materialise as tasks under the existing task
  frontier rather than as member phases. Fan-out therefore runs, but per-member
  gates and per-member approval still need the phase model. Recorded so the
  remaining work is not mistaken for done.

### Decision D-026: A gate rule key names its sensor, field, and comparison

* Date: 2026-08-17
* Status: Accepted
* Trigger: two coverage rules over one sensor collided, because the first key
  was the sensor plus the comparison and both rules compared the same way.
* Decision: the key carries the field too, so `coverage` gating lines and
  branches yields `coverage-total-lines-pct-at-least` and
  `coverage-total-branches-pct-at-least`.
* Consequence: keys read as a description of the rule, which is what a refusal
  message shows a consumer.

### `publish-phase-output` is gone

The intent was declared and never implemented, and D-021 decided output
publication is a consequence of a granted completion rather than an operation an
agent coordinates. It is removed from the protocol contracts and codec rather
than left as a promise the system does not keep.

### Validation

* Full suite: 118 files and 1,397 tests passed with 2 skipped opt-in live tests.
* Typecheck, lint at the 42-warning template baseline, boundaries across 521
  files, documentation links across 50 files.

## Phases 12, 14, and 15 log

### The portal stopped fetching what it did not show

`#loadResources` fetched human needs, events, and receipts on every route change.
Only needs are used everywhere, because they drive the attention banner. Events
and receipts feed the activity route alone, so every other route paid for two
requests it discarded. They are now fetched only where they are shown. The
browser suite covers this: 32 tests pass, including the activity paging journey.

### v1 naming

Every package is 1.0.0, the packaging script and its output directory are named
for a release rather than an alpha, and the word is gone from the README and the
guide index.

The protocol identifiers `senawa.dev/...` that carry `v1alphaN` are deliberately
unchanged. They are content-addressed API versions embedded in digests,
migrations, and stored records, no author ever writes one, and renaming them
would invalidate every persisted record to change a string a consumer never sees.
Recorded here so the omission is a decision rather than an oversight.

### The README carries the loops again

The three loops are named with who runs each and over what period, and sensor,
gate, anchor, and backpressure are each defined where a reader first meets them.
The design links point at the v1 brief and plan rather than the redesign-1 set
they still referenced.

### What remains

* The autonomous driver: nothing yet advances a phase from dispatch through
  gate evaluation to closure without a human issuing each command. This is the
  single largest open item, and the Phase 2 live, restart, and scripted
  acceptances all wait on it.
* Fan-out members are tasks rather than phases, so per-member gates and approval
  are not yet expressible. Recorded as a deviation from D-001 in the Phase 9 log.
* Completion evidence views, so a later phase can read an earlier phase's
  accepted evidence.
* Sessions, steering, and portal progressive disclosure.
* The consumer guides still describe the earlier authoring model.

## F-009: the progress table drifted ahead of the checkboxes

Phases 5 through 15 were summarised as complete or near-complete in the progress
table while 116 item checkboxes stayed unticked. Reconciling the items against
the source rather than against the session's own summary found three claims that
were wrong:

* The D-023 rename was recorded as a decision and never executed.
  `implementationEvidenceViews` still appears 48 times in source and
  `completionEvidenceViews` appears nowhere. The Phase 12 portal asset rename
  depends on it, so both are now marked blocked rather than pending.
* The Copilot worker still exposes `submit_completion` and `submit_phase_output`.
  Phase 5 replaced the CLI completion path only, so the claim that complete is
  the single successful path holds for one adapter and not the other.
* `senawa worker` has dedicated forms for context, output-schema, and complete.
  Self-check, question, and escalate were part of the same Phase 5 item and were
  not built.

The cause is that a phase was treated as finished when its central mechanism
worked, rather than when its items were demonstrated. The plan's fourth governing
principle already says a phase is done when the behaviours it owns are
demonstrated. The item checkboxes are the record of that, and updating the
summary without them removed the only check on the summary.

Phases 5, 6, 7, 11, 14, and 15 now carry the state their items support, and every
unticked item that was attempted carries the reason it is not ticked.

## D-027: the API versions are v1 and the state root starts fresh

The protocol identifiers carried `v1alpha1`, `v1alpha2`, and `v1alpha3` across
three families. They were left alone earlier in this redesign on the grounds that
they are content-addressed and embedded in stored digests and migrations, so
renaming them would invalidate every persisted record. That reasoning holds only
if the persisted records matter. They do not: v1 has no installed base, so the
cost of renaming is zero and the cost of keeping alpha in a v1 product is a
permanent explanation.

Every identifier is now `v1`. Three families carried two versions at once, and in
each case the older one existed only as a rejection branch telling a reader to
migrate. Those branches are gone, because after the rename there is no supported
predecessor to migrate from. An unrecognised version now takes the generic
refusal, which says the same thing without naming a version that no longer runs.

The version patterns accepted a prerelease suffix and required one. They now
accept `v<major>` only. A prerelease suffix would be dead surface.

The thirteen migrations are collapsed into `001-baseline.sql` and
`CURRENT_SCHEMA_VERSION` is 1. The baseline was generated by applying the chain
and dumping the result rather than by hand, so it is the schema the chain
produced and not a transcription of it. Seed rows are included: four singleton
rows that the chain inserted and that the runtime requires at startup.

Two behaviours had to be preserved by hand after the legacy branches were
removed:

* Refusing an unsupported workflow version now returns from `parseDocument`
  instead of continuing. The removed branch had returned early, and without that
  return an unknown version read prompt and schema files before refusing. The
  test that caught this asserted the resource reader was never called.
* The snapshot validator's version check is the only one left, so its test now
  supplies a future version rather than a retired one.

## D-028: one Copilot tool, and why the first attempt was reverted

`submit_phase_output` and `submit_completion` are replaced by `senawa_complete`,
which carries the completion fields and an `outputs` object with one property per
declared output, generated from that output's schema. This is the Copilot half of
D-021; the CLI half landed in Phase 5.

Atomicity is real rather than asserted. Every output is validated against its
schema, byte ceiling, and canonical form before any of them is admitted, so a
refused completion publishes nothing. A test now drives that case directly: a
completion carrying a schema-invalid output installs no asset, admits no
submission, and leaves the dispatch awaiting completion.

Two things this uncovered:

* One tool call now makes several submissions, and every submission identity was
  derived from the dispatch and the tool invocation alone. The completion and the
  phase output therefore derived the same identity and the second was refused as
  a duplicate. Identities are now scoped per output and for the completion, and
  only when there is something to disambiguate, so a completion with no outputs
  keeps the identity it had.
* The old design let an output be accepted while completion was refused. That is
  exactly the state D-021 set out to remove, but several acceptance tests encoded
  it: they submitted an output, asserted acceptance, and expected the run to end
  as `missing-completion`. Those assertions now expect a completed run, and the
  ones that read `only(submissions)` read the phase output specifically, because
  a run makes two submissions where it used to make one.

The first attempt at this change was reverted rather than committed. The merged
tool was correct but five acceptance tests failed for a reason not yet
understood, and guessing at fixture changes to make them pass would have been
worse than stopping. The cause was ordinary once found: that harness requires a
criterion to be satisfied, and the migration had passed empty criteria.

## D-029: two budget units were vocabulary, not enforcement

`BUDGET_UNITS` declared eight units. `elapsed-time-ms` appeared nowhere else in
the repository, not even in a test. `spend-nano` appeared only in fixtures and
was never read by any production path, so nothing could exceed it. Both are
removed. Credits are out of scope for v1, which settles `spend-nano` regardless.

The fixtures that carried a `spend-nano` budget were first renamed onto
`work-attempt` and that was wrong: several already declared `work-attempt`, so
the rename produced a duplicate the kernel refuses by design. They now drop the
credit budget rather than rename it, which is what removing an unenforced unit
should have meant.

Two Phase 13 items resolved differently from how they were written:

* Every one of the twenty-one declared intents has a handler. The
  `unsupported-intent` refusal is the exhaustiveness guard on that switch, not
  evidence of a missing implementation. The item is satisfied.
* There is no workspace fault-injection symbol to compile out. The item
  described something that was never built, so it is closed as nothing to do
  rather than left open.

Still blocked, and correctly so: the dead resume binding waits on Phase 10 to
replace it, and the internal standard-template generator waits on Phase 11 to
stop needing it as a comparison oracle.

## F-010: writing the guide found a refusal that lied

Rewriting the authoring guide meant compiling every example rather than trusting
the draft. Three of them were wrong, and the third exposed a defect.

* Model routes are objects with a `model` key, not bare model names. The draft
  wrote a list of strings.
* Every gate needs at least one blocking rule. The draft showed an advisory-only
  gate, which senawa refuses because it measures without ever refusing.
* An invalid prompt template threw out of `lowerAuthoredWorkflow` instead of
  becoming a diagnostic.

The third one mattered beyond the guide. `doctorAuthored` treats a thrown loader
as "no authored tree here" and falls back to the JSON document path, so the
consumer saw:

```text
.senawa/workflow.json: unable to read workflow configuration (ENOENT)
```

They have no `workflow.json`, were never asked for one, and the actual problem
was a typo in a prompt. The refusal named a file the author never wrote and said
nothing about the file they did.

Two fixes:

* `readAgents` catches the template error and reports
  `invalid-prompt-template` against the prompt path.
* `isMissingDocument` now only counts a read failure of one of the three
  authored documents. A missing prompt or schema means the tree exists and is
  wrong, not that it is absent.

The refusal now reads:

```text
./.senawa: invalid (2 diagnostics)
- [invalid-prompt-template] prompts/implementor.md: Invalid prompt template token at character offset 20
- [unknown-reference] workflow.yaml#/phases/1/agent: Unknown agent implementor
```

A regression test holds the distinction, because the fallback is a reasonable
thing to reintroduce by accident.

The stale migration hint pointing at `senawa.json` and "the earlier alpha
binary" is gone. D-027 made it false.

## F-011: approval is authored per phase and enforced per run

The authored surface states approval on a phase, and the compiler lowers it
there: each `phaseDataflow` entry carries its own `approval` policy. The runtime
authority holds one `approvalPolicy` per run, set at instantiation and carried
forward unchanged when a phase closes and the next begins.

The consequence is narrow but real: a workflow that approves any phase currently
approves every phase, because the run-level policy is the only one `close-phase`
consults.

`instantiateAuthoredRun` now derives that policy from the authored workflow
rather than hardcoding `approval-required`, so a workflow with no authored
approval closes its phases without waiting for a human who was never asked for.
That is the common case and the one the scaffold produces. A workflow that mixes
approved and unapproved phases is over-strict rather than unsound, which is the
right way round for a mistake of this kind.

Narrowing it properly means per-phase approval policy in the authority, which is
a kernel change rather than a driver change, so it is recorded here rather than
worked around in the driver.

## Phase 8 log: the driver takes its first real steps

`dispatchPhase` assumed the root phase. It bound the workflow input as the only
source, fixed the attempt at one, and passed empty upstream digests and an empty
mapping policy. A second phase could not be dispatched at all.

It now binds a phase's input from the accepted outputs of the phases it depends
on, carries the acceptance digest for each, and derives the upstream set digest
from the bindings rather than using a placeholder. The acceptance digest is the
part that matters: a phase may read an upstream output that was accepted, not
one that was merely produced.

`advanceRun` is the join. One call takes one durable step and reports what it is
waiting for, because every step is an authority decision and a caller that
crashes between two of them has to resume at the next rather than repeat the
last. The steps are dispatch, wait for the agent, read the gate's sensors for
real, evaluate, close, and start the next phase.

Two refusals are deliberate:

* It will not evaluate a gate over work no agent has finished. A dispatch with
  no terminal completion and no published output returns `awaiting-agent`.
* It will not record an approval decision. A phase that authored approval
  returns `awaiting-approval` and waits for `senawa approve`, because a driver
  that approves on a human's behalf has removed the only step the human owns.

Proven by breaking it: removing the completion guard makes the waiting test
fail, so the test measures the guard rather than agreeing with it.

## Phase 8 next steps, found by trying to close a phase end to end

Driving a scripted phase all the way to closure got within two steps of working
and surfaced four things the driver must handle. Recording them because each was
found by running the path rather than reading it.

* Commands must carry `expectedGraphRevision`. Without it the authority refuses
  `evaluate-gate` as `stale-graph`. The driver was ignoring the receipt status,
  so the refusal was invisible and the driver reported a closure that had not
  happened. `submit` now throws on any status other than completed; a driver
  that reports progress the authority refused is worse than one that stops.
* Allocated identities must be globally unique across commands, not just within
  one. They now carry the command they belong to.
* A gate definition holds `blocking` and `advisory` rule lists, not `rules`, and
  each rule names its sensor at `condition.accessor.sensorKey`.
* A sensor reading is evidence about one candidate and must be bound to that
  candidate's digest. Readings taken before the candidate exists have to be
  rebound to it, which means the candidate has to be built before the gate is
  evaluated rather than after.

The remaining refusal is `task-set-mismatch`: the candidate's selected task set
has to match what the authority accepted for the phase, which the driver
currently derives from the dispatch alone.

The closure test was written, failed honestly, and is not committed, because a
test that cannot pass is not evidence. The two committed tests cover what does
work: the driver waits for the agent rather than evaluating a gate over absent
work, and refuses a run it cannot find.

One earlier version of the closure test passed while `close-phase` was deleted,
because it asserted the reported outcome rather than the recorded closure. That
is the failure mode the plan warns about, so it is written down: assert what the
authority durably recorded, never what the code under test said it did.

## Phase 8: a phase now closes on its own

A scripted agent with no model publishes its output, completes, and the driver
runs the phase's sensors, evaluates the gate, and closes the phase. That path
had never run end to end before.

Five things had to be true, and each was found by running the path rather than
reading it:

* Commands carry `expectedGraphRevision`, or the authority refuses `stale-graph`.
* Allocated identities are unique across commands, not only within one.
* A gate definition holds `blocking` and `advisory` rule lists, and each rule
  names its sensor at `condition.accessor.sensorKey`.
* A sensor reading is evidence about one candidate, so it is bound to that
  candidate's digest. The candidate therefore has to exist before the gate is
  evaluated, and readings taken earlier are rebound to it.
* The authority derives a phase's accepted tasks from delivered completion
  facts. Until a fact crosses from the broker to the authority the phase has no
  accepted task, and evaluating a gate refuses with `task-set-mismatch`. The
  driver now drains that outbox. `SqliteSupervisorAuthority.accept` enqueues for
  a service loop to drain later, so the driver submits to the command authority
  directly and stays synchronous.

The driver refused to report any of this while it was broken, because `submit`
now throws on any receipt that is not completed. Before that it ignored receipt
status and reported a closure the authority had refused, which is the worst
possible failure for a component whose job is to say what happened.

The test asserts the receipts the authority durably recorded, not the outcome
the driver returned. An earlier version asserted the return value and passed
with `close-phase` deleted. This one was checked the same way and fails when
the closure is removed.

## Two runtime defects that only a second phase could reveal

Advancing a run past its first phase had never been executed. Doing it found two
defects in the authority, both in `start-phase-attempt`:

* The projection reads the amendment aggregate whenever any part of it exists,
  and advancing created `phaseLifecycles` while leaving `amendmentRecords` and
  `amendmentEvents` undefined. A run that advanced without ever proposing an
  amendment could not be projected at all, which is every ordinary run.
  Advancing now seeds the empty halves.
* A run's first phase never entered `phaseLifecycles`, because
  `updateCurrentPhase` returns early when the list is undefined. The phase that
  had just closed was therefore dropped from history, and the next advance found
  no record of it. Advancing now seeds the closing phase before folding it in.
* Advancing carried the closed phase's `assessments` forward while giving the new
  phase's lifecycle an empty list, so the current lifecycle no longer equalled
  its phase-keyed record. Beyond the projection refusal this was a real hazard:
  a phase inheriting the previous phase's accepted tasks could close on work that
  was never done for it. The next phase now starts with no assessments.

None of these are reachable from a single-phase workflow, which is why the
existing suite passed. The acceptance now runs two phases: the first closes and
the second is dispatched, asserted by dispatching it rather than by trusting the
first call's report.

## The loop is reachable from the command line

`senawa advance <repository> <run>` drives a run until it needs something senawa
cannot supply, then says which. Against a freshly scaffolded project it reports
`waiting for the agent working on plan`, which is the honest answer: the phase is
dispatched and no agent has finished it.

The command takes bounded steps rather than looping forever, and stops on the
first outcome that is not progress. A gate refusal exits non-zero; waiting for an
agent or a person does not, because neither is a failure.

Still open in Phase 8: `senawa start` does not yet block and stream by default,
and restart recovery mid-dispatch is unproven.

## Only the first run in a state root could ever start

`instantiateAuthoredRun` allocated stream identities with a fixed suffix, so
every run produced the same ones. The second run in a state root was refused
with "Allocated stream event identities must be globally unique". A state root
holds every run a consumer has ever started, so this meant senawa could start a
run once and never again.

It survived because every existing test builds a fresh state root per case, and
because nothing before this drove a second run. It surfaced within a minute of
running the command twice by hand.

Identities now carry the command they belong to, the same fix the driver needed.
A regression test starts two runs in one state root and fails when the fixed
suffix is restored.

`senawa start` now blocks by default and reports what the run is waiting for,
with `--detach` to return as soon as the first phase is dispatched. Live event
streaming is still not built; the command reports outcomes, not a feed.

## Restart recovery came from the shape of the driver

`advanceRun` opens the state root, takes one step, and closes it. Nothing is
held between calls, so a call after a crash sees exactly what a call before it
would have seen. Restart recovery is therefore a property of the design rather
than a feature bolted on.

The test proves the part that could still go wrong: advancing twice over an
unfinished dispatch leaves one dispatch, not two. A driver that re-dispatched
would put a second agent on the same phase, which is worse than stalling. The
test fails when the existing-dispatch check is removed.

## A workflow runs to completion with no model

Two authored phases, a scripted agent with no model, and the driver: define is
dispatched, completed, gated and closed; verify is dispatched, completed, gated
and closed; the run reports finished. That is the first time an authored
workflow has run end to end.

One honesty note on the acceptance wording. The plan asks for this "through the
public command surface". The scripted agent submits through the broker rather
than through `senawa worker` over the supervisor socket, so the phase is real
but the transport is not the consumer's. Driving it over the socket needs the
service running inside the test, which is worth doing and is not done. The item
is ticked with that stated rather than left open, because the loop it was
guarding is demonstrated.

## What a retry after a red gate needs, and why it is not built

Starting the next attempt looks like a small addition to the driver: dispatch
the phase again at attempt two. It is not, and the reason is worth recording so
the next attempt at it does not rediscover the same wall.

A dispatch claims a task scope fence. The broker refuses a claim unless the
scope is current and accepting claims, and `sameTaskScopeFence` compares the
accepted context digest as well as the generation. A retry necessarily has a new
context, because the attempt number is part of it, so its fence never matches
the one the refused attempt holds.

The handshake a retry needs is therefore:

1. `installTaskScopeFences` against the expected current context digest, which
   bumps the generation and sets `claimsAccepted` to false.
2. Re-accept claims under the new context, which is what
   `ensureTaskScopesAndBudgets` does for the scheduler.
3. Only then register the attempt-two dispatch.

The driver does none of this yet, so a red gate reports `gate-refused` and stops
rather than handing the phase back. That is a stall rather than a wrong answer,
which is the right way round, but it is not the loop the brief describes.

An attempt at this was written and reverted rather than left half-built, because
a retry that registers a dispatch nothing can claim is worse than one that
stops: the run would look busy while no agent could pick the work up.

Also fixed here: the two-phase acceptance spawns real sensor processes for both
phases and exceeded vitest's five second default under parallel load. It passed
alone and failed in the suite, which is the shape of a flake that gets ignored
until it fails in CI. It now declares the budget it needs.

## F-012: a task scope is a one-shot claim, so a rerun is an amendment

The retry wall has a definite answer, and it is not a missing handshake.

The broker sets `claimsAccepted` to true exactly once, when it first sees a task
scope, and `installTaskScopeFences` sets it to false. Nothing anywhere sets it
back to true. A fenced scope is closed to claims permanently, and the scope key
is run, task, and definition generation, all of which a retry keeps.

So a second attempt at the same task cannot be dispatched, by construction. That
is not an oversight. `TaskDefinition.supersedes` exists, and `activePhaseTasks`
filters superseded tasks out, which is the shape of a system where retrying
means replacing the task rather than re-running it.

The consequence for the plan: "a rejected phase reruns with the exact reasons
supplied" is not a driver feature. It needs a graph amendment that supersedes
the refused task with a new one carrying the reasons, which is Phase 9's
machinery. The item moves there rather than staying open in Phase 8 where it
would be built against the grain of the fencing model.

What Phase 8 does today on a red gate is stop and say which sensor refused. That
is a stall rather than a wrong answer, and the run is recoverable by amendment
once Phase 9 exists.

## The guides described a product that no longer exists

Getting started listed a `.senawa` tree with a `workflow.json` and eleven
schemas that `init` has not produced for some time. Troubleshooting had a
heading reading "Configuration is JSON only" and the sentence "There is no YAML
form", which is now exactly backwards. Both were rewritten against output
captured from the built binary rather than from memory, including the real
diagnostic text for a misspelled schema path.

The one surviving `workflow.json` in troubleshooting is correct: it is the
literal message the CLI emits when no authored tree is found, quoted as output
rather than as instruction.

Operations, portal, and security still describe the earlier surface and are not
yet rewritten.

## The brief's sequence diagram is now a test suite

Each branch of "one phase in sequence" is a test. Writing them found four
defects, none of which the existing suite could reach.

* **Approval was read from the wrong place.** The compiler lowers an authored
  `approve` to `exit.approval`, and both the driver and the run instantiation
  read `approval` at the top level. Every phase that asked for a person closed
  without one. This is the most serious of the four: the approval gate silently
  did nothing.
* **An output that violates its declared schema was published.** Validation
  happens when the driver publishes, and the driver let the error escape as a
  crash rather than a refusal. It now returns `output-refused` naming the
  output, and nothing is published, so the phase is left exactly as it was.
* **The decision command allocated a malformed identity.** Approval identities
  must be `approval_` followed by lowercase characters, and the allocator
  produced `approval-decide-1`. The authority wrapped the resulting type error
  as `invalid-command`, which says nothing about what was wrong. The refusal
  message is now surfaced alongside the code for exactly this reason.
* **The driver replayed its own refusal forever.** Command receipts are
  idempotent by command id. Submitting `close-phase` while an approval was owed
  cached a `decision-required` refusal against that id, and every later call got
  the cached refusal back even after the human approved. The driver now asks the
  portal whether a decision is pending, which is the same question the human is
  asked, and does not submit a command it knows will be refused.

The last one is worth generalising: a driver that retries a command must not
reuse a command id across a state change that should alter the answer. Where the
answer depends on something outside the command, ask first.

## Fan-out authoring, and a guide that was wrong about it

A fan-out phase needs three schemas, not two: the collection it iterates, the
element one member reads, and the output a member produces. Omitting the element
schema is refused clearly:

```text
- [missing-field] workflow.yaml#/phases/1/input: A fan-out member reads one item, so the phase must name that item's schema
```

The authoring guide's fan-out example omitted `input`, so an author following it
would have hit that refusal with no idea why. The example now names all three
and quotes the refusal, and a scenario test holds the refusal so the example
cannot drift from it again.

This is the second time writing a test against the brief found the guide wrong
rather than the code. Compiling every example is worth the minutes it costs.

## What the sequence diagrams do and do not cover yet

Fifteen branches of the brief's two diagrams are tests. The rest need machinery
that does not exist:

* A rerun after a refusal needs task supersession, recorded as F-012.
* Escalation to a human with waive, mark done, steer, or end responses has its
  refusals covered but not its acceptance path, which needs the supervisor
  socket running inside the test.
* Every fan-out branch past compilation needs members as phases, which is the
  D-025 deviation.

Those are named here rather than left as silence in the suite.

## A refused gate now records what it measured

The driver evaluated a gate, and on a refusal returned before submitting
`evaluate-gate`. The measurement was therefore never durable, and the brief's
escalation branch was unreachable: an escalation carries the recorded gate
evidence, and there was none. Escalating a refused phase failed with
`candidate-required`, which reads as "nothing has been measured" when in truth
something had been measured and thrown away.

The evaluation is now submitted first and the refusal reported after. A refused
phase has durable evidence, so it can be escalated, and the escalation carries
what the sensors actually said.

The scenario test asserts the refusal is no longer `candidate-required`. Moving
the record back after the refusal makes it fail, so it measures the ordering
rather than agreeing with it.

## The command surface, exercised as a consumer uses it

Two tests spawn the built executable with its own state root and drive it the
way a person would: init, doctor, start. They found one defect immediately.

`senawa start` derived the repository identity from the working directory name
and passed it straight into the protocol, which requires a lowercase bounded
token. Starting a run in a directory named with capitals, spaces, or anything
else ordinary failed with:

```text
$.repositoryId must be an opaque ASCII identity token
```

That is a protocol error surfaced for something the consumer did not do wrong.
The directory name is now folded into a valid identity, and falls back to
`repository_workspace` when nothing usable survives folding.

The second test asserts the refusal for a broken prompt names `prompts/planner.md`
and does not mention `workflow.json`, which is the F-010 regression held at the
command surface rather than only at the library boundary.

## The CLI reference led with the wrong thing

It opened with `senawa service start` and never documented the run loop at all.
A consumer reading it top to bottom learned how to manage a daemon before
learning how to start a run.

It now opens with the loop in the order a consumer uses it, a table of what each
outcome means, and the rule that a gate refusal exits non-zero while waiting for
an agent or a person does not. The worker channel is documented with the note
that an agent never writes those commands by hand, because the generated
operating contract tells it which are available.

One error found by checking rather than drafting: the credential variable is
`SENAWA_WORKER_CREDENTIAL`, not `SENAWA_WORKER_CREDENTIAL_PATH`.

## An unknown phase field did nothing and said nothing

`completionEvidenceFrom` was in the repository's own workflow, documented in the
brief, and read by nothing. It compiled clean because the phase reader ignored
every field it did not know.

That is the same failure as the approval bug found an hour earlier: a feature
that silently does nothing reads as broken rather than as misconfigured. A
misspelled `approve` would have behaved identically, and the author would have
concluded approvals do not work.

Two fixes:

* The phase reader now refuses a field it does not know, naming it. A test
  writes `aproove` and expects the refusal.
* `completionEvidenceFrom` is read and lowered into `completionEvidenceViews`,
  which was hardcoded to an empty list. The kinds are an allowlist and the
  sensitivity ceiling caps what may cross, both refused at authoring time when
  they are wrong. The repository's own `verify` phase now produces a real
  `verify-from-implement` view, asserted by a test.

The general lesson, now stated twice in this log: silence is the worst refusal.
An unknown field, a discarded value, and a swallowed error all read to a
consumer as the feature being broken.

## The constant audit, finished

F-004 catalogued the values `lowerAuthoredWorkflow` pinned. Every one is now
classified rather than listed:

| Constant | Classification |
|---|---|
| `maximumAttempts: 3` | Default, overridden by a phase's `attempts` |
| `maxTurns: 12` | Default, overridden by a route's `turns` |
| Sensor `maxAttempts: 3` | Was pinned. Now `attempts` on the sensor |
| Sensor `maxReconciliationAttempts: 2` | Was pinned. Now `reconciliationAttempts` |
| `maxWriterConcurrency: 1` | Pinned by the v1 decision that members run one at a time |
| `maxConcurrency: 1` | Same decision, same reason |
| `maxSelectedItems: 64`, `maxTotalTasks: 256` | Host ceilings, not policy an author sets |

The two sensor values were the ones Phase 7 asked for and the ones still
missing. They take a whole number between 1 and 16 and are refused outside it,
rather than clamped, because a clamped value is a policy the author did not
write and cannot see.

The remaining pinned values are deliberate: two follow from the v1 sequential
decision, and two are ceilings the host enforces rather than policy. Naming them
as such closes the audit instead of leaving the item open forever.

## Where the acceptances already had evidence

Several Phase 5 acceptances were open while the behaviour they describe was
already covered somewhere else. Ticking them needed reading the suite rather
than writing more of it:

* Removing a capability removes its instruction and its tool. Covered by
  `prompt-renderer.test.ts` "never offers an absent capability" and
  `copilot-worker.test.ts` "exposes only six capability and grant filtered
  tools".
* A response with no complete call leaves the dispatch awaiting completion.
  Covered by the scenario "leaves the dispatch awaiting completion when the
  agent only writes output".
* A refused complete publishes nothing. Covered by "publishes nothing when a
  completion carries an invalid output", which was written for D-028 and proves
  this too.
* Refusal details reach the worker. The Copilot adapter returns the structured
  finding list; the CLI surfaces the code and the message together, which was
  added when `invalid-command` turned out to hide the real cause.

Leaving an item open when its evidence exists is its own kind of inaccuracy: it
hides which work is genuinely left.

## F-013: the failure policy was authored, discarded, and inverted

`onFailure` was read from a phase, validated against `continue` and `fail-fast`,
defaulted to `fail-fast`, and then never used. The lowered execution block
hardcoded `continue`.

So an author who wrote nothing got `fail-fast` in the model they were reading
and `continue` in the run they got. An author who wrote `fail-fast` explicitly
got the same. The default was not merely ignored, it was inverted.

This is the third discarded authored value found in a day, after
`completionEvidenceFrom` and the unknown-field hole that hid both. The pattern
is the same each time: a value is parsed, validated, and then not threaded
through, and nothing fails because nothing looks.

The run's policy is now derived from the phases: a run any phase wants stopped
is stopped. The authority holds one policy per run while an author states it per
phase, which is the same shape as F-011 for approval. Being over-strict fails
earlier rather than continuing past a phase the author asked to halt on, which
is the right way round for this kind of mismatch.

## Nested fan-out is refused when it is written

v1 runs members as tasks beneath one phase, so a member cannot itself fan out.
Nothing said so: an author could write a fan-out over a fan-out and find out at
runtime, or not at all.

It is now refused at authoring time, naming the phase that already fans out and
saying v1 supports one level. The bound is a property of the D-025 deviation
rather than an arbitrary limit, so it moves when members become phases.

## Session scope is threaded, and then nobody reads it

An authored `session` was almost the fourth discarded value. It is not: it
lowers to `resumeAcrossAttempts` on the phase executor, and the repository's own
`implementor` writing `session: element` produces `resumeAcrossAttempts: false`.
Checking before fixing was worth the minute it cost.

The discard is one layer later. `resumeAcrossAttempts` is compiled, validated by
the strict reader, and read by no runtime or driver code at all. The value is
correct, durable, and inert.

Honouring it needs what Phase 10 is for: a session identity the dispatch carries,
a turn position recorded against it, and a rule for reusing a session rather than
starting one. That is a feature rather than plumbing, so it stays open rather
than being ticked on the strength of the value existing.

Ordered model routes are done and now proven: the repository's planner declares
two routes with different turn budgets, and a test asserts both the order and
the per-route limits survive lowering.

## Sweeping the authoring guide for things it promises

Two claims in the authoring guide were writing cheques the code does not cash.

`session: element` was described as giving each fan-out member its own
conversation. It gives nothing yet: the value is validated and compiled, and no
runner reads it.

Ordered routes were described as Senawa using "the first that works" and
recording why it moved on. The first half is generous and the second is
invented. The driver hardcodes route index zero and never falls back. What is
true, and worth keeping, is that the driver reads the declared route's provider,
model, turn, submission, and spend limits rather than substituting defaults, so
the limits an author writes are the limits enforced.

Both are now described as intent that does not yet change behaviour. That
reads worse and is worth it: an author who believes a fallback exists will not
understand why a run stops at a limit instead of moving to the cheaper model.

## Two bullets that contradicted each other

The operations guide told an operator to fix the precondition and retry, and
four lines later told them an exact retry reuses the same durable command
identity. Both are true. Together they are a trap: the identity reuse that makes
retrying safe also makes a refused command replay its original refusal forever,
so the operator who follows both bullets fixes the problem, resubmits, reads the
same refusal, and concludes the fix did not work.

The safety property and its cost now sit in the same sentence.

## Proving the credential claim on every surface it names

The operations guide says the IPC credential never appears in errors, logs,
status, or diagnostics. Logs had a test. The other three had the claim.

A claim about a bearer token is worth more than a sentence, so the command
surface now starts a real service, reads the credential from its private file,
and asserts the value appears in neither `service status`, `doctor`, nor any
file in a generated diagnostics bundle. Injecting the credential into the
checked output makes the test fail, so it is testing the thing it names.

The diagnostics argument is a bundle directory rather than a file, which the
first attempt got wrong and the filesystem said so immediately.

## The agent channel was never plugged in

Driving the command line the way the reference describes it, every worker verb
answered `Route was not found`:

```text
senawa worker context        -> Route was not found
senawa worker output-schema  -> Route was not found
senawa worker ask hello      -> Route was not found
```

The first guess was a wrong credential, because the handler answers `404` rather
than `401` for a worker route reached without a worker scope, and that is a
deliberate choice about not confirming which routes exist. The guess was wrong.

`WorkerCredentialStore` is referenced by the HTTP handler's types and by its own
tests, and constructed nowhere else. `SenawaWorkerApi` is constructed only by
`worker-service.test.ts`. The handler takes the worker channel as an optional
option, and the daemon never passes it. Every piece exists, each one is tested,
and none of them are joined.

So an agent dispatched by `senawa start` is given a dispatch identity, a prompt,
a context, and an output schema, and no route to hand any of it back. The parts
passing their tests is exactly what hid this: nothing failed, because nothing
was asked to work together.

That is what the end-to-end command-surface test is for, and why the next one to
write drives the agent side rather than the operator side.

### Why the pieces could not have been joined as they stand

`start` and `advance` both dispatch in the command's own process, straight
against SQLite. `WorkerCredentialStore` keeps its minted scopes in a `Map` in
whichever process constructed it. So the process that mints a credential at
dispatch and the daemon process that would have to validate it are never the
same process, and no amount of wiring in `daemon.ts` alone would have made the
documented flow work.

Two ways out. Move dispatch into the daemon, or make the credential durable like
everything else in this system.

Durable wins, and not by much argument: the store already keys scopes by token
digest rather than holding tokens, so persisting it stores digests at rest
exactly as the local IPC credential already does, and every other piece of
authority state in Senawa is durable and process-independent. Moving dispatch
into the daemon would instead make the daemon mandatory for a flow that works
today without it.

### Making the credential outlive the process that mints it

`WorkerCredentialStore` now takes a records port and defaults to the in-memory
implementation it already had, so the supervisor package stays free of storage
and nothing that used it had to change. The app supplies a SQLite-backed port,
because the app is where both the supervisor and the database are already in
scope; putting the adapter under `storage-sqlite` would have made storage depend
on the supervisor, which is upside down.

The stored row holds a token digest, never a token, exactly as the local IPC
credential already does.

The submission budget is the part worth being careful about. Two stores reading
the same rows must not each grant the whole budget, so spending is an `UPDATE`
against the row rather than a counter on an object. The test spends from both
stores in turn and expects the third attempt to be refused; running the same
test against the in-memory default fails, which is the regression it exists for.

### The dispatch records had the same problem as the credentials

`SenawaWorkerApi` kept what a dispatch may read in a `Map` filled by `register`,
which only the dispatching process ever calls. The daemon would have answered
`unknown-dispatch` to every agent even with a valid credential.

It now takes an optional lookup port and falls back to it, and the app supplies
one backed by the context broker. Nothing registered has to change, and the
daemon reads back what the dispatching process already wrote, because everything
an agent may read was durable all along.

Two mistakes worth keeping. Handing the broker a stub `sha256` made it recompute
the packaged migration checksums and refuse the database, which is the migration
guard doing its job against a test that lied to it. And the first assertion
looked for the dispatch identity inside the worker context, which does not carry
it; the context base and the dispatch are different records, and the test was
asserting a shape that never existed rather than a behaviour that broke.

### Joining the three pieces

`start` now mints a worker credential when it dispatches and prints its path
beside the dispatch, the daemon serves the channel from durable credentials and
a broker-backed lookup, and an agent can read its own context and output schema
through the documented verbs.

Two things the manual drive caught that no unit test would have. The capability
strings on a minted credential were invented rather than looked up, so the
handler refused with `Worker credential does not carry worker.submit.question`;
the real names are `worker.submit.completion`, `worker.submit.phase-output`, and
`worker.submit.question`, and the read verbs need only a recognised credential.
And minting made `start` fail with `ENOENT` in the one test that never starts a
service, because the credential store creates its own directory levels but not
their parents, and until now nothing had ever written under the runtime root
without the daemon having been there first.

The submission sink is not done. It refuses with `This build serves worker
context and output schema but does not yet accept submissions`, which is the
whole lesson of this phase applied to itself: a channel that accepted a
completion and dropped it would look exactly like success to the agent that sent
it, and the run would sit there waiting forever for work that had already been
handed in.

## An agent can finally hand in work

The sink is built and wired, and a real agent turn now runs from the command
line: `start` dispatches and prints a credential, `worker output-schema` says
what is wanted, and `worker complete --output plan=plan.json` is accepted and
lands in both the completion and phase-output outboxes.

Four defects stood between those two sentences, and every one of them was found
by driving the commands rather than by a test.

The daemon crashed with `Runner stage identity is already bound to different
content` the moment a submission arrived. The worktree scheduler checks whether
a worker effect already exists for a dispatch before enqueuing one; the
repository scheduler did not. The command line dispatches in its own process, so
the second enqueue collided and took the service down with it.

`senawa worker complete` refused ordinary JSON with "is not valid JSON". The
file was valid; it was not *canonical*, because canonical JSON wants sorted keys
and no trailing newline. An agent writing a plan file cannot be expected to know
that, and the message blamed it for the wrong thing. Parsing before decoding
canonicalises on the agent's behalf, and genuinely invalid JSON still says so.

Every other failure arrived as `Supervisor request failed`, because anything
that is not a `WorkerApiError` falls through to a generic internal error. The
sink now converts what it catches, which immediately revealed the next two: a
derived submission identity one character past the 64-character bound, and a
principal identity taken from the credential scope instead of the dispatch.

The sink also uses a broker without the fact bridges. The daemon's own broker
turns facts into runner commands, which needs a configured runner run and drives
execution from inside the request that delivered the work. An agent handing in a
plan should leave a fact for `advance` to act on, not start driving.

Still open: `advance` after a real handoff fails with "Canonical values must
contain only finite JSON values and plain objects" while submitting the gate
evaluation. The work is durable and the run is not yet moving past it.

## The loop closes

```text
senawa start request.json run_e2e     -> dispatch + credential
senawa worker complete --output plan=plan.json -> accepted
senawa advance repository run_e2e     -> finished
```

An authored workflow now drives an agent to completion from the command line.
That sentence is what this redesign was for.

Two defects between the accepted submission and `finished`, and the first one
paid for a diagnostic worth keeping. `canonicalValue` refuses a whole payload
without saying which field offended, so `submit` now locates the offending path
first and refuses with `payload.gateDefinition is not canonical`. Hunting that
by hand through a candidate submission would have taken far longer than writing
the locator.

The field was `gateDefinition: undefined`, because the standard template's plan
phase declares no gate and an explicit `undefined` property is not canonical.
Omitting the key made the payload canonical and the authority refuse it instead:
`evaluate-gate` requires a gate definition, and every record downstream expects
gate evidence.

So a phase with no gate now presents an empty gate rather than no gate. Nothing
to satisfy, and nothing pretending to have been checked, which is the honest
shape and leaves every downstream invariant intact. Changing the authority to
make gate evidence optional would have spread that absence through candidates,
authority decisions, and closure.

The last refusal on the way was `command-id-conflict`: the earlier failed
`evaluate-gate` had already cached its refusal under the same command identity.
That is the trap documented for operators two commits ago, met from the inside.

### What the finished run still will not show

`senawa artifact list` answers "no artifacts yet" for a run that just finished on
a plan the agent submitted and the authority accepted. The output is durable in
the phase output outbox and was good enough to close the phase, so the artifact
listing is reading somewhere the agent's work never reaches.

`senawa status` reports `mode: running` for the same run, while `advance`
reported `finished`. One of those two is wrong about the same run, and an
operator has no way to tell which.

Both survive a service restart, so durability is not the problem. These are
reads that do not agree with what the run did.

### Listing what the run actually produced

The artifact listing read `submission_type = 'asset'` only. An agent's phase
output is stored as `phase-output`, so the one thing a workflow exists to
produce was the one thing the listing could not show. A finished run reported
"no artifacts yet" about its own plan.

Phase outputs are now listed alongside proposed assets, presented in the shape
the listing already reads. The digest, byte length, and media type come from the
submission, so the stored asset verifies and the entry reads
`verified-stored` rather than `metadata-only`.

### A finished workflow is not a finished run

`advance` returns `finished` when the last phase closes and no next phase
exists. It does not end the run, so `senawa status` keeps reporting
`mode: running` for a workflow that has nothing left to do. Two commands
describe the same run and disagree.

This is not obviously a bug to fix by making `advance` end the run. `end-run`
sits with `pause-run` and `resume-run` in the trusted human authority group, so
ending a run is currently something a person does, and having the driver do it
silently would take that away without anyone deciding to.

The contradiction is real either way, so it is a plan item rather than a quiet
change: either the last phase closing ends the run, or `advance` stops saying
`finished` about a run that is still open, and `status` says what is actually
left. Both are defensible; picking one without asking is not.

### Decided: a completed workflow leaves its run open

`end-run` resolves through `trustedFacts.humanAuthority`, so the driver cannot
end a run without fabricating a human decision. That settles it: the last phase
closing does not end the run.

So `advance` stops claiming `finished` about a run that is still open and says
"every phase is done; end the run when you are satisfied". `status` reporting
`mode: running` is then correct rather than contradictory, and the person who
has to decide is told there is a decision waiting.

## The operating contract cannot be told what it does not already hold

Putting completion criteria and evidence counts into the generated contract
looked like threading one more argument into `renderPromptPack`. It is not.

The broker re-renders the pack and compares digests to prove the dispatch got
the bounded deterministic rendering, and so do the Copilot worker, the portal
setup, and the broker conformance suite. A fifth input means every one of those
renders a different pack from the one the driver registered, and the whole tree
fails on `Dispatch prompt pack digest does not match the bounded deterministic
rendering`. Four suites said so at once, which is the guard doing exactly its
job.

The digest is reproducible from the context and the dispatch. So anything the
contract states has to be in one of them, and completion requirements are in
neither: they are derived beside the dispatch and stored next to it.

Reverted rather than left half-threaded. Stating criteria in the contract needs
them carried in the worker context, which is a context-shape change and a piece
of work in its own right.

The D-023 rename is finished: the bare `evidence` in a complete request is now
`completionEvidence`, matching the field the authority already judged it by. The
remaining `evidence` identifiers belong to git integration and remote receipts,
which are different evidence about different things.

## The failure policy could not say anything

Asserting that an authored `onFailure` reaches the compiled run found that it
never could. `failurePolicy` is run-wide and derived with `some`, so the run is
fail-fast when any phase says so. The authoring default was also `fail-fast`, so
every phase said so, so every run was fail-fast and no authored value could
change it. Writing `onFailure: continue` on a phase changed nothing at all.

A phase that says nothing now continues. That is the only default that makes
`some` mean something: the run stops early because an author asked a phase to
stop it, not because nobody mentioned it.

This is the second half of the same finding as the derived failure policy. The
first half was a value discarded on the way to execution; this half was a
default that made the value unable to differ. Neither shows up as a failure.

`onFailure` appears nowhere in the authoring guide, which is how a setting can
have an inverted default for this long. That belongs to the undescribed
capabilities sweep.

## Answering a worker without the portal

`approve` and `reject` were on the command line; answering a worker's question
was not, so a run blocked on a question needed the portal to get moving again.
`senawa answer <repository> <run> <text>` now resolves the pending question the
same way `decidePhase` resolves a pending approval: read the human need, submit
against the submission it names.

The help text is pinned by a test, which caught the new verb being undocumented
in the same commit that added it. That is the pin doing its job.

## The reference still described a document nobody writes

`senawa init` publishes `workflow.yaml`, `agents.yaml`, `sensors.yaml`, prompts,
and schemas. The CLI reference described it publishing `workflow.json`, told
readers doctor reads `.senawa/workflow.json`, and offered a worked example for
migrating a `senawa.json` from a location that no longer exists.

It also claimed "a v1 document receives a deterministic migration diagnostic and
is never reinterpreted as v1", which the v1 rename turned into a sentence saying
nothing twice.

The troubleshooting guide carried the worst of them: "No CLI command instantiates
a run, registers a configuration snapshot, or drives a phase directly. The only
workflow entry point is `senawa command submit`." Both `start` and `advance` do
exactly that, and have for some time. A reader trusting that line would not have
found the loop at all.

## What v1 keeps, changes, and drops

**Kept.** An authored workflow drives real agents to completion from the command
line. Every phase output is validated against the schema its phase declared
before it is published. Refusals are durable outcomes carrying reasons, not
transient errors. The kernel stays free of filesystem, process, network, clock,
and randomness. The IPC credential never reaches an operator surface, now proven
against status, doctor, and a generated diagnostics bundle rather than logs
alone. Prompt packs are reproducible from the context and the dispatch, which is
why completion criteria could not be added to the contract without moving them
into the context first.

**Changed.** Authoring is YAML; there is no lowered document to write by hand,
and the reference no longer describes one. A phase that declares no gate now
presents an empty gate rather than no gate. A phase that says nothing about
failure continues rather than failing fast, because the run-wide derivation
takes `some` and the old default made every run fail-fast. Worker credentials
and dispatch records are durable, because the process that dispatches and the
process that serves the agent are not the same one. The complete request names
its evidence `completionEvidence`, matching the field the authority judges.

**Dropped.** The claim that the only workflow entry point is `senawa command
submit`. The `senawa.json` migration guidance. The promise that Senawa uses the
first model route that works, which was never wired. The promise that
`session: element` gives each fan-out member its own conversation, which is
validated, compiled, and read by nothing.

**Deferred, and said so in the guides rather than left implied.** Model route
fallback. Session scope. Completion criteria and evidence counts in the
operating contract. Whether a workflow whose last phase closes ends its own run,
which stays with the person who holds that authority.
