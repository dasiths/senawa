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
