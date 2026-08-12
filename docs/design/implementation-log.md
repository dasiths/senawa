---
title: Redesign Implementation Log
description: Decisions, validation, and review outcomes for the Senawa alpha redesign
ms.date: 2026-08-12
ms.topic: reference
---

This file records major implementation decisions, alternatives, deviations,
validation results, commits, pushes, and unresolved risks for the autonomous
Senawa alpha redesign.

The governing source is the [Comprehensive Alpha Implementation
Plan](implementation-plan.md).

## Recording rules

Record an entry before or alongside implementation when a choice:

* Changes package or process boundaries
* Changes a public protocol, workflow, or storage contract
* Selects a third-party dependency
* Changes authority, durability, security, or failure semantics
* Deviates from the comprehensive plan
* Defers an acceptance criterion
* Changes phase order or scope
* Produces a failed validation that changes the implementation approach

Small local implementation details do not need entries unless they establish a
pattern that later phases will depend on.

Each phase records:

* Decisions and alternatives
* Deviations from plan
* Validation commands and results
* Independent review findings and resolution
* Commit identity and push result
* Remaining risks and next-phase constraints

## Status

| Phase | State | Commit | Push |
|-------|-------|--------|------|
| 0. Preserve evidence and reset | Complete | `749c9c0` | Pushed |
| 1. Canonical codec and graph kernel | Complete | `b1712fe` | Pushed |
| 2. Completion, gates, closure, and escalation | Complete | `d8a3d7a` | Pushed |
| 3. Protocol and in-memory command slice | Complete | `0f5f485` | Pushed |
| 4. SQLite authority and immutable assets | Complete | `ef8580a` | Pushed |
| 5. Fenced runner and reconciliation | In progress | Pending | Pending |
| 6. Workflow and sensor configuration | Not started | Pending | Pending |
| 7. Context broker and serial workers | Not started | Pending | Pending |
| 8. Local supervisor, HTTP, SSE, and CLI | Not started | Pending | Pending |
| 9. Additive amendments | Not started | Pending | Pending |
| 10. Parallel worktrees and integration | Not started | Pending | Pending |
| 11. Local portal | Not started | Pending | Pending |
| 12. Remote control-plane protocol | Not started | Pending | Pending |
| 13. Reporting, packaging, and hardening | Not started | Pending | Pending |

## Decision D-001: Clean alpha implementation reset

* Date: 2026-08-12
* Status: Accepted by product owner
* Phase: 0
* Decision: Remove the current implementation and create a new minimal workspace
  in the existing repository. Preserve Git history, the devcontainer,
  implementation plan and log, relevant probes, and generic tooling that remains
  useful.
* Alternatives: Refactor in place; maintain a parallel vNext implementation;
  delete everything except the devcontainer; create a sibling repository.
* Rationale: Senawa is alpha and has no compatibility obligation. In-place work
  would let current ontology and package seams shape the redesign. A parallel
  implementation would create an unnecessary legacy surface. A devcontainer-only
  wipe would discard evidence and history without adding design freedom.
* Consequence: Current apps, packages, schemas, persisted runs, commands, tests,
  examples, and compatibility adapters may be removed atomically.

## Decision D-002: Authority-oriented package graph

* Date: 2026-08-12
* Status: Accepted for implementation; may be revised by phase disproof
* Phase: 0
* Decision: Use protocol, kernel, runtime, storage, configuration,
  execution-host, supervisor, portal, reporting, and testing boundaries. Apps are
  composition roots only.
* Alternatives: Preserve current packages; one monolithic package; one package
  per process; domain/application adapter names matching the old system.
* Rationale: Boundaries follow authority and dependency direction. The pure
  kernel must remain isolated from storage and effects, while clients share one
  protocol without importing workflow behavior.
* Consequence: No new package may import legacy implementation code. Empty
  packages are not created before their first vertical slice.

## Decision D-003: Complete local alpha, remote protocol reference

* Date: 2026-08-12
* Status: Accepted scope boundary
* Phase: Plan-wide
* Decision: Deliver the complete local product and an authenticated remote
  protocol, outbound connector, deterministic control-plane simulator, and
  conformance suite. Do not claim a production hosted service.
* Alternatives: Build production multi-tenant hosting now; omit remote behavior;
  expose repository supervisors directly to the internet.
* Rationale: The protocol and partition semantics affect local architecture, but
  production identity operations, billing, regional deployment, and cloud
  storage are different products.
* Consequence: Remote completion criteria concern authority, delivery, replay,
  partitions, and data policy rather than cloud operations.

## Decision D-004: SQLite selection remains probe-gated

* Date: 2026-08-12
* Status: Open until Phase 4 probe
* Phase: 4
* Decision: Use a Senawa-owned embedded relational authority. Select the concrete
  SQLite binding only after no-credit packaging and durability comparison.
* Alternatives: `better-sqlite3`; `node:sqlite`; WASM SQLite; another embedded
  database.
* Rationale: The current Node floor and native packaging materially affect the
  distributable alpha. Choosing from convenience before probing would violate
  the migration plan.
* Consequence: Phase 0 does not add a database dependency. Phase 4 records the
  measured selection before implementation.

## Decision D-005: Commit and push each validated phase

* Date: 2026-08-12
* Status: Accepted by product owner
* Phase: Plan-wide
* Decision: Commit after the reset and after every implementation phase, then
  push `redesign/workflow-state-machine` to `origin`.
* Alternatives: One final commit; local commits with one final push; compatibility
  releases between phases.
* Rationale: Phase commits provide review, rollback, and recovery while the owner
  is away without requiring compatibility releases.
* Consequence: A phase cannot be marked complete before validation, independent
  review, log update, commit, and push attempt.

## Decision D-006: Heavy subagent delegation with central authority

* Date: 2026-08-12
* Status: Accepted execution strategy
* Phase: Plan-wide
* Decision: Delegate bounded research, implementation, and review tasks heavily,
  while the primary agent owns plan sequencing, integration, validation, commits,
  and this log.
* Alternatives: Primary-agent-only implementation; one subagent implementing the
  whole system.
* Rationale: Narrow agents reduce context decay, but central integration is
  required to preserve dependency and authority decisions.
* Consequence: Subagents receive exact phase scope and file ownership. Their
  reports are inputs, not phase-completion authority.

## Decision D-009: Remove historical design and WIP records

* Date: 2026-08-12
* Status: Accepted by product owner
* Phase: 1
* Decision: Keep only this implementation log, the comprehensive plan, and a
  concise design index. Delete retired guides, prior research syntheses,
  historical decisions, findings, and compatibility anchors.
* Alternatives: Preserve compatibility pages; archive WIP research; retain probe
  findings as design authority.
* Rationale: Senawa is starting clean and Git history already preserves deleted
  material. Historical documents were distracting from the active design.
* Consequence: The comprehensive plan and this log are the only active design
  records. External probes remain fixtures, not architecture authority.

## Decision D-007: Generated artifacts remain outside Git

* Date: 2026-08-12
* Status: Accepted
* Phase: 0
* Decision: Ignore dependencies, package-manager caches, build output, coverage,
  TypeScript build metadata, local agent state, environment files, logs, and
  embedded-database files recursively. Preserve the existing root `.gitignore`
  rules and append only missing redesigned runtime and database patterns. Remove
  stale generated directories from deleted packages without deleting the active
  root dependency installation.
* Alternatives: Track built output; rely on package-local ignore files; clean
  the entire dependency installation before every commit.
* Rationale: Generated output is reproducible and creates misleading diffs. One
  root policy is easier to audit across future packages and apps.
* Consequence: Release packaging must build from source. Phase validation checks
  that generated files are ignored and absent from the index.

## Phase 0 log

### Plan

* Preserve the implementation plan and log, relevant probes, history, and
  generic tooling.
* Remove the current implementation and compatibility surfaces.
* Create protocol, kernel, testing, and minimal CLI scaffolding.
* Validate install, build, typecheck, lint, tests, boundaries, and docs.
* Obtain independent implementation review.
* Commit and push.

### Decisions

* D-007 establishes recursive generated-artifact hygiene.
* The reset creates only protocol, kernel, testing, and truthful CLI surfaces;
  future package directories wait for their first executable vertical slice.

### Deviations

* The specialized Implementation Validator had no filesystem access. A
  filesystem-capable Researcher Subagent performed two severity-graded reviews
  instead. This changes review tooling, not review independence or criteria.
* Initial shared TypeScript `rootDir` and Biome include patterns were corrected
  after focused validation exposed project-relative output and generated-file
  traversal defects.

### Validation

Passed on 2026-08-12:

* `pnpm install`
* Clean `pnpm build`
* `pnpm typecheck`
* `pnpm lint` across 22 intended source and configuration files
* `pnpm test`: 2 files and 5 tests, including built CLI subprocess behavior
* `pnpm check:boundaries`: 14 source files plus negative rule fixtures
* `pnpm docs:links`: 37 Markdown files
* `git diff --check`
* Git index scan: no tracked `node_modules`, `dist`, coverage, package cache,
  agent state, environment, build metadata, log, or database files
* Preserved probe tree restored byte-for-byte after an over-broad formatter run

### Review

Independent review found:

* High: Biome traversed generated output. Resolved with source-specific include
  patterns and a successful lint-after-build check.
* High: Replacement files were unstaged while deletions were staged. Resolution
  is the atomic `git add -A` and staged-diff review immediately before commit.
* High: Legacy numbered guides claimed Beads architecture was current. Resolved
  by deleting the guides and making the comprehensive plan authoritative.
* Medium: Boundary enforcement lacked negative coverage. Resolved with checks
  for kernel and protocol Node imports, app and testing imports, adapter imports,
  and runtime observations.
* Low: CLI help was not an exact allowlist. Resolved with exact renderer and
  built-process assertions plus package-version consistency.

No unresolved critical, high, medium, or low findings remain before staging.

### Commit and push

* Commit: `749c9c0 chore(build): reset repository for redesign`
* Push: succeeded to `origin/redesign/workflow-state-machine` on 2026-08-12

### Remaining risks

* Preserved probes may reference deleted production packages. Each such probe
  must remain clearly historical or be adapted only when its subject is
  reimplemented.
* Root guidance and README must not describe deleted commands as available.
* The reset must be buildable in the same commit as the deletions.

## Decision D-010: Canonical value and digest boundary

* Date: 2026-08-12
* Status: Accepted for Phase 1
* Phase: 1
* Decision: Accept only finite JSON primitives, arrays, and plain string-keyed
  objects into immutable canonical snapshots. Serialize primitives with
  ECMAScript JSON encoding, object keys in UTF-16 code-unit order, and the
  complete result as UTF-8 bytes. Compute SHA-256 through an injected synchronous
  byte interface and validate lowercase hexadecimal output.
* Alternatives: Import Node crypto in the kernel; depend on asynchronous Web
  Crypto; own a production SHA-256 implementation; retain insertion order; hash
  caller-owned mutable objects.
* Rationale: The kernel needs byte-stable digests without choosing a runtime or
  I/O adapter. Immutable snapshots prevent accepted values from changing after
  validation. Injection keeps cryptographic implementation and runtime concerns
  above the pure kernel while preserving exact byte semantics.
* Consequence: Composition layers must provide a conforming SHA-256 adapter.
  Canonical input rejects non-finite numbers, class instances, cycles, and values
  outside JSON rather than coercing them.

## Decision D-011: Opaque identity and consumer key lexical forms

* Date: 2026-08-12
* Status: Accepted for Phase 1
* Phase: 1
* Decision: Brand every canonical identity kind separately and require a matching
  kind prefix plus a 1-64 character lowercase opaque token. Keep consumer keys as
  separate 1-63 character lowercase DNS-label-like values. Represent definition
  generations as branded positive safe integers beginning at 1.
* Alternatives: Compile-time brands without runtime distinction; UUID-specific
  identities; unvalidated arbitrary strings; one shared entity identity type;
  zero-based or floating-point generations.
* Rationale: Prefix validation catches cross-kind identity errors at runtime
  without prescribing whether an authority uses UUIDs, counters, or another
  deterministic token source. Restricted consumer keys avoid normalization and
  case-folding ambiguity while retaining readable workflow keys.
* Consequence: Future runtime authorities generate the opaque token and pass the
  complete prefixed value to the kernel constructor. Parent and kind scoping of
  consumer-key uniqueness belongs to graph compilation, not this bounded slice.

## Decision D-012: Canonical graph ownership and relation semantics

* Date: 2026-08-12
* Status: Accepted for Phase 1
* Phase: 1
* Decision: Compile one normalized, flat workflow input into an immutable graph.
  A workflow or phase owns phases, phases own executable tasks, and tasks own
  criteria. Dependencies and supersession connect definitions of the same kind.
  Supersession must stay within one parent scope and move to a strictly newer
  generation. Definition payloads remain domain-neutral canonical values.
* Alternatives: Restrict phases to one level; infer ownership from array
  nesting; permit cross-kind dependencies; permit cross-parent supersession;
  require repository paths and commands in executable task definitions.
* Rationale: Recursive phase containment supports decomposition without adding
  another entity kind and makes containment acyclicity explicit. Flat parent
  references produce one validation path for all domains. Same-kind relations
  preserve graph meaning, while same-parent, increasing-generation supersession
  prevents a replacement from silently moving work between owners.
* Consequence: Later amendments must produce the same normalized compiler input
  and satisfy these invariants before events apply. Domain adapters may assign
  meaning to canonical definition payloads, but repository-specific fields do
  not enter the kernel graph contract.

## Decision D-013: Content-addressed run events and replay authority

* Date: 2026-08-12
* Status: Accepted for Phase 1
* Phase: 1
* Decision: Model run instantiation and exact graph-revision acceptance as pure
  kernel commands that emit immutable canonical events. Commands supply every
  event identity, content digest, sequence, timestamp, graph, revision guard,
  and fact. The kernel verifies the supplied SHA-256 digest and requires the
  event identity to equal `event_<content-digest>`. Run state is derived only by
  applying the ordered event sequence.
* Alternatives: Generate event metadata in the kernel; permit arbitrary event
  identities; mutate run state directly while retaining events as an audit log;
  defer revision concurrency checks to storage; include task lifecycle behavior
  in the initial reducer.
* Rationale: Caller-supplied facts keep the kernel independent of clocks,
  randomness, and authority allocation. Content-addressed event identities make
  exact replay and duplicate rejection deterministic. Before and after revision
  checks make graph replacement explicit at both decision and replay time.
* Consequence: Composition layers must allocate timestamps and sequences, then
  supply a digest and matching event identity before invoking the kernel. Later
  protocol and storage layers persist these exact events rather than treating a
  mutable run row as workflow authority. Completion and task lifecycle behavior
  remain Phase 2 work.

## Decision D-014: Recompile graphs at kernel trust boundaries

* Date: 2026-08-12
* Status: Accepted for Phase 1
* Phase: 1
* Decision: Treat submitted workflow graphs as untrusted canonical values.
  Snapshot each graph once, validate its exact recursive schema, reconstruct
  normalized compiler input only from node definitions, and recompile with the
  injected SHA-256 implementation. Accept the graph only when its submitted
  revision digest and complete canonical content equal the recompiled result.
  Commands map graph validation failure to `invalid-command`. Event application
  first verifies the submitted canonical event content digest, then maps graph
  validation failure to `invalid-event` and stores only the recompiled graph.
* Alternatives: Trust a well-formed graph envelope and revision digest; validate
  nodes and edges without recompilation; recompute only the revision digest;
  retain the caller-owned graph after successful validation.
* Rationale: A digest supplied beside caller-controlled content does not confer
  semantic authority. Recompilation proves definition digests, revision digest,
  typed edges, ordering, and graph invariants through the same compiler that
  creates canonical graphs. Separating event content verification from graph
  validation preserves evidence of exactly what was submitted while preventing
  forged graph structure from entering run state.
* Consequence: Canonical graph array ordering and exact field sets are part of
  the persisted contract. Replay may use submitted graph bytes to verify event
  identity, but state authority always uses a fresh compiler-owned graph.

## Phase 1 log

### Bounded slice 1: Codec and identity

#### Decisions

* D-010 establishes canonical JSON snapshots, serialization, and the hashing
  port.
* D-011 establishes runtime-distinct identity syntax, stable consumer keys, and
  definition generations.

#### Scope

* Implemented canonical JSON-safe values, serialization, UTF-8 bytes, SHA-256
  digest validation, ten opaque identity kinds, consumer keys, and definition
  generations.
* Deferred graph entities, typed edges, compiler behavior, invariants, commands,
  events, and reducer behavior to later Phase 1 slices.

#### Validation

Passed on 2026-08-12:

* Focused canonical and identity tests: 45 tests
* Kernel package typecheck
* Kernel source Biome check
* Dependency boundary check across 22 source files

#### Remaining risks

* Graph compilation must enforce consumer-key uniqueness within kind and parent
  scopes.
* Composition layers need conformance tests for each concrete SHA-256 adapter.
* The complete Phase 1 validation, independent review, commit, and push remain
  pending until the graph kernel is implemented.

### Bounded slice 2: Canonical graph and compiler

#### Decisions

* D-012 establishes graph ownership, typed relation, supersession, and
  domain-neutral executable-input semantics.

#### Scope

* Added distinct workflow, phase, task, and criterion definitions and graph node
  semantics.
* Added immutable source pointers, canonical definition payloads, per-definition
  digests, and a deterministic graph revision digest.
* Added typed containment, dependency, and supersession edges.
* Added one compiler for normalized workflow and executable-work inputs.
* Added duplicate identity and scoped consumer-key checks, reference and parent
  validation, containment and relation cycle checks, and supersession ownership
  and generation checks.
* Kept commands, events, reducer transitions, completion, and runtime effects out
  of this bounded slice.

#### Validation

Passed on 2026-08-12:

* Focused graph compiler and invariant tests: 19 tests
* Complete current kernel suite: 3 files and 64 tests
* Kernel package typecheck
* Targeted Biome check for graph source, tests, and exports
* Dependency boundary check across 26 source files
* Documentation link check across 17 Markdown files
* `git diff --check`

#### Remaining risks

* Phase 1 commands, events, and deterministic reducer behavior remain for later
  bounded slices.
* The complete Phase 1 validation, independent review, commit, and push remain
  pending.

### Bounded slice 3: Run commands, events, and replay

#### Decisions

* D-013 establishes caller-supplied content-addressed event metadata, exact
  revision concurrency guards, and replay-derived run state.

#### Scope

* Added an event identity kind and exported pure run command, event, state,
  decision, event-application, digest, and replay APIs.
* Added run instantiation from an already compiled workflow graph and acceptance
  of one exact new graph revision guarded by the expected current revision.
* Added canonical immutable event snapshots, content digest and identity
  verification, strict sequence checks, duplicate event rejection, and run,
  workflow, and before and after revision checks during replay.
* Kept completion, task lifecycle, dispatch, evidence, approval, and amendment
  behavior out of Phase 1.

#### Validation

Passed on 2026-08-12:

* Focused run command and reducer tests: 10 tests
* Complete kernel suite: 4 files and 76 tests
* Complete workspace suite: 6 files and 81 tests
* Workspace build and typecheck
* Biome check across 30 intended source and configuration files
* Dependency boundary check across 30 source files
* Documentation link check across 17 Markdown files
* `git diff --check`

#### Remaining risks

* Phase 1 independent review, commit, and push remain pending after this bounded
  implementation slice.
* Concrete composition-layer SHA-256 adapters still require conformance tests
  when their packages are introduced.

### Bounded slice 4: Graph authority review repair

#### Decisions

* D-014 establishes exact graph validation, recompilation, and separate event
  evidence and state authority semantics.

#### Scope

* Added exported `validateWorkflowGraph` and a dedicated
  `GraphValidationError`.
* Added exact recursive checks for graph, node, definition, source, canonical
  input, relation-array, and typed-edge contracts.
* Reconstructed normalized workflow input exclusively from submitted node
  definitions, recompiled through `compileWorkflowGraph`, and required the
  submitted revision digest and complete canonical graph to match.
* Updated commands to retain only validator-returned graphs and map validation
  failures to `invalid-command`.
* Updated event application and replay to snapshot the entire event, verify its
  submitted canonical content digest, validate graph semantics, retain only the
  recompiled graph, and map validation failures to `invalid-event`.
* Added adversarial coverage for fabricated graphs, wrong node content,
  extra and missing fields, forged edges with recomputed event digests,
  noncanonical ordering, caller mutation, wrong graph digests, and malformed
  identity brands.
* Kept completion and all Phase 2 lifecycle behavior out of the repair.

#### Validation

Passed on 2026-08-12:

* Focused graph compiler and validation tests: 52 tests
* Focused run command and reducer tests: 14 tests
* Complete workspace suite: 6 files and 121 tests
* Workspace build and typecheck
* Biome check across 30 intended source and configuration files
* Dependency boundary check across 30 source files
* Documentation link check across 17 Markdown files
* `git diff --check`

#### Review

Independent Phase 1 findings 3 and 4 are resolved. Submitted graphs no longer
gain authority from shape and caller-supplied digests, and event replay no
longer stores caller graph references after validating unrelated event bytes.

#### Remaining risks

* Concrete composition-layer SHA-256 adapters still require conformance tests
  when their packages are introduced.
* The complete Phase 1 independent review, commit, and push remain pending.

### Phase 1 final validation and review

#### Documentation cleanup

* Applied D-009 by deleting all historical guides, WIP research, findings,
  compatibility anchors, and ignored subagent research caches.
* Kept only `docs/design/README.md`, `implementation-plan.md`, and
  `implementation-log.md` as active design files.
* Removed `.beads` state and every empty legacy directory.

#### Independent review

The first review found four high-severity trust-boundary defects:

* Sparse arrays and accessors could produce invalid or colliding canonical
  values. Fixed through descriptor-based single-pass validation and snapshotting.
* Graph compiler brands were not validated at runtime. Fixed for every identity,
  key, generation, parent, source, dependency, and supersession value.
* Run transitions accepted shallow fabricated graphs. Fixed through exact graph
  reconstruction, recompilation, digest verification, and whole-graph equality.
* Event replay retained mutable caller graphs. Fixed by snapshotting submitted
  events and storing only compiler-owned graphs.

The re-review found no high implementation defects. Its remaining medium finding
was inconsistent malformed-input error classification. Command facts now map to
`invalid-command`, and malformed event timestamps map to `invalid-event`, with
focused tests.

The review also noted that atomic staging was still pending. That is resolved by
the staged-diff audit immediately before commit.

The first staged commit gate then found that graph compiler validation still read
caller-owned definitions more than once, allowing a stateful accessor to change
an identity after validation. `compileWorkflowGraph` now canonical-snapshots the
entire normalized input once before validation or compilation. Accessors are
rejected without invocation, and sparse relation arrays fail at the canonical
input boundary.

#### Final validation

Passed on 2026-08-12:

* Clean workspace build and typecheck
* Biome check across 30 intended source and configuration files
* Complete workspace suite: 6 files and 125 tests
* Architecture boundaries across 30 source files and negative fixtures
* Documentation links across 17 Markdown files
* `git diff --check`

Commit `0f5f485 feat: add versioned command protocol` was pushed to
`origin/redesign/workflow-state-machine` on 2026-08-12.
* Exactly three active design files
* No empty directories outside ignored dependency caches

#### Remaining risk

Concrete SHA-256 adapters remain a later composition-layer responsibility and
must pass canonical-byte conformance tests before persistence relies on them.

#### Commit and push

* Commit: `b1712fe feat: add canonical workflow graph kernel`
* Push: succeeded to `origin/redesign/workflow-state-machine` on 2026-08-12

## Decision D-015: Exact completion and evidence accounting

* Date: 2026-08-12
* Status: Accepted for Phase 2 bounded slice A
* Phase: 2
* Decision: Bind each completion submission to an exact task identity,
  definition generation, and context revision digest. Require one terminal
  disposition, a non-empty summary, and exactly one outcome for every declared
  criterion. Account workflow-defined evidence by canonical kind under `none`,
  `task`, `required-criteria`, or `all-satisfied` policies. Treat malformed or
  contradictory accounts as typed errors, while unmet evidence minimums remain
  valid negative accounting assessments.
* Alternatives: Infer task completion from mutable status; permit partial
  criterion maps; compare evidence kinds by object identity or caller ordering;
  make missing evidence a parse error; let sensors determine completion.
* Rationale: Exact generation binding prevents stale work from completing a
  different definition. Complete criterion accounting prevents omitted work
  from disappearing. Canonical descriptor equality and explicit minimums keep
  evidence accounting deterministic, while negative assessments preserve facts
  for later gate decisions instead of conflating insufficiency with malformed
  input.
* Consequence: Required criteria cannot be skipped, and their waiver must carry
  the exact canonical authority fact configured by the workflow. Superseded
  submissions must name a distinct replacement task generation. Later command,
  event, candidate, and gate slices consume these immutable records rather than
  adding completion semantics to sensors or adapters.

## Decision D-016: Content-addressed readings and fail-closed gates

* Date: 2026-08-12
* Status: Accepted for Phase 2 bounded slice B
* Phase: 2
* Decision: Represent each sensor result as immutable success or failure facts
  bound to an exact input digest and identified by its canonical content digest.
  Define gate policies as digest-addressed blocking and advisory rule sets over
  bounded JSON Pointers. Evaluate conditions with strong Kleene three-valued
  logic. Missing or failed readings and incompatible comparison types produce
  `unknown`; a missing path makes `exists` false. A gate accepts only when every
  blocking rule is true. Advisory results are recorded but never affect
  acceptance.
* Alternatives: Add an allocated reading identity; use binary predicates; let
  sensors select workflow consequences; treat unknown as success; evaluate
  unbounded consumer expressions.
* Rationale: Content identity avoids an uncoordinated new identity kind while
  binding every decision to exact evidence. Three-valued predicates preserve
  uncertainty, and fail-closed blocking rules prevent missing evidence from
  granting authority. Fixed condition and pointer limits keep pure evaluation
  finite without introducing runtime effects.
* Consequence: Sensor execution remains outside the kernel. Later runtime and
  configuration layers must provide exact input digests, persist reading and
  evaluation records, and interpret the gate decision without allowing sensors
  to choose lifecycle consequences.

## Decision D-017: Accepted phase accounts and concurrency capacity

* Date: 2026-08-12
* Status: Accepted for Phase 2 integration
* Phase: 2
* Decision: Admit an accounting assessment into a phase candidate only when the
  task disposition is `completed`, its evidence policy is satisfied, and every
  required criterion is satisfied or explicitly waived. Model concurrency as a
  scheduler capacity ceiling rather than a monotonic consumable budget.
* Alternatives: Treat every structurally valid terminal account as accepted;
  let phase gates infer unresolved accounting; consume one permanent budget unit
  per worker start; add reversible budget counters to the pure budget ledger.
* Rationale: Structural accounting and acceptance are separate. A blocked or
  evidence-deficient account is useful evidence but cannot satisfy a phase.
  Concurrent-worker capacity measures current occupancy and must be released, so
  it does not share monotonic budget semantics.
* Consequence: Blocked, skipped, superseded, or unresolved work escalates or is
  replaced before candidate construction. Phase 10 owns concurrency reservation
  and release under scheduler fencing.

## Decision D-019: Waivers remain obligation-scoped

* Date: 2026-08-12
* Status: Accepted for Phase 2 review repair
* Phase: 2
* Decision: Restrict phase authority decisions to `approve` and `reject`.
  Required-criterion waivers remain exact workflow-policy-bound facts inside
  completion accounting, and budget allowances remain exact escalation-policy
  decisions. A phase-level waiver cannot substitute for approval.
* Alternatives: Permit unscoped phase waivers; require an arbitrary scoped
  obligation on phase decisions; treat a waiver as approval during closure.
* Rationale: An exception must bind the exact obligation it changes. The phase
  candidate contains several independent obligations, so a broad waiver is
  ambiguous and can bypass completion or gate policy.
* Consequence: Closing an approval-required phase needs an exact `approve`
  decision. New waiver classes require their own typed, policy-bound contracts.

## Decision D-020: Completion policy is graph authority

* Date: 2026-08-12
* Status: Accepted as a Phase 2 review repair
* Phase: 2, with a Phase 1 graph-contract amendment
* Decision: Store each task generation's completion policy in its canonical graph
  definition. Candidate creation receives the validated workflow graph and
  derives exact completion requirements for selected task generations from that
  graph. Callers cannot submit or replace requirements beside an assessment.
* Alternatives: Trust requirements embedded in each candidate entry; compare two
  caller-supplied requirement digests; introduce a detached policy record without
  binding it to graph authority.
* Rationale: Reassessment prevents forged arithmetic only when the expected
  obligations come from an independently accepted source. The canonical graph is
  already the authority for task generations and criteria, so it must also own
  their completion policy.
* Consequence: Task graph inputs gain a typed completion policy. The compiler
  validates its exact schema and criterion membership, then includes it in the
  task definition digest and graph revision. Candidate creation validates the
  exact graph and derives requirements from graph definitions before reassessing
  submissions. This deliberately amends the Phase 1 graph contract.

## Decision D-021: Phase candidates cover every active direct task

* Date: 2026-08-12
* Status: Accepted for Phase 2 review repair
* Phase: 2
* Decision: Derive the complete active direct-task set from the canonical graph.
  A task is inactive when another task owned by the same phase supersedes it.
  Candidate task IDs and generations must exactly equal that active set; context
  revisions remain exact caller facts checked against assessments.
* Alternatives: Let callers select any subset; infer completeness from supplied
  assessments; include superseded generations; aggregate child-phase tasks into
  the parent candidate.
* Rationale: A phase cannot close while graph-owned work is omitted. Child phases
  close independently, and superseded generations no longer own obligations.
* Consequence: Empty, partial, extra, superseded, or stale-generation task sets
  fail before accounting or gate evaluation.

## Decision D-018: Exact snapshot lifecycle projection

* Date: 2026-08-12
* Status: Accepted for Phase 2 bounded slice E
* Phase: 2
* Decision: Derive phase lifecycle projections from one exact snapshot of a
  phase generation and its current immutable candidate, gate evaluation,
  approval policy, authority decision, closure, and escalation records. Treat
  every supplied escalation as active. Reject a snapshot containing both a
  closure and an escalation because these records carry no sequence or explicit
  resolution fact. Revalidate every record digest and cross-record relation
  before deriving status, accounting, human needs, and the projection digest.
* Alternatives: Persist mutable phase status; infer latest state from record
  timestamps; let closure always override escalation; let escalation always
  override closure; add event ordering or escalation resolution records in this
  slice.
* Rationale: Operational views must be reproducible from authority records and
  must not become another authority. Timestamps do not establish total order,
  and neither closure nor escalation records encode resolution. Rejecting a
  contradictory snapshot preserves exact semantics until a later ordered event
  or resolution model can prove which fact is current.
* Consequence: Runtime projections must supply only current records for one
  phase generation. An active escalation prevents `closed`; resolving an
  escalation requires omitting it from the exact current snapshot under a
  separately validated authority model. Future ordered projections must retain
  this rejection rule unless they add explicit closure and escalation ordering
  semantics.

## Phase 2 log

### Bounded slice A: Task completion accounting

#### Decisions

* D-015 establishes exact task-generation binding, complete criterion accounts,
  canonical evidence policy semantics, and exact required-waiver authority.

#### Scope

* Added immutable task generation references, completion submissions, terminal
  and criterion dispositions, evidence attachments and requirements, criterion
  assessments, accounting assessments, and typed accounting errors.
* Added exact runtime validation for task identities, generations, context
  revision digests, non-empty summaries, criterion declarations and outcomes,
  waiver authority, supersession replacement references, evidence assets, and
  evidence policy minimums.
* Added deterministic canonical-kind evidence counts for task, required
  criterion, and satisfied-criterion scopes. Insufficient counts produce a
  negative immutable assessment rather than a malformed-input error.
* Added one-time canonical snapshots for both untrusted inputs and adversarial
  coverage for accessors, sparse arrays, forged brands, caller mutation, extra
  fields, duplicates, unknown references, omissions, waivers, supersession, all
  terminal dispositions, and all evidence policy modes.
* Kept sensors, gates, candidates, task lifecycle state, persistence, and
  adapter behavior outside this bounded slice.

#### Validation

Passed on 2026-08-12:

* Focused completion accounting suite: 23 tests
* Kernel package typecheck
* Biome check for completion source, tests, and kernel exports
* Architecture boundaries across 38 source files
* Documentation links across 17 Markdown files
* Owned-path `git diff --check`

#### Remaining risks

* A later Phase 2 slice must bind accounting assessments into exact phase
  candidates and closure records without introducing mutable completion status.
* Workflow configuration must produce criterion requiredness, evidence policies,
  and canonical waiver authority facts that match these kernel contracts.

### Bounded slice B: Sensor readings and gates

#### Decisions

* D-016 establishes content-addressed sensor facts, bounded three-valued
  conditions, and fail-closed gate semantics.

#### Scope

* Added immutable successful and failed sensor reading records bound to exact
  input and content digests.
* Added `all`, `any`, `not`, `exists`, equality, inequality, and four numeric
  comparison conditions over bounded JSON Pointers into exact reading data.
* Added digest-addressed gate definitions with distinct blocking and advisory
  rules and deterministic evaluations bound to candidate input, policy, and
  sorted reading digests.
* Added exact schemas, one-time untrusted input snapshots, typed errors, stale
  and duplicate reading refusal, and fixed condition depth, node, pointer
  segment, and pointer length budgets.
* Kept sensor execution, retries, workflow consequences, completion,
  candidates, and approvals outside this bounded slice.

#### Validation

Passed on 2026-08-12:

* Focused gate suite: 35 tests
* Kernel package typecheck
* Biome check for gate source, tests, and kernel exports
* Architecture boundaries across 38 source files
* Documentation links across 17 Markdown files
* `git diff --check`

#### Remaining risks

* Phase 6 configuration must validate sensor references before execution; a
  missing referenced reading intentionally remains an `unknown` gate result.
* Composition-layer SHA-256 adapters still require canonical-byte conformance
  tests before persisted reading and evaluation digests become authority.

### Bounded slices C and D: Candidate closure, budgets, and escalation

#### Scope

* Added phase candidates bound to exact graph, phase, active task set, graph-owned
  completion policy, accepted assessments, barriers, and gate policy.
* Added source-authoritative gate evidence, approval-only authority decisions,
  exact closure records, independent finite budget ledgers, first-class
  escalations, policy-bound additional allowances, and replay protection.
* Added exact validators for every persisted record and cross-record digest.

#### Review repairs

* Recompute gate evaluations from exact definition and readings.
* Reassess completion from graph-owned task policy rather than caller policy.
* Track applied allowance decisions and verify exact authority, unit, and limit.
* Snapshot exported validator inputs before property access.
* Remove broad phase waivers.
* Require the complete active direct-task set derived from graph supersession.

### D-020 review repair: Graph-owned completion policy

#### Decisions

* D-020 makes the canonical graph the independent authority for task completion
  criteria and evidence policy.

#### Scope

* Added a typed static completion policy to every task definition. The compiler
  requires one exact criterion requirement for every criterion owned by the
  task, rejects unknown and duplicate criteria, validates the evidence policy,
  and includes the complete policy in the task definition digest and graph
  revision.
* Added exported completion-policy validation and graph-derived completion
  requirement helpers while preserving context revision as a selected-task
  input.
* Removed completion requirements from accepted assessment entries and removed
  caller authority over candidate evidence policy digests. Candidate creation
  and validation now revalidate an exact canonical workflow graph, bind its
  revision, verify phase and selected task generations against graph
  definitions, derive context-bound requirements, reassess every submitted
  assessment, and derive the aggregate evidence policy digest internally.
* Threaded exact graph authority through closure validation and lifecycle
  projection without adding completion commands, mutable lifecycle state, or
  kernel effects.
* Updated software-delivery, incident-response, run, candidate, and lifecycle
  fixtures with explicit valid policies.
* Added adversarial coverage in which a caller creates a self-consistent
  assessment from empty criteria and a `none` evidence policy. Candidate
  construction rejects it because the selected graph task requires a criterion
  and evidence. Added exact graph revision, unrelated graph revision, stale
  selected generation, and stale context coverage.

#### Validation

Passed on 2026-08-12:

* Focused graph suite: 58 tests
* Focused candidate suite: 20 tests
* Completion, graph, candidate, run, and lifecycle integration slice: 128 tests
* Kernel package typecheck
* Clean workspace build and typecheck
* Complete workspace suite: 11 files and 247 tests
* Biome check across 40 intended source and configuration files
* Architecture boundaries across 50 source files and negative fixtures
* Documentation links across 17 Markdown files
* `git diff --check`

#### Remaining risks

* Phase 6 workflow configuration must require explicit completion policy for
  every normalized task and preserve the exact criterion-accounting contract.
* Later amendment logic must treat a selected task policy change as a task
  definition and graph revision change while retaining exact historical graph
  authority for existing candidates.

### Bounded slice E: Operational lifecycle projections

#### Decisions

* D-018 establishes immutable, digest-addressed lifecycle projections rebuilt
  from exact current records rather than mutable status.

#### Scope

* Added a pure phase-generation projection over optional current candidate,
  gate evaluation, authority decision, closure, and escalation records plus
  exact approval and escalation policy inputs.
* Added derived `awaiting-completion`, `awaiting-gate`, `gate-rejected`,
  `awaiting-approval`, `approval-rejected`, `awaiting-closure`, `closed`, and
  `escalated` states without accepting status as input.
* Added immutable selected-task accounts, terminal-disposition counts,
  completion summaries, source-record digests, approval needs, and escalation
  context for human action.
* Exported existing exact gate-evaluation and escalation validators and added an
  exact closure validator that reconstructs closure from its candidate, gate,
  policy, and authority source records.
* Added candidate, gate-policy, approval-policy, authority, escalation-policy,
  owner, context, and digest relation checks. Closure and active escalation in
  one unordered snapshot are rejected as contradictory.
* Kept commands, events, persistence, clocks, runtime effects, and escalation
  resolution outside the kernel projection.

#### Validation

Passed on 2026-08-12:

* Focused lifecycle suite: 8 tests
* Candidate, budget, and lifecycle integration suites: 49 tests
* Kernel package typecheck
* Biome check for lifecycle source, tests, validators, and kernel exports
* Clean workspace build and typecheck
* Complete workspace suite: 11 files and 232 tests
* Biome check across 40 intended source and configuration files
* Architecture boundaries across 50 source files and negative fixtures
* Documentation links across 17 Markdown files
* `git diff --check`

#### Remaining risks

* A later ordered authority model must represent escalation resolution before a
  historical escalation and closure can coexist in one projection input.
* Runtime query assembly must provide one internally consistent current-record
  snapshot and must not infer current records from timestamps alone.

### Phase 2 final review and validation

Independent review reproduced and drove repairs for forged gate evaluations,
self-authorized completion requirements, allowance replay, unsafe exported
validators, broad phase waivers, and omitted graph tasks. The final gate found no
critical, high, medium, or low findings.

Passed on 2026-08-12:

* Clean workspace build and typecheck
* Biome check across 40 intended files
* Complete workspace suite: 11 files and 248 tests
* Architecture boundaries across 50 source files and negative fixtures
* Documentation links across 17 Markdown files
* `git diff --check`

The final adversarial gate verified exact active task-set coverage, supersession,
graph-owned completion policy, source-authoritative gate evaluation, one-time
policy-bound allowances, accessor-safe validators, approval-only phase closure,
and closure/escalation contradiction handling.

Commit `d8a3d7a feat: add completion and escalation semantics` was pushed to
`origin/redesign/workflow-state-machine` on 2026-08-12.

## Decision D-022: Canonical dependency-free protocol validation

* Date: 2026-08-12
* Status: Accepted for Phase 3 bounded slice A
* Phase: 3
* Decision: Define the `senawa.dev/protocol/v1alpha1` wire contracts as
  browser-safe TypeScript DTOs with dependency-free exact runtime validators.
  Accept object inputs for canonical encoding, and require raw JSON inputs to
  already use the canonical key ordering and scalar encoding. Apply fixed byte,
  depth, node, string, identity, role, capability, and version-list limits.
* Alternatives: Add a schema dependency; accept arbitrary JSON text and lose
  duplicate-key evidence during native parsing; reuse kernel brands and
  canonical helpers; defer runtime validation to transport adapters.
* Rationale: The bounded schemas are manageable without a dependency. Requiring
  canonical raw JSON rejects duplicate keys, including ambiguous repeated
  principal fields, while deterministic encoding gives every browser and
  transport one golden representation. Independent wire strings avoid coupling
  protocol clients to kernel compile-time brands or behavior.
* Consequence: Clients encode through the protocol codec before transport.
  Future protocol fields require an API version change or an explicit schema
  revision because every current object rejects unknown fields.

## Decision D-023: Principal and transport attribution remain singular

* Date: 2026-08-12
* Status: Accepted for Phase 3 bounded slice A
* Phase: 3
* Decision: Carry exactly one authenticated principal value containing issuer,
  subject, tenant, assurance, and sorted roles. Carry transport kind and request
  identity in a separate exact attribution value. Do not admit principal IDs,
  issuers, roles, or equivalent authentication claims in transport attribution
  or beside the canonical principal field.
* Alternatives: Use one unqualified principal ID; merge authentication and
  transport metadata; allow each transport to define identity fields; accept a
  client principal plus a server principal.
* Rationale: Authentication claims and delivery provenance answer different
  questions. A singular principal prevents precedence ambiguity, while separate
  attribution preserves an audit trail without letting transport metadata act
  as authority.
* Consequence: Authenticated ingress adapters must construct the canonical
  principal from verified credentials and must not forward competing
  client-supplied identity fields. Authorization remains runtime behavior.

## Decision D-024: Receipt contracts expose uncertainty without transitions

* Date: 2026-08-12
* Status: Accepted for Phase 3 bounded slice A
* Phase: 3
* Decision: Define durable receipts with queued, claimed, completed, refused,
  expired, cancelled, and unknown-effect statuses; a non-negative safe-integer
  cursor; and optional prior revision, result revision, result, and exact error
  values. Keep transition legality, cursor advancement, replay, and terminal
  status rules outside protocol validation.
* Alternatives: Omit unknown effect; make status transitions protocol behavior;
  infer receipt state from command responses; use transport sequence numbers as
  authority cursors.
* Rationale: Lost output can leave effect state unknowable, so uncertainty must
  be representable rather than collapsed into failure. Protocol defines the
  durable shape, while a transactional runtime must decide and persist legal
  monotonic transitions.
* Consequence: Phase 3 runtime work must enforce exact replay idempotency,
  conflicting command refusal, expiry, authorization, and cursor monotonicity.
  A receipt decoder validates one record but cannot prove history by itself.

## Decision D-025: Runtime verifies protocol canonical payload bytes

* Date: 2026-08-12
* Status: Accepted for Phase 3 bounded slice B
* Phase: 3
* Decision: Export a browser-safe protocol canonical byte API and require the
  runtime command service to recompute every payload digest with an injected
  SHA-256 implementation before executing an intent. Keep kernel canonical
  behavior out of protocol and use the protocol encoder for wire payloads.
* Alternatives: Trust the supplied digest; recompute with kernel canonical
  helpers; hash transport-specific request bodies; import Node crypto directly.
* Rationale: Every transport needs one payload byte definition, while protocol
  must remain behavior-free and runtime must remain independent of Node APIs.
  Digest verification before mutation prevents a caller from binding authority
  to a digest that does not describe the decoded payload.
* Consequence: Concrete composition roots supply SHA-256. Protocol and runtime
  conformance share one canonical byte vector without coupling browser clients
  to kernel brands.

## Decision D-026: Admission facts and authorization are injected

* Date: 2026-08-12
* Status: Accepted for Phase 3 bounded slice B
* Phase: 3
* Decision: Make current time, canonical admission facts, approval and stream
  event identity allocation, SHA-256, and authorization policy explicit runtime
  inputs. Authorize the singular authenticated principal by intent and role.
  Do not consult ambient clocks, randomness, transport attribution, or process
  state.
* Alternatives: Read `Date.now()` and random identifiers inside runtime; grant
  authority by transport kind; embed one fixed role matrix in the command
  service; let clients supply authority decision principals in payloads.
* Rationale: Supplied facts make admission deterministic and restartable.
  Keeping policy behind a port permits repository-specific composition without
  allowing transport metadata or payload claims to widen authority.
* Consequence: Adapters authenticate once, construct one canonical principal,
  and supply deterministic admission facts. Runtime rejects duplicate allocated
  stream event identities and binds authority decisions to the authenticated
  principal.

## Decision D-027: Receipts are the durable command state machine

* Date: 2026-08-12
* Status: Accepted for Phase 3 bounded slice B
* Phase: 3
* Decision: Admit each new command through `queued`, `claimed`, and exactly one
  terminal receipt with a monotonically increasing per-run cursor. Store the
  canonical command envelope beside its terminal receipt. Exact replay returns
  that original receipt without advancing authority. Reuse of the command
  identity with a different canonical envelope returns a conflict refusal and
  cannot replace the stored command.
* Alternatives: Store only terminal outcomes; infer command state from events;
  make replay execute the intent again; compare only payloads for command reuse;
  assign cursors per transport connection.
* Rationale: Durable intermediate states make lost responses and later claims
  observable. The complete canonical envelope includes principal, guards,
  expiry, attribution, and payload, so all authority-relevant changes conflict.
* Consequence: Receipt and event queries replay one ordered authority history.
  Completed receipts carry prior and result record revisions where present.
  Conflict responses do not mutate the already terminal command history.

## Decision D-028: Runtime snapshots retain records and revalidate sources

* Date: 2026-08-12
* Status: Accepted for Phase 3 bounded slice B
* Phase: 3
* Decision: Serialize the in-memory authority as canonical JSON containing
  commands, receipt transitions, event frames, kernel run events, and immutable
  lifecycle records. On reconstruction, verify cursor and receipt legality,
  command-to-run bindings, event payload digests, graph replay, completion
  accounting, candidates, gate evidence, authority decisions, closure, and the
  derived lifecycle projection through current protocol and kernel APIs.
* Alternatives: Serialize a mutable status projection; retain process-memory
  indexes; trust typed snapshot records; replay only protocol event frames;
  place the in-memory authority in the testing package.
* Rationale: The restart test must prove that no process memory is authoritative.
  Kernel validators remain the source of workflow semantics, while runtime owns
  command ordering, identity, authorization, expiry, and query assembly.
* Consequence: Production runtime does not import testing. Deterministic
  fixtures and conformance cases live in testing, while the real in-memory
  authority and command/query ports live in runtime for later adapter
  conformance.

## Decision D-029: Authority snapshots reconstruct command provenance

* Date: 2026-08-12
* Status: Accepted for Phase 3 review repair
* Phase: 3
* Decision: Persist exact admission time, canonical facts, allocation sequence,
  and authorization decision with each command. Restore completed commands by
  deterministic execution into an empty authority. Restore non-effect refused
  or expired commands by deterministically reconstructing their exact receipt
  and event lifecycle from validated admission facts and allocations.
* Alternatives: Trust serialized lifecycle records; protect snapshots with an
  unkeyed digest; rerun every refusal under current dependencies; copy submitted
  receipt and event history directly.
* Rationale: An unkeyed snapshot digest cannot establish authority. Deterministic
  replay proves completed effects. Non-effect outcomes need their observed error
  fact preserved, but all deterministic admission errors and every transition
  field can still be reconstructed and compared exactly.
* Consequence: Policy drift makes a snapshot incompatible. Unknown-effect is not
  restored directly until Phase 5 reconciliation exists. Global run, repository,
  command, and event identities are checked before replay.

## Decision D-030: Failed command execution rolls back authority records

* Date: 2026-08-12
* Status: Accepted for Phase 3 review repair
* Phase: 3
* Decision: Preserve queued and claimed command history, but restore run records
  and projection metadata to their exact pre-execution values before persisting
  any terminal refusal caused after execution begins.
* Alternatives: Let failed commands retain partial records; discard the entire
  command lifecycle; require every handler to implement its own rollback.
* Rationale: Receipt durability and workflow authority are separate. A refused
  command must remain observable without granting any mutation it failed to
  finalize.
* Consequence: Phase 4 transactions must commit command history and authority
  effects atomically while preserving this refusal behavior.

## Decision D-031: Pin better-sqlite3 for the alpha authority

* Date: 2026-08-12
* Status: Accepted after Phase 4 no-credit probe
* Phase: 4
* Decision: Pin `better-sqlite3@12.11.1` and
  `@types/better-sqlite3@9.6.0` while the Node floor remains 22.12. Use one
  long-lived local write connection with WAL, `synchronous=FULL`, foreign keys,
  trusted schema off, finite busy timeout, immediate write transactions, and no
  network filesystem support.
* Alternatives: Built-in `node:sqlite`; `better-sqlite3@13`; SQLite WASM.
* Rationale: Node 22.12 requires an experimental flag and lacks later backup and
  timeout APIs. Node 22.17 in this container bundles SQLite 3.50.0, within a
  documented WAL-reset corruption range fixed in 3.51.3. `better-sqlite3@13`
  failed the Node 22.12 probe, while 12.11.1 loaded on 22.12 and 22.17, bundles
  SQLite 3.53.2, and passed WAL, rollback, busy timeout, migration, integrity,
  and online backup probes.
* Consequence: Native prebuild packaging becomes part of the alpha platform
  matrix. Disprove the choice if clean install falls back to compilation or the
  reference workload exceeds 25 ms transaction p99 or 50 ms event-loop-delay
  p99.

## Decision D-037: Replace whole-snapshot command persistence

* Date: 2026-08-12
* Status: Accepted after Phase 4 latency disproof
* Phase: 4
* Decision: Keep canonical snapshot export and startup verification, but stop
  replaying and rewriting the complete authority on every command. Maintain a
  revision-aware per-connection authority cache and persist only changed run,
  command, receipt, event, and projection rows inside the immediate transaction.
  Refresh from canonical authority when another connection advances revision.
* Alternatives: Raise the latency threshold; accept whole-snapshot behavior for
  alpha; remove normalized tables; use one database for many repositories.
* Rationale: The intended one-repository workload reached 190 ms p99 after 100
  durable command lifecycles, exceeding the 25 ms threshold. Whole-authority
  replay and full normalized-table synchronization make command cost grow with
  history.
* Consequence: Incremental persistence must retain exact canonical export,
  restart replay validation, optimistic revisions, refusal rollback, concurrent
  connection visibility, and normalized-table equality checks.
* Implementation: Each SQLite connection caches one replay-validated
  `InMemoryAuthority`, its `RuntimeCommandService`, canonical snapshot fragments,
  and the observed revision. `BEGIN IMMEDIATE` protects the revision read. A
  revision mismatch rebuilds all three caches from canonical JSON before command
  execution. A new command appends one checked three-receipt and three-event
  lifecycle, upserts only its run and repository ownership, and advances the
  canonical snapshot and revision in the same transaction. Pre-commit failures
  roll back SQLite and rebuild the cache from committed canonical JSON;
  post-commit acknowledgement faults retain the committed cache for exact retry.
  CAS continues through full normalized replacement so absent rows are deleted
  exactly, and startup still verifies normalized tables against replay-validated
  canonical state.
* Validation: The original 100-command same-run payload-digest refusal workload
  measured about 190 ms p99. The final repaired workload measured 12.46 ms p50,
  20.00 ms p95, 23.80 ms p99, and 79.27 ms maximum with a 25 ms p99 limit.
  Four preceding fresh-database runs measured p99 between 15.20 and 21.28 ms.
  A 16,384-page WAL auto-checkpoint interval keeps automatic checkpointing bounded
  without repeatedly charging growing canonical-row checkpoints to command
  commits.

## Decision D-032: Transact through replay-validated canonical authority state

* Date: 2026-08-12
* Status: Superseded for steady-state command submission by D-037
* Phase: 4
* Decision: Each command submission starts `BEGIN IMMEDIATE`, loads the exact
  canonical runtime snapshot and optimistic revision, reconstructs the in-memory
  authority by deterministic replay, executes `RuntimeCommandService`, and
  persists the new snapshot plus normalized rows under the same revision guard.
* Alternatives: Reimplement command handlers in SQL; persist only an opaque
  snapshot; let receipt history and runtime records commit separately.
* Rationale: Reusing the Phase 3 command service preserves one decision path and
  its exact refusal rollback behavior. Normalized rows add relational integrity
  without becoming a second source of lifecycle semantics.
* Consequence: The initial command path was synchronous and rewrote normalized
  command, receipt, and event rows. D-037 retained replay validation for startup,
  revision refresh, rollback recovery, and CAS input while replacing steady-state
  command replay and normalized rewrites with incremental caches and deltas.

## Decision D-033: Install immutable asset bytes before committing descriptors

* Date: 2026-08-12
* Status: Accepted
* Phase: 4
* Decision: Stage asset bytes on the asset filesystem, digest them through the
  supplied SHA-256 port, fsync the file, atomically link it at its digest path,
  fsync the containing directory, and only then commit its SQLite descriptor.
* Alternatives: Commit the descriptor before rename; store large assets as
  SQLite blobs; coordinate descriptor and filesystem writes with recovery flags.
* Rationale: SQLite and filesystem operations cannot share one atomic commit.
  Installing immutable bytes first permits harmless unreferenced files after a
  crash while preventing committed descriptors from naming absent bytes.
* Consequence: Orphan digest files can remain after a failed descriptor
  transaction and may be garbage-collected only by a later maintenance feature.
  Every existing path component is checked without following symlinks; new
  directories and parents are fsynced before descriptor authority is committed.

## Decision D-034: Separate command history scopes from active-run ownership

* Date: 2026-08-12
* Status: Accepted
* Phase: 4
* Decision: Key persisted run scopes by repository and requested run identity,
  but enforce repository and global run singleton rules only for instantiated
  runs with authority records. Rejected commands against another run retain
  durable receipt history without becoming active runs.
* Alternatives: Drop identity-conflict receipt history; make every refused scope
  an active run; attach conflict receipts to a different run identity.
* Rationale: Phase 3 creates queued, claimed, and refused history before an
  authority identity conflict is known. Treating that history scope as active
  contradicted deterministic snapshot restoration and SQL uniqueness.
* Consequence: Repository rows point to one active composite run key while
  non-active run scopes remain queryable for command history.

## Decision D-035: Treat every expired lease acquisition as a new fenced epoch

* Date: 2026-08-12
* Status: Accepted
* Phase: 4
* Decision: Lease acquisition and renewal use immediate transactions. A live
  owner can renew its current fence, but any acquisition after expiry increments
  the fence, including reacquisition by the same owner identity. Guarded writes
  require the exact live owner and fence.
* Alternatives: Reuse fences for the same owner; rely on expiry alone; defer all
  lease storage until the runner exists.
* Rationale: Owner labels can survive process restarts and cannot identify one
  execution epoch. Incrementing after expiry prevents stale work from regaining
  authority under a reused label.
* Consequence: Phase 5 runner writes must carry the granted fence and use guarded
  storage operations rather than checking a lease outside their transaction.

## Decision D-036: Verify backups and restore only into a fresh authority path

* Date: 2026-08-12
* Status: Accepted for the alpha restore surface
* Phase: 4
* Decision: Online backups publish a self-contained bundle directory containing
  `authority.db`, exact content-addressed assets, and a manifest binding database
  and asset digests. Build and verify a unique partial bundle, fsync all files and
  directories, and publish the manifest last. Restore verifies the complete
  bundle and writes only to fresh database and asset destinations.
* Alternatives: Replace a possibly live database in place; restore without asset
  verification; expose raw SQLite backup files without verification.
* Rationale: Replacing a path while another process holds the old inode can split
  local authority. Fresh-destination restore is a smaller safe alpha contract.
* Consequence: Backup destinations overlapping or aliasing the live database,
  WAL, SHM, asset tree, or existing paths are refused. In-place disaster recovery
  requires an explicit coordinated shutdown and swap workflow later.

## Phase 3 log

### Bounded slice A: Browser-safe protocol contracts

#### Decisions

* D-022 establishes dependency-free exact validation, canonical raw JSON, fixed
  input budgets, and wire identities independent from kernel brands.
* D-023 separates one authenticated principal from transport attribution.
* D-024 represents durable receipt outcomes and unknown effects without moving
  transition authority into protocol.

#### Scope

* Added public v1alpha DTOs and exact encode/decode APIs for authenticated
  principals, transport attribution, repository and run identity, commands,
  durable receipts, event stream frames, projections, capability handshakes,
  and errors.
* Added command intents for run instantiation, graph revision acceptance,
  completion submission, gate evaluation, authority decisions, phase closure,
  escalation creation, and allowance grants.
* Added deterministic canonical JSON encoding plus byte, depth, node, string,
  list, identity, digest, timestamp, cursor, Unicode, dense-array, plain-object,
  and accessor safety checks. Exact schemas reject every unknown field.
* Added command and receipt golden encodings plus adversarial coverage for all
  intents and statuses, duplicate principal keys, alternate attribution,
  malformed and oversized values, non-canonical capabilities, accessors, sparse
  arrays, deep payloads, and unknown fields on every envelope.
* Kept kernel imports, Node APIs, schema dependencies, workflow decisions,
  persistence, authorization, expiry decisions, receipt transitions, runtime
  packages, and transport adapters outside this bounded slice.

#### Validation

Passed on 2026-08-12:

* Focused protocol suite: 29 tests
* Protocol package typecheck and build
* Biome check across seven protocol package files
* Architecture boundaries across 58 source files and negative fixtures

#### Remaining risks

* The next Phase 3 slice must persist commands and receipts in memory, enforce
  replay identity and conflicting reuse, evaluate expiry and authorization,
  advance cursors monotonically, and expose transport-independent conformance.
* Payload digests and exact object digests are format-validated at the wire
  boundary. Runtime composition must recompute them with its SHA-256 adapter
  before accepting authority effects.
* Later version negotiation must define compatibility when more than one
  protocol version is implemented; this slice only accepts v1alpha1 envelopes.

### Bounded slice B: In-memory command authority

#### Decisions

* D-025 establishes protocol canonical bytes and runtime payload digest
  verification through injected SHA-256.
* D-026 establishes supplied admission time, facts, identity allocation, and
  intent-role authorization.
* D-027 establishes legal receipt transitions, monotonic per-run cursors, exact
  replay, and conflicting command identity refusal.
* D-028 establishes canonical authority snapshots and source revalidation during
  reconstruction.

#### Scope

* Added the real `@senawa/runtime` package with explicit SHA-256,
  authorization, admission-fact, command, query, and serializable-authority
  ports. Runtime depends only on protocol and kernel.
* Added an in-memory command authority with canonical snapshot serialization,
  restart reconstruction, legal `queued` to `claimed` to terminal receipt
  transitions, prior and result record revisions, monotonic run cursors, exact
  command replay, conflicting reuse refusal, and receipt, event, and projection
  queries.
* Added strict admission for protocol decode, payload digest, expiry,
  authorization, repository and run identity, one active run per repository,
  graph revision, task context revision, and exact candidate guards.
* Mapped `instantiate-run`, `submit-completion`, `evaluate-gate`,
  `record-authority-decision`, and `close-phase` through exact kernel source
  validation. The command-only journey compiles and instantiates a graph,
  assesses completion, constructs the exact phase candidate, evaluates gate
  evidence, records authenticated approval, closes the phase, and derives the
  lifecycle projection from immutable records.
* Included `accept-graph-revision` while no lifecycle records exist. Runtime
  replays the current kernel run state, enforces the expected revision, rejects
  replacement of the configured lifecycle phase, and records the accepted
  content-addressed graph event.
* Extended testing with deterministic graph, principal, SHA-256, clock, facts,
  and identity fixtures plus a transport-independent conformance suite.
* Extended dependency boundaries to reject runtime Node imports, ambient clock
  or randomness, dependencies beyond protocol and kernel, and any production
  dependency on testing.

#### Narrowed scope

* `create-escalation` and `grant-allowance` remain valid protocol intents but
  return `unsupported-intent` in this bounded runtime slice. Their ordered
  resolution and policy semantics remain for a later Phase 3 slice that can
  preserve the Phase 2 closure and escalation consistency rules.
* The in-memory authority is synchronous and has no SQLite, HTTP, lease, claim
  owner, or external-effect behavior. Transactional cross-connection authority
  remains Phase 4 work.

#### Validation

Passed on 2026-08-12:

* Focused protocol and runtime conformance: 37 tests
* Complete workspace build and typecheck
* Biome check across 50 intended files
* Complete workspace suite: 13 files and 285 tests
* Architecture boundaries across 66 source files and negative fixtures
* Documentation links across 17 Markdown files
* `git diff --check`

#### Remaining risks

* A transactional authority port for cross-process persistence belongs to Phase
  4 and must preserve these receipt, replay, cursor, and snapshot conformance
  semantics.
* Receipt conflict responses intentionally preserve the original terminal
  command without appending a second lifecycle for the reused identity. Later
  transports must expose that refusal without treating it as a new command.
* The runtime implementation does not yet process escalation and allowance
  intents. Those remain explicit unsupported-intent outcomes until ordered
  escalation resolution is added.

### Phase 3 final review and validation

Independent review found and drove repairs for altered completed-command replay,
cross-run identity collisions, non-exact lifecycle records, partial mutation on
refusal, empty-run creation during event-ID preflight, and forged non-effect
receipt, event, allocation, and terminal-error histories.

The final gate reproduced eleven individual snapshot forgeries and rejected all
of them. Exact completed, expired, unauthorized, payload-digest mismatch, and
rolled-back generic refusal snapshots restore byte-for-byte. No critical, high,
medium, or low findings remain.

Passed on 2026-08-12:

* Frozen-lock dependency installation
* Clean workspace build and typecheck
* Biome check across 50 intended files
* Complete workspace suite: 13 files and 292 tests
* Architecture boundaries across 66 source files and negative fixtures
* Documentation links across 17 Markdown files
* `git diff --check`

## Phase 4 log

### Decisions

* D-031 pins `better-sqlite3@12.11.1` and its type package.
* D-032 keeps runtime command semantics in one replay-validated decision path.
* D-033 orders asset installation before descriptor commitment.
* D-034 distinguishes durable refusal scopes from active-run ownership.
* D-035 gives every post-expiry lease epoch a new fence.
* D-036 verifies backup content and limits restore to a fresh destination.
* D-037 replaces per-command replay and whole-history normalized rewrites with a
  revision-aware connection cache and checked command deltas.

### Scope

* Added `@senawa/storage-sqlite` with one checksummed strict-schema migration,
  `user_version`, startup integrity checks, WAL, full synchronous durability,
  foreign keys, trusted schema disabled, finite busy timeout, and immediate write
  transactions.
* Added normalized repository, run, command, receipt, event, runtime-record,
  projection-time, asset, lease, claim, cancellation, effect-intent, and
  effect-outcome storage. The exact canonical authority snapshot remains the
  replay-validated source used by command execution and recovery.
* Added a runtime `AuthorityPort` while preserving `InMemoryAuthority` and all
  existing command, query, serialization, replay, and refusal behavior.
* Added content-addressed asset staging, digest installation, descriptor
  transactions, read verification, startup descriptor verification, online
  backup, verified partial files, atomic rename, and fresh-path restore.
* Added immediate-transaction lease acquisition, expiry takeover, monotonically
  increasing fences, and one guarded cancellation placeholder write.
* Added one reusable authority conformance suite and ran it against in-memory and
  SQLite implementations. SQLite-specific tests cover independent connections,
  real concurrent writer contention, stale revisions, full reopen journeys,
  duplicate commands, active-run ownership, lease fences, command and asset
  crash points, migrations, backup, restore, corruption, and read-only storage.
* Added stale connection refresh, same-instance cache rollback, and trigger-backed
  append-only normalized history tests. Added a deterministic 100-refusal
  benchmark that reports p50, p95, p99, and maximum latency and fails at a 25 ms
  p99.
* Added the exact native and type dependencies through pnpm, allowed only the
  `better-sqlite3` install script, added project references, and constrained
  storage production dependencies in the boundary checker.

### Narrowed requirements

* Claim, cancellation, effect-intent, and effect-outcome tables are real durable
  schema, but only lease acquisition and a fence-guarded cancellation placeholder
  have behavioral APIs in Phase 4. Phase 5 defines runner intent, outcome, claim,
  and reconciliation transitions.
* Disk-full behavior was not deterministically injectable in this environment.
  Pre-commit fault injection proves rollback and the POSIX read-only probe proves
  no receipt is returned when SQLite cannot write.
* Clean tarball installation and native loading ran on the current Linux and Node
  container only. The declared alpha platform matrix remains release validation.
* Restore writes only to a fresh destination. Coordinated in-place replacement is
  intentionally absent to avoid split authority with open database handles.

### Validation

Passed on 2026-08-12:

* Frozen-lock installation across seven workspace projects
* Complete workspace build and typecheck
* Biome check across 57 intended files
* Focused authority suites: three files and 45 tests
* Complete workspace suite: 15 files and 322 tests
* Architecture boundaries across 73 source files and negative fixtures
* Documentation links across 17 Markdown files
* D-037 benchmark with 100 same-run durable refusals below the 25 ms p99 limit
* Clean npm tarball install of kernel, protocol, runtime, and storage packages,
  followed by opening the installed SQLite authority and packaged migration

### Review

Independent review found four high-severity defects and drove these repairs:

* Backup publication can no longer replace or alias a live authority path.
* CAS path creation rejects symlink and hardlink escape and fsyncs new parents.
* Fence-guarded writes compare lease expiry with a separately supplied trusted
  current time rather than a backdated request timestamp.
* Normalized rows are exact projections of canonical state; CAS removes absent
  rows and startup rejects any divergence.

The review also drove self-contained backup bundles, concurrent first-migration
retry, storage identifier validation, and D-037 incremental persistence. The
final independent gate found no critical or high issues and approved Phase 4
under the explicit narrowed scope below.

### Commit and push

Pending atomic staging, commit, and push.

### Remaining risks

* Canonical snapshot export and the canonical authority-row update remain linear
  in retained history. D-037 removes replay, deep canonical revalidation, and
  normalized history rewriting from the steady-state command path, but larger
  histories still require representative measurement.
* Unreferenced digest files after failed descriptor transactions have no garbage
  collector yet.
* Network filesystems remain unsupported, and the adapter does not attempt to
  detect every mount topology.
* Full runner claim, intent, outcome, cancellation, and reconciliation behavior
  remains Phase 5 work.
* Platform packaging is proven only on Linux glibc x64 with Node 22.17. macOS,
  Windows, other architectures and libc variants remain release-matrix work.
* Real `ENOSPC` during WAL, checkpoint, backup, or asset fsync remains untested;
  fault injection and read-only storage tests cover rollback paths.
* The final enforced benchmark measured 21.75 ms p99 locally; the independent
  review measured 13.67 ms p99, both below the 25 ms threshold.

Commit `ef8580a feat: add transactional local authority` was pushed to
`origin/redesign/workflow-state-machine` on 2026-08-12.

## Entry template

```markdown
## Decision D-NNN: Title

* Date: YYYY-MM-DD
* Status: Proposed, accepted, superseded, or rejected
* Phase: Phase number
* Decision: Exact choice
* Alternatives: Credible alternatives
* Rationale: Why this choice best fits current evidence
* Consequence: Constraints or follow-up work created by the choice

## Phase N log

### Decisions

### Deviations

### Validation

### Review

### Commit and push

### Remaining risks
```