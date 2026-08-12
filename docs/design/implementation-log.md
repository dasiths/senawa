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
| 1. Canonical codec and graph kernel | Ready to commit | Pending | Pending |
| 2. Completion, gates, closure, and escalation | Not started | Pending | Pending |
| 3. Protocol and in-memory command slice | Not started | Pending | Pending |
| 4. SQLite authority and immutable assets | Not started | Pending | Pending |
| 5. Fenced runner and reconciliation | Not started | Pending | Pending |
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
* Exactly three active design files
* No empty directories outside ignored dependency caches

#### Remaining risk

Concrete SHA-256 adapters remain a later composition-layer responsibility and
must pass canonical-byte conformance tests before persistence relies on them.

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