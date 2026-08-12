# Comprehensive Alpha Implementation Plan

This plan governs the autonomous Senawa alpha implementation. It is the active
design and execution source and does not preserve former APIs, persisted runs,
package boundaries, or implementation compatibility.

Major decisions and deviations are recorded in
[Implementation Log](implementation-log.md).

## User requests

The implementation must deliver:

* A consumer-defined software-factory workflow kernel
* Deterministic phases, tasks, criteria, dependencies, and transitions
* Workflow-defined evidence accounting, sensors, gates, approvals, and closure
* Human-approved agent proposals for additive phases and tasks
* Durable restart from exact workflow boundaries
* Zero to many scoped agents with immutable cross-agent context
* Parallel task execution in isolated workspaces and serialized integration
* A Senawa-owned embedded transactional authority with no Beads dependency
* A supervisor process with one API shared by CLI and portal
* Local HTTP and SSE plus an authenticated remote control-plane protocol
* An installable alpha with initialization, diagnostics, backup, export, and
  end-to-end tests
* Major decisions and plan deviations recorded while implementation proceeds
* A commit and push after the reset and after every implementation phase

## Scope boundary

The alpha includes a complete local product and a complete remote protocol with
a deterministic control-plane simulator. It does not include operation of a
production hosted multi-tenant service, billing, production OIDC, regional
failover, cloud object storage, or distributed execution leases.

Initial product limits:

* One active run per repository
* Additive phase and task amendments only
* One serialized repository integration slot
* One supported live worker adapter plus deterministic simulated workers
* npm distribution first
* No old-run, Beads, file-runtime, CLI, or schema compatibility

## Target dependency graph

```text
protocol
  ^
  |
kernel
  ^
  |
runtime
  ^       ^
  |       |
storage-sqlite   execution-host
         \       /
          supervisor

cli -----------> protocol
portal --------> protocol
control-plane -> protocol
```

Planned production boundaries:

| Boundary | Responsibility |
|----------|----------------|
| `packages/protocol` | Browser-safe versioned commands, receipts, events, projections, principals, assets, and capability contracts |
| `packages/kernel` | Pure canonical graph, reducer, completion, conditions, gates, candidates, approvals, closure, escalation, amendments, context, and barriers |
| `packages/runtime` | Ports, command service, runner, scheduler, intents, reconciliation, projections, and queries |
| `packages/storage-sqlite` | Transactional authority, migrations, leases, claims, content-addressed assets, backup, integrity, and export |
| `packages/configuration` | Workflow, sensor, schema, role, model-policy, initialization, and doctor contracts |
| `packages/execution-host` | Worker, sensor, bounded-process, Git worktree, integration, and context-read adapters |
| `packages/supervisor` | Repository registry, runner lifecycle, local IPC, loopback HTTP, SSE, wake-up, drain, and portal hosting |
| `packages/portal` | Static browser client over protocol only |
| `packages/reporting` | Deterministic reports, diagnostic bundles, and validated exports |
| `packages/testing` | Deterministic fixtures, in-memory authority, fake effects, crash injection, and conformance suites |
| `apps/senawa` | CLI and local product composition root |
| `apps/control-plane` | Remote protocol reference server and partition simulator composition |

Dependency rules:

* Kernel imports no filesystem, process, network, database, Git, clock, random,
  worker, sensor, or UI module.
* Protocol contains no workflow behavior and no Node-only APIs.
* Runtime defines ports and does not import concrete adapters.
* Concrete adapters do not import each other.
* Apps compose packages; no package imports an app.
* Portal and control plane import protocol, never local storage or execution
  authority.
* Production packages never import testing packages.

## Cross-phase execution rules

For every phase:

1. Read this plan and the implementation log.
2. Use scoped subagents for independent implementation tasks when file and state
   dependencies permit.
3. Make the smallest grounded edit that can falsify the phase hypothesis.
4. Run a focused executable validation immediately after the first edit.
5. Iterate until focused and phase-wide validation pass.
6. Run an independent Implementation Validator review.
7. Resolve all critical and high findings and record lower findings or deferrals.
8. Update the implementation log with decisions, deviations, validation, and
   residual risk.
9. Commit with a Conventional Commit message and required generated footer.
10. Push `redesign/workflow-state-machine` to `origin`.

If a push fails because of credentials or remote policy, record the failure and
continue with local commits. Do not expose secrets or request credentials through
chat.

## Phase 0: Preserve evidence and reset

### Goal

Remove the old implementation and create a minimal buildable workspace that
cannot import legacy architecture.

### Preserve

* `.git/`
* `.devcontainer/`
* `docs/design/implementation-plan.md` and
  `docs/design/implementation-log.md`
* Relevant `experiments/probes/`
* Repository history
* Generic Markdown link checking
* Generic pnpm, TypeScript, Vitest, and Biome concepts

### Remove or replace

* Current apps, packages, tests, examples, `.senawa`, and `.agents`
* Numbered current-design guides and generated CLI reference
* Beads and file-runtime implementations
* Implementation-specific scripts and root graph configuration
* Current README and repository guidance

### Create

* Fresh root tooling and workspace configuration
* `packages/protocol`
* `packages/kernel`
* `packages/testing`
* Minimal `apps/senawa` exposing version and help only
* New repository README and guidance that make no unimplemented claims

### Acceptance

* Fresh install, build, typecheck, lint, and tests pass.
* No production source references Beads or legacy packages and schemas.
* The executable advertises only implemented commands.
* Preserved probes retain historical fixture names and are marked appropriately
  when no longer runnable against production code.

### Disproof

* The reset requires a legacy package to build.
* The repository is left in a misleading hybrid state.
* A preserved probe silently changes its measured fixture.

### Commit

`chore(build): reset repository for redesign`

## Phase 1: Canonical codec and graph kernel

### Goal

Implement stable identity, canonical serialization, workflow compilation, graph
invariants, commands, events, and a pure deterministic reducer.

### Acceptance

* Workflow, run, phase, task, criterion, asset, dispatch, approval, amendment,
  escalation, and typed-edge identities are distinct.
* One compiler creates one revisioned graph from normalized definitions.
* Containment, dependency, and supersession cycles fail before events apply.
* Equivalent input property orders produce byte-identical canonical digests.
* Software-delivery and non-software fixtures use the same canonical model.
* Kernel has no environment or I/O imports.

### Validation

* Golden canonical digest vectors
* Entity and edge invariant tables
* Cycle, reference, generation, and supersession tests
* Reducer replay tests
* Dependency-boundary check

### Disproof

* Execution still needs separate workflow, plan, and runtime representations.
* Canonical output depends on time, locale, randomness, process, or property
  insertion order.
* Non-software work needs software-specific canonical task fields.

### Commit

`feat: add canonical workflow graph kernel`

## Phase 2: Completion, gates, closure, and escalation

### Goal

Implement the full pure completion chain and independent finite budgets.

### Acceptance

* Completion, accounting, evidence, reading, gate evaluation, authority decision,
  and closure are distinct immutable records.
* Every task generation has an explicit disposition, summary, and criterion
  account.
* Phase candidates bind exact task sets, inputs, policies, and barriers.
* Conditions are pure three-valued predicates; blocking unknown fails closed.
* Independent finite budgets create first-class escalations.
* Resume never silently resets counters.

### Validation

* Criterion disposition and evidence tables
* Candidate staleness and unrelated-amendment tests
* Condition truth tables
* Exact approval, waiver, closure, and escalation digest tests
* One failure-class test for each budget
* Projection rebuild without mutable status authority

### Disproof

* Closure requires authoritative mutable status.
* Omitted work disappears without a finding.
* Approval applies to a different candidate.
* Any autonomous loop can be unbounded.

### Commit

`feat: add completion and escalation semantics`

## Phase 3: Protocol and in-memory command slice

### Goal

Create one versioned command model shared by CLI, HTTP, runner, portal, and
remote delivery, then exercise a complete in-memory workflow.

### Acceptance

* Commands include identity, principal, intent, payload digest, revisions, exact
  candidate guards, and expiry.
* Receipts are durable state machines with monotonic cursors.
* Exact command replay is idempotent and conflicting reuse is refused.
* One in-memory journey reaches closure through only protocol commands.
* Queries derive projections from immutable records and events.

### Validation

* Protocol encode/decode golden fixtures
* Invalid, stale, oversized, expired, unauthorized, and conflict cases
* Receipt lifecycle and cursor replay
* Transport-independent conformance suite
* Serialized in-memory restart

### Disproof

* Different clients require different mutation semantics.
* Lost output leaves effect state unknowable.
* Protocol transport concerns leak into kernel decisions.

### Commit

`feat: add versioned command protocol`

## Phase 4: SQLite authority and immutable assets

### Goal

Implement one transactional local authority and content-addressed artifact store.

### Required probe

Compare supported SQLite bindings for Node compatibility, packaging, WAL,
transactions, backup, and platform installation. Record the selected binding and
evidence before adopting it.

### Acceptance

* One transaction commits revisions, events, receipts, projections, claims,
  fences, leases, intents, outcomes, and active-run ownership.
* Asset staging cannot leave committed descriptors pointing to missing bytes.
* Lease takeover increments a fence and stale owners cannot write.
* Migrations, backup, restore, integrity, and unsupported-schema behavior are
  explicit and tested.

### Validation

* Persistence conformance across independent connections
* Concurrent writer, stale revision, duplicate command, claim, and lease cases
* Crash injection around blob and transaction boundaries
* Disk-full and read-only cases where supported
* Migration and backup/restore tests
* Clean `npm pack` install on the declared platform matrix

### Disproof

* Committed state references missing content.
* Two writers act under the same fence.
* Packaging is not viable on the declared alpha platforms.

### Commit

`feat: add transactional local authority`

## Phase 5: Fenced runner and reconciliation

### Goal

Perform exactly one durable, recoverable transition per runner operation.

### Acceptance

* Runner persists intent before one external effect and reconciles semantic
  freshness before committing outcome.
* Duplicate wakes and repeated runner operations are idempotent.
* Unknown effects remain explicit and bounded.
* Spend reserves before dispatch and finalizes from reported usage.
* Foreground recovery uses the same lease and cannot race a healthy runner.

### Validation

* Crash matrix around intent, effect, and commit boundaries
* Duplicate delivery, lost response, wake, stale lease, and takeover cases
* Worker result reconciliation matrix
* Independent budget and spend tests
* Replay equivalence with uninterrupted execution

### Disproof

* Process memory is needed to determine legal progress.
* A crash silently duplicates an effect.
* Runner applies policy not represented by the kernel plan.

### Commit

`feat: add fenced workflow runner`

## Phase 6: Workflow and sensor configuration

### Goal

Load consumer workflows, schemas, roles, model policy, sensors, and gates into one
immutable normalized snapshot.

### Acceptance

* Doctor reports independent definition errors without starting work.
* One compiler handles initial work and later amendments.
* Sensor-free workflows are valid.
* Undefined references and unbounded loops fail validation.
* Sensors measure; workflow nodes own consequences.
* Init writes a versioned example without overwriting or invoking a model.

### Validation

* Valid and invalid fixture corpus
* Software and non-software workflows
* Embedded and projected executable work
* Sensor argument-vector, timeout, output, environment, and process cleanup tests
* Deterministic snapshot and drift detection
* Init no-overwrite tests

### Disproof

* JSON Schema alone is asked to enforce graph semantics.
* Sensor configuration can widen authority or choose lifecycle.
* Initial and amendment compilation diverge.

### Commit

`feat: add workflow configuration loading`

## Phase 7: Context broker and serial workers

### Goal

Dispatch scoped agents with immutable context bases and lazy full-asset reads.

### Acceptance

* Context bases bind graph, contracts, dependencies, assets, repository base,
  policy, capabilities, and one digest.
* Prompt packs are bounded renderings, not authority.
* Asset reads use opaque scoped grants with budgets and audit receipts.
* Agents can submit completion, questions, assets, discoveries, and amendments
  only for assigned work.
* Stale completion is preserved but cannot close work.
* Simulated worker completes the full journey; one live adapter passes explicit
  opt-in probes.

### Validation

* Canonical context and barrier vectors
* Lazy read, pointer, chunk, expiry, budget, and denial tests
* Prompt injection and sensitivity tests
* Crash resume with unchanged context and fresh dispatch after changed context
* Missing completion, duplicate completion, blocked, malformed, and stale cases

### Disproof

* Agent needs arbitrary repository access to read canonical assets.
* Replay resolves current aliases instead of historical assets.
* Worker identity can widen graph or approval authority.

### Commit

`feat: add scoped worker context`

## Phase 8: Local supervisor, HTTP, SSE, and CLI

### Goal

Make the supervisor the normal local control plane and CLI a thin client.

### Acceptance

* Supervisor accepts commands, persists receipts, wakes runners, recovers queues,
  and exposes queries and replayable SSE.
* CLI and HTTP pass one transport conformance suite.
* Loopback portal sessions enforce host, origin, session, and CSRF rules.
* Service lifecycle supports start, stop, status, drain, logs, and recovery.
* Direct recovery remains available under the same fence.

### Validation

* Supervisor crash and restart during every receipt stage
* Lost client response and exact retry
* SSE replay, heartbeat, gap, and slow-client cases
* Local IPC ownership and credential tests
* Host, origin, CSRF, traversal, payload, and rendering tests
* Black-box CLI/service journey

### Disproof

* Supervisor memory is authoritative.
* CLI or portal bypasses the shared command service.
* Service failure prevents direct recovery.

### Commit

`feat: add local supervisor and cli`

## Phase 9: Additive amendments

### Goal

Allow agents and humans to propose additive phases and tasks, with exact human
approval and quiescent application.

### Acceptance

* Proposal binds base graph and context, normalized operations, impact, and
  digest.
* Approval applies exactly the reviewed normalized graph.
* Unrelated work remains current.
* Affected active work is fenced and stale output is refused.
* Completed candidates are never retroactively rewritten.

### Validation

* Duplicate, conflicting, stale, withdrawn, and overlapping proposals
* Approval digest and revision races
* Quiescent application and crash recovery
* Unrelated-current and affected-stale cases

### Disproof

* Approval and applied graph differ.
* Global revision invalidates unrelated work.
* Amendment rewrites completed history.

### Commit

`feat: add approved workflow amendments`

## Phase 10: Parallel worktrees and integration

### Goal

Execute dependency-ready tasks concurrently with snapshot isolation and one
serialized integration slot.

### Acceptance

* Effective concurrency respects workflow, supervisor, host, and resource limits.
* Every writer uses an isolated worktree and immutable base.
* Siblings cannot observe partial work.
* Integration is fenced, durable, restartable, and followed by configured gates.
* Fan-in digest is independent of completion order.
* Failed siblings do not cancel unrelated work unless workflow selects fail-fast.

### Validation

* Disjoint edits, same-file conflicts, semantic conflicts, cancellation, and
  task-local failure
* Post-integration failure and rework
* Restart while integration owns the slot
* Every sibling completion permutation
* Resource and spend cap scheduling

### Disproof

* Task closes before required integration.
* Late cancelled output reaches the target.
* Fan-in depends on timing.
* Parallel execution can mutate canonical state outside Senawa.

### Commit

`feat: add isolated parallel execution`

## Phase 11: Local portal

### Goal

Provide an operational portal for graph inspection, artifacts, questions,
approvals, amendments, escalations, receipts, and run control.

### Acceptance

* Portal imports protocol only and shares no backend authority.
* Desktop and mobile views remain usable without overlapping controls.
* Every destructive or authority-expanding action requires explicit review.
* Large content uses bounded, sanitized viewers.
* Staleness, pending receipts, and human needs are globally visible.

### Validation

* Component and accessibility tests
* Injection and hostile-content tests
* Playwright desktop and mobile screenshots
* SSE reconnect and stale-projection behavior
* Complete approval, question, amendment, and escalation flows

### Disproof

* Portal needs direct kernel or database access.
* UI hides stale state or authority consequences.
* Dynamic content can produce executable HTML.

### Commit

`feat: add local workflow portal`

## Phase 12: Remote control-plane protocol

### Goal

Implement the outbound repository connector, reference control-plane server,
authenticated protocol, delivery chain, partition semantics, and conformance
simulator without claiming a production hosted service.

### Acceptance

* Principal identity derives from the accepting server, never client actor data.
* Receipt chain distinguishes central acceptance, delivery, local acceptance,
  runner claim, and outcome.
* Repository supervisor reauthorizes every command locally.
* Local deterministic work follows explicit disconnected policy.
* Projection staleness is always visible.
* Source, credentials, local leases, and unsynchronized assets remain local.

### Validation

* Duplicate, delayed, reordered, expired, revoked, and partitioned delivery
* Stale approval and amendment refusal
* Tenant/repository authorization denial matrix
* Capability and version negotiation
* Data-classification synchronization tests

### Disproof

* Central receipt is mistaken for repository execution.
* Network partition grants new authority.
* Client controls tenant, repository, or principal identity.

### Commit

`feat: add remote control plane protocol`

## Phase 13: Reporting, packaging, and hardening

### Goal

Ship a coherent npm alpha with deterministic reports, operations, security
limits, and a no-credit end-to-end acceptance journey.

### Acceptance

* Reports reconstruct graph, trajectory, actors, models, assets, context,
  amendments, escalations, gates, approvals, costs, and uncertainty.
* Backup, restore, export, integrity, repair, diagnostics, and service operations
  are documented and tested.
* npm package installs cleanly on declared platforms.
* Security ceilings cover payloads, outputs, processes, paths, networks, secrets,
  sessions, and retention.
* Public documentation matches only implemented behavior.

### Validation

* Clean-install matrix
* Deterministic report and export golden tests
* Backup/restore and corruption journey
* Hostile schema, artifact, output, archive, path, and network tests
* Full no-credit workflow with completion, approval, amendment, parallel
  integration, escalation, crash recovery, portal observation, and remote
  simulation
* Opt-in live worker smoke test with cost warning

### Disproof

* Installation depends on undeclared global tools.
* Report cannot explain an accepted transition.
* Recovery or export loses provenance.
* Documentation advertises unimplemented authority or hosting.

### Commit

`feat: complete senawa alpha`

## Final completion criteria

The autonomous implementation is complete only when:

* All phase acceptance criteria pass.
* Independent validation has no unresolved critical or high findings.
* Every major decision and deviation is in the implementation log.
* Every phase has a commit and recorded push result.
* Build, typecheck, lint, unit, conformance, system, documentation, and packaging
  checks pass from a fresh install.
* The no-credit end-to-end workflow passes after process restarts.
* The current branch contains no Beads or legacy compatibility implementation.
* The final implementation review states which planned contracts were accepted,
  changed, disproved, or deferred.