---
title: Redesign Implementation Log
description: Decisions, validation, and review outcomes for the Senawa alpha redesign
ms.date: 2026-08-13
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
| 5. Fenced runner and reconciliation | Complete | `40b0de4` | Pushed |
| 6. Workflow and sensor configuration | Complete | `4667ab0` | Pushed |
| 7. Context broker and serial workers | Complete | `4009bd8` | Pushed |
| 8. Local supervisor, HTTP, SSE, and CLI | Not started | Pending | Pending |
| 9. Additive amendments | Not started | Pending | Pending |
| 10. Optional parallel workspaces and integration | Not started | Pending | Pending |
| 11. Local portal | Not started | Pending | Pending |
| 12. Remote control-plane protocol | Not started | Pending | Pending |
| 13. Reporting, packaging, and hardening | Not started | Pending | Pending |
| 14. Consumer documentation and adoption journeys | Not started | Pending | Pending |

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

## Decision D-038: Keep external effect commands in the runner boundary

* Date: 2026-08-12
* Status: Accepted for Phase 5 bounded slice A
* Phase: 5
* Decision: Keep completed local protocol intents in the synchronous
  `RuntimeCommandService`. Represent external work as a distinct typed
  `QueuedEffectCommand` owned by the runtime runner, with one stable operation
  identity, exact repository and run identity, context and input digests,
  canonical input, finite reconciliation limit, deadline, and budget
  reservation. Do not add a protocol dispatch intent in this slice.
* Alternatives: Migrate every local command through the runner; add one generic
  protocol dispatch command; let each effect adapter own its queue and retry
  policy.
* Rationale: Existing local intents have deterministic kernel outcomes and no
  external uncertainty. Moving them would add recovery states without changing
  authority. External effects need durable intent and inspection semantics, but
  exposing generic dispatch to clients would grant an adapter-level capability
  before Phase 7 defines scoped worker and context authority.
* Consequence: Runtime scheduling consumes durable effect commands produced by
  trusted engine planning. A later protocol command may request domain work, but
  it must not let a client select an arbitrary effect host operation. Existing
  completed local receipts and replay behavior remain unchanged.

## Decision D-039: Fence engine-owned effect transactions

* Date: 2026-08-12
* Status: Accepted for Phase 5 bounded slice A
* Phase: 5
* Decision: Make `runOnce` consume supplied time, attempt identity, and one live
  owner and fence fact. The deterministic scheduler first reconciles one durable
  nonterminal effect, then selects at most one queued command. An engine-owned
  authority port reserves budget and persists intent before dispatch, then
  fence-checks and atomically commits the outcome, receipt, event, budget
  settlement, and projection. Effect hosts dispatch, inspect, and cancel by the
  stable operation identity.
* Alternatives: Let hosts persist their own outcomes; hold one database
  transaction open around an external call; infer missing effects as failed;
  apply outcomes under the fence that originally created the intent.
* Rationale: The authority transaction must end before an unbounded external
  call. A takeover can inspect the same operation and commit under its new fence
  without trusting process memory. Missing inspection permits idempotent
  dispatch only while the bound context remains current. Unknown inspection is
  persisted and stops at the command's finite reconciliation limit.
* Consequence: Exact attempt replay cannot append another transition. Terminal
  reported usage settles the reservation; absent terminal usage is recorded and
  charged as unreported reservation. Stale semantic outcomes remain durable but
  do not enter the current projection. Direct foreground execution must compose
  the same `FencedRunner` and authority port instead of bypassing fencing.

## Decision D-040: Isolate runner authority from command snapshots

* Date: 2026-08-12
* Status: Accepted for Phase 5 bounded slice B
* Phase: 5
* Decision: Implement `RunnerAuthorityPort` as a focused
  `SqliteRunnerAuthority` over the authority database. Add migration v2 tables
  for runner configuration, budgets, queued commands, intents, outcome attempts,
  cancellations, escalations, receipts, events, and projections. Continue to use
  the existing `leases` table and one shared acquisition transaction, with a
  digest-derived resource key for each repository and run.
* Alternatives: Store runner state in the canonical command authority snapshot;
  attach runner-only rows to the normalized command `runs` table; repurpose the
  Phase 4 placeholder effect tables; use a separate runner database.
* Rationale: Canonical command rows are verified as an exact normalization of
  `authority_state`. Runner-only rows in that graph would invalidate command
  snapshots and connection caches. The placeholder effect tables also reference
  normalized command runs and cannot represent runner configuration independently.
  Separate v2 tables preserve those invariants while one database and lease table
  retain atomic fencing and backup behavior.
* Consequence: Runner reads and writes do not increment command authority
  revisions or change canonical snapshots. Effect hosts remain outside storage.
  The v1 placeholder effect, claim, and cancellation tables remain unused until a
  future migration removes or assigns them a command-authority purpose.

## Decision D-041: Let authority select and claim each effect action

* Date: 2026-08-12
* Status: Accepted for Phase 5
* Phase: 5
* Decision: Before any effect-host call, atomically bind the exact run, durable
  intent, live owner and fence, current context, attempt identity, and one
  authority-selected action. The action is dispatch, inspection, cancellation,
  or settlement. Same-fence overlap is busy, terminal state replays, and only a
  higher takeover fence can replace a crashed claim.
* Alternatives: Replay lookup before the host call; caller-selected action;
  adapter-local claims; transaction around the external effect; rely only on the
  operation identity for idempotency.
* Rationale: A lookup followed by a host call leaves a race where two wakes can
  cross the effect boundary. Caller-selected actions also let stale plans or
  forged provenance dispatch when current authority requires inspection,
  cancellation, settlement, or replay.
* Consequence: Context cannot change under a current-fence claim. A delayed start
  plan is resolved from current durable state, recovery of a prior-attempt intent
  inspects instead of redispatching, and crashed claims require lease takeover.

## Decision D-042: Settle bounded uncertainty conservatively

* Date: 2026-08-12
* Status: Accepted for Phase 5
* Phase: 5
* Decision: When active, unknown, or cancellation reconciliation reaches its
  finite limit, commit one terminal failed settlement without another host call.
  Release the reservation and charge it as unreported usage. Reject reported
  usage above the reserved amount and roll back the complete settlement.
* Alternatives: Leave exhausted effects nonterminal; retry cancellation without
  a bound; release uncertain reservations without spend; accept provider usage
  above the authorized reservation.
* Rationale: An unattended runner must neither retry forever nor leak reserved
  budget. A provider report cannot retroactively authorize spend beyond the
  pre-dispatch ceiling.
* Consequence: Uncertainty remains visible through its prior outcomes and final
  reason, while budget state always reaches a bounded conservative result.

## Phase 5 log

### Bounded slice A: Effect-agnostic fenced runner core

#### Decisions

* D-038 separates trusted runner effect commands from synchronous local protocol
  intents.
* D-039 establishes one fenced authority contract for intent persistence,
  dispatch, inspection, reconciliation, and atomic outcome commitment.

#### Scope

* Added typed worker, sensor, Git, asset, and time effect contracts with stable
  operation identity, owner and fence, context and input digests, canonical
  input, budget reservation, details, output digest, usage, deadline, and
  intent, active, completed, failed, cancelled, and unknown states.
* Added a pure deterministic scheduler that prioritizes durable nonterminal
  effects and otherwise selects one queued command by sequence and command
  identity.
* Added `FencedRunner` over injected authority and effect-host ports. It persists
  intent before dispatch, inspects after crashes or lost responses, redispatches
  only a current missing operation under its stable identity, cancels deadlines
  and requested work, and bounds both active and unknown reconciliation.
* Added an in-memory runner authority with exact lease checks at both write
  boundaries, independent budget reservation and escalation, reported and
  unreported usage settlement, semantic freshness, exact attempt replay,
  recursively immutable command and outcome snapshots, receipts, events, and
  current projection updates in one commit method.
* Added reusable authority conformance fixtures, a generic queued worker effect
  path, a complete inspection-result matrix, and crash injection before and
  after intent persistence and outcome commitment.
* Preserved `RuntimeCommandService` behavior and protocol schemas. No Node API or
  concrete adapter entered runtime.

#### Narrowed scope

* The SQLite effect-intent and outcome tables remain unchanged. A later Phase 5
  slice implements `RunnerAuthorityPort` over those existing tables and their
  lease fences after the in-memory transition contract is reviewed.
* Kernel budget ledgers remain the workflow policy authority. This slice proves
  independent runtime reservation and exhaustion behavior but does not yet
  create kernel escalation records or allowance commands.
* Supervisor wake-up and direct foreground composition remain Phase 8 work. Both
  must call the same fenced runner contract established here.

#### Validation

Passed on 2026-08-12:

* Runtime and testing package typechecks
* Focused runner conformance and crash matrix: 23 tests
* Targeted Biome formatting and import checks
* Clean workspace build and typecheck
* Biome check across 61 intended files
* Complete workspace suite: 16 files and 345 tests
* Architecture boundaries across 81 source files and negative fixtures
* Documentation links across 17 Markdown files
* `git diff --check`

#### Review

The bounded-slice diff audit found two authority defects and drove repairs:

* Active host inspection could continue without a deadline. Active and unknown
  outcomes now share the command's finite reconciliation limit.
* Shallow freezing allowed nested command input or host outcome details to
  change after persistence. The in-memory authority now canonical-snapshots and
  recursively freezes both boundaries, with caller and host mutation tests.

No unresolved critical or high findings remain in bounded slice A.

#### Remaining risks

* SQLite conformance must prove the same atomic receipt, event, outcome, budget,
  and projection transaction under independent connections and lease takeover.
* A future trusted planner must derive queued effect commands from canonical
  graph and context authority rather than accepting arbitrary client dispatch.
* Phase-wide independent review and later Phase 5 slices remain pending.

### Bounded slice B: Durable SQLite runner authority

#### Decisions

* D-040 separates durable runner state from normalized command authority while
  retaining the shared database, migration checksums, and lease fences.

#### Scope

* Added checksummed migration v2 with independent runner run configuration,
  context, budget, queue, intent, outcome-attempt, cancellation, escalation,
  receipt, event, and projection tables.
* Added `SqliteRunnerAuthority` with durable `configureRun`, `enqueue`, load, and
  query methods plus fenced context updates, cancellation requests, and lease
  takeover.
* Made intent persistence, budget reservation, outcome commitment, usage
  settlement, budget release or spend, event and receipt append, and projection
  update atomic under `BEGIN IMMEDIATE` transactions.
* Required exact live owner, fence, expiry, and supplied time at every runner
  write boundary. Consolidated command and runner lease acquisition on one
  transaction implementation over the existing `leases` table.
* Preserved every outcome attempt for exact replay, prevented terminal outcome
  replacement, bounded active and unknown reconciliation, and excluded stale
  semantic outcomes from the current projection.
* Published Vitest-backed runner suite registration through an explicit testing
  subpath while preserving test-framework-free runner fixtures at the package
  root.
* Registered the shared runner authority conformance suite against SQLite and
  added close-and-reopen crash recovery at all four intent and outcome commit
  boundaries.
* Added stale-fence takeover, duplicate wake, exact active replay, terminal
  immutability, active and unknown bounds, fenced cancellation, stale context,
  budget escalation, and command-snapshot isolation coverage.

#### Narrowed scope

* Storage contains no effect host and never dispatches, inspects, or cancels an
  external system directly. `FencedRunner` remains the only host composition
  boundary.
* Migration v2 does not repurpose the Phase 4 placeholder effect, claim, or
  cancellation tables because their command-run foreign keys would couple the
  two authority models.
* Trusted command derivation, supervisor wake-up, foreground composition, and
  worker dispatch remain later Phase 5 and Phase 8 work.
* Kernel budget policy and allowance commands remain authoritative. SQLite
  persists runner reservations, settlement, and budget-exhausted escalation
  facts without introducing new kernel policy.

#### Validation

Passed on 2026-08-12:

* Focused SQLite authority and runner suite: 43 tests
* Clean workspace build and typecheck
* Biome check across 62 files
* Complete workspace suite: 16 files and 361 tests
* Architecture boundaries across 83 source files
* Documentation links across 17 Markdown files
* `git diff --check`
* SQLite command-authority benchmark: 18.53 ms p99 across 100 samples, below the
  25 ms threshold

#### Review

The bounded-slice diff audit and executable checks found three local defects and
drove repairs:

* SQLite initially emitted `effect-queued` instead of the established
  `effect-command-queued` event contract. Shared conformance caught the mismatch.
* The future-schema fixture still treated schema version 2 as unsupported. It now
  probes version 3.
* The benchmark exposed Vitest suite registration behind the testing package
  root's runner fixture export. Fixtures and fake hosts remain available at the
  root, while suite registration now loads only through its explicit subpath.

No unresolved critical or high findings remain in bounded slice B. The
phase-wide review and its repairs are recorded below.

#### Remaining risks

* A trusted planner must still derive queued effect commands from canonical graph
  and context authority rather than expose arbitrary effect dispatch.
* Supervisor and foreground recovery must compose this same authority and runner
  contract rather than introduce another execution path.
* Trusted planning and supervisor composition remain later phases.

### Phase-wide review and closure

#### Independent review iterations

The independent review rejected the phase four times before approval. Each
rejection produced a discriminating conformance or adversarial test:

* Stale owners could call effect hosts before commit-time fence rejection.
  `RunnerAuthorityPort` now validates the live fence before every host operation,
  and host adapters receive that fence. Memory and SQLite prove zero stale-owner
  host calls.
* Exhausted active and unknown effects became permanent nonterminal records with
  leaked reservations. They now reach one terminal conservative settlement.
* Context changes trusted commit-time freshness and rewrote projections without
  advancing the cursor. Fenced context and cancellation mutations now append
  durable transitions, and projection membership compares immutable outcome
  context with current run context.
* In-memory authority retained only the latest attempt and accepted unfenced
  control mutations. It now retains exact historical attempts and shares the
  fenced mutation contract with SQLite.
* Exact attempt replay and uncertain cancellation still crossed the host boundary
  before replay or finite settlement. Replay moved ahead of effects, cancellation
  received one bounded host attempt, and synthetic settlement preserves the
  configured reconciliation count.
* SQLite could settle another run's intent under the wrong fence, usage could
  exceed its reservation, and concurrent wakes could pass a non-linearizable
  lookup. Exact run scoping, checked usage, and transactional effect claims fixed
  those defects.
* A stale start plan could still redispatch a terminal operation and callers could
  forge claim origin. Authority now selects the action from current durable state
  and terminal outcomes replay regardless of attempt identity.

The final independent review reported no critical, high, medium, or low findings
and approved Phase 5.

#### Final validation

Passed on 2026-08-12:

* Clean workspace build and typecheck
* Biome check across 62 files
* Complete workspace suite: 16 files and 375 tests
* Focused runner and SQLite authority suites: 80 tests
* Architecture boundaries across 83 source files
* Documentation links across 17 Markdown files
* `git diff --check`
* SQLite command-authority benchmark: 15.69 ms p99 across 100 samples, below the
  25 ms threshold

One benchmark run immediately after an earlier full test suite measured 27.67 ms
p99. Two immediate isolated reruns measured 14.18 ms and 15.93 ms, and the exact
test-then-benchmark sequence subsequently measured 14.94 ms. The final clean
sequence measured 15.69 ms. The isolated outlier was retained in this record and
was not reproducible as a history-growth regression.

#### Commit and push

* Implementation commit: `40b0de4 feat: add fenced workflow runner`
* Push: succeeded to `origin/redesign/workflow-state-machine`

#### Remaining risks

* A trusted planner must derive queued effect commands from canonical graph and
  context authority rather than expose arbitrary effect dispatch.
* Supervisor and foreground recovery must compose this same authority-selected
  claim protocol rather than introduce another execution path.

## Decision D-043: Normalize consumer configuration before kernel compilation

* Date: 2026-08-13
* Status: Accepted for Phase 6 bounded slice A
* Phase: 6
* Decision: Accept one exact `senawa.dev/workflow/v1alpha1` unknown-input
  boundary with flat phases and embedded executable work. Derive each branded
  graph identity from its definition kind and the supplied SHA-256 digest of a
  qualified consumer path, resolve consumer references before lowering one
  `NormalizedWorkflowInput`, and delegate graph authority to
  `compileWorkflowGraph`. Produce one recursively immutable
  `senawa.dev/configuration-snapshot/v1alpha1` snapshot whose component digests
  bind the graph and every sorted registry, and whose snapshot digest excludes
  only itself.
* Alternatives: Expose graph identities in consumer documents; allocate
  identities by declaration order; duplicate graph and completion validation in
  configuration; use JSON Schema as the semantic compiler; add YAML and file
  loading to the package root.
* Rationale: Qualified-path identities make property and declaration order
  irrelevant while preserving scoped consumer keys. Kernel compilation remains
  the single authority for graph references, cycles, completion policy, and
  canonical graph digests. An unknown-input boundary with explicit diagnostics
  isolates callers from mutation and keeps the package usable in browsers.
* Consequence: Diagnostics retain source locator and pointer information, while
  accepted graph source pointers use stable key-based paths. This slice emits
  empty schemas, roles, model policies, sensors, gates, and projections. Their
  registries and component digests reserve the complete snapshot shape without
  implementing their later semantics.

## Decision D-044: Bind workflow execution authority in the normalized snapshot

* Date: 2026-08-13
* Status: Accepted for Phase 6 bounded slice B
* Phase: 6
* Decision: Extend the exact `senawa.dev/workflow/v1alpha1` document with
  declaration-order-insensitive schema, role, model policy, sensor, and gate
  registries plus in-memory top-level projected work records. Require executable
  work to name an agent role and six positive finite loop budgets. Bind role,
  budgets, optional input schema, and phase-owned gate references into canonical
  task graph input. Compile gate conditions through kernel `defineGate`, and use
  Ajv 8 draft 2020-12 only to validate consumer schema definitions and local
  references, without validating runtime data.
* Alternatives: Add a second projected-work compiler; let sensors select
  lifecycle consequences; execute process sensors during doctor; permit human
  or authority roles to execute work; use filesystem callbacks for projection;
  hand-roll draft 2020-12 schema validation.
* Rationale: One work parser and lowerer prevents embedded and projected work
  from acquiring different authority semantics. Phase-bound gates keep process
  sensors as measurement definitions while workflow structure owns consequence
  attachment. Canonical task bindings and registry component digests make every
  authority-bearing definition immutable and drift-visible. Ajv provides strict
  browser-safe schema structure and reference validation without adding runtime
  effects to configuration.
* Consequence: `@senawa/configuration` may depend only on `@senawa/kernel`,
  `ajv`, and `json-schema-traverse`. Registry declarations sort by key, while
  model routes and sensor argv preserve semantic order. Projected work is
  supplied as resolved `{ phase, work }` content and collides by the same
  qualified phase/work key as embedded work. Amendments remain assigned to
  Phase 9. YAML, filesystem, process, CLI, and init adapters remain deferred to
  later Phase 6 slices.

## Decision D-045: Bound process measurements and bootstrap file commands at adapters

* Date: 2026-08-13
* Status: Superseded by D-046
* Phase: 6
* Decision: Execute configured process sensors only through a dependency-free
  `@senawa/execution-host` Node adapter that returns either a measurement or an
  adapter failure. On Linux, spawn one literal argument vector without a shell
  in a detached process group, inherit only explicitly named ambient variables,
  bound output prefixes while draining both pipes, and terminate plus confirm
  the complete group after timeout, cancellation, or leader exit. Keep CLI
  doctor and init orchestration behind injected file and SHA-256 ports. Doctor
  calls the pure configuration doctor, while init uses exclusive creation and
  the pure versioned example renderer.
* Alternatives: Execute sensors from configuration doctor; use shell command
  strings; spread `process.env`; terminate only the leader; treat nonzero exits
  as adapter failures; let init overwrite or truncate existing files; add model
  or runner services to CLI bootstrap commands.
* Rationale: Measurement outcomes preserve observed process facts without
  granting sensors lifecycle authority. Literal argv, allowlisted environment,
  realpath containment, bounded output, and group cleanup constrain host
  effects. Injected CLI ports make it structurally impossible for doctor or init
  to dispatch sensors, models, or runner work.
* Consequence: Executable sensor measurement is currently available only on
  POSIX Linux; other platforms return an explicit unsupported result. Linux
  cleanup treats a group containing only dead zombie records as absent after
  `/proc` confirms that no runnable member remains. Configuration amendments
  remain assigned to Phase 9. Async runner integration and supervisor-backed
  operational CLI commands remain assigned to Phase 8.

## Decision D-046: Package a native Linux subreaper and preserve failed init paths

* Date: 2026-08-13
* Status: Accepted for Phase 6 bounded slice C review repairs
* Phase: 6
* Decision: Replace detached Node process-group supervision with a packaged C17
  Linux subreaper. Node opens the canonical root directory with no symlink
  following, passes it as fd 4, drains bounded command output, reads a versioned
  status record on fd 3, and sends timeout or cancellation `SIGTERM` only to its
  owned helper process. The helper resolves cwd from fd 4 with `openat2`
  containment, changes directory by descriptor, forks the exact argv and
  allowlisted environment, records exec failures separately, and retains the
  original leader unreaped until its initial process-group `SIGTERM`. It then
  reaps every descendant as a child subreaper. After the grace interval it uses
  pidfds for currently adopted direct children and never signals the numeric
  process group again. Build the helper with strict `cc` flags into the package
  `dist` directory and ship it in the package tarball; runtime compilation is
  forbidden. Init syncs the exclusively created file and parent directory in
  order, never unlinks a failed pathname, and reports that a partial owned path
  may remain.
* Alternatives: Retain detached Node process groups with `/proc` inspection;
  treat zombies as successful cleanup; signal a numeric process group after its
  leader is reaped; discover and compile helper source at runtime; remove an
  init pathname after write or sync failure.
* Rationale: A detached process group does not own or reap escaped descendants,
  and a numeric PGID can be reused after its leader is reaped. Subreaper
  adoption plus generation-bound pidfds proves descendant death and reaping,
  including children that create a new session. Descriptor-relative cwd
  resolution removes the checked-path-to-spawn pathname race. Preserving failed
  init paths avoids deleting a replacement installed after exclusive creation.
* Consequence: Executable sensors are an alpha feature for Linux x64 with glibc
  2.34 or newer, matching the packaged helper's linked baseline. Source builds
  require a C17 compiler available as `cc`; both root and execution-host builds
  fail clearly when it is unavailable. The compiled helper is executable
  package content, and no compiler is needed at runtime.
  Configuration and execution adapters independently cap timers, output, and
  retry controls. Failed init can leave a partial file for explicit operator
  inspection or removal.

## Phase 6 log

### Bounded slice A: In-memory sensor-free workflow configuration

#### Opening

Phase 6 opened on 2026-08-13 after confirming the Phase 5 implementation,
independent review, commit, and push were complete. The status table was updated
to match that recorded closure.

#### Scope

* Add a pure browser-safe `@senawa/configuration` package over
  `@senawa/kernel`.
* Compile the exact v1alpha1 workflow, phase, embedded work, criterion,
  dependency, completion policy, and canonical input boundary.
* Aggregate sorted doctor diagnostics and make compilation throw the complete
  diagnostic set without returning a partial snapshot.
* Detect deterministic component and key drift between immutable snapshots.

#### Deferred scope

* YAML, filesystem and Node adapters, JSON Schema evaluation, projected work,
  amendments, sensors, roles, model policy, gates, process execution, init, and
  CLI doctor behavior remain outside bounded slice A.

#### Review repairs

Review repairs on 2026-08-13 retained kernel graph authority while adding an
immutable structured diagnosis result. Kernel diagnosis now aggregates
independent definition and reference failures, reports one deterministic
diagnostic per cyclic strongly connected component, and returns a graph only
when the diagnostic set is empty. `compileWorkflowGraph` retains its original
validation order and throwing behavior for compatibility, with enriched subject
and field context where available.

Configuration doctor now translates every kernel diagnostic through lowered
identity-to-source metadata. It no longer searches error messages or decides
graph references before kernel diagnosis. Diagnostics derived from a definition
that failed local compilation are suppressed because they cannot be established
independently; unrelated valid definitions continue through reference and cycle
analysis.

Later independent review found that any failed workflow or duplicate identity
still suppressed all relationship analysis, generic completion paths still
relied on message text, and regular expressions left valid Node import syntax
unclassified. Diagnosis now removes only ambiguous duplicate identities from
relationship graphs and continues across unaffected valid definitions.
Completion validation carries a structured path. The dependency-boundary script
parses TypeScript syntax and inspects static imports, exports, dynamic imports,
import-equals declarations, and `require` calls against Node's complete builtin
module set.

The final review also found an invalid mutable test type and cascading graph
source errors when the external locator itself was invalid. The fixture now uses
the production evidence-policy mode union, and doctor substitutes a valid
internal source locator during diagnosis while returning exactly one
`invalid-locator` diagnostic to the caller.

A final boundary probe found that valid multi-argument dynamic imports and
`require` calls bypassed the AST check because it required exactly one argument.
The scanner now inspects the first literal argument whenever at least one exists,
with explicit option-bearing import and require self-tests. Independent review
then approved bounded slice A with no remaining findings.

#### Validation

Passed on 2026-08-13:

* Focused configuration suite: 13 tests
* Configuration package declaration build
* Clean workspace build and typecheck
* Biome check across 70 files
* Complete workspace suite: 17 files and 388 tests
* Architecture boundaries across 95 source files
* Documentation links across 17 Markdown files
* `git diff --check`

Review repairs passed on 2026-08-13:

* Focused kernel and configuration suites: 76 tests
* Clean workspace build and typecheck
* Biome check across 70 files
* Complete workspace suite: 17 files and 393 tests
* Architecture boundaries across 95 source files, including builtin import
  self-tests
* Documentation links across 17 Markdown files
* `git diff --check`

Final bounded-slice validation passed on 2026-08-13:

* Focused kernel and configuration suites: 80 tests
* Clean workspace build and typecheck
* Biome check across 70 files
* Complete workspace suite: 17 files and 397 tests
* Architecture boundaries across 95 source files, including AST import syntax
  self-tests
* Documentation links across 17 Markdown files
* `git diff --check`

### Bounded slice B: Authority registries and projected work

#### Scope

* Extended the existing exact workflow document and immutable snapshot rather
  than adding a second compiler or doctor path.
* Added canonical schema entries with unique `$id` enforcement, exact draft
  2020-12 declarations, local-only static `$ref`, precise undefined
  local-reference diagnostics, strict Ajv compilation, sorted entries, and
  per-entry and component digests.
* Added agent, human, and authority role declarations; sorted finite
  capabilities; required model policies for agents; explicit ordered model
  routes with finite turn, submission, and millidollar bounds; and refusal of
  human or authority work execution.
* Added exact process sensor measurement definitions with argument vectors,
  safe relative working directories, bounded timeout and output, unique
  inherited environment names, attempt bounds, and reconciliation bounds.
  Sensor definitions cannot declare lifecycle, action, approval, or authority
  fields and do not execute processes.
* Added phase-bound gate declarations, undefined sensor checks before kernel
  lowering, sorted gate rules, and kernel-owned condition and pointer
  validation through `defineGate`. Empty sensor and gate registries remain
  valid.
* Added resolved top-level projected work records. Embedded and projected work
  use the same parser, semantic checks, identity derivation, task lowering, and
  completion-policy lowering. Qualified collisions fail before snapshot
  construction.
* Added canonical task bindings for role, sorted finite budgets, optional input
  schema, and sorted phase gate references. Populated every snapshot registry
  with sorted immutable canonical entries and per-entry digests.

#### Deferred scope

* Additive amendments remain deferred to Phase 9.
* YAML decoding, filesystem loading, process execution, process cleanup, CLI
  doctor, init, and no-overwrite behavior remain deferred to later Phase 6
  slices or execution-host adapters.
* Consumer schemas are validated as definitions only. Runtime task input and
  sensor output validation is not part of this slice.

#### Review self-audit

The bounded-slice self-audit traced every new authority-bearing field from the
consumer boundary into either canonical graph input or a component-digested
registry. It confirmed that projected and embedded work share one lowering
function, gate consequences attach by phase, undefined sensor references are
reported before gate definition, and configuration imports no Node, process,
filesystem, runtime, protocol, or application modules. It also confirmed that
Ajv was the only new production dependency at that point. The later review
repair made the already-transitive `json-schema-traverse` library a direct
dependency and updated the boundary allowlist.

The audit repaired consumer gate types that leaked kernel-branded identities,
made undefined local schema references point at their exact fields, and removed
a replacement-tool append artifact before final validation. No unresolved
critical or high findings remain. No subagent or independent review was run for
this bounded slice because the implementation request explicitly prohibited
subagents.

#### Review repairs

The Slice B review identified path portability, schema traversal, schema
identity, gate reference, and diagnostic-location defects. Repairs on
2026-08-13 made these changes:

* Sensor working directories now reject case-insensitive Windows drive
  designators for both absolute and drive-relative forms. Future execution-host
  adapters remain responsible for resolving the accepted relative path against
  their configured root and proving host containment before process execution.
* Schema reference inspection now uses `json-schema-traverse` at schema-bearing
  locations, with explicit draft 2020-12 locations for `prefixItems`,
  `dependentSchemas`, unevaluated schemas, and `contentSchema`. Annotation data
  in `default`, `examples`, `const`, and `enum` is never interpreted as schema.
* Local URI fragments are percent-decoded before JSON Pointer unescaping and
  resolution. Remote references, malformed fragments, and undefined local
  pointers remain rejected before strict Ajv 2020-12 compilation.
* Top-level schema resource identifiers are parsed and normalized with the
  browser-safe WHATWG `URL` API. Empty fragments identify the same resource,
  malformed absolute identifiers are rejected, and duplicate detection uses
  normalized resource identity.
* Gate sensor discovery now follows only the typed condition grammar and never
  traverses comparison `expected` data.
* Kernel `GateError` values retain their existing codes and messages while
  optionally carrying immutable structured parse paths. Configuration maps
  those paths, including sorted blocking or advisory rule indexes, back to the
  exact consumer accessor field.
* A second review found unresolved named dynamic anchors, malformed JSON Pointer
  tilde escapes, percent-equivalent resource identifiers, and root-only
  duplicate-rule diagnostics. Schema diagnosis now collects `$anchor` and
  `$dynamicAnchor` declarations from schema locations before resolving named
  local references, rejects invalid RFC 6901 escapes, and canonicalizes URI
  percent triplets by decoding unreserved bytes and uppercasing reserved bytes.
  Duplicate gate rules now identify the later blocking or advisory rule key.
* The final Slice B anchor review found that the anchor collection remained
  document-wide and JSON Pointer fragments still resolved from the document
  root. Schema locations now bind to their nearest resource root and normalized
  resource identity. The root resource uses the normalized top-level `$id`;
  every nested `$id` starts an embedded resource and must remain an absolute URI
  without a non-empty fragment. Relative embedded identifiers are rejected at
  their declaration rather than resolved against a parent identifier.
* `$anchor` and `$dynamicAnchor` names share a resource-local namespace for
  static `$ref` targets.
  Duplicate names fail at the later declaration path, while the same name may
  appear in separate resources. Named and JSON Pointer fragments resolve only
  from the reference location's nearest resource. This rejects root access to
  embedded anchors and embedded access to root-only pointers while accepting
  references internal to either resource.
* Ajv 8.17.1 meta-schema validation accepts `$anchor`, and its resolver indexes
  static anchors, but strict compilation reports `$anchor` as an unknown
  keyword because the 2020 vocabulary does not register it. Registering the
  keyword makes root static anchors compile, but representative embedded
  resource references overflow Ajv's compiler stack. The configuration package
  therefore validates resource and reference semantics with its explicit index,
  retains Ajv meta-schema validation on the original declaration, and compiles
  an equivalent deep copy. That copy removes anchor declarations and embedded
  identifiers, then rewrites every validated local reference to the exact
  document JSON Pointer for its resource-local target. Ajv compilation thus
  exercises every static reference target without silently treating named
  fragments as document-wide.
* The subsequent adversarial review demonstrated that rewriting `$dynamicRef`
  to a static pointer cannot preserve dynamic-scope semantics. Workflow
  configuration v1alpha1 now rejects `$dynamicRef` explicitly until runtime
  schema evaluation can implement and test its dynamic scope. It does not claim
  static equivalence for stored schemas.
* Schema analysis now rejects definitions beyond 128 container levels or 10,000
  container nodes before recursive schema-library traversal, returning an
  `invalid-schema` diagnostic instead of exposing doctor to stack overflow.
  Static JSON Pointer targets must remain in the reference location's nearest
  resource, and root plus embedded resource identifiers participate in one
  registry-wide uniqueness index across every schema entry.

#### Validation

Passed on 2026-08-13:

* Frozen workspace install after locking Ajv 8.17.1
* Focused configuration typecheck
* Focused configuration suite: 31 tests
* Clean workspace build and typecheck
* Biome check across 71 files
* Complete workspace suite: 17 files and 411 tests
* Architecture boundaries across 97 source files
* Documentation links across 17 Markdown files
* `git diff --check`

Review repairs passed on 2026-08-13:

* Frozen workspace install with direct `json-schema-traverse` 1.0.0 ownership
* Focused kernel and configuration suites: 81 tests
* Clean workspace build and typecheck
* Biome check across 71 files
* Complete workspace suite: 17 files and 423 tests
* Architecture boundaries across 97 source files
* Documentation links across 17 Markdown files
* `git diff --check`

Second review repairs passed on 2026-08-13:

* Focused kernel gate and configuration suites: 86 tests
* Clean workspace build and typecheck
* Biome check across 71 files
* Complete workspace suite: 17 files and 428 tests
* Architecture boundaries across 97 source files
* Documentation links across 17 Markdown files
* `git diff --check`

Final anchor review repair focused validation passed on 2026-08-13:

* Focused configuration suite: 57 tests
* Focused configuration typecheck
* Biome check for the modified schema validator and configuration tests
* Clean workspace build and typecheck
* Biome check across 71 files
* Complete workspace suite: 17 files and 437 tests
* Architecture boundaries across 97 source files
* Documentation links across 17 Markdown files
* `git diff --check`

Static-only resource policy validation passed on 2026-08-13:

* Focused configuration suite: 61 tests
* Clean workspace build and typecheck
* Biome check across 71 files
* Complete workspace suite: 17 files and 441 tests
* Architecture boundaries across 97 source files
* Documentation links across 17 Markdown files
* `git diff --check`

#### Commit and push

No commit or push was performed for bounded slice B, as requested.

### Bounded slice C: Process measurement and bootstrap CLI

#### Scope

* Added a recursively immutable, sensor-free v1alpha1 example factory and
  deterministic JSON renderer to the browser-safe configuration package.
* Added the real `@senawa/execution-host` package with zero production
  dependencies. Its public API returns discriminated measurement and failure
  outcomes for bounded executable sensors.
* Preserved argv bytes as literal strings and constructed a null-prototype
  environment from only configured inherited names and supplied ambient values.
  Bare executables require an inherited `PATH`.
* Added bounded stdout and stderr capture with complete pipe draining, timeout,
  `AbortSignal` cancellation, and explicit measurement or failure outcomes.
* The initial detached Node process-group and pathname-based cwd implementation
  was rejected during review and replaced by D-046's native descriptor-relative
  supervisor before Phase 6 approval.
* Added async CLI `doctor` and `init` commands with injected file and SHA-256
  ports. Doctor parses JSON and aggregates pure configuration diagnostics. Init
  uses exclusive `wx` creation, syncs the file and parent directory, never
  overwrites an existing or partial file, and never removes a failed pathname.
* Updated package references, workspace locking, architecture boundaries, CLI
  help, and the CLI reference.

#### Limitations and deferred scope

* Executable process measurement returns `unsupported-platform` outside Linux.
  No shell, Windows process-tree, or macOS process-group adapter is claimed.
* Consumer YAML loading is not implemented; alpha doctor accepts JSON only.
* Configuration amendments remain assigned to Phase 9.
* Runner integration, sensor supervision, and supervisor-backed operational CLI
  commands remain assigned to Phase 8.

#### Review notes

Focused self-review added a null-prototype environment so inherited names cannot
select ambient prototype properties and forced-cleanup coverage for a process
that ignores `SIGTERM`. The later independent review rejected zombie-tolerant
process-group confirmation and led to D-046's subreaper and complete reaping
requirements.

#### Slice C review repairs

The detached Node process-group implementation and its zombie-only `/proc`
success rule were rejected. A packaged Linux x64/glibc native helper now owns
the command as a child subreaper, preserves the leader PID until the sole
process-group signal, and uses pidfds for generation-bound forced cleanup of
adopted children. Tests require actual descendant `/proc` disappearance,
setsid escape cleanup, repeated tree reaping, no surviving helper process, and
bounded UTF-8 prefix behavior.

Configuration and execution-host validation now cap timeout at `2147483647`,
each output prefix at 64 MiB, and sensor attempt controls at `10000`. Init now
syncs file content and the parent directory before success. Failures close the
owned descriptor without unlinking the pathname, preserving replacements, and
doctor reports normalized JSON locations and safe filesystem error codes.

Independent native-boundary review approved descriptor containment, subreaper
ownership, leader-preserving group termination, pidfd forced cleanup, complete
reaping, status and exec-error protocols, output draining, packaging, and
durable init. It found two Node listener-order races: a missing supervisor could
emit `error` while the root descriptor was still closing, and cancellation
during asynchronous root setup could be missed. The adapter now latches abort
before its first await, rechecks at every setup boundary, installs child error
and close listeners immediately after `spawn`, and treats post-spawn root-handle
close as non-authoritative because the helper owns its duplicated descriptor.
Deterministic regressions prove an absent helper settles as `spawn-failed`
without an uncaught event and setup-time cancellation returns before root open
or helper spawn.

Final phase-wide stress review found one remaining native startup race: a queued
cancellation could signal the helper before it installed signal handlers. The
helper now emits one `SENAWA1 result=ready` status frame only after subreaper,
signal, cwd, fork, process-group, and exec setup succeeds. Node queues timeout or
cancellation until that frame and accepts exactly one optional ready frame before
the terminal status. A deterministic post-spawn hook aborts in the former race
window across 25 consecutive attempts; every attempt returns a cancelled
measurement and no helper survives.

The readiness review then found that the status parser filtered duplicate,
reordered, blank, unterminated, and over-limit frames instead of rejecting them.
Fd 3 is now an exact framed protocol: setup failure is one newline-terminated
error frame, while a launched command is exactly one ready frame followed by one
newline-terminated command or error frame and EOF. Truncated capture, duplicate
readiness, out-of-order readiness, blank frames, and missing terminal newlines
all fail closed as setup errors. Public adapter tests generate each malformed
stream through a temporary supervisor executable.

#### Review repair validation

Passed on 2026-08-13:

* Frozen workspace install across 9 projects
* Root build with strict native helper compilation through `cc`
* Focused configuration suite: 63 tests
* Focused execution-host suite: 19 tests
* Focused CLI suite, including the built executable: 13 tests
* Workspace typecheck and Biome check across 79 files
* Complete workspace suite: 18 files and 471 tests
* Architecture boundaries across 107 source files
* Documentation links across 17 Markdown files
* Package inspection with the helper present as executable mode `0755`
* `git diff --check`

#### Final independent review and validation

Independent phase-wide review rejected Slice C until all process and bootstrap
guarantees were executable. The final reviewed implementation includes:

* Practical timer, output, attempt, and reconciliation ceilings shared by
  configuration and the execution adapter
* Descriptor-relative `openat2` cwd containment with no pathname check-to-spawn
  gap
* A packaged Linux subreaper that preserves the leader generation, adopts and
  reaps descendants, and uses pidfds for forced cleanup
* Bounded UTF-8 output semantics that omit incomplete trailing sequences
* Durable exclusive init with file and parent-directory sync and no pathname
  unlink on failure
* Safe filesystem and JSON syntax diagnostics from doctor
* Immediate child lifecycle listeners, setup-time abort latching, and a native
  readiness handshake before timeout or cancellation signals
* Exact fd 3 frame cardinality, order, termination, and truncation validation

The final independent review reported no critical, high, medium, or low
findings and approved Phase 6.

Passed on 2026-08-13:

* Frozen workspace install across 9 projects
* Root build and execution-host native build with strict C17 compilation
* Clean workspace typecheck
* Biome check across 79 files
* Complete workspace suite: 18 files and 479 tests
* Focused configuration suite: 63 tests
* Focused execution-host suite: 27 tests
* Focused CLI suite: 13 tests
* Architecture boundaries across 107 source files
* Documentation links across 17 Markdown files
* Execution-host tarball contains the supervisor as executable mode `0755`
* No live `senawa-process-supervisor` after validation
* `git diff --check`

The process-table baseline before broad validation contained 656 pre-existing
zombies and no Senawa supervisor. Subsequent broad-suite snapshots contained
657 and 658 zombies with no Senawa supervisor; each added record was
`[esbuild] <defunct>` reparented to PID 1, not a helper-owned command. No attempt
was made to clean these unrelated zombies. Execution-host tests separately
proved that every recorded descendant path disappeared from `/proc`, five
repeated trees did not grow the test process's direct zombie count, and no
helper child remained.

No commit or push was performed during bounded-slice implementation.

The full suite initially exposed a test-only startup race because a 100 ms
timeout could fire before a grandchild wrote its PID proof under parallel load.
The test now allows one second for tree construction while retaining a separate
500 ms termination grace and the same descendant absence assertions. Independent
phase-wide review followed the bounded implementation and drove the repairs
recorded above.

#### Validation

Passed on 2026-08-13:

* Frozen workspace install across 9 projects after lockfile update
* Focused configuration suite: 62 tests
* Focused execution-host suite: 12 tests
* Focused CLI suite, including the built executable: 8 tests
* Execution-host package declaration typecheck
* Clean workspace build and typecheck
* Biome check across 78 files
* Complete workspace suite: 18 files and 458 tests
* Architecture boundaries across 107 source files
* Documentation links across 17 Markdown files
* Process-table check with no live execution-host helper commands
* `git diff --check`

#### Commit and push

* Implementation commit: `4667ab0 feat: add workflow configuration loading`
* Push: succeeded to `origin/redesign/workflow-state-machine`

## Decision D-047: Derive task context revisions from recursion-free context bases

* Date: 2026-08-13
* Status: Accepted for Phase 7 bounded Slice A
* Phase: 7
* Decision: Compile one exact `senawa.dev/worker-context-base/v1alpha1` record
  from a recursion-free task seed containing only `taskId` and
  `definitionGeneration`, plus graph and configuration digests, selected
  immutable contract references, a dependency barrier, historical asset
  bindings, repository base, model policy reference, role, capabilities, and
  finite budgets. Compute `contextDigest` over that complete versioned content,
  derive `ContextId` from the digest, and use
  `taskGenerationReferenceForContext` to promote the result into the exact
  `TaskGenerationReference.contextRevisionDigest`. Derive historical
  `AssetBindingId` values and dispatch identities from their canonical content.
  Dispatch identity binds repository, run, task generation, context, ordinal,
  worker principal and role, narrowed capabilities, and prompt pack digest.
* Alternatives: Include a `TaskGenerationReference` in context input and create
  a digest cycle; accept a caller-supplied context digest or identity; embed and
  reorder model routes in worker context; let prompt packs or dispatch records
  carry graph mutation or approval authority; allocate context and dispatch
  identities from clocks or random values.
* Rationale: The task seed makes context construction acyclic while preserving
  the established generation reference at every completion boundary. Exact
  canonical recompilation rejects fabricated digests and identities. Referencing
  `orderedRoutesDigest` preserves route precedence without duplicating policy
  content. Capability subset validation prevents assignment from widening the
  immutable context authority.
* Consequence: A changed authority fact creates a new context digest, task
  generation reference, context identity, and dispatch identity. Reusing an
  unchanged context and dispatch ordinal reproduces the same dispatch and worker
  session identity. This slice defines no prompt renderer, lazy asset grant,
  worker submission, protocol, runtime, storage, SDK, or adapter behavior.

## Phase 7 log

### Bounded Slice A: Pure context bases and worker assignment contracts

Added browser-safe, I/O-free kernel contracts for canonical dependency barriers,
worker context bases, and deterministic worker dispatch. Constructors snapshot
unknown input before validation, require exact object shapes, sort set-like
contracts, dependencies, asset bindings, capabilities, and budgets, reject
duplicates and invalid bounds, and recursively freeze accepted records. Model
routes remain ordered behind their policy and routes digests and are not
reordered by the context compiler.

Historical asset bindings preserve semantic asset identity, exact alias binding
digest, content digest, media type, sensitivity, and byte length. Dependency
barriers preserve each exact dependency generation, disposition, assessment
digest, canonical authority fact, and derived authority-fact digest. Dispatches
bind only assigned worker facts and reject capability widening or extra approval
and graph authority fields.

Focused validation passed on 2026-08-13:

* Identity suite: 43 tests
* Context and dispatch suite: 24 tests
* Kernel package typecheck
* Biome check for all touched TypeScript files

Broad validation passed on 2026-08-13:

* Root build, including the execution-host native helper
* Root and kernel package typecheck
* Biome check across 81 files
* Complete workspace suite: 19 files and 507 tests
* Architecture boundaries across 111 source files
* Documentation links across 17 Markdown files
* `git diff --check`

No commit or push was performed for this bounded slice.

## Decision D-048: Admit scoped worker reads and proposal-only submissions

* Date: 2026-08-13
* Status: Accepted for Phase 7 bounded Slice B
* Phase: 7
* Decision: Keep raw context grant tokens only at the client boundary and
  persist their SHA-256 digests with exact dispatch, task generation, context,
  principal, historical asset binding, pointer, read mode, sensitivity,
  issuance, expiration, operation, byte, and chunk bounds. The broker owns an
  injected SHA-256 implementation, trusted clock, and grant-token issuer. It
  requires exactly 32 token bytes, base64url encodes them, and rejects reused
  token digests. Reserve one operation and the worst-case requested bytes
  atomically before asset I/O. Install an exact canonical in-flight request
  before reservation so concurrent replay shares one result and one charge.
  Admit worker output as one of five exact, capability-gated submission
  variants only after recursively refusing issued grant tokens. Preserve stale
  submissions without completion assessment, emit at most one current
  completion fact per dispatch, and store later current completions explicitly
  as duplicates.
* Alternatives: Persist bearer tokens; resolve semantic aliases at read time;
  charge actual response bytes after I/O; let prompt text carry grants or raw
  sensitive content; treat stale completion as current; expose approval,
  closure, allowance, graph mutation, or raw effect commands to workers; route
  completion submissions directly through lifecycle commands.
* Rationale: Digest-only persistence prevents authority snapshots, events,
  errors, and prompts from becoming bearer-token stores. Historical binding
  reads preserve replay semantics when aliases move. Worst-case precharge
  prevents concurrent reads from oversubscribing a grant. Proposal-only
  submissions preserve agent observations while keeping lifecycle authority in
  the kernel and runtime command paths. Prompt rendering excludes the derived
  dispatch identity, so prompt-pack and dispatch digest derivation remains
  acyclic.
* Consequence: A denied read never charges bytes, although a pointer or digest
  denial discovered after I/O consumes the precharged operation. In-memory
  authority retains served bytes for exact replay and omits them from canonical
  snapshots. Production composition must inject a grant-token issuer backed by
  cryptographic entropy. The broker enforces exact token length and digest
  uniqueness but does not create entropy. A later durable adapter must preserve
  the same atomic reservation, exact canonical request replay, receipt, secret
  refusal, and immutable historical-binding semantics. SQLite, SDK, and live
  worker adapters remain outside this bounded slice.

### Bounded Slice B: Scoped context broker and serial worker simulation

Added browser-safe protocol contracts and exact codecs for context grants,
pointer and chunk reads, durable audit receipts, and completion, question,
asset, discovery, and amendment-proposal submissions. The codecs share the
canonical protocol snapshot boundary and reject unknown fields, accessors,
sparse arrays, malformed identities, pointers, timestamps, digests, and bounded
payload violations.

Added a Node-free runtime context broker with an injected historical asset port,
in-memory authority, deterministic bounded prompt renderer, completion-fact
port, and serial simulated worker. The authority stores canonical contexts and
dispatches, digest-only grants, read attempts and receipts, immutable accepted
and stale submissions, questions, events, and a projection. Reads enforce exact
scope, sensitivity, expiration, mode, pointer, range, chunk, digest, operation,
and byte constraints. Worker submission admission binds exact dispatch, task,
context, and principal facts and never grants graph, approval, closure,
allowance, or effect authority.

Shared testing conformance provides deterministic token allocation, historical
asset bytes, prompt fixtures, completion-fact capture, and serial worker
journeys. Focused validation passed on 2026-08-13:

* Worker protocol codec suite: 5 tests
* In-memory context broker conformance suite: 8 tests
* Protocol, runtime, and testing package typechecks
* Biome check for all Slice B TypeScript files

Broad validation passed on 2026-08-13:

* Root build, including the execution-host native helper
* Root workspace typecheck
* Biome check across 89 files
* Complete workspace suite: 21 files and 520 tests
* Architecture boundaries across 127 source files
* Documentation links across 17 Markdown files
* `git diff --check`

No SQLite schema, SDK integration, live adapter, or `FencedRunner` change was
made in this bounded slice. No commit or push was performed, as requested.

### Bounded Slice B review repairs

Moved hashing, time, and token issuance behind immutable broker dependencies.
Grant envelopes and authority records now retain trusted `issuedAt` facts, and
worker read and submission APIs no longer accept caller-supplied time or hash
implementations. Deterministic tests inject a controllable clock and a unique
32-byte issuer. The runtime remains browser-safe and I/O-free; production
cryptographic entropy remains an issuer-port obligation.

Added canonical recursive refusal for every worker submission variant. Every
43-character base64url candidate is hashed and compared with issued grant
digests before persistence or completion-fact forwarding. Prompt-rendering and
grant-persistence inputs receive the same refusal when a previously issued
token could cross those boundaries. Errors, events, snapshots, and completion
facts do not contain refused token material.

Read identities now retain exact canonical requests and one in-flight promise
or completed result. Exact concurrent replay performs one asset read and one
charge. Changed requests receive conflict receipts attributed to a resolvable
grant, and distinct concurrent identities reserve budgets synchronously before
I/O. Internal asset failures settle and retain deterministic denials.

Completion authority now records one terminal current completion per dispatch.
Later current completion identities are stored as `duplicate` without another
completion fact, stale completions remain `stale`, and exact identity replay
remains replayed. The simulated serial adapter reports `completed` or `blocked`
only from an accepted admission carrying a completion fact.

Focused review validation passed on 2026-08-13:

* Worker protocol codec suite: 5 tests
* In-memory context broker conformance suite: 11 tests
* Protocol, runtime, and testing package builds

Broad review validation passed on 2026-08-13:

* Root build, including the execution-host native helper
* Root workspace typecheck
* Biome check across 89 files
* Complete workspace suite: 21 files and 523 tests
* Architecture boundaries across 127 source files
* Documentation links across 17 Markdown files
* `git diff --check`

No commit or push was performed for the review repairs, as requested.

## Decision D-049: Serialize durable context admission through SQLite

* Date: 2026-08-13
* Status: Accepted for Phase 7 bounded Slice C
* Phase: 7
* Decision: Persist a complete secret-free context authority image and
  normalized context records in schema version 3. Execute each broker mutation
  under `BEGIN IMMEDIATE` by hydrating the runtime authority, applying the
  existing runtime admission policy, mirroring the resulting canonical state,
  and committing before acknowledgement. Keep read reservations, bounded asset
  I/O, receipts, usage counters, events, and replay bytes in one transaction.
  Bind each secret-free canonical replay key to an admission-time SHA-256
  digest and retain exact token-digest receipt-attempt metadata separately from
  the public receipt. Derive expected receipt charges and remaining budgets
  during verification from ordered replay semantics and verified asset bytes,
  rather than treating persisted charge fields as accounting authority. Retain
  a digest-bound read-failure stage only for live `digest-mismatch` outcomes so
  verification can distinguish historical transient I/O or integrity failures
  from deterministic outcomes reconstructed from repaired assets.
  Store historical assets as verified 64 KiB chunks, read only overlapping
  chunks for range requests, and limit pointer-capable JSON assets to 1 MiB.
  Deliver completion facts after submission commit and acknowledge the outbox
  in a second transaction.
* Alternatives: Reimplement grant and submission policy in SQL; persist raw
  grant tokens; retain whole-asset reads in the runtime port; reserve usage in
  one transaction and settle results in another; deliver completion facts
  before durable submission commit; store context state in command or runner
  snapshots.
* Rationale: Transactional hydration preserves one semantic contract and keeps
  policy in runtime while SQLite owns compare, reserve, commit, replay, and
  recovery atomicity. `BEGIN IMMEDIATE` serializes independent processes before
  request identity and budget comparison. Chunk manifests make range I/O
  proportional to the request, and the JSON ceiling bounds the only operation
  that requires a complete parse. The transactional outbox preserves accepted
  completion authority across delivery loss without requiring an exactly-once
  external call. Independent replay-key digests detect accidental or partial
  semantic divergence without retaining a bearer token. They are unkeyed
  integrity checks, not protection against an attacker who can rewrite every
  canonical record, normalized row, and digest coherently.
* Consequence: Exact reads replay identical bytes and receipts without another
  charge after reopen or lost acknowledgement. A crash before read commit rolls
  back the reservation and result together; a crash after commit replays the
  durable result. Completion delivery is at least once and requires the
  completion-fact consumer to be idempotent by submission identity. Context
  tables and chunks participate in database integrity, backup, and restore,
  while command and runner snapshots remain unchanged. Every served, denied,
  and conflicting read remains attributable to the exact presented token digest
  and secret-free replay identity. Startup, backup, and restore recompute
  operation and byte accounting from those facts. A `digest-mismatch` receipt is
  valid only with independently recorded `asset-read` or `asset-integrity`
  provenance bound to its receipt cursor, replay-key digest, request digest, and
  token digest. No SDK or live worker adapter is introduced.

### Bounded Slice C: Durable SQLite context broker

Added checksummed migration `003-context-broker.sql` and advanced the supported
schema version to 3. The migration adds exact context, dispatch, historical
asset binding, chunk manifest, grant digest, read attempt, receipt, event,
projection, submission, question, terminal completion, and completion outbox
tables with run-scoped indexes and foreign keys. Existing command authority,
runner authority, lease, revision, and filesystem CAS records are unchanged.

Refactored the runtime asset port to bounded range reads and bounded JSON reads.
The in-memory and SQLite adapters now run the same factory-driven conformance
suite. Durable authority images include dispatch completion requirements,
digest-only grants, completed read results, submissions, terminal claims,
outbox state, questions, events, and counters. Public snapshots continue to
omit served bytes and grant authority.

The SQLite composition verifies complete content before dedicated context asset
insertion, stores fixed 64 KiB chunks with per-chunk digests, verifies chunks on
startup and backup or restore integrity checks, and queries only overlapping
chunks for ranges. Pointer reads refuse assets above the 1 MiB parse ceiling.
Fault injection covers reservation, precommit, postcommit acknowledgement, and
outbox acknowledgement boundaries.

Focused validation passed on 2026-08-13:

* In-memory context broker conformance suite: 12 tests
* SQLite context broker conformance and durability suite: 22 tests
* Runtime, testing, and storage SQLite package typechecks
* Independent worker connections returned one exact result with one charge
* Reopen, raw-token scan, conflict, exhaustion, outbox, corruption, backup,
  restore, and command and runner isolation probes

Broad validation passed on 2026-08-13:

* Root build, including the execution-host native helper
* Root workspace typecheck
* Biome check across 89 files
* Complete workspace suite: 21 files and 546 tests
* Architecture boundaries across 127 source files
* Documentation links across 17 Markdown files
* SQLite authority refusal benchmark: p99 9.28 ms against a 25 ms limit
* `git diff --check`

No commit or push was performed for this bounded slice, as requested.

### Bounded Slice C review repairs

Replaced cast-based context authority hydration with exact canonical decoding.
Hydration now recompiles contexts and dispatches with the injected SHA-256
implementation, validates completion requirements and persisted protocol
records, rejects bearer fields and issued-token candidates, and checks unique
identities, usage bounds, replay receipts, submissions, completion claims,
questions, outbox facts, event sequence, and cursor consistency. Protocol now
provides an exact decoder for secret-free persisted grant envelopes.

Added one deterministic normalized context projection shared by SQLite writes
and verification. Startup, backup, and restore compare exact row counts and all
canonical and scalar fields for context bases, dispatches, asset bindings,
grants, read attempts, receipts, events, projection, submissions, questions,
terminal completions, and completion outbox records. Schema version 3 now seeds
the exact empty context projection.

Expanded context asset verification from individual chunk checks to complete
manifest validation. Each manifest must match its binding, use 64 KiB chunks,
declare the exact chunk count, contain contiguous indexes and offsets with exact
final-chunk sizing, reproduce every chunk digest, and reproduce the aggregate
content digest and byte length. Range reads repeat manifest and selected-chunk
geometry checks, and complete reads verify the full content digest.

Serialized same-instance asynchronous SQLite reads through a releasing promise
queue. Exact concurrent calls now share the first durable result after its
transaction commits, with one charge and one asset read. Completion outbox
delivery now tracks instance-local in-flight submission identities and refuses
reentrant delivery while retaining the durable at-least-once contract.

Regression coverage now includes canonical grant bearer, budget, and scope
corruption; normalized grant-row divergence; coordinated chunk content and
chunk-digest corruption; chunk offset and manifest count corruption;
same-instance exact concurrent reads; and completion outbox reentry.

Focused review validation passed on 2026-08-13:

* Runtime hydration and complete SQLite context suites: 30 tests
* Complete SQLite storage suite: 79 tests
* Protocol, runtime, and SQLite package builds
* SQLite package typecheck

Broad review validation passed on 2026-08-13:

* Root build, including the execution-host native helper
* Root workspace typecheck
* Biome check across 89 files
* Complete workspace suite: 21 files and 554 tests
* Architecture boundaries across 127 source files
* Documentation links across 17 Markdown files
* SQLite authority refusal benchmark: p99 8.51 ms against a 25 ms limit
* `git diff --check`

No SDK work, commit, push, or subagent review was performed, as requested.

#### Final Slice C durable invariant repairs

Extended D-049 verification across the runtime authority image, normalized
SQLite rows, and verified historical asset chunks. Runtime now exports an exact
browser-safe `PersistedAssetReadReplayKey` decoder. It accepts only the canonical
secret-free pointer or chunk request shape, requires canonical string equality,
and rejects bearer fields. The runtime broker and SQLite verifier also use one
exported pure JSON Pointer evaluator, so durable pointer replay cannot diverge
from live admission semantics.

After authority hydration, normalized-row comparison, and complete manifest and
chunk verification, SQLite recomputes every served response. Chunk reads select
the exact historical range. Pointer reads reconstruct the bounded complete JSON
asset, apply the runtime pointer byte ceiling and request limit, and compare the
canonical response byte for byte with both canonical and normalized durable
results. Startup, backup, and restore therefore reject coordinated result
corruption that preserves row equality.

SQLite also replays completed read receipts in `receipt_cursor` order. Exact
stored-result receipts charge their resolved grant by the codec-authorized
operation and byte amounts. Conflict receipts remain distinct audit records,
charge zero, and must preserve an attributable grant's budget at that cursor.
Unknown-token receipts remain unattributed with zero remaining budget. Every
receipt remaining budget must equal its grant maxima minus cumulative usage,
and the final cumulative operations and bytes must equal the durable grant
counters.

Focused validation passed on 2026-08-13:

* Strict replay-key and coordinated corruption selection: 5 tests
* Complete in-memory context and SQLite storage suites: 97 tests

Broad validation passed on 2026-08-13:

* Root build, including the execution-host native helper
* Root workspace typecheck
* Biome check across 89 files
* Complete workspace suite: 21 files and 559 tests
* Architecture boundaries across 127 source files
* SQLite authority refusal benchmark: p99 9.41 ms against a 25 ms limit

No subagent, commit, or push was used for these final repairs, as requested.

#### Final Slice C replay identity and accounting repairs

Added an admission-time `replayKeyDigest` over the canonical UTF-8 secret-free
replay key. Durable reads now retain that digest and their exact token digest,
and hydration checks both against the canonical replay key. Migration 003 and
the normalized read-attempt projection persist the same independent identity.

Added a durable receipt-attempt ledger for every served, denied, and conflicting
read. Each entry binds its cursor and public receipt to the exact canonical
replay key, replay-key digest, token digest, bearer-bearing request audit digest,
and reservation fact. The public authority snapshot and protocol receipt remain
unchanged and no grant token is persisted.

SQLite verification now replays attempts in receipt order, resolves only the
exact token-digest grant, evaluates live admission stages, reconstructs served
bytes or missing JSON Pointer targets from verified historical content, and
derives operation charges, byte charges, response sizes, remaining budgets, and
final grant counters independently from receipt charge fields. Runtime and
verification share the pure worst-case byte-charge helper.

Focused regression validation passed on 2026-08-13:

* Coordinated served byte overcharge rejection on startup and backup
* Coordinated post-reservation invalid-pointer undercharge rejection
* Canonical and normalized replay-key mutation with a stale digest rejection
* Equivalent-grant conflict reattribution rejection by exact token digest
* Complete in-memory context and SQLite storage suites: 101 tests

Broad validation passed on 2026-08-13:

* Root build, including the execution-host native helper
* Root workspace typecheck
* Biome check across 89 files
* Complete workspace suite: 21 files and 563 tests
* Architecture boundaries across 127 source files
* Documentation links across 17 Markdown files
* SQLite authority refusal benchmark: p99 21.88 ms against a 25 ms limit
* `git diff --check`

No subagent, commit, or push was used for these repairs, as requested.

#### RI-4 independent digest-mismatch provenance

Durable receipt attempts now retain optional `failureStage` and
`failureFactDigest` facts that are absent from public receipts. The only valid
stages are `asset-read` and `asset-integrity`. Live admission records them at
the failure boundary, and exact hydration requires both fields if and only if
the receipt denial is `digest-mismatch`. The fact digest binds the stage to the
receipt cursor, replay-key digest, request digest, and exact token digest.

SQLite migration 003 stores the same facts in nullable normalized receipt
columns with pair and enum constraints. Verification derives request
permission and the current verified-asset outcome before considering the
historical denial. A valid chunk range therefore reconstructs served bytes,
and an allowed pointer is evaluated with the shared runtime JSON Pointer
evaluator. A missing target derives post-reservation `invalid-pointer`. A
historical `digest-mismatch` overrides that reconstructed outcome only when its
validated live failure provenance is present.

Focused validation passed on 2026-08-13:

* Coordinated canonical and normalized `invalid-pointer` to `digest-mismatch`
  relabeling was rejected by startup, backup, and restore verification
* A genuine transient asset-integrity failure reopened with one charged
  operation after the asset became readable
* Coordinated failure-stage mutation with a stale fact digest was rejected by
  startup and backup verification
* Complete context broker and SQLite storage suites: 103 tests

Broad validation passed on 2026-08-13:

* Root build, including the execution-host native helper
* Root workspace typecheck
* Biome check across 89 files
* Complete workspace suite: 21 files and 565 tests
* Architecture boundaries across 127 source files
* Documentation links across 17 Markdown files
* SQLite authority refusal benchmark: p99 16.57 ms against a 25 ms limit
* `git diff --check`

No subagent, commit, or push was used for RI-4, as requested.

The provenance digest detects accidental, partial, and reviewer-probe
coordination. Consistent with D-049's existing integrity model, it does not
authenticate records against an attacker who can coherently rewrite all
canonical data, normalized facts, and unkeyed digests.

## Decision D-050: Bind live Copilot sessions to validated worker routes

* Date: 2026-08-13
* Status: Accepted for Phase 7 bounded Slice D
* Phase: 7
* Decision: Compile and exactly revalidate one deterministic
  `senawa.dev/worker-model-route-selection/v1alpha1` value in the kernel. Bind
  it to the exact dispatch, context, model policy, ordered route index,
  provider, model, `maxTurns`, `maxSubmissions`, and `maxMillidollars`. Retain a
  separate trusted positive `maxAiCredits` ceiling for the Copilot SDK and
  compute a selection digest over all fields. Do not convert currency units to
  AI credits. Use the dispatch identity as the Copilot session identity. Attempt
  `resumeSession` with pending work disabled, create the exact session only when
  metadata confirms that identity is absent, and leave the external Copilot
  session store as an operational dependency. Keep SDK declarations behind an
  execution-host port. Run sessions in SDK `empty` mode with verified isolated
  working and base directories, explicit tool filtering, disabled ambient
  discovery and persistence features, generic permission refusal, and an
  independent pre-tool allowlist. Expose only six capability-filtered custom
  tools whose handlers derive authority fields and deterministic identities,
  inject grant tokens from closure-local maps, and call the context broker.
* Alternatives: Convert `maxMillidollars` into SDK AI credits; let the model
  choose an automatic provider or model; create a second checkpoint database;
  use a random SDK session identity; expose SDK types through runtime or kernel;
  inherit repository tools, instructions, skills, MCP servers, or permissions;
  accept model-supplied dispatch identities or bearer tokens; infer completion
  from assistant text.
* Rationale: Independent units avoid a fabricated exchange rate. Exact route
  selection recompilation makes policy choice and SDK credit authority
  reviewable without adding effects to the kernel. Dispatch-scoped SDK sessions
  preserve unchanged-context resume and changed-context fencing. A narrow port
  makes the authority adapter testable offline, while closed schemas, derived
  identities, broker admission, permission refusal, and tool allowlisting keep
  model output proposal-only.
* Consequence: Copilot SDK 1.0.9 supports `maxAiCredits` but has no `maxTurns`
  session option. Senawa retains exact turn, submission, and millidollar policy
  facts; the adapter enforces the submission ceiling and does not claim SDK turn
  enforcement. SDK session files are not duplicated in SQLite. Phase 8 must
  define backup, retention, restore, and operational checks for the external
  SDK session store. A shared started client is accepted only with explicit
  trusted acknowledgement that its owner configured SDK empty mode, and its
  external owner remains responsible for stopping it.

### Bounded Slice D: Live Copilot SDK worker adapter

Pinned `@github/copilot-sdk` exactly at 1.0.9 in execution-host. The installed
SDK resolves `@github/copilot` and the platform CLI at 1.0.78, koffi at 3.1.4,
and one transitive zod at 4.4.3. No direct zod dependency was added because raw
JSON schemas are supported. The Linux x64 CLI package and koffi platform
prebuild are present. pnpm reports the koffi install script as suppressed, but
direct loading of the installed transitive package successfully resolves its
optional prebuilt native module.

Added the pure worker model route selection contract and exact tamper-resistant
recompilation. Its selection digest binds context and dispatch identity, the
complete model policy reference, ordered route index, provider and model, the
three Senawa policy ceilings, and the independent SDK AI-credit ceiling.

Added an internal SDK-neutral execution-host port, a production SDK 1.0.9
wrapper, and a serial Copilot worker adapter. The production wrapper verifies
real working and base directories outside the repository before constructing a
client in empty mode. Session options disable tool search, infinite sessions,
large-output files, streaming, MCP, extensions, canvases, config discovery,
custom instructions, instruction discovery, file hooks, host Git operations,
the cross-session store, skills, memory, remote sessions, and additional
directories. Available tools contain only the selected custom names, while
built-in and MCP tools are excluded. Every permission request is rejected, and
the pre-tool hook independently denies unknown tools.

The adapter validates context, dispatch, route selection, prompt bytes and
digest, isolated paths, and grant-map bindings before contacting the SDK. It
attempts dispatch-ID resume with `continuePendingWork: false`, creates the exact
dispatch-ID session only when absent, runs one active dispatch, bounds send time,
aborts timeout or cancellation, always disconnects, and never stops a shared
client. Completion, blocked, stale, duplicate, missing, aborted, and crashed
results derive from broker admission and sanitized lifecycle facts. Assistant
text cannot complete work.

Added six closed, protocol-bounded JSON-schema tools for granted historical
asset reads and question, asset, discovery, amendment, and completion proposals.
Model arguments omit repository, run, dispatch, context, principal, task,
request, and submission identities and all tokens. Handlers derive request and
submission identities from dispatch and SDK tool-call facts through injected
SHA-256, inject trusted bindings and current authority callbacks, and return
bounded JSON with base64 asset data or generic refusal codes. Grant tokens
remain only in closure-local maps and broker requests.

Added an explicit live probe gated by `SENAWA_COPILOT_LIVE=1`, model, positive
AI-credit ceiling, timeout, and `SENAWA_COPILOT_ACKNOWLEDGE_COST_AND_DATA=1`.
It uses isolated temporary directories, no asset grants or sensitive content,
one completion-only dispatch, one turn policy fact, and one submission. Failures
are sanitized. The live probe was not opted into or run against the service in
this slice; its default skip behavior passed.

Focused validation passed on 2026-08-13:

* Kernel context and route selection suite: 44 tests
* Offline Copilot adapter suite: 17 tests
* Production wrapper no-start smoke suite: 2 tests
* Default live probe: 1 skipped test
* Kernel and execution-host package typechecks
* Biome check for all Slice D TypeScript, JSON, and boundary files
* Built execution-host import without starting Copilot
* Exact transitive koffi native prebuild import
* Frozen lockfile install
* Execution-host package build and native supervisor build
* Execution-host tarball contained runtime JavaScript, declarations, maps,
  executable native supervisor, and exact dependency metadata; compiled tests
  and the live probe were excluded

Broad validation passed on 2026-08-13:

* Root build, including the execution-host native helper
* Root workspace typecheck
* Biome check across 95 files
* Complete workspace suite: 23 files and 604 tests, with 1 live test skipped
* Architecture boundaries across 139 source files
* Documentation links across 17 Markdown files
* `git diff --check`

No live service call, subagent, commit, or push was performed, as requested.
Final Phase 7 independent review followed the bounded implementation.

### Slice D review repairs

Independent review rejected the SDK adapter until its confinement remained
true across cancellation and delayed tool execution. The final repairs:

* Require the exact `github-copilot` provider before any SDK call; a validated
  route for another provider is refused rather than silently executed by
  Copilot.
* Bind both the pre-tool hook and every handler invocation to the exact dispatch
  session and registered tool name.
* Close a run-scoped tool fence synchronously at timeout or abort, before
  awaiting SDK cancellation. Calls received while abort is pending or after the
  run returns are refused without broker mutation.
* Track every started handler and retain the serial guard until all handlers
  settle. A permanently pending broker operation therefore fails closed and can
  retain the adapter; Phase 8 must provide cancellation-aware broker operations
  or process-level recovery rather than release authority early.
* Give cancellation precedence over a completion racing with the same run.
* Reject SDK state directories equal to, beneath, or containing the repository.
* Require `maxAiCredits` to round to at least one safe nano-credit.

Adversarial tests cover a captured completion after return, completion while
SDK abort is gated, a delayed read holding the serial guard, wrong session and
tool identities, unsupported providers, ancestor directories, and sub-nano
credit ceilings.

### Final Phase 7 review and validation

The final independent review reported no critical, high, medium, or low
findings and approved Phase 7. It also confirmed the approved Slices A-C
remained intact: immutable context authority, proposal-only protocol and broker
admission, historical scoped reads, exact durable replay and accounting, stale
completion preservation, and serialized SQLite authority.

Passed on 2026-08-13:

* Frozen workspace install across 9 projects
* Root build, including the execution-host native helper
* Clean workspace typecheck
* Biome check across 95 files
* Complete offline workspace suite: 23 files and 611 tests
* Live Copilot service probe: 1 test skipped because explicit model, budget,
  timeout, data/cost acknowledgement, and `SENAWA_COPILOT_LIVE=1` were not set
* Focused final kernel and SDK confinement suites: 70 tests
* Architecture boundaries across 139 source files
* Documentation links across 17 Markdown files
* SQLite command-authority benchmark: p99 15.86 ms across 100 samples, below the
  25 ms threshold
* Execution-host package contains runtime SDK adapter output and executable
  native supervisor while excluding tests and the live probe
* `git diff --check`

### Remaining risks

* Phase 8 must own SDK session-store backup, retention, restore, and health
  checks; those files are an explicit external operational dependency.
* Production completion-fact consumers must remain idempotent by exact
  submission identity for at-least-once outbox delivery.
* The live adapter probe still requires an explicit separately authorized run;
  no paid service call was made in Phase 7.

### Commit and push

* Implementation commit: `4009bd8 feat: add scoped worker context`
* Push: succeeded to `origin/redesign/workflow-state-machine`

## Decision D-051: Stage supervisor orchestration beside command authority

* Date: 2026-08-13
* Status: Accepted for Phase 8 bounded Slice A
* Phase: Phase 8
* Decision: Add a durable SQLite supervisor queue and wake layer while retaining
  `SqliteAuthority.submit` and its canonical terminal transaction as the sole
  workflow mutation authority. The supervisor stores the exact attributed
  command envelope and deterministic admission facts, claims under the shared
  lease table, executes outside its queue transaction, and records the exact
  command receipt in a separate terminal acknowledgement transaction.
* Alternatives: Move command execution into a new supervisor transaction;
  treat in-memory scheduling as authoritative; or duplicate workflow mutation
  state in supervisor tables.
* Rationale: Retrying the same canonical command after a crash between command
  commit and queue acknowledgement returns the existing durable receipt. This
  closes the supervisor crash window without split workflow authority or a
  transaction held across execution.
* Consequence: Supervisor recovery requires the stored ordered allocation facts
  and a live run lease fence. Supervisor persistence DTOs use exact browser-safe
  protocol codecs, while storage owns relational semantic verification without
  importing the concrete supervisor adapter. Supervisor time predicates use
  normalized epoch-millisecond columns; canonical timestamp strings remain in
  receipts and records. A strictly higher live lease fence or natural claim
  expiry can reclaim staged work without appending a second claimed receipt.
  HTTP, SSE, IPC, CLI, SDK backup, and daemon lifecycle integration remain later
  Phase 8 slices.

## Phase 8 log

Status: In progress. Bounded Slice A implements the durable local supervisor
authority only.

### Bounded Slice A: Durable supervisor command queue

The slice adds:

* A behavior-free `CommandSubmission` protocol codec that excludes principal
  and transport attribution and rejects attempts to inject either field
* A Node-local supervisor package with authenticated admission, exact canonical
  admission replay, staged queued, claimed, and terminal receipts, one-command
  deterministic draining, query APIs, wake scans, and foreground recovery
* SQLite migration 004 with supervisor repository and run scope, command and
  receipt history, durable generation wakes, and service desired mode
* Shared lease renewal and guarded release while preserving monotonically
  increasing takeover fences
* Durable running, draining, drained, and stopped modes; draining continues to
  accept and queue commands but claims no new work

The existing runtime command service and normalized SQLite command-authority
snapshot are unchanged. `SqliteSupervisorAuthority` uses one connection for
queue transactions and composes `SqliteAuthority` on a separate connection to
the same database. No queue transaction remains open across command execution.

### Slice A focused validation

Passed on 2026-08-13:

* Supervisor package typecheck
* Exact protocol submission and SQLite supervisor suites: 2 files and 41 tests
* Recovery at queued commit, claimed commit, command submit, before terminal
  commit, and after terminal commit fault points
* Exact uninterrupted and recovered command receipt, event stream, projection,
  canonical authority JSON, and queue terminal receipt comparisons
* Lost response replay, conflict nonmutation, startup wake scan, duplicate scan,
  wake acknowledgement race, draining behavior, lease renewal, guarded release,
  live-owner exclusion, takeover, and stale-fence refusal

Repository-wide validation passed on 2026-08-13:

* Frozen workspace install across 10 projects
* Root build, including the execution-host native helper
* Clean workspace and supervisor package typechecks
* Biome check across 102 files
* Complete offline workspace suite: 24 files and 623 tests
* Live Copilot service probe: 1 test skipped because explicit model, budget,
  timeout, data/cost acknowledgement, and `SENAWA_COPILOT_LIVE=1` were not set
* Architecture boundaries across 149 source files
* Documentation links across 17 Markdown files
* SQLite command-authority benchmark: p99 13.52 ms across 100 samples, below the
  25 ms threshold
* `git diff --check`

No HTTP, SSE, local IPC, portal security, CLI, SDK session backup, daemon, commit,
or push is included in bounded Slice A.

### Slice A review repairs

Review repairs RI1 through RI3 add:

* Exact protocol codecs for supervisor admission facts, staged receipts, wakes,
  and service records, including exact unknown-field refusal and durable receipt
  decoding
* Storage-owned global supervisor verification for canonical command and
  admission fields, run identities, contiguous command and receipt cursors,
  legal staged histories, claim fields, exact underlying terminal receipts,
  wakes, service singleton state, and normalized timestamp columns
* Startup, backup, and restore refusal for canonical-but-semantically-invalid
  supervisor data
* Guarded higher-fence claim takeover before the former claim expiry, with
  same-or-lower fence exclusion and one claimed staged receipt
* Integer epoch-millisecond authority for acceptance ordering, claim expiry,
  wake scheduling, and service mode monotonicity; shared lease comparisons
  continue to use validated `Date.parse` values in JavaScript

Review repairs RI4 and RI5 add:

* Guarded lease release under `BEGIN IMMEDIATE` with an exact row read, parsed
  epoch liveness validation, and an exact resource, owner, fence, and expiry CAS;
  release at exact expiry is stale, while an earlier mixed-precision release
  permits immediate takeover at a higher fence
* Exact queued and terminal staged receipt times against their command acceptance
  timestamp and normalized epoch column; claimed receipt time remains canonical
  and normalized because the command row does not persist a claim timestamp

Focused review regression validation passed on 2026-08-13:

* Exact protocol and supervisor suites: 2 files and 52 tests
* Mixed-precision acceptance, wake, and service mode timestamp cases
* Immediate higher-fence and natural-expiry command reclaim
* Stale-fence refusal and single claimed history preservation
* Canonical receipt corruption refusal during live backup, startup, and
  manifest-valid restore
* Command epoch, wake generation, command state/history, and service epoch
  semantic corruption refusal on startup
* Mixed-precision guarded release at a whole-second timestamp, immediate fence 2
  reclaim, and stale or exact-expiry release refusal
* Coordinated queued receipt canonical and normalized timestamp corruption
  refusal during live backup, startup, and manifest-valid restore
* Exact protocol, supervisor, and SQLite storage suites: 3 files and 142 tests

RI4 and RI5 repository-wide validation on 2026-08-13:

* Root build and clean workspace typecheck passed
* Complete offline workspace suite passed: 24 files and 636 tests; the live
  Copilot service test remained skipped without its explicit opt-in settings
* Architecture boundaries passed across 151 source files
* Documentation links passed across 17 Markdown files
* Changed TypeScript files passed Biome, and `git diff --check` passed
* SQLite command-authority benchmark passed on immediate rerun at p99 19.06 ms
  across 100 samples, below the 25 ms threshold; the first run recorded a
  transient p99 106.96 ms while p95 remained 18.25 ms
* Full-workspace Biome remained blocked by pre-existing formatting in
  `packages/supervisor/tsconfig.json` and `tsconfig.json`; RI4 and RI5 did not
  modify those files

Repository-wide review repair validation passed on 2026-08-13:

* Root build, including the execution-host native helper
* Clean workspace typecheck
* Biome check across 103 files
* Complete offline workspace suite: 24 files and 634 tests
* Live Copilot service probe: 1 test skipped because explicit model, budget,
  timeout, data/cost acknowledgement, and `SENAWA_COPILOT_LIVE=1` were not set
* Architecture boundaries across 151 source files
* Documentation links across 17 Markdown files
* SQLite command-authority benchmark: p99 19.93 ms across 100 samples, below the
  25 ms threshold
* `git diff --check`

## Decision D-052: Bound supervisor queries before adding listeners

* Date: 2026-08-13
* Status: Accepted for Phase 8 bounded Slice B
* Phase: Phase 8
* Decision: Add behavior-free receipt and event page contracts, bounded runtime
  query ports, normalized SQLite page reads, and a transport-neutral supervisor
  API before implementing HTTP, IPC, or SSE listeners. Authenticated ingress
  context owns principal, transport, request identity, time, facts, and ordered
  allocation facts. Client submissions remain attribution-free.
* Alternatives: Let each listener construct command envelopes and queries;
  return unbounded histories; expose staged supervisor receipts as protocol
  durable receipts; or load the canonical authority snapshot for every page.
* Rationale: One exact API and one transport conformance suite keep attribution,
  retry, conflict, error, and paging behavior independent of framing. SQLite
  `LIMIT + 1` reads preserve bounded memory while retaining normalized tables as
  query indexes and the canonical authority as workflow mutation truth.
* Consequence: Command submission returns an exact local
  `SupervisorCommandAcceptance` containing the latest staged receipt and its
  command location. Durable receipt and event pages contain at most 1,024 items,
  reject identity or cursor ambiguity, and remain sparse-cursor safe. The event
  page `latestCursor` is the workflow/run authority cursor, not the latest
  available event cursor, so a terminal page can be empty while
  `afterCursor < latestCursor`. Command envelope identity is resolved before
  trusted admission allocation, and exact durable replay returns without fresh
  allocation facts. Draining accepts and wakes new commands without claiming
  them; drained and stopped modes return a typed service-unavailable error.
  Future HTTP, IPC, CLI, and SSE adapters must run the shared transport
  conformance suite.

### Bounded Slice B: Transport-neutral supervisor API and bounded queries

The slice adds:

* Exact `ReceiptPage` and `EventReplayPage` protocol codecs with canonical,
  frozen outputs and bounded cursor validation
* `RuntimeQueryPort` receipt and event page methods with retained legacy query
  methods
* In-memory slicing and SQLite normalized-table paging with `LIMIT + 1`, direct
  terminal receipt lookup, latest run cursor, earliest event cursor, and fresh
  visibility across independent connections
* Server-derived authenticated ingress context and an exact transport-neutral
  `SupervisorApi` for capabilities, submission, receipt lookup, bounded pages,
  and projection lookup
* Typed safe API errors and a reusable supervisor transport conformance
  registrar exercised through an in-process serialized client/handler boundary

No production dependency was added. The conformance registrar remains in the
supervisor test surface, avoiding a production dependency cycle through
`@senawa/testing`.

### Slice B focused validation

Passed on 2026-08-13:

* Exact protocol codec suite: 1 file and 36 tests
* Runtime conformance suite: 1 file and 15 tests
* SQLite storage suite: 1 file and 88 tests
* In-process supervisor transport conformance: 1 file and 6 tests
* Protocol, runtime, storage, and supervisor package typechecks

Repository-wide validation passed on 2026-08-13:

* Root build, including the execution-host native helper
* Clean workspace typecheck
* Biome check across 105 files
* Complete offline workspace suite: 25 files and 645 tests
* Live Copilot service probe: 1 test skipped because its explicit model, budget,
  timeout, data/cost acknowledgement, and `SENAWA_COPILOT_LIVE=1` settings were
  not provided
* Architecture boundaries across 155 source files
* Documentation links across 17 Markdown files
* SQLite command-authority benchmark: p99 15.96 ms across 100 samples, below the
  25 ms threshold
* `git diff --check`

### Slice B review repairs

The Slice B review found that SQLite page metadata and rows could observe
different commits, protocol pages admitted cursor states that the query contract
cannot represent, and transport conformance did not prove drained admission
nonmutation.

The repairs add:

* Deferred SQLite read transactions around receipt and event metadata plus row
  reads, with nested savepoint behavior when a page query runs inside an existing
  same-connection transaction
* Deterministic storage fault checkpoints that commit through an independent WAL
  connection after metadata is read; the current page retains its original
  snapshot and the next page observes the committed receipt and event rows
* Receipt and event refusal when `afterCursor` exceeds `latestCursor`, event
  replay-gap refusal before `earliestAvailableCursor - 1`, sparse terminal empty
  event pages, and nonempty `hasMore` pages
* Matching in-memory and SQLite query-boundary refusal for cursor positions that
  cannot produce a valid page
* Drained and stopped transport assertions for typed service unavailability,
  unchanged pending wakes, and absence of a durable command row

Focused review validation passed on 2026-08-13:

* Protocol, runtime, SQLite storage, and supervisor transport suites: 4 files
  and 148 tests
* Receipt and event snapshot interleaves, nested same-connection page reads,
  direct protocol invariant cases, and drained or stopped queue nonmutation

Repository-wide review repair validation passed on 2026-08-13:

* Root build, including the execution-host native helper
* Clean workspace typecheck
* Biome check across 105 files
* Complete offline workspace suite: 25 files and 648 tests
* Live Copilot service probe: 1 test skipped because its explicit opt-in settings
  were not provided
* Architecture boundaries across 155 source files
* Documentation links across 17 Markdown files
* SQLite command-authority benchmark: p99 24.80 ms across 100 samples, below the
  25 ms threshold
* `git diff --check`

No subagent, commit, or push was run for these review repairs.

#### Slice B follow-up review repairs

A follow-up review found that `SupervisorApi` allocated trusted identifiers
before the durable queue could identify an exact retry, the event codec treated
the run authority cursor as if every cursor had an available event, and page
cursor failures lost their meaning at the transport boundary.

The repairs add:

* Server-attributed command-envelope construction before trusted admission work
* Queue admission under `BEGIN IMMEDIATE`, with exact canonical-envelope replay
  or conflict before invoking a lazy admission callback
* Allocation-free lost-response retry even when the allocator fails, plus
  request and principal attribution conflicts before allocator invocation
* Sparse terminal event pages where `afterCursor` is 7, `latestCursor` is 8,
  and the event list is empty
* Protocol-neutral `PageQueryError` codes for cursor-ahead and event replay-gap
  failures in in-memory and SQLite query authorities
* Stable supervisor mappings of cursor-ahead to safe `invalid-request` status
  400 and event replay-gap to safe `event-replay-gap` status 409

Follow-up focused validation passed on 2026-08-13:

* Protocol, runtime, SQLite storage, supervisor queue, and transport suites: 5
  files and 170 tests
* Protocol, runtime, testing, SQLite storage, and supervisor package typechecks

Repository-wide follow-up validation passed on 2026-08-13:

* Root build, including the execution-host native helper
* Clean workspace typecheck and Biome check across 105 files
* Complete offline workspace suite: 25 files and 649 tests
* Live Copilot service probe: 1 test skipped because its explicit opt-in settings
  were not provided
* Architecture boundaries across 155 source files
* Documentation links across 17 Markdown files
* SQLite command-authority benchmark: p99 13.73 ms across 100 samples, below the
  25 ms threshold
* `git diff --check`

No subagent or commit was run for the follow-up repairs.

HTTP, local IPC, SSE listeners, daemon integration, CLI conversion, commit, and
push remain outside bounded Slice B.

## Decision D-054: Share one hardened handler across local transports

* Date: 2026-08-13
* Status: Accepted for Phase 8 bounded Slice C
* Phase: Phase 8
* Decision: Use one exact `SupervisorHttpHandler` over `SupervisorApi` for
  authenticated HTTP over a Unix socket and session-authenticated HTTP bound
  exactly to `127.0.0.1`. Derive ingress principals from transport-specific
  server context. Authenticate Unix-socket requests with a private 32-byte
  bearer credential, and authenticate loopback requests with one-time bootstrap
  capabilities, host-only sessions, exact Origin checks, and separate CSRF
  tokens. Register SSE wake notification before bounded replay reads and retain
  no event backlog in memory.
* Alternatives: Use separate IPC and portal routers; add a third-party web
  framework; trust loopback without sessions; expose bootstrap or session
  tokens in URLs after redirect; or poll into an in-memory SSE backlog.
* Rationale: One handler and one conformance suite keep command semantics,
  paging, attribution, canonical framing, and safe errors independent of the
  listener. Private filesystem objects plus a credential provide the available
  Node alpha boundary because Node does not expose `SO_PEERCRED`. Digest-only
  one-time capabilities and sessions avoid retaining reusable raw portal
  secrets server-side.
* Consequence: The runtime directory must be current-user `0700`; credential and
  socket must be current-user `0600`; symbolic links and live socket peers are
  refused. Startup holds the lifetime lock while validating and recovering the
  deterministic private binding socket, and refuses a live or insecure staging
  peer. HTTP client request deadlines are absolute and cannot be extended by
  response activity. Loopback binds only IPv4 `127.0.0.1` and requires exact
  Host. Portal mutations require exact Origin and CSRF. SSE pages at 256 events,
  heartbeats every 15 seconds, emits a typed gap before close, and bounds a
  stalled write to 30 seconds. Daemon lifecycle, operational CLI, logs, static
  portal files, and direct-recovery routes remain the next Phase 8 slice.
  Decision D-053 remains future Phase 10 work.

### Bounded Slice C: Local HTTP, IPC security, sessions, and SSE

The slice adds:

* Exact raw-target routing and one shared hardened HTTP handler over the
  transport-neutral supervisor API
* Real HTTP/1.1 listeners over authenticated Unix sockets and loopback TCP, plus
  one canonical client supporting both connection forms
* Private runtime directory, credential, stale socket, owner, mode, symbolic
  link, and concurrent-listener enforcement
* One-time portal bootstrap capabilities, host-only session cookies, one-time
  CSRF delivery, exact Host and Origin checks, and no CORS response headers
* Subscribe-before-replay SSE with canonical frames, sparse cursors,
  heartbeats, typed gaps, bounded page reads, abort handling, and bounded
  backpressure stalls
* Shared transport conformance across in-process, authenticated UDS, and
  loopback session clients, plus independent-client concurrent acceptance
  regressions

No third-party web framework, portal UI, daemon process, lifecycle CLI, worktree
operation, commit, or push is included in bounded Slice C.

### Slice C validation

Focused validation passed on 2026-08-13:

* Raw HTTP target and query hardening: 1 file and 19 tests
* Private local credential and portal session security: 1 file and 4 tests
* SSE replay race, canonical framing, heartbeat, gap, and bounded stall: 1 file
  and 4 tests
* Real-listener Host, Origin, session, CSRF, framing, socket mode, symbolic link,
  and concurrent-start security: 1 file and 12 tests
* Shared in-process, authenticated UDS, and loopback session transport
  conformance plus independent-client acceptance races: 1 file and 20 tests
* Supervisor queue, terminal notifier, security, HTTP, SSE, and transport suite:
  6 files and 81 tests
* Supervisor package typecheck and focused Biome checks across all Slice C files

Repository-wide validation passed on 2026-08-13:

* Root build, including the execution-host native helper
* Clean workspace typecheck and Biome check across 117 files
* Complete offline workspace suite: 29 files and 703 tests passed; the live
  Copilot service probe remained skipped without its explicit opt-in settings
* Architecture boundaries across 179 source files
* Documentation links across 18 Markdown files
* SQLite command-authority benchmark: p99 13.64 ms across 100 samples, below the
  25 ms threshold
* `git diff --check`

No subagent, worktree operation, commit, or push was run for bounded Slice C.

#### Slice C security review repairs

A security review found that Unix socket stale inspection preceded singleton
ownership, request bodies used replacement UTF-8 decoding, Node could emit
automatic expectation responses, HTTP clients had no bounded transport timeout,
and raw targets admitted percent-encoded control characters.

The repairs add:

* Exact current-user `0700` socket parents and canonical direct-child socket
  paths with no traversal or symbolic-link components
* A lifetime `O_CREAT|O_EXCL` current-user `0600` lock that binds PID to Linux
  process start time, fsyncs its exact record, rejects live or malformed locks,
  and removes stale locks only by held-descriptor inode and device identity
* Lock-before-inspection stale socket cleanup, atomic publication from a private
  bind path, and inode-checked socket and lock cleanup on startup failure or
  close
* Fatal UTF-8 request-body decoding before JSON or API submission
* Authenticated `checkContinue` and `checkExpectation` handling with no interim
  response and typed expectation rejection
* A bounded HTTP client request timeout, settle-once response handling, typed
  sanitized transport failures, and explicit aborted and oversized response
  rejection
* Raw and decoded C0 and DEL rejection in request paths, query keys, and query
  values before route matching
* Private-parent, lock mode, lock symlink, exact stale and live lock, socket
  replacement, malformed UTF-8, expectation, client timeout, truncated response,
  and 50-way stale socket race regressions

Review-repair validation passed on 2026-08-13:

* Focused Slice C security and conformance suite: 6 files and 97 tests
* Full supervisor package suite: 6 files and 97 tests
* Root build, including the execution-host native helper
* Clean workspace typecheck and Biome check across 117 files
* Complete offline workspace suite: 29 files and 719 tests; the live Copilot
  service probe remained skipped without its explicit opt-in settings
* Architecture boundaries across 179 source files
* Documentation links across 18 Markdown files
* SQLite command-authority benchmark: p99 13.58 ms across 100 samples, below the
  25 ms threshold
* `git diff --check`

No subagent, worktree operation, commit, or push was run for these review
repairs. Decision D-053 remains unchanged and assigned to Phase 10.

#### Final Slice C private binding and client deadline repairs

A final review found that an abrupt exit after private bind but before atomic
publication could leave a staging socket that blocked the next owner, and the
HTTP client's inactivity timeout could be extended indefinitely by response
bytes.

The repairs add:

* A stable private binding path derived only while the newly acquired lifetime
  lock is held
* Current-user `0600` socket, no-symbolic-link, direct-private-parent, and live
  peer validation before stale staging cleanup
* Device-and-inode comparison across the liveness probe, exact stale unlink,
  parent-directory fsync, live-peer refusal, and identity-checked cleanup on
  startup failure or close
* One settle-once wall-clock client deadline that starts with the request,
  destroys the request on expiry, and is cleared by every resolve or reject path
* A child-process crash regression that exits after private bind and before
  publication, followed by reachable restart and complete artifact cleanup
* A slow-drip response regression that sends data more frequently than the
  deadline while proving bounded rejection and client-side socket closure

Final-repair validation passed on 2026-08-13:

* Focused crash-recovery and slow-drip deadline regressions: 2 tests
* Full Slice C security and conformance suite: 6 files and 100 tests
* Root build, including the execution-host native helper
* Clean workspace typecheck and Biome check across 117 files
* Complete offline workspace suite: 29 files and 722 tests passed; the live
  Copilot service probe remained skipped without its explicit opt-in settings
* Architecture boundaries across 179 source files
* Documentation links across 18 Markdown files
* SQLite command-authority benchmark: p99 18.17 ms across 100 samples, below the
  25 ms threshold
* `git diff --check`

No subagent, worktree operation, commit, or push was run for these final repairs.
Decision D-053 remains unchanged and assigned to Phase 10.

#### Final Slice C session lifetime repair

The final security review found that an already-open loopback SSE connection
could outlive its authenticated portal session and continue receiving future
events. Portal session security now returns the remaining lifetime from its
trusted clock. The HTTP handler arms an independent wall-clock abort for that
deadline and closes the stream before any event at or after expiry. A real
loopback regression opens an empty stream with a 40 ms session, notifies an event
after 60 ms, and proves the stream closes without delivering the event.

Focused session, SSE, and HTTP security validation passed with 35 tests. No
worktree operation was used, and Decision D-053 remains unchanged.

A follow-up review demonstrated that an expiry timer alone cannot run while a
synchronous replay query blocks the event loop. `SseEventSource` now evaluates a
loopback authorization predicate before every replay query and immediately
before every frame write. The handler supplies a trusted session validation
closure in addition to the wall-clock abort timer. A real loopback regression
lets preflight succeed, blocks subscribed replay for 80 ms across a 40 ms
session lifetime, returns an event, and proves the event is suppressed. Focused
session, SSE, and HTTP security validation now passes with 36 tests.

## Decision D-053: Make worktree execution explicit and isolated

* Date: 2026-08-13
* Status: Accepted for Phase 10 planning
* Phase: Phase 10
* Decision: Add the versioned configuration option
  `execution.workspaceMode` with values `repository` and `worktree`. Omission
  means `repository`. Repository mode creates no worktrees and permits one
  effective writer. Worktree mode is an explicit opt-in that requires a verified
  Git repository, immutable bases, isolated writers, and serialized integration.
  Every worktree test must create a fresh temporary Git repository outside the
  Senawa checkout. Tests must never add, remove, or mutate worktrees in the
  mounted `/workspaces/senawa` repository.
* Alternatives: Require a worktree for every writer; infer worktree support from
  Git availability; enable parallel worktrees by default; run integration tests
  against the active Senawa checkout.
* Rationale: The Senawa checkout can be mounted into a devcontainer, where host
  and container Git paths do not form a safe worktree test boundary. Most local
  workflows do not require parallel writers. An explicit mode keeps default
  execution portable and serial while retaining isolated parallel execution for
  consumers that configure and validate it.
* Consequence: Phase 10 must extend the exact configuration schema, bind the
  selected workspace mode into the immutable configuration snapshot, and refuse
  writer concurrency above one in repository mode. Worktree adapters remain in
  execution-host but are never constructed or called unless worktree mode is
  selected. Test fixtures own temporary repository creation, commits, worktrees,
  cleanup, and containment checks.

## Decision D-056: Finish with researched consumer documentation and one PR

* Date: 2026-08-13
* Status: Accepted for final delivery planning
* Phase: Phase 14 and final delivery
* Decision: Add Phase 14 after reporting, packaging, and hardening. Run a fresh
  RPI research cycle against the final implementation, then publish
  consumer-facing philosophy, architecture, getting-started, authoring,
  operations, security, troubleshooting, limitation, and example documentation.
  Commit and push that phase before generating and creating one pull request for
  the complete implementation branch.
* Alternatives: Expand README incrementally during implementation; publish only
  generated API references; create the pull request before consumer docs; retain
  research and PR chunk artifacts in the active tree.
* Rationale: Consumer documentation must describe the final behavior rather than
  plans or intermediate architecture. Fresh audience and journey research after
  Phase 13 prevents stale commands, authority claims, and package boundaries
  from becoming the adoption surface. One final pull request gives reviewers a
  coherent redesign history after every phase has its own validated commit.
* Consequence: Phase 14 is the last implementation phase. Its research artifacts
  are temporary, worktree examples use fresh temporary repositories, and its
  acceptance journey is no-credit by default. Final PR generation follows the
  repository PR-reference workflow, full validation, parallel diff review,
  branch push verification, PR creation, and temporary artifact cleanup.

## Decision D-055: Compose one fenced local supervisor lifecycle

* Date: 2026-08-13
* Status: Accepted and implemented for Phase 8
* Phase: Phase 8
* Decision: Compose SQLite command, query, runner, wake, service-mode, log, and
  repository authorities behind one `SupervisorService`. Use one serialized
  operation queue for daemon cycles, direct recovery, quiescent backup, status,
  logs, and stop. Bind supervisor queue claims and `FencedRunner` effects to the
  existing runner lease resource.
  Expose lifecycle and recovery only through authenticated Unix-socket routes;
  loopback returns not found. Keep SDK session-store filesystem health and
  backup in execution-host and combine it with SQLite backup in the app.
* Alternatives: Retain a memory scheduler; give direct recovery a separate
  effect path; dispatch the asynchronous Copilot worker as a synchronous effect
  host; expose operational routes to loopback sessions; or copy SDK state into
  SQLite.
* Rationale: Durable scans and one lease fence preserve recovery after process
  loss without making process memory authoritative. Reusing `FencedRunner`
  avoids a second effect state machine. Structural health and backup ports keep
  SDK filesystem details outside supervisor. Health checks bind only durable,
  nonterminal worker intents to their exact dispatch session IDs, so a queued
  worker can create its first session while missing metadata for a started
  effect blocks uncertain redispatch.
* Consequence: The lifecycle is `stopped` to `starting`, `running`, `draining`,
  `drained`, `stopping`, and `stopped`, with degraded health as an overlay.
  Startup failure and graceful stop exhaustively close started listeners in
  reverse order, then owned closeables, runner authority, and supervisor
  authority. Combined backup requires a serialized drained-state proof and
  stops the owned Copilot client before either store is copied. Forced exit
  leaves leases for expiry.
  Synchronous hosts retain the original `FencedRunner` API. Production Copilot
  execution uses `AsyncFencedRunner` through the same transition scheduler,
  durable intent, authority-selected claim, inspection, and commit semantics.
  Worker dispatch, inspection, and cancellation validate exact repository, run,
  context, kind, route, and dispatch bindings before grants or SDK mutation.

### Final Phase 8 review repairs

The final P0 session-eligibility review replaced queued-dispatch health inputs
with exact `startedSessionIds` derived from durable, nonterminal worker intents.
Daemon composition now provides the production SDK metadata probe to the
filesystem store. A real daemon composition test proves a first dispatch can
create its session when metadata is initially absent, while a reopened durable
intent with missing metadata remains undispatched and reports degraded health.

The P1 repairs serialize cycles, wake pumping, direct recovery, quiescent
operations, status, logs, and stop through one service operation queue. Worker
effects load and validate their complete stored authority binding before every
dispatch, inspection, and cancellation. Cross-kind, cross-repository,
cross-run, and cross-context tests prove that rejected intents do not issue
grants or call SDK create, metadata, or abort operations.

The P2 repairs make listener startup failure and service stop cleanup
exhaustive. Only successfully started listeners close, in reverse order,
followed by closeables and both authorities even when an earlier close fails.
Combined backup requires a serialized drained-state proof, stops the SDK client
before either store copy, and does not restart it. Tests verify copied SQLite
and SDK markers, reject backup while running, reject recovery during backup,
and prove failed daemon listener startup leaves no Unix socket lock.

Final review validation passed on 2026-08-13:

* Focused eligibility, serialization, binding, lifecycle, daemon composition,
  and backup suites: 6 files and 35 tests
* Frozen dependency installation, root build, and workspace typecheck
* Biome check across 135 files
* Complete offline suite: 38 files and 755 tests passed; one live SDK test
  remained skipped without opt-in settings
* Architecture boundaries across 215 source files
* Documentation links across 18 Markdown files
* SQLite command-authority benchmark: p99 18.83 ms across 100 samples, below
  the 25 ms threshold
* `git diff --check` and process-residue check

Decision D-053 remains unchanged and assigned to Phase 10. No worktree
operation or live SDK invocation was used for these repairs.

The final lifecycle review also moved complete status and log queries inside
the serialized operation queue. A status request that has entered the queue
finishes its snapshot, asynchronous SDK health check, mode read, and response
decode before stop can close SQLite. Queries submitted after closure return a
typed `service-unavailable` response. An authenticated Unix HTTP regression
gates health, starts stop, proves stop remains pending, then releases health and
verifies both the valid status response and subsequent typed refusal.

Owned Copilot SDK shutdown failures now propagate as `AggregateError` while
service cleanup continues through the context broker, runner authority,
supervisor authority, and listener socket. Startup preserves its primary
failure as the first aggregate entry when cleanup also fails. Composition
failures before service ownership roll back any created SDK, context broker,
and authority without double-closing resources after service construction.
Real-path tests reopen both SQLite stores and reacquire the socket lock after
SDK construction and shutdown failures.

D-055 retains the 25 ms refusal p99 threshold. Its CI variance-resistant
measurement protocol uses one excluded 100-submission conditioning database,
then five independent fresh databases. Every measured window excludes 10
warmups and records 100 unique refusal submissions with normal history growth.
Acceptance requires at least four of five window p99 values below 25 ms and a
median window p99 below 25 ms. One noisy window remains visible in the report;
neither its samples nor a failed window are discarded or rerun.

Final lifecycle validation passed on 2026-08-13:

* Focused service, daemon composition, and operational HTTP suites: 3 files and
  14 tests
* Frozen dependency installation, root build, and workspace typecheck
* Biome check across 135 files
* Complete offline suite: 38 files and 759 tests passed; one live SDK test
  remained skipped without opt-in settings
* Architecture boundaries across 215 source files
* Documentation links across 18 Markdown files
* Two independent conditioned benchmark invocations passed 4 of 5 and 5 of 5
  windows; median window p99 was 18.59 ms and 16.73 ms against the unchanged
  25 ms threshold
* `git diff --check` and process-residue check

Decision D-053 and Decision D-056 remain unchanged. No worktree, subagent,
commit, or live SDK invocation was used for these repairs.

## Phase 8 bounded Slice D log

Slice D adds:

* Durable repository registration, desired mode, bounded sanitized logs, and
  database-derived status counts and lease facts
* Startup recovery, live wake pumping, drain and stop transitions, shared
  direct recovery, 30-second leases, and 10-second renewal checks
* Authenticated UDS status, drain, stop, recovery, logs, and portal bootstrap
  routes with loopback operational-route refusal
* XDG-private daemon composition, signal shutdown, detached readiness polling,
  and thin CLI workflow and operational commands
* SDK session-store health plus bounded manifest backup, verification, and
  fresh-only restore, combined with SQLite under an outer manifest
* Built-process status, submit, exact retry, receipt, event, drain, stop,
  restart, and durable recovery coverage

Focused Slice D validation passed on 2026-08-13:

* Lifecycle, queue recovery, direct lease recovery, registry, and log tests: 25
  tests
* Operational router and authenticated UDS or loopback refusal tests: 26 tests
* SDK session-store health and backup tests: 4 tests
* CLI, combined backup, and built service journey tests: 15 tests
* Shared in-process, UDS, and loopback transport conformance: 20 tests

Repository-wide Slice D validation passed on 2026-08-13:

* Root build, including the execution-host native helper
* Clean workspace typecheck and Biome check across 129 files
* Complete offline workspace suite: 34 files and 735 tests passed; the live
  Copilot service probe remained skipped without its explicit opt-in settings
* Architecture boundaries across 203 source files
* Documentation links across 18 Markdown files
* SQLite command-authority benchmark: p99 13.60 ms across 100 samples, below the
  25 ms threshold
* `git diff --check`

Phase 8 production composition completed on 2026-08-13:

* `AsyncFencedRunner` retains the synchronous runner's scheduling, durable
  intent, claim, replay, reconciliation, and conservative accounting semantics.
  It resolves trusted time and lease facts before every authority call. An
  abort or lease-provider failure leaves the durable claim for takeover and
  does not synthesize an outcome.
* `SupervisorRunController.runOnceAsync` renews the 30-second run lease every 10
  seconds while an asynchronous host is pending. Renewal failure aborts the
  host synchronously and leaves the uncertain lease unreleased. Service cycles,
  service recovery, and direct foreground recovery use this controller path.
* `CopilotWorkerEffectHost` validates an exact durable effect input, reloads its
  registered context and dispatch, issues fresh scoped grants, resumes by
  dispatch identity, maps only sanitized adapter results, and inspects broker
  completion facts plus SDK session metadata without treating an uncertain
  missing session as permission to duplicate dispatch.
* `CompletionFactCommandBridge` admits deterministic engine-service
  `submit-completion` commands through `SqliteSupervisorAuthority.accept`.
  Queue commit precedes context-outbox acknowledgement, and exact redelivery is
  idempotent by the completion fact digest and submission identity.
* The daemon opens the SQLite context broker and completion bridge. It composes
  the production Copilot SDK only when `SENAWA_REPOSITORY_DIR` is explicit;
  otherwise status is degraded and worker dispatch remains disabled. Graceful
  stop closes the owned SDK client and broker before the shared authorities.
* A seeded production composition test runs a worker effect through a fake SDK,
  accepted broker completion, outbox bridge, supervisor queue, final workflow
  assessment, and terminal effect outcome. Trusted planning that creates worker
  effect commands remains a later workflow-planning concern, not a Phase 8
  supervisor composition gap.

Focused completion validation passed:

* Async runner conformance, crash recovery, renewal, abort, and higher-fence
  takeover: 38 tests
* Supervisor delayed renewal, live-owner refusal, renewal abort, and takeover: 2
  tests
* Completion bridge queue-commit fault, exact redelivery, and command drain: 1
  test
* Seeded worker effect through production host and completion assessment: 1 test

Repository-wide completion validation passed on 2026-08-13:

* Root build, clean workspace typecheck, and Biome check across 134 files
* Complete offline workspace suite: 37 files and 748 tests passed; the live
  Copilot service probe remained skipped without its explicit opt-in settings
* Architecture boundaries across 213 source files
* Documentation links across 18 Markdown files
* SQLite command-authority benchmark: p99 13.97 ms across 100 samples, below the
  25 ms threshold
* `git diff --check`

Independent self-review found no additional Phase 8 production composition gap.

The live Copilot SDK probe remains intentionally opt-in and was not run. No
subagent or commit was used for this completion work.

### Final Phase 8 independent approval

Independent review rejected Phase 8 until the real daemon composition, not only
an injected test composition, satisfied session recovery, serialization,
binding, cleanup, and backup requirements. The final repairs:

* Derive expected SDK sessions only from durable nonterminal worker intents.
  Never-started effects can create their first session, while a started effect
  whose session metadata disappeared remains degraded and cannot redispatch.
* Serialize wake cycles, direct recovery, status, logs, quiescent backup, and
  stop through one service operation queue.
* Validate worker effect kind, repository, run, context, dispatch, and route
  before issuing grants or invoking SDK create, inspect, or abort operations.
* Close every started listener and owned resource on startup or shutdown
  failure, propagate Copilot SDK shutdown errors, and roll back SQLite ownership
  when composition fails before the service assumes ownership.
* Require combined SQLite and SDK backup to run under serialized drained-state
  proof after the owned SDK client stops.
* Keep the 25 ms SQLite refusal threshold while measuring five independent
  fresh-database windows after an excluded conditioning pass. Acceptance
  requires at least four passing windows and a median window p99 below 25 ms.

The final independent review reported no P0, P1, or P2 findings and approved
Phase 8. One P3 cleanup was completed before delivery: duplicate foreground
recovery modules were consolidated into `recovery.ts`, and the ignored
`expiresAt` caller parameter was removed because `SupervisorRunController` owns
the fixed lease duration.

Final validation passed on 2026-08-13:

* Frozen workspace install across 10 projects
* Root build, including the execution-host native helper
* Clean workspace typecheck
* Biome check across 135 files
* Complete offline workspace suite: 38 files and 759 tests passed
* Live Copilot SDK probe: 1 test skipped without explicit service, model,
  budget, timeout, and data/cost acknowledgement settings
* Architecture boundaries across 215 source files
* Documentation links across 18 Markdown files
* Two conditioned benchmark invocations passed 4 of 5 and 5 of 5 windows, with
  median window p99 values of 18.66 ms and 19.01 ms against the unchanged 25 ms
  threshold
* Canonical recovery API build, lint, service, CLI, and black-box tests: 20
  focused tests
* No active Senawa service or process-supervisor residue
* `git diff --check`

Decision D-053 remains assigned to Phase 10. No Git worktree operation was used
in Phase 8. Decision D-056 remains final delivery planning for Phase 14 and the
pull request.

### Commit and push

Pending final Phase 8 delivery.

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