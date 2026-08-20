# Senawa v1 implementation log

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

## The contract can state what completion means, because the context now carries it

The reverted attempt threaded completion requirements into `renderPromptPack` as
a fifth argument, and four suites refused it at once: the pack is re-rendered
from the context and the dispatch and compared by digest, so anything the
contract states has to live in one of those two.

So it lives in the context. `WorkerContextBase` now carries `completionPolicy`,
the same `{ criteria, completionEvidencePolicy }` the task definition declares,
and the generated contract states the criteria by name, which of them are
required, the evidence mode, and the minimum count of each kind. An agent can
now read what completion means before it starts work rather than discovering it
in a refusal.

### D-030: the context policy and the judged policy must be the same policy

* Date: 2026-08-18
* Status: Accepted
* Decision: `registerDispatch` refuses a dispatch whose context completion policy
  differs from its completion requirements.
* Alternatives: derive the context policy inside the broker, or trust the caller
  to pass the same value twice.
* Rationale: the contract an agent reads is generated from the context, and
  completion is judged from the requirements. Left unchecked, a dispatch could
  tell an agent one thing and refuse it by another, which is the same class of
  defect as an authored value that is parsed and discarded. Deriving it inside
  the broker was rejected because the broker has no graph.
* Consequence: every caller passes the policy it read from the task definition,
  and the fixtures that previously invented requirements now agree with their
  contexts.

### A canonical value is not a string, and coercing one throws

The first draft wrote `String(requirement.kind)` in the instruction line. An
evidence kind is a `CanonicalValue`, so it can be an object, and a canonical
object has a null prototype with no `toString`. The no-credit acceptance, whose
kind is `{ name, version }`, failed with `Cannot convert object to primitive
value`. Kinds are now serialised canonically when they are not strings.

Worth stating because the type said so all along and the code read as though the
kind were a name. Nothing in the suite caught it until a fixture used the shape
the type actually permits.

### Both tests were checked by breaking the code

Emptying the criteria list in the contract fails the renderer test. Disabling the
new broker comparison fails the conformance test, but only after the first
version of that test was rewritten: it re-registered the harness dispatch, so it
passed on the pre-existing duplicate-registration check instead of the new one,
and stayed green with the invariant disabled. It now registers a fresh dispatch
whose requirements disagree with its context.

## F-014: the path a real agent takes had no test, and it was lying twice

The scenario harness drove the broker directly, and every acceptance went that
way, so `BrokerWorkerSubmissionSink` had no test at all. It is the only thing a
real agent reaches over the worker channel, and it did two things no test could
see:

* It discarded every evidence item the agent attached. `senawa worker complete
  --evidence` read the files, sent them, and the sink replaced the list with an
  empty one.
* It reported every criterion satisfied whatever the agent said.

So a phase authoring `completionEvidence: { mode: task, require: [...] }` had its
completion accepted with no evidence at all. The policy was authored, compiled,
carried into the context, and then not consulted. That is the same shape as the
discarded `onFailure` and the ignored `completionEvidenceFrom`, and it is the
third time it has been found on the path between an authored value and the
behaviour it names.

Evidence is now ingested into assets during the complete call, per D-022, and
judged before any output is published, so a completion that owes evidence leaves
the phase untouched. The refusal names the scope, the kind, the minimum, and what
was actually carried:

```text
This completion owes evidence: this completion needs 2 of definition-note and carries 0
```

`completeThroughSink` exists so that path is exercised in future rather than
skipped again. Both new tests were checked by breaking the code: removing the
evidence check makes the refusal test fail.

### An evidence item can name the criterion it supports

The kernel counts task-scoped evidence and criterion-scoped evidence separately,
matching on `criterionId`, so a policy of `required-criteria` or `all-satisfied`
was unreachable from the command line: every attachment was task-scoped.
`--evidence <kind>@<criterion>=<file>` binds one, and a bare kind stays task
evidence, which is what the common case wants.

### The artifact listing hid the one thing a sharer needs

`senawa artifact list` printed identity, media type, size, and availability. The
sensitivity was in the metadata and dropped on the way to the line, so a person
deciding whether to send a run's artifacts anywhere could not see which of them
carried a classification. It is now in the line.

The confidential acceptance follows one authored `sensitivity: confidential`
output through the contract, the prompt pack, and the listing, and asserts the
body never appears in the first two while the label appears in all three.

## Two Phase 5 acceptances that were true and unproven

The Copilot tool has taken typed per-output parameters generated from each
output's schema since D-028; the plan note saying otherwise was written before
that change and never corrected. What was genuinely missing was the acceptance
tying the two halves together, so there is now a test where the authored prompt
says only "Complete the assigned work", the delivered prompt carries the
generated contract, and the worker completes through `senawa_complete`.

The first version of that test asserted the authored prompt matched no
`/senawa|complete|tool/`, and failed on the word "Complete" in an ordinary
English sentence. A test for protocol text has to look for protocol text, not
for words that also appear in it.

Prompt-pack verification covering the contract is now asserted directly: two
contexts differing only in completion policy render different pack digests, so a
contract that changed without its dispatch changing cannot survive the broker's
re-render.

## F-012 was half right, and the half that was wrong blocked the whole loop

F-012 concluded that a retry was impossible by construction: a task scope is a
one-shot claim, `claimsAccepted` is set true exactly once and never reset, so a
second attempt at the same task can never be dispatched, and retrying therefore
needs amendment machinery to supersede the task.

The first two clauses are true. The conclusion is not, and reading
`registerDispatch` rather than reasoning from the fence model is what showed it.

A retry never touches `claimsAccepted`, because nothing fences anything: no
amendment is proposed, so the scope stays open. What refused the retry was one
line of `sameTaskScopeFence`, comparing the accepted context digest. A retry
necessarily has a new context, so it failed a comparison that exists to detect an
amendment changing a task definition under a live claim, in a situation where no
definition changed at all.

The amendment route would not have worked anyway. `compileAmendmentGraph` refuses
to add a task to a phase that has candidate history, and a phase whose gate was
evaluated has exactly that. So the recorded plan for retry could not have been
built as written.

### D-031: a later attempt takes the task scope over

* Date: 2026-08-18
* Status: Accepted
* Decision: `registerDispatch` accepts a dispatch for an existing task scope when
  the scope is still accepting claims and its fence generation is unchanged, and
  advances the scope's accepted context digest to the new dispatch's. The
  takeover is refused unless the new context's phase attempt ordinal is strictly
  greater than the one the scope currently accepts.
* Alternatives: superseding the task by amendment, which the candidate-history
  refusal blocks; or dropping the digest comparison entirely, which would let a
  dispatch built against an older context claim a scope a newer one holds.
* Why it is not a weakening: fencing is what closes a scope, and fencing sets
  `claimsAccepted` false and bumps the generation, both of which still refuse.
  The digest comparison was doing "this is the current dispatch", and monotonic
  attempt ordinals say that more precisely.
* Consequence, and the part that makes it correct rather than merely permissive:
  `admitSubmission` still uses the strict comparison, so once the retry takes the
  scope over, the refused attempt's late submissions become stale rather than
  being accepted into the phase. The runner refuses to claim its effects for the
  same reason. That is exactly the behaviour a retry needs.

Two invariants downstream had assumed one accepted context per scope forever:

* The durable mirror threw `Context and runner task-scope currentness diverge`
  when the context authority advanced the digest. Only the context authority ever
  writes that field, and fencing moves the other two, so the mirror now carries a
  digest-only change and still refuses a divergence in fence generation or
  claim acceptance.
* Rehydration required every stored dispatch's fence to equal the scope's
  accepted digest, which the superseded attempt's dispatch no longer does.
  `isHistoricalTaskScopeFence` now means what its name says, and no longer
  compares the digest that a takeover is defined to change.

### The next attempt is told what the last one failed

A retry that is not told what to change only spends an attempt. The reasons
cannot go in the mapped input, because that is validated against the phase's
declared input schema and an extra key would be refused. They travel in the
worker context as `priorRefusals`, bounded at 32 entries of 1,024 characters, and
the generated contract states them:

```text
This is attempt 2. The last one was refused for these reasons, so change what they name:
- measure did not pass
```

That is the same route `completionPolicy` took, and for the same reason: the
prompt pack is reproducible from the context and the dispatch, so anything the
contract says has to live in one of them.

The driver now reads `maximumAttempts` and `onGateRejected` from the authored
phase, so the loop the brief describes is the loop the workflow states. Three
existing scenarios asserted a terminal refusal under the default policy, which
now retries; they declare `attempts: 1` so they still measure the refusal rather
than being rewritten to agree with the new behaviour.

## A rejection is a retry too, and the reason is read back rather than paraphrased

`onApprovalRejected` was authored and unread, the same shape as `onFailure`
before it. `close-phase` refuses a rejected candidate with `rejected-authority`,
which the driver now tolerates: it reads the reason back out of the recorded
decision, dispatches the next attempt with it, and reports `rejected` when the
policy or the attempt ceiling says to stop.

Reading it back matters. The reason is bound into the decision digest precisely
so it cannot drift from what the person said, and a driver that summarised it
would hand the agent a paraphrase of the only sentence that mattered.

Two latent collisions had to be fixed for any of this to work twice. The
candidate carried `attempt: 1` regardless, so a second attempt would have built
an identical candidate and hit `candidate-exists` forever. And the gate and close
commands used one identity per phase, so an attempt-two evaluation would have
replayed attempt one's cached refusal. Both now carry the attempt.

## Liveness is a compile error, not a paragraph

The plan asked for proof that no reachable state leaves a run unable to progress,
await a person, fail, or escalate. Prose cannot hold that; an exhaustive switch
can. `classifyOutcome` maps every `AdvanceOutcome` to `progress`,
`awaiting-human`, or `refused`, with a `never` default, so adding an outcome
without classifying it fails to compile. The tests enumerate every kind, assert
each classifies, and assert every refusal carries at least one reason, because a
refusal that names nothing gives a person no basis to escalate on.

Writing it found that `describe` in the advance command had a `default` branch
that reported everything unrecognised as "every phase is done". A retry would
have printed that. It is now exhaustive too, and a run that retried says so.

## The live path is opt-in and honest about what it adds

`live-loop.test.ts` drives a real Copilot agent through a scenario dispatch and
then advances the run to completion. It is skipped unless `SENAWA_COPILOT_LIVE`
and the cost acknowledgement are both set.

What it adds over the scripted acceptances is narrow and worth stating: the
scripted worker is told the protocol by the harness, and a model has to find it
in the generated contract. The first draft stubbed the route selection with a
cast, which would have made it pass while proving nothing; `startAuthoredRun` now
returns the real selection instead.

## F-015: fan-out reports itself as a broken workflow

Driving a compiled fan-out found that reaching one throws:

```text
Phase implement declares no executable work
```

An author who wrote a valid `forEach` reads that as their workflow being wrong.
It is not: a fan-out phase has no task until its members are materialised from
the collection the earlier phase produced, and v1 does not materialise them. The
refusal now says that.

This is the fifth time in this redesign that an unimplemented or discarded thing
has presented as a defect in the consumer's input rather than as a limit of the
product. The others were the missing `workflow.json`, the ignored unknown field,
the discarded `completionEvidenceFrom`, and the inverted `onFailure` default.

### What running a fan-out actually needs, established rather than assumed

Members cannot be dispatched without existing in the graph, because completion
requirements and the candidate are both derived from graph tasks. Materialising
them is therefore a graph amendment, and `PlanImportCoordinator` already turns a
`FanOutEvaluation` into an `AmendmentProposal` for exactly this.

The obstacle is not machinery, it is authority. `record-amendment-decision` is
authorised for `release-manager` alone, so as things stand every fan-out would
stop and ask a person to approve the members its own workflow declared. The
brief's fan-out diagram has no human between the planner completing and the
members running, and states that humans are asked only at declared phase edges.

The resolution the evidence supports, recorded here so the phase that builds it
does not reopen the question: an amendment whose diff is additions only, arising
from an accepted output of a phase that authored `forEach`, is the authored shape
being filled in rather than an unplanned graph change, and needs no human
decision. `ImportPlanResult` already separates `proposal-enqueued` from
`review-required`, and the fan-out diff classifier already forces review on any
change or removal, so the distinction exists and is unwired rather than absent.

Not built here. Recorded with its evidence so it is a decision waiting to be
executed rather than a question waiting to be asked again.

## F-016: the dead-export acceptance measures three different things

"No exported production symbol lacks a production caller" sounds like one rule.
Building the check found it is three, with very different truth values.

The first draft counted every exported symbol and reported 670 findings, which is
not a gate, it is noise nobody will read. Narrowing it three times, and checking
each level against the source rather than accepting the count:

* **Types are not dead when nothing names them.** A type describing a function's
  parameters is used by every caller who writes an object literal. Condemning
  those would delete the vocabulary the codebase is written in. Values only.
* **`export *` is invisible to identifier counting.** Half the remaining
  findings were symbols a package's `index.ts` republishes wholesale. Resolving
  star re-exports dropped 236 findings to 59.
* **A symbol its own test imports is an internal under test.** Those 59 included
  symbols exported only so a unit test could reach them, which is a reason to
  export, not a defect. Condemning them would buy a tidier surface with worse
  tests.

What survives is unambiguous: an exported value that no other file mentions at
all. Twelve of those existed and are now module-private. `pnpm check:exports`
runs in the pipeline, and reintroducing one is proven to fail it.

The lesson generalises past this check. A criterion stated in one sentence can
still be three rules, and the count a first implementation produces is evidence
about the rule rather than about the code.

## The three remaining guides were accurate and incomplete

The plan said operations, portal, and security "still describe the earlier
surface". Checking every claim in all three found no false ones: the paths,
modes, byte limits, session lifetimes, capability lists, and route behaviour all
match the source. The log entry was written before later commits corrected them.

What is wrong is different and worse in one way: `senawa start`, `advance`,
`approve`, `reject`, and `answer` appear zero times across all three. An
operator reading operations.md end to end learns to run a daemon, take a backup,
verify integrity, and produce a diagnostics bundle, and never learns how to run
a workflow or unstick one. Security.md describes the in-process worker
capability set and never mentions the per-dispatch worker credential, which is
the whole of D-010, D-014, and F-003.

A guide that says nothing false while omitting its subject is not a correct
guide. Operations now opens the loop with what each `advance` outcome means and
what to do about it, security carries the worker channel including the honest
statement that it prevents privilege by identity and not privilege by theft, and
the portal guide states that every decision it offers is also a command and that
neither surface can start or advance a run.

Every command name and outcome string in the new prose was taken from the help
text and the `describe` switch rather than from memory, which caught two errors
before they shipped: the credential lives under `dispatches/<id>/credential`
rather than a `worker/` directory, and `output-refused` was missing from the
outcome table.

## The authoring reference is the reader, written down

Every field, default, bound, and diagnostic in `docs/reference/authoring.md` was
read out of `authoring.ts` rather than recalled. Several would have been wrong
from memory: `onFailure` defaults to `continue` and not `fail-fast`, a sensor's
timeout is 300000 rather than 30000, and `field` is required for every gate
comparison except `exitCode`.

The page states the deferred things where an author would otherwise assume them:
`session` and the order of `models` are compiled and validated and read by no
runtime, and a fan-out compiles without running. An author who believes a route
fallback exists will not understand why a run stops at a limit rather than moving
to the cheaper model, so the sentence that reads worse is the one that ships.

The host limits are listed as limits rather than as defaults an author forgot to
change, which is the distinction F-004 said the plan kept blurring.

## The design set described a system with two extra budget units and no driver

Sweeping `docs/design` against source found the same two shapes as the guides.

False claims, three of them: `BUDGET_UNITS` was described as eight units in two
places, and `elapsed-time-ms` and `spend-nano` were removed by D-029 for never
being counted. `EvidenceAttachment` and `EvidencePolicy` were renamed by D-023
and the design set kept the old names, which is worse than a stale name because
the rename exists to stop a reader confusing agent testimony with senawa's own
measurement. Both are corrected, and the distinction the rename protects is now
stated where the type is defined.

A missing subject, again: `advanceRun`, `dispatchPhase`, and `senawa advance`
appeared zero times across all eight design documents. The component this whole
redesign was built to add was absent from the set that explains how the system
works. `architecture.md` now describes the three files, why one step per call is
the right shape, why the prompt pack has to be rendered against a discarded
dispatch, and which two refusals are load bearing.

The remaining `alpha` sentences went with it. D-027 renamed the product and left
prose behind in two design files.

## Refusals that named a problem and no next step

Six consumer-facing messages said what was wrong and stopped there. A refusal is
the prose a consumer reads while something is going wrong, so it is the worst
place to make them work out what to do:

| Was | Is |
|---|---|
| A rejection must carry a reason | ...The next attempt is given it word for word. |
| Nothing is waiting for a decision on this run | ...Run senawa status to see what it is waiting for. |
| An answer must carry text | ...The agent that asked reads it as written. |
| Nothing is waiting for an answer | ...Run senawa status to see what it is waiting for. |
| not available as verified stored content | senawa never verified these bytes against their digest, so it will not serve them... |
| Supervisor did not become ready | ...Read senawa service logs for what it refused. |

The artifact one is the clearest gain. The old wording named a state a consumer
has no vocabulary for; the new one says what senawa declined to do and why, which
is the same fact in words that answer the question the reader is actually asking.

## What this redesign accepted, changed, disproved, and deferred

Recorded once, at the end, so a later reader can tell a settled contract from a
guess that survived.

**Accepted, and proven by executable checks.** An authored workflow drives real
agents from the command line. Completion is granted against sensors that execute
real code, never against a claim. A refusal publishes nothing and carries reasons
the next attempt is given. The kernel stays free of clock, randomness, network,
filesystem, and process. Worker and operator identities are separate and
mutually unreachable. Every phase output is validated against the schema its
phase declared before publication. There is no reachable outcome that means
stuck, and that is a compile error rather than a claim.

**Changed, with the reason recorded.** Authoring is YAML and there is no lowered
document to hand-write. A phase declaring no gate presents an empty gate rather
than no gate. A phase saying nothing about failure continues rather than failing
fast, because the run-wide derivation takes `some` and the old default made every
run fail-fast. Worker credentials and dispatch records are durable, because the
process that dispatches and the process that serves the agent are different ones.
A later attempt takes a task scope over rather than being refused by it.

**Disproved, having been believed.** F-012 said a retry needed amendment
machinery because a task scope is a one-shot claim; a retry never fences
anything, and the amendment route was blocked anyway by the candidate-history
refusal. The plan said the operations, portal, and security guides described an
earlier surface; they described the current one accurately and omitted the run
loop entirely. The dead-export acceptance read as one rule and was three, two of
which condemn legitimate code.

**Deferred, and said so where an author would otherwise assume otherwise.**
Fan-out execution, which needs member materialisation by amendment and settles an
authority question F-015 records. Session scope and model route fallback, both
compiled and read by nothing. Live steering. The agent-pool view.
Whether a finished workflow ends its own run, which stays with the person who
holds that authority.

## Progressive disclosure, and the assertion that makes it mean something

The overview led with six counters, two of which answer "why is nothing moving"
rather than "what is this run", and an authority vector panel of digests. The
delivery view led with two revision numbers. All of them are what a reader wants
once they have a question and noise before they do, so they are behind a
`details` element now.

`details` rather than a custom toggle, because it is keyboard reachable and
readable by assistive technology with no code here, and because the browser
already knows how to render it.

The assertion is the part worth keeping. The existing browser test checked that
"Dataflow revision" was visible, which the change broke correctly. Rewriting it
to open the disclosure first would have been agreeing with the change; it now
asserts the text is *hidden*, opens the disclosure, and asserts it is visible.
That is both halves of the acceptance in one test, and removing the disclosure
makes it fail.

Two more parallel-load timeouts surfaced while running the full suite repeatedly:
a workspace restart acceptance and a git binary-conflict case, both passing alone
and both spawning real processes. They declare their budgets now. That is the
third time this shape has appeared, which suggests the five second default is
simply wrong for a suite that spawns processes, and a repository-wide
`testTimeout` would be the better fix than annotating them one at a time. It is
now 30 seconds, and the per-test annotations added while chasing the individual
flakes are removed, because a workaround left in place after the cause is fixed
reads as a fact about that test.

## The two fixtures F-004 asked for, and the assertion that nearly did nothing

The concise fixture is what `senawa init` scaffolds and the explicit one is the
repository's own tree. The concise test asserts the scaffold states no
`attempts`, `sensitivity`, `completionEvidence`, or `onGateRejected`, and that
the compiled run carries the documented defaults for all four anyway. The
explicit test asserts each overridden value reaches the compiled document.

One of the four assertions was worthless when written. It checked that
`workflow.yaml` contained `onFailure: continue`, which is the text of the input
rather than the effect, and the repository authors the same value the default
produces. Hardcoding the lowering to ignore the field left the test green. It was
removed rather than repaired, because the scenario suite already proves that one
properly by compiling both policies and comparing them.

The three that remain were each checked by discarding the authored value in the
lowering, and each fails. That is what makes this an acceptance rather than a
description: it catches the specific failure F-004 found four separate times, a
value parsed, validated, and then not threaded through.

## The default view was changed, and the tests moved with it

The portal opens on the graph. Booting lands there, and the browser tests that
drive run controls navigate to the overview first, because that is where pause,
resume, and end live.

An earlier attempt at this was reverted on the grounds that making a person
navigate to pause a run was a product decision I should not settle by editing
tests. That was over-cautious: the brief already says graph and terminal are the
primary surfaces, so the decision was made, and the navigation in the tests is
what a person does rather than a workaround.

Five tests needed it, and one of them for a reason worth recording. The
overview-race journey asserts "Run paused" on its *main* page, which is a badge
on the overview; the test is about the overview read, so that page belongs on the
overview throughout rather than only its controller.

Moving the controls into the persistent rail so no navigation is needed at all
remains worth doing, and is now a layout improvement rather than a blocker.

## D-032: a plan import is decided by the engine, and F-015 was too pessimistic

F-015 said fan-out execution was blocked on an authority decision nobody had
made. Reading the code rather than reasoning from the role list showed the
decision was smaller than that, and mostly already made.

Two facts settle it. `record-amendment-decision` is not a trusted-human-authority
intent: it is an ordinary intent gated by the role policy, unlike `end-run`,
`pause-run`, and the rest. And the plan-import bridge already submits its
proposal under an **engine** principal, so the engine has always been trusted to
propose one.

More to the point, the review question is answered *before* the proposal exists.
`PlanImportCoordinator` refuses to enqueue anything whose diff changed or removed
a member without an explicit decision. A proposal that reaches the authority has
therefore already passed the only review that was ever required.

* Date: 2026-08-19
* Status: Accepted
* Decision: a proposal whose source kind is `import-plan` may be decided by a
  principal without the release-manager role. Every other proposal needs one.
* Where it is enforced: the authority, not the role policy. The policy answers
  who may call the intent; the authority answers whether this principal may
  decide this proposal. A deployment that grants `engine` the intent still cannot
  use it to approve a worker's amendment.
* Consequence: asking a person to approve the members of a fan-out they wrote is
  asking them to approve their own workflow, and that is no longer asked.

## Fan-out runs

`planFanOut` evaluates the frontier over the accepted upstream collection, builds
the member tasks, and proposes them; `advanceRun` decides and applies the
proposal, then dispatches members one at a time. A two-element collection now
produces two member tasks and a dispatched first member.

Seven defects stood between the first attempt and that sentence, and each was
found by running the path.

* **The driver never read its upstream outputs.** `upstreamOutputs` returned
  `canonicalValue({})` as every value. The two-phase acceptance passed because
  its second phase accepts an empty object. Fan-out cannot, because the
  collection is the whole point. It loads the stored asset now, which also means
  every second phase finally reads what the phase before it produced.
* **An item without `dependsOn` was an error.** The authored lowering always sets
  the dependency pointer, so every element had to carry an ordering field. An
  item that says nothing depends on nothing.
* **The template's criteria are authored keys; a graph task references criterion
  node identities.** The nodes are built first and the policy references them.
* **The result snapshot and the proposal each need the other**, because a
  proposal binds its result snapshot to its result graph and the result graph
  only exists once the proposal compiles. The first proposal exists to produce
  the graph, exactly like the prompt pack's discarded first dispatch.
* **Allocated approval identities were malformed.** `advance-run` built
  `approval-<digest>-1`; approvals require `approval_` and lowercase. This is the
  second time this exact trap has been hit, and it was invisible the first time
  because the driver reported only the refusal code. It now reports the message
  too, which is what named the problem in one run.
* **The driver recompiled from the authored project every call**, so it never saw
  the amended graph and fanned out forever. It reads the run's current graph now.
* **A fan-out phase carries no role.** Its members run the agent the task
  template names, and read their own element rather than the upstream collection.

### An amendment had never met a closed phase

The last one is the most interesting, and it is a real gap rather than a wiring
mistake. Applying an amendment changes the graph revision. Every archived phase
lifecycle holds a candidate that names the revision it closed under, and the
projection re-derived all of them against the new graph, so the apply failed with
`graph-mismatch` on history that was already settled.

Archived lifecycles arrived with D-011, after the amendment machinery, and the
two had never been exercised together. Every existing amendment test amends a run
whose phases have not closed.

A candidate that names an earlier revision is history: re-deriving it against a
later graph asks a question the record never answered, and its own digest still
verifies, which is the integrity the record actually carries. `historical` now
threads through candidate validation, closure validation, projection, and
rehydration, and is set only when the recorded revision differs from the current
one.

## D-033: session scope is what may change and still be the same conversation

`decideAgentSessionResume` compared fifteen fields and resumed only on exact
equality. Research called it a replay guard rather than a persona rule, and that
is right, but the consequence was stronger than recorded: cross-phase resume was
not merely unreachable, it was unreachable *by construction*, because a second
phase differs in the prompt, the input, the context, and the task. So did a
retry, which differs in all the same ways precisely because it carries the
reasons the last attempt was refused.

* Date: 2026-08-19
* Status: Accepted
* Decision: the decision takes a scope. `attempt` keeps the fifteen-field guard.
  `phase` compares the task and the graph, so a retry resumes. `run` compares the
  workflow alone, so a persona keeps its session across the phases it works.
* Why the field sets are what they are: what a scope ignores is exactly what the
  session exists to carry. A retry that started fresh would forget why it was
  refused, which is the whole value of the durable session in the rejection loop.
* Consequence: `attempt` remains the default, so nothing resumes differently
  until a caller asks for a wider scope, and the replay guard is unchanged for
  every existing caller.

The adapter now takes the scope, so the authored `session: run | phase | element`
has somewhere to arrive. What remains is the driver recording a binding per
dispatch and looking up its predecessor, which is what turns the scope from
expressible into effective.




## Terms used everywhere and defined nowhere

`anchor`, `backpressure`, and `frozen set` appeared in the README and in no
design page. `completion evidence` and `gate evidence` are the pair whose
confusion D-023 exists to prevent, and the distinction was stated in the brief
and nowhere a reader of the design set would find it.

The design index now defines fourteen terms once each, and the pages use them
without redefining them. The two evidence entries carry the property that decides
correctness in their definition rather than in a paragraph elsewhere: completion
evidence can be argued with and therefore never backs a gate.

Checking the counted claims on the same pass found two more that had drifted.
Durability described thirteen migrations and `CURRENT_SCHEMA_VERSION` as 13; D-027
collapsed the chain into one baseline and set the version to 1. The page now says
so, and says why the collapse was safe, because a reader who knows migrations
exist to carry an installed base forward should be told that v1 has none.

Two counted claims were checked and are correct: twelve components, and eight
manifests read by the boundary script. Counting them was cheap and the alternative
was leaving two more numbers nobody had verified.

## F-019: the driver ran the phases in alphabetical order

Building the first example outside the test suite produced a run that finished
after one phase. The workflow declares `research`, `plan`, `implement`, and the
research agent did its work, closed, and the driver reported "every phase is
done".

`nextPhase` read the phase order from `snapshot.phaseDataflow` and took the
entry after the one that closed. That registry is sorted by key, because every
registry in a configuration snapshot is sorted for canonicalisation. The order
it holds is alphabetical: `implement`, `plan`, `research`. Closing `research`
found the last entry, so there was nothing after it.

The graph is not the answer either. `sortNodes` orders nodes by definition id,
which is a digest. In this example the three digests happened to ascend in the
authored order, which is how a first reading of the live database appeared to
confirm that the graph preserved declaration order. It does not; it agreed by
coincidence, and a workflow with one more phase would have disagreed.

What survives canonicalisation is `dependsOn`, which the authored `needs:`
lowers to. `phaseSequence` now recovers the order from it: no phase precedes
something it needs, and phases that need nothing from each other keep the
registry's stable key order, so nothing that had no dependencies changes.

The severity is in what the suite could not see. Every phase pair in the
scenarios is named in alphabetical order — `define` then `verify`, `define`
then `implement` then `verify` — so registry order and authored order agreed in
every test, and the bug was invisible to 1484 of them. The workflow that
`senawa init` writes is `plan` then `implement`, which is the opposite order:
the template shipped a second phase no run could reach. The regression test
names its second phase `assemble` for that reason, and was confirmed to fail on
the old code before the fix was kept.

## F-020: the production policy had never been asked about `start-phase-attempt`

Fixing F-019 turned "every phase is done" into "start-phase-attempt was refused:
unauthorized". `runtimeDependencies.authorization` listed twenty-two of the
twenty-three intents the protocol accepts, and the missing one was the intent
that starts the second phase. A policy that denies by default plus an intent
nothing ever sent is a gap that stays silent for as long as the other bug lasts:
each defect was the reason the other could not be observed.

Listing the intent is a one-line fix and worth little on its own. The guard is
the test: a `Record<CommandIntent["type"], readonly string[]>` naming a role for
every intent, asserted against the shipped policy. It fails to compile when the
protocol gains an intent, which forces the decision about who may send it to be
made when the intent is introduced rather than the first time a user reaches it.

## F-021: a run that asked a question was stopped for good

Instructing the example's research agent to ask a person is what found this.
The agent asked, and nothing happened, ever.

Three separate things were missing and each hid the next.

The model asked in prose. The operating contract said "Ask a question rather
than guessing when the assignment is ambiguous" and never said how, so a chat
model did what a chat model does and wrote the question in its reply. The
session then ended with `missing-completion` and no question was ever recorded.
The contract's first line already says a phase "is finished by calling senawa,
never by printing a result in your reply"; asking needed the same sentence and
did not have it.

An unanswered question writes a row in `context_fresh_dispatch_requirements`,
and `ProductionScheduler.schedule` refuses to work while one is unsatisfied.
Nothing in the repository ever set `satisfied_by_dispatch_id`. The column is
written once, as `NULL`, and the baseline migration carries a trigger for an
`UPDATE` that no code performs. So the requirement was permanent and the
scheduler stopped forever.

The answer was never delivered. `senawa answer` wrote it to
`context_question_answers`, the portal could read it, and the agent could not:
no prompt, context, or session carried it. Answering was a durable record of a
decision nobody acted on.

The fix is a loop rather than three patches. `answeredQuestions` is now part of
the worker context, so it is covered by the context digest like everything else
the agent is told. The driver sees an answered-but-undelivered requirement,
dispatches the phase again carrying the question and the answer in the person's
words, and marks the requirement satisfied by that dispatch. The contract tells
the agent to ask by calling senawa, that asking stops the run, and that the
answer arrives on a later turn.

Two consequences worth stating rather than burying.

The answer arrives on the **next attempt**, not the same one. A task scope is
taken over only by a strictly greater attempt, which is the invariant that makes
the turn that asked unable to hand work in afterwards. Keeping the same attempt
would need that invariant relaxed, which is a worse trade than spending an
attempt. So a question costs an attempt against the authored ceiling, and a
phase whose agent asks three questions needs `attempts` above three. For a model
policy with more than one route it also advances the route, which is wrong in
principle for a question turn and is not corrected here.

## F-022: `senawa advance` invented the input the run was started with

Found while making the answer loop dispatch twice against one attempt. The
second dispatch was refused for disagreeing with the first about the phase
attempt's content, and the disagreement was the workflow input.

`runAdvanceCommand` passed `bindingDigest: "0".repeat(64)` and `canonicalValue({})`.
`senawa advance` runs in its own process and has no memory of `senawa start`, and
nothing read the run's binding back, so every phase the command dispatched read
an empty object as the workflow input. The template's later phase reads only its
upstream, which is why nothing had noticed.

`queryWorkflowInput` reads the binding, the asset store supplies the value, and
the command dispatches on what the run was actually given. The scenario harness
did the same thing with a fixed fake digest, and now reads it back the same way,
so the tests exercise the path the command uses.

## F-023: asking twice made the database refuse to open

The first live run with a question-asking prompt asked three. Every process
that opened the authority afterwards died on
`SQLite context_questions row 0 diverges from canonical context authority`.

The integrity check reads the table `ORDER BY submission_id` and the canonical
authority in the order things happened, then compares them row by row. A
submission id is a digest, so with one question the two agree by having only one
element, and with two they agree only by luck. Every row in these tables is
keyed, so the two sides hold a set rather than a sequence; the check now sorts
both sides before comparing, which keeps it exact about content and stops it
inventing an ordering invariant nobody holds.

## F-024: a real retry corrupted the run, and only a real one could show it

Delivering the answer dispatches the phase again, which took the task scope over
with a later attempt, which broke `verifyAmendmentTables`:
`SQLite runner command diverges from shared task-scope currentness`.

The check demanded every queued runner command name the scope's *current*
accepted context. A queued command is a durable record of what was asked for at
the time, so after a takeover every earlier command names an earlier context by
construction. What actually must not happen is a command ahead of the fence, and
staleness is stopped where it matters, in `persistIntent` at claim time.

The reason this was never seen: `advanceRun`'s retry path is exercised only by
the scenario harness, which submits through the broker sink and never queues a
runner command. Every test of a retry therefore ran without the one row that
made a retry fail. The new test enqueues a command, registers a later attempt,
and reopens the authority; the old check refuses it.

Both defects were reachable by any run that retried a phase after a real worker
effect, which is to say by any real run, and neither had anything to do with
questions. Asking three questions is simply what finally produced two of
something the suite only ever produced one of.

## F-025: no retried phase could ever close

After the answer loop worked, the live run's research phase had three dispatches
against one task and refused to close:
`Task task_e30b… is selected more than once`, and once that was fixed,
`acceptedAccountingAssessments[0] is stale for its selected task generation`.

`dispatchedPhaseTasks` collected the task of every dispatch the phase owned. A
task attempted more than once has a dispatch per attempt, so a retried phase
selected the same task once per attempt. A candidate selects a *set* of tasks,
so it refused itself. The same collection fed the assessments, so the second
error was the same mistake seen from the other side: an earlier attempt's
completion was assessed against an earlier context revision, which is stale by
construction.

Both now read the latest dispatch of each task. An earlier attempt is history:
it is not the phase's current work, and its evidence is not what closes the
phase.

This has nothing to do with questions. Any phase that retried — after a red
gate, after a rejection, after an abort-retry steer — could not close. The
scenario suite covers the retry itself and stops at the retry: every test
asserts that a second attempt was dispatched and none asserts that a phase
survives one. The new test steers an abort-retry, hands the second attempt in,
and closes; the old code refuses it by name.

Also fixed here: `senawa advance`, `answer`, `approve`, `steer`, `override`, and
`start` now wake a running supervisor over IPC. They write durable work and
exit, and the supervisor is otherwise woken only from inside its own process, so
it slept through everything another process asked of it until it next started.
Confirmed live: answering a question and advancing now runs the agent without a
service restart.

## F-026: a declared phase input could not name what it read

The example's plan phase declares `plan-input`, which is `{request, research}`,
and the run refused to dispatch it: `mapped phase input does not satisfy schema
plan-input`.

Lowering derived a phase's mappings from `needs` alone. One upstream landed at
the root whatever the phase declared, more than one landed under a member named
for the *phase*, and the workflow input was unreachable to any phase with an
upstream. So a declared input schema could name only the phase names of its
upstreams, could never read the request the run was started with, and was
checked against none of that until the moment the phase was dispatched.

The repository's own workflow shows the same thing: `plan-input` names
`definition` and `research`, where `definition` is the *output schema* of the
phase called `define`. Lowering produced `{define, research}`, which that schema
refuses. Nothing drives the repository's workflow end to end, so it compiled
clean and would have failed on its second phase.

Lowering now reads the declared input schema's property names, which is what the
author is saying they want, and binds each one: a property named for an upstream
phase or for that phase's output is that output; a property the workflow input
declares is that property of the workflow input. A fan-out phase is excluded,
because there `input:` is the shape of one element rather than a merge.

What this does not do: `verify-input` in the repository's workflow names
`completionEvidence`, which is assembled from a declared evidence view rather
than mapped from a source. Lowering leaves such a property unbound rather than
refusing it, so that phase is still undispatchable. The mapping model has no way
to express "this member comes from the evidence view", and inventing one from
here would be guessing. It is the next thing to fix in this area.

## D-046: the supervisor drives runs, so the portal is a complete surface

Driving the example from the browser found that the portal could answer a
question and nothing would act on the answer. Verified on a clean run: the badge
showed `Needs 1`, the dialog submitted, the status line read `answer-question
completed`, needs went to 0 — and forty-five seconds later there were still two
dispatches, one unsatisfied fresh-dispatch requirement, and both surfaces
reporting `waiting on you: 0`. The run looked healthy and idle. It was stuck.

Delivering an answer lived in `advanceRun`, which was only ever called by
`senawa advance`. The supervisor executed work that some other process had
dispatched and never moved a workflow forward itself. So the portal was a
complete surface for answering and no surface at all for progressing, which
makes answering from it pointless.

* Date: 2026-08-19
* Status: Accepted
* Decision: the supervisor drives. `SupervisorRunController` takes a
  `driveRunOnce` hook, called at the end of a cycle when no effect was in
  flight, and the daemon supplies it with `advanceRun`.
* Why there and not elsewhere: the controller already holds the run lease. A
  second process driving the same run concurrently is exactly what the lease
  exists to prevent, so driving belongs inside it.
* What the service needed: `SENAWA_PROJECT_DIR`, defaulting to its working
  directory. Driving compiles the workflow and runs its gate sensors, and
  neither is possible from `SENAWA_REPOSITORY_DIR`, which is the agents' write
  area and deliberately not the project.
* Consequence for the CLI: `senawa advance` now asks a running supervisor to
  drive rather than driving alongside it, and only drives in-process when
  nothing is listening. One process moves a run at a time, always.
* Consequence for a person: they answer, and the run continues. Confirmed live
  from the browser with no command line at all — answer, fifteen seconds, the
  agent had read it, worked, and asked the next question.

## F-027: an authored attempt ceiling was three whatever the author wrote

The first self-driving run escalated for budget on its fourth attempt of a phase
authored `attempts: 8`.

`attempts:` set the phase's `maximumAttempts` and nothing else. The agent
executor's budget came from `AGENT_BUDGETS`, a module constant fixed at three,
so the iteration policy and the budget that actually stops the work disagreed
whenever an author raised the ceiling. Raising `attempts` bought nothing beyond
three.

The budget is now sized from the phase's own ceiling. They are two counters for
one thing and there is no reading under which they should differ.

## F-028: a step could be taken once per run, whatever it decided

The first self-driving run stalled closing its research phase:
`evaluate-gate was refused: command-id-conflict: Command identity is already
bound to a different canonical envelope`, and every retry gave the same answer,
so the run could not proceed by any route.

`submit` derived a command identity from the run and the step name and nothing
else. Two different decisions from the same step therefore arrived under one
identity, and the authority correctly refused the second for conflicting with
the first. A phase that reached a step twice — which any retried phase does —
was stuck there for good.

The identity now carries the payload digest as well. Replay is unchanged: the
same decision digests the same and is recognised as the command already
recorded. A genuinely different decision is a different command, which is what
it is.

Fixing it let the live example close research and dispatch its plan phase.

## F-029: a gate-refused phase cannot close on a later attempt

Writing the regression test for F-028 found the next wall. A scenario whose
sensor fails once and then passes gets as far as the second attempt's
completion and is refused:
`submit-completion was refused: candidate-exists: Completion cannot change
after candidate creation`.

The first attempt's refusal created a candidate for the phase, and the
authority holds that a completion may not change what a candidate already
decided. That is right for one attempt. It is wrong across attempts: the
retry exists precisely to decide again, and nothing supersedes the earlier
candidate when a phase is retried.

The test is not kept, because a test that asserts a defect is a test that has
to be deleted to fix it. What is recorded here is the reproduction:

```
startScenario("gate-then-pass", {
  attempts: 3,
  secondPhase: true,
  sensorCommand: "test -f passed || { touch passed; exit 1; }",
})
```

complete, advance (refused, retrying), complete the retry, advance. The last
step is the one that fails.

The three retry defects found this session — F-025's task set, F-028's command
identity, and this — are all the same shape: the phase model was built and
tested one attempt at a time, and every mechanism that records a phase's
decision assumes it happens once. Retrying is authored, documented, and covered
by tests that stop at the retry.

## F-030: the contract told an agent to ask senawa something it could not ask

The example's planner stopped the run to ask a person: "What is the schema for
the `plan` output, specifically the structure and required fields for each task
in the tasks array?"

The operating contract has said "Ask senawa for an output schema rather than
guessing its shape" from the beginning. The SDK worker's tools were
`senawa_read_asset`, `submit_question`, `propose_asset`, `record_discovery`,
`propose_amendment`, `senawa_complete`, and four workspace tools. None of them
answers that. `senawa worker output-schema` exists, but that is the CLI channel,
and an agent running under the SDK has no way to reach it.

So the contract named a capability the agent did not have, and an agent that
followed the contract did the only other thing available: it asked a person, and
the run stopped waiting for an answer senawa was holding the whole time.

`senawa_output_schema` returns each declared output's schema and the schemas it
references, and is offered only when the phase declares an output for it to
describe. The contract's sentence is now true.

Worth noting how this was found: not by a test, but by reading what a real agent
asked a real person. The instruction and the tool list were each correct in
isolation and nothing compared them.

## F-031: a worker that produced nothing kills its task, with attempts left

The live example's plan phase was dispatched twice. The second attempt produced
no submissions at all and ended `missing-completion`, which is a failed effect,
which fences the task: `claims_accepted 0, fence_generation 2`. The phase had
authored eight attempts and had used two.

A fence is permanent and there is no path back, so the run ends there. That is
right for a worker that corrupted something and wrong for one that simply did
nothing: the attempt ceiling exists precisely to decide how many empty turns are
tolerable, and fencing on the first one takes that decision away from the author.

Not fixed here. It needs a distinction the failure policy does not currently
draw, between an effect that failed and an effect that finished without doing
anything, and that is a policy question rather than a bug to patch.

## F-032: an unbounded answer is recorded, then can never be delivered

Found by typing into the portal, not by reading code. The answer textarea had
`maxLength: null`. A 9,000-character answer was accepted, the authority recorded
it, the receipt came back clean, and the portal cleared the need — every signal a
person gets said the question was answered.

The supervisor then failed to deliver it, twice:

```
drive-run-failed repository_rpi-workflow run_21f617aafb2470bb1431b90ba8c6bf68:
ContextError: An answered question must carry bounded non-empty text
```

`packages/kernel/src/context.ts` refuses answer text longer than 4,096
characters when it assembles the worker context. That check is correct and it is
in the wrong place to help: by the time it runs, the answer is an immutable
authority record. An answer cannot be replaced, so the agent waits for something
that will never arrive and the run is stranded with no operator action that can
recover it.

The bound now lives at the three places a person can reach:

* `MAX_ANSWER_LENGTH` in `packages/protocol/src/codec.ts`, enforced by
  `decodeAnswerQuestionPayload`, so no route into the authority can record an
  answer the kernel will later refuse. This is the load-bearing one.
* `senawa answer` exits 2 with the length it got and the length allowed, so the
  CLI reports a mistake instead of a stack trace.
* The portal caps the field at 4,096 and counts characters as they are typed, so
  the limit is visible before the decision is made rather than after it is
  irreversible.

Both tests were proven by deletion: removing the codec check fails the protocol
test, removing both checks fails the CLI scenario test.

The general shape, third time this session: a constraint enforced where the data
is *used* rather than where it is *accepted* turns a typo into an unrecoverable
run. Validation belongs at the boundary a person can still be told about.

Verified live afterwards: focus lands in the answer box, the counter reads
`0 of 4096 characters` and stops at 4096 when 5,000 are pasted, the field's
accessible name stays "Answer" with the counter as its description, the `Needs`
badge navigates to the needs view, and answering entirely from the browser
advanced the run's cursor from 3 to 6 with `answer-question completed`.

## F-033: a worker that submitted nothing is spent, not failed

F-031 recorded this as a policy question. Driving the example end to end settled
it: the question was blocking every run.

The live run's research phase asked two questions, was answered twice, and on the
next turn produced nothing. `missing-completion` became a `failed` effect, which
fenced the task permanently (`claims_accepted 0`), and the run ended there with
six of its eight authored attempts unused.

`resultObservation` now reports `missing-completion` as `cancelled`, beside
`awaiting-answer`, which was fixed for the same reason. A crash is still
`failed`: a worker whose session threw did something the run cannot reason
about, and fencing is the right answer for that.

`daemon-composition.test.ts` asserted the old behaviour under the name "fences a
failed repository writer", but its fake session returned normally and submitted
nothing, so it was a *silent* worker, not a failed one. Its subject — that a
fence survives a service restart — is worth keeping, so its SDK now throws. The
test proves what its name always claimed.

## F-034: a refused gate wedges its phase forever

With the fence fixed, the run reached the next wall. The driver evaluated the
research gate, the authority refused it once with `task-set-mismatch`, and every
later attempt was refused with:

```
evaluate-gate was refused: command-id-conflict:
Command identity is already bound to a different canonical envelope
```

The gate command was keyed `gate-<phase>-<attempt>`. A refused submission leaves
that identity bound to the envelope that was refused, so the corrected candidate
for the same attempt can never be submitted. The refusal is transient; being
unable to resubmit is permanent.

The identity now carries the candidate digest, so a different decision gets a
different identity. This is the same defect as the one fixed in "Key a driver
command on what it decided, not only on which step decided it" — a second place
where a command was keyed on the step rather than on what it decided.

The original `task-set-mismatch` was transient: re-running the same computation
produced the correct set (`graphTasks` and `candidateTasks` both held exactly
the research task). The wedge, not the mismatch, is what ended the run.

## F-035: a kernel refusal message is durable, and one bad run stops the service

While diagnosing F-034 I added the two task sets to the `task-set-mismatch`
message. Every existing database then refused to open:

```
TypeError: Stored command receipt or authorization decision does not match replay
```

A refusal message is part of the receipt the authority replays, so changing the
text of any kernel refusal invalidates every database that recorded it. That is
correct for an exact authority and it is not written down anywhere. It belongs
in the durability documentation before someone reworders a message in a release.

The second half is worse. The unopenable run took down the **whole supervisor**:
`SqliteSupervisorAuthority` constructs `SqliteAuthority`, `verifyDatabase`
throws, and the service process exits. One corrupt run therefore stops every
other run on that machine, and the failure appears as a service that will not
stay up rather than as a run that cannot be opened. A run that fails to verify
should be quarantined and reported, not fatal to its host.

Not fixed. Recorded with the reproduction: change any string passed to `fail` in
`packages/kernel/src/candidates.ts`, run a workflow far enough to record that
refusal, then restore the string.

## F-036: the driver waited forever for a turn that was already over

With the fence removed, a spent turn stopped killing the run and started
stalling it instead. The plan phase's agent produced nothing, the effect was
cancelled, and `step` reported `awaiting-agent` on every later cycle:

```ts
if (!completed || published.length === 0) return { kind: "awaiting-agent", phaseKey };
```

That reads "the agent has not finished" from the absence of a completion, which
is also what "the agent finished and handed in nothing" looks like. Only the
runner records the difference, because an empty turn writes nothing to the
context broker.

The driver now reads the effect outcome for the dispatch. A dispatch whose
effect reached a terminal outcome that is not `completed` is a spent attempt: it
starts the next one while attempts remain, and rejects the phase when they run
out. That is what the authored `attempts:` count is for.

## F-037: an agent retried a rejected completion twenty-six times

The live planner asked this, which is the clearest defect report in the log:

> I have attempted to submit a valid plan completion 26 times, and every attempt
> is rejected with error code "completion-arguments-invalid". I have tried many
> different JSON structures for the outputs parameter, all of which appear to
> match the schema returned by senawa_output_schema. What specific aspect of my
> plan submission is causing the error? Is there an undocumented constraint or
> format requirement I'm missing?

There was no undocumented constraint. `exactObject` threw a bare
`Invalid tool arguments`, the handler caught it and discarded it, and the agent
was told only `completion-arguments-invalid`. It could not learn which key was
unexpected or missing, so it guessed, and every guess cost a model call.

`exactObject` now names the unexpected and missing keys, and the refusal carries
that detail to the agent. Every other refusal in this system names its path and
reason; the one an agent hits most often did not.

## F-038: restarting the service ended the run

The plan task retried correctly four times and then fenced. The effect was
`crashed`, and a crash is the one worker outcome that still fences.

Nothing crashed. `copilot-worker.ts` ran the turn, then:

```ts
try { await session.disconnect(); } catch { status = "crashed"; }
```

Stopping the supervisor closes the SDK client under the running turn, so the
hang-up fails, so a finished turn is recorded as a crash, so the task is fenced
for good. Every service restart during a dispatch therefore ended the run — which
is what happened repeatedly while these fixes were being developed.

Hanging up is not part of the turn. A disconnect failure is now noted in the
transcript and leaves the outcome alone.

## F-039: one failing endpoint took every command offline

Naming transcript lines by agent needed the agent list, so the run view fetched
it alongside the graph. That list then returned 500, the whole assembly failed,
the portal reported `Connection offline`, and **every** button was disabled —
including the one that answers a blocked agent's question, which has nothing to
do with agents or the graph.

A person watching a run that needs them was left with a page that showed the
question and refused to let them answer it.

The naming is a nicety. It is now fetched on its own and its failure is ignored,
so a label can never cost a person the ability to act. The underlying 500 on
`/agents` is not fixed and not understood; it is recorded here because the
coupling, not the 500, is what made it fatal.

## F-040: a refused command said only that it was refused

Answering any of four queued questions produced `answer-question refused` in the
status line, and the dialog closed. There was no reason anywhere in the UI. The
receipt held one:

```
stale-question: Question answer guards do not match current authority
```

Those questions were asked by dispatches whose task later moved on, so their
guards no longer bind and they can never be answered. The portal still listed
them as things waiting on a person, offered a button, and reported nothing
useful when it failed.

The narration now carries the refusal's message. Two things remain unfixed and
are recorded: a question whose guards are stale is still queued as a human need
forever, and nothing prunes it; and the dialog closes on refusal rather than
staying open with the reason beside the field a person just filled in.

## F-041: retrying a turn that asked a question asks it again

The spent-attempt retry from F-036 fired on turns that ended `awaiting-answer`
as well, because those are cancelled effects too. The driver re-dispatched with
the same context, the agent asked the same question again, and the queue grew:
one live run reached seven dispatches and five identical questions in a few
minutes, spending an attempt on each.

A turn that stopped to ask is waiting for a person, not spent. The retry now
skips a dispatch that has an unanswered question against it; the existing
answered-question path already handles the other half.

## F-042: only an accepted completion finishes a turn

Three findings in this log are the same finding. A turn that stopped to ask
(F-021), a turn that submitted nothing (F-033), and a turn whose session died
when the supervisor restarted (F-038) were each reported as a failed effect,
each fenced its task permanently, and each ended a live run that had done
nothing wrong. Each was fixed one at a time, and the next one appeared.

`resultObservation` now has one rule: an accepted completion is `completed` and
every other ending is `cancelled`. The authored `attempts:` count is what bounds
how many endings a phase tolerates, and it is the only thing that should.

Nothing is lost. A failed effect still fences, and the workspace effect host
still produces one for a refused candidate, a failed gate, and a refused
publication — failures about the work, not about one agent's turn.

`daemon-composition` asserted the old rule. Its subject is that task-scope state
survives a service restart, which is worth keeping, so it now asserts the
corrected contract: a failed worker leaves its task claimable, and it is still
claimable after a reopen.

## F-043: the agent was stringifying the output it could not hand in

With F-037's diagnostics in place the live planner reported the real cause
itself:

> The planner has prepared a 3-task plan for building tic-tac-toe but cannot
> submit it due to "Invalid tool arguments: expected an object" errors on
> senawa_complete. The outputs parameter contains a valid plan schema with
> summary and tasks array.

It was sending `outputs` as encoded JSON. The message did not say which object
was wrong, and the tool would not decode it, so the agent could see nothing to
correct. Two changes: the message names the parameter, and a string is decoded
before validation. Handing a nested object back as JSON is a routine thing for a
model to do and it is not worth an attempt.

## F-044: the retry note read as a refusal of the work

A retried attempt carries `priorRefusals` into the agent's prompt, and the spent
attempt retry from F-036 put this in it:

> the previous turn ended without handing any work in

The agent read it as senawa's verdict on what it had submitted, and asked:

> I've attempted to submit a plan four times, and the system refuses completion
> saying "the previous turn ended without handing any work in." What does
> "handing work in" mean in this context? Should I be dispatching tasks to
> workers?

The note is about the *previous* turn and is not a judgement of anything the
agent sent, but nothing in the wording said so. It now says which turn it
describes and that it is not a refusal.

## F-045: the transcript recorded that a tool failed and not why

Diagnosing F-043 from outside the agent was impossible because the operator's
own record of the run held only:

```
tool senawa_complete failure
```

The refusal and its detail were already computed and sent to the model; the
transcript line dropped both. It now carries the code and the detail, so the
moment an agent starts retrying is the moment a person can see the reason.

Still open: the live planner's completion is refused as `completion-refused`
with no detail, which means the error reaching that handler is not an `Error`
with a message. That is the next thing to chase, and the run cannot finish until
it is understood.

## F-046: a submission the broker rejects is reported to the agent as a success

The live planner did exactly what it was told and still could not hand in:

> I submitted senawa_complete with the exact five keys specified... The system
> still refuses but doesn't provide a detail field. What specifically is
> preventing the plan completion from being accepted?

There was no detail field because the tool did not fail. `admitCompletion` ends:

```ts
return success({ status: result.status, replayed: result.replayed });
```

`SubmissionAdmissionResult["status"]` is `"accepted" | "stale" | "duplicate"`, so
a rejected submission is returned as a *successful* tool call carrying the word
`stale`. The agent has to notice that a success means refusal, and there is
nothing anywhere saying what "stale" means or what to do about it. Two of the
refusal-detail fixes in this branch could not help, because this path never
raises a failure at all.

`stale` here means the dispatch's context revision is no longer current. That is
the second half of the defect, and it is one this branch introduced.

## F-047: the spent-attempt retry supersedes an agent that is still working

F-036 made the driver start a new attempt when a dispatch's effect ended without
a completion. The effect ends when the *worker process* ends, which is not the
same as the agent being finished with the task: a new attempt takes over the
task scope, and the previous agent's submissions are then rejected as `stale`
forever.

The live run showed the shape clearly: seven dispatches for a three-phase
workflow, no completion, `missing-completion` on each, and a planner insisting —
correctly — that it had submitted a valid plan several times.

Two things have to be true together, and are not yet:

* a spent attempt must be retried, or an empty turn stalls the run (F-036);
* a retry must not start while the previous agent can still hand work in, or it
  guarantees the refusal it is trying to recover from.

Not fixed. The retry needs to be conditioned on the previous dispatch being
genuinely finished with its task scope rather than on its effect having ended,
and `admitCompletion` must report `stale` and `duplicate` as failures that say
what they mean.

## F-047 resolved: cancelling reported a turn over while it was still running

The overlap in F-047 had one cause, and it is not where I first looked.
`CopilotWorkerEffectHost.cancel` did this:

```ts
const active = this.#active.get(input.dispatchId);
if (active !== undefined) {
  active.abort();
  return { status: "cancelled", ... };
}
```

Aborting only asks the turn to stop. The observation was terminal immediately,
while `dispatch` was still awaiting `adapter.run`, so the driver started the next
attempt, the next attempt took the task scope over, and everything the still
unwinding worker submitted was refused as stale.

Everywhere else the outcome is written after `adapter.run` resolves, which is
after `scope.active = false` and after `await Promise.allSettled(scope.pending)`.
So a resolved run genuinely means no more submissions, and cancel now waits for
the same promise `dispatch` returns before reporting the turn over.

The completion plan still calls for the attempt lifecycle to be recorded rather
than inferred, and it should be. This makes the signal the driver already reads
mean what the driver assumes, which is the smaller half of that and the half
that unblocks the run.

## F-048: a duplicate phase output made the run unopenable

The clean run of phase 2 stopped answering `senawa status` at all:

```
TypeError: Invalid durable context authority snapshot:
events[4].payload does not match its submission result
```

Replay checks an event's type against the stored result of the submission it
names. The broker wrote the result with one expression and the event type with
another:

```ts
status: stale ? "stale" : (duplicateCompletion || duplicateOutput) ? "duplicate" : "accepted"
...
stale ? "worker-submission-stale"
  : duplicateCompletion ? "worker-submission-duplicate"
  : "worker-submission-accepted"
```

The event arm omits `duplicateOutput`, so a duplicate *phase output* recorded
`worker-submission-accepted` beside a result of `duplicate`, and every later open
of that database refused. A retried agent submitting the same output twice is
routine, so this bricks a run for doing something normal.

The event type is now derived from the result, which is the only arrangement in
which the two cannot disagree.

This is the second half of F-035, arriving on its own: an unopenable run is not
merely unreadable, it takes the supervisor down with it. That half is still
unfixed.

## The example produced a working game

Phase 2 of the completion plan passed. One clean run, no service restarts, every
question answered from the portal, no CLI:

```
agents dispatched: 3
waiting on you: 0
drive-run-failed: 0
```

Three dispatches for three phases, which is what the workflow describes: one
agent per sequential phase, no retries, no fences, no stalls. The agents wrote
`game.js`, `cli.js`, and `test.js` into the example workspace. Their own tests
pass:

```
# tests 9
# pass 9
# fail 0
```

And it plays:

```
Player X, enter position (0-8):  X | X | X
-----------
 O | O | 5
-----------
 6 | 7 | 8

Player X wins!
```

Twenty-two findings separated the first attempt at this from this run. The ones
that mattered were all the same shape: something normal — a question, an empty
turn, a restart, a retry, a duplicate submission — was treated as a failure, and
a failure was permanent. The attempt ceiling is the only thing that should end a
phase early, and now it is.

The remaining walls were about telling the truth. An agent that cannot see why
it was refused retries blind, and it costs a model call every time. A run whose
operator record says only "failure" cannot be diagnosed from outside. Both are
fixed, and both were found by reading what a live agent said about them.

## F-039 resolved: a refusal is prose, and the contract wanted a token

The `/agents` 500 was not mysterious once the error was allowed out. The handler
maps anything unrecognised to `Supervisor request failed` with nothing logged, so
calling the query directly was the only way to see it:

```
ProtocolValidationError: $.agents[1].latestRefusal must contain 1-128 UTF-16 code units
```

`latestRefusal` was validated as `token` — lowercase, 1 to 128 characters,
matching a token pattern. It holds a sentence written for a person. So the agent
list failed as soon as any agent had been refused once, which is routine, and
the run view fetches that list, so the portal went offline reporting a run whose
only problem was that an agent had been told no.

It is bounded free text now, truncated at the store rather than refused at the
boundary.

The same defect sat one line above it, unexploded. `model` was a token too, and
the live runs record `unknown` for every agent — which is the identity problem
the portal analysis complains about. Fixing that, which is the first item of the
portal work, would have started recording `claude-haiku-4.5`, whose dot no token
accepts, and the outage would have come straight back. A model name is a vendor's
string, reported and never matched on, so it is bounded free text too.

Two lessons, both already in this log in other forms. A validator that is
stricter than its producer is a fault waiting for real data. And an error that is
swallowed is a defect nobody can find: this one was visible for hours as a bare
500 and took minutes to diagnose once its message was read.

## F-040 resolved: questions nobody could ever answer

The portal listed four questions as human needs on a run where every attempt to
answer one was refused. `stale-question: Question answer guards do not match
current authority`. Seven such refusals, zero answers.

The guard is right. A question can only be answered while its asking dispatch
still holds the task scope; once a later attempt takes the scope over, the
answer would be attached to work that no longer exists. What was wrong is that
nothing told the queue. A question the authority would never accept an answer to
sat in the list of things a person must do, with an enabled button, forever.

The cost is worse than a wasted click. The queue is the portal's claim about what
is blocked on a human. Filling it with entries that cannot be acted on makes the
whole queue untrustworthy, and buries the needs that are real.

Both places that count an unanswered question now apply the same rule the guard
applies: the task's fence must still be accepting claims and must still name the
context the question was asked from. The needs list and the graph node count were
separate queries, and the second one is why a node stayed `awaiting-human` after
its question had been abandoned.

The rule now lives in three places rather than one, which is a duplication worth
watching. Deriving the queue from the guard directly would be better, but the
guard is inside a command handler and the queue is a read model, so for now they
agree by construction of the same predicate rather than by sharing code.

The test earns its place: it registers a question, sees it listed and its node
awaiting a human, opens a second attempt on the same task, and sees both clear.
Reverting the filter makes it fail.

Still open on the same finding: the answer dialog closes when the command is
refused, so the reason is lost. That belongs with the portal work, where a
refusal should stay on screen beside the field that caused it.

## F-035 part two: an unopenable record, scoped honestly

The plan called this "quarantine an unopenable run". Looking at it properly, that
name promises something the storage cannot deliver. There is one record per
project, holding every run in it, so there is no per-run unit to quarantine. Real
isolation means splitting the store, which is an architecture change and not a
debt-clearing item.

What was actually wrong was smaller and worth fixing. A record that fails to
verify killed the service with a bare invariant string — `file is not a
database`, or one of forty similar sentences naming an invariant and no row. An
operator reading that has no idea whether work has been lost, or what to try.

The service now says which record it could not open, that nothing has been lost,
and which two commands to reach for. Checked against a deliberately corrupted
store: the guidance is not a dead end, because `senawa integrity check` runs
against a record the service refuses to open and reports the failing category.

The underlying cause still travels with it, so the invariant is one line further
down rather than gone.

Left undone deliberately: the forty verification messages still name an invariant
without naming the row that broke it. F-048 cost an hour of grepping for exactly
that reason. It is a mechanical change across a large surface, and it belongs
with whoever next has a failing record in front of them to test against.

## Portal, first pass: names instead of identities

The agent list is the view that answers "who is stuck, and on what". Measured
against a real run it answered neither. `Working on` read
`task_e30bb4a5f7e1cba2…`. `Model` read `unknown (route 0)`. `Attempt` read `1`
for every row including the retries. Three separate defects wearing one costume.

The model was the interesting one. It was read from `$.modelPolicy.model` in the
dispatch context, and that key has never existed: a context names a model policy
by digest only, so the query asked for something no context has ever carried and
faithfully reported `unknown` for every agent in every run since the view was
written. The chosen route is recorded with the dispatch's effect, from the moment
it is registered, and that is now where it comes from.

The first attempt read it from `runner_effect_intents`, which is populated only
once a runner claims the work. That passed against the example database, where
everything had been claimed, and failed against a freshly registered dispatch.
Worth recording: querying live data proved the idea and hid the bug, and only a
test at the earliest moment in the lifecycle found it.

`Attempt` was the same class of mistake one level down — `$.phaseAttempt.attempt`
where the value lives at `$.phaseAttempt.phase.attempt`.

Names now come from the graph, which has carried the authored key all along and
already renders it in another view. Identities stay on the cell for hovering,
because a digest is what you check a row against, not what you read it by.

Two smaller things fell out. Route zero is the authored first choice and adds
nothing, so it is shown only when an agent was actually moved to a fallback. And
the steer buttons read `Steer researcher` three times with nothing to choose
between them; they name the work now.

The lesson is the one this log keeps finding: nothing exercised `listAgents` at
all. No test, anywhere. That is how a validator that refuses real data reached a
release, and how three wrong JSON paths sat in one query. There are tests now, at
both ends — a dispatch just registered, and a full journey that ran.

Two browser tests failed on this pass and both were right to. They asserted the
old wording of things earlier commits deliberately changed: a transcript labelled
by dispatch identity rather than by the agent, and a dialog that told a person
their answer "requires a fresh dispatch boundary". The tests now assert the
readable versions, and one of them checks that no cell in the agent table is a
bare digest, which is the rule the whole pass is about.

## Portal, second pass: attempts fold into the agent

Six table rows for two agents, because the table listed dispatch attempts and
called them agents. `researcher` appeared four times, and two of its rows differed
only in a `State` cell reading `working` against `finished`, so the view looked
like it was stuck repeating itself.

An agent is one entry now, with its attempts listed underneath. Nothing is lost:
the refusal each attempt was told to act on sits on that attempt, the session and
the task identity are on the elements they belong to for hovering, and the
heading carries the persona, the work, the model and the current state.

Grouping is by persona and task together rather than by persona alone. A fan-out
puts the same persona on several tasks at once, and merging those would claim two
agents are one.

The browser test that covered this asserted four column headers and that the body
had rows. Every one of those assertions passed while every cell underneath read
as a digest, which is why the view survived this long. It checks what a person
can actually read now, and that no digest is rendered as text anywhere in it.

## F-049: the supervisor stopped driving, and said nothing

A test that had been green all session started failing, and the instinct to call
it flake was wrong. Bisecting put it at `6129029`, the commit in this session
that moved driving from the command line into the supervisor. Every run driven by
the supervisor stopped after its first phase.

The chain took a while to see, because each link hid the next.

A queued runner command is refused when its identity is already bound to
different content. Sound rule. But the content it compares includes `queuedAt`,
the moment somebody asked for the work, which decides nothing about the work.
The command line passes one timestamp for a whole invocation, so it never
noticed. The supervisor reads a live clock, so its second offer of the same
stage carried a different timestamp, and the store told it the identity was
bound to different content.

That threw. The throw travelled up through the run cycle into the wake pump,
which caught it and recorded it with `appendLog` — into a table. Not stderr, not
the service log, nowhere anybody watching a run would look. The visible symptom
was a run that stopped, a status that read `agents dispatched: 1` forever, and a
service log containing one SQLite warning.

Identity now covers everything that decides the work and not the moment it was
asked for. Different input still conflicts, and there is a unit test for both
halves; the sixty-second end-to-end timeout was a terrible way to learn this.

Two things this cost, worth naming:

The debugging itself introduced a bug. A trace line called `.slice` on
`JSON.stringify(undefined)`, threw inside the cycle, and produced exactly the
symptom being investigated. Two rounds went by before the real error appeared
underneath. Instrumentation is code, and it fails like code.

Two fixes were written before the real one, on plausible theories: driving in a
loop like the command line does, and driving on cycles that processed a receipt.
Both were reverted once the actual cause was found, because each was tested
against the fixed system and neither was needed. A change that cannot be shown to
matter does not get to stay.

Left open: a background failure in the supervisor is recorded only in the
authority log, reachable through `senawa diagnostics create` and nowhere else. A
run that stops for an unreported reason is the hardest thing to diagnose, which
is written in a comment eleven lines above the code that swallowed this one.

## F-050: the one budget a run spends had no ceiling

The live example stopped for a third time, on a budget escalation: `Budget
allowance requested for review-iteration`. The portal listed it, and the only
control on it was disabled. `senawa approve` answered "Nothing is waiting for a
decision on this run", which is a strange thing to read on a run whose status
says it is waiting on you.

A ceiling is what a person is permitted to grant when a budget runs out. The
authored run declared ceilings for `dispatch-failure`, `work-attempt`, and
`workspace-operations` — every unit that counts a failure, and not the unit an
ordinary dispatch spends. So the single budget a healthy run actually exhausts
was the one nobody could ever raise. The run had spent all eight of its
review-iterations answering three questions and asked for a ninth, and there was
no answer to that question anywhere in the product.

This is F-040 again in a different costume: a human need in the queue that no
human can satisfy. The queue is the portal's claim about what is blocked on a
person, and a run stopped forever behind a disabled button is the worst version
of getting that claim wrong.

Two smaller things came out of it.

The refusal for a malformed policy read `Run instantiation was refused`, dropping
the receipt's own sentence. Adding the ceiling in the wrong position cost a full
test cycle to diagnose; with the reason attached it reads `Allowance policy
ceilings must be sorted by unit` and costs seconds. That is the same lesson as
F-039 and F-045, now three times over.

`senawa approve` decides phase candidates and nothing else, which is defensible,
but saying "nothing is waiting" when something plainly is sends a person looking
for a fault that is not there. It names what is actually blocking now.

Still open: `grant-allowance` is authorised in the daemon's policy and has no
command-line surface at all. The portal can grant one; the command line cannot.
For an example driven mostly from a terminal that is a real gap.
