# Current-System Divergence and Redesign Migration

This document maps the current repository to the proposed redesign and defines
small falsifiable implementation slices. Existing implementation choices are
evidence, not constraints or compatibility requirements.

## Alpha reset decision

Senawa is alpha software. The redesign does not preserve current APIs, workflow
or sensor formats, persisted runs, CLI grammar, package boundaries, runtime
backends, or compatibility executables.

The recommended strategy is a clean implementation reset in this repository:

1. Preserve Git history, WIP research, measured probes, the devcontainer, and
  generic tooling that still earns its place.
2. Remove the current application and package implementation as one deliberate
  reset.
3. Create a new minimal workspace and package graph from the redesigned
  responsibilities.
4. Reintroduce behavior through falsifiable vertical slices.
5. Port individual mechanisms or test scenarios only after the new contract
  exists.

This is neither an in-place refactor nor a devcontainer-only wipe. An in-place
refactor would let current types and package seams shape the new ontology. A
devcontainer-only wipe would discard measured evidence, test scenarios,
documentation, and repository history without adding design freedom.

The redesign fails if its canonical graph, completion records, context bases,
supervisor, or embedded authority make core behavior less explicit or less
recoverable than the current implementation.

## Strengths to preserve

The current repository already demonstrates valuable properties:

* Deterministic transition selection outside model context
* Worker completion backpressure
* Exact phase artifact versions and digests
* Human approval and rejection loops
* Separate valid-attempt and dispatch-failure accounting
* Resolved input manifests and consumed-input provenance
* Repository baseline and delta evidence
* Sensor readings and gate evaluations
* Driver leases, atomic claims, and revision-checked state writes
* Dispatch intent and outcome reconciliation
* Durable browser command receipts
* Append-only journal and run report
* Worker capability ceilings independent of model selection

These are redesign principles and test ideas. Their current implementations are
not presumed reusable. Beads mappings, schemas, package boundaries, commands,
ports, adapters, and persisted formats may all be deleted.

## Reset preservation boundary

### Preserve

* `.git/` and branch history
* `.devcontainer/`
* `docs/design/wip/` research, decision status, findings, and rejected rationale
* Reproducible `experiments/probes/` that still measure relevant external
  substrates or failure modes
* `AGENTS.md` and repository instructions after updating them for the new tree
* Generic formatter, TypeScript, test, and workspace configuration when the new
  scaffold still uses them
* Test scenarios for crash recovery, duplicate commands, completion omissions,
  sensor failure, cancellation, stale results, and hostile output

### Replace

* `apps/` and `packages/` implementation
* `tests/contract/` fixtures tied to current runtime formats
* `.senawa/` sample definitions and `.agents/` skill content
* Current examples, demos, generated CLI reference, and build scripts
* Root package and TypeScript configuration that encode the old package graph
* Retired numbered design guide content, while stable compatibility paths remain

### Do not carry forward as constraints

* Beads compatibility or old-run resume
* File-runtime compatibility
* Existing package names or ports
* Existing command names and exit codes
* Existing YAML and artifact schemas
* Existing browser implementation
* Existing worker-host adapters
* Existing public or internal TypeScript APIs

Preservation means retaining evidence or a scenario, not copying an
implementation. Code should be reintroduced only when it satisfies a new
interface and a new test.

## Divergence inventory

### Product and authoring

| Current system | Proposed direction |
|----------------|--------------------|
| One built-in RPI-oriented artifact family | Consumer-defined workflows and schemas over a small canonical kernel |
| Manual repository setup | Versioned initialization profiles and validation |
| Plan-specific `import-plan` action | Explicit executable-work materialization boundary |
| Software-specific task fields in the canonical plan | Generic tasks with typed software effects |
| Fixed workflow snapshot with additive tasks only | Immutable ancestry plus human-approved definition revisions |

### Domain model

| Current system | Proposed direction |
|----------------|--------------------|
| Static workflow phases joined to small runtime phase records | One typed revisioned graph |
| Plan phases compile away | First-class phase membership and barriers |
| Runtime task extends plan artifact shape | Separate task definition, generation, and runtime projection |
| Criteria nested in tasks | Stable criterion entities or identity-bearing values |
| Evidence distributed across dispatch and files | Content-addressed assets and typed evidence links |
| Mutable status establishes phase completion | Immutable candidate, gate, approval, and closure records |

### Mutation and context

| Current system | Proposed direction |
|----------------|--------------------|
| Initial import and plan revision use different logic | One compiler and amendment reducer |
| No phase amendment | Agent proposal plus exact human approval |
| Input manifest pins some assets | Complete context basis and result-bound barriers |
| Prompt embeds bounded content | Layered prompt plus lazy audited full-asset reads |
| No atomic semantic freshness check | Context-bound acceptance and stale-result outcomes |

### Runtime and interaction

| Current system | Proposed direction |
|----------------|--------------------|
| Beads plus several file authorities | One Senawa-owned transactional run authority |
| Foreground driver and browser supervisor | Local service plus separately fenced runners |
| Browser commands have receipts; CLI generally does not | One durable command service for every client |
| Actor channel is provenance | Authenticated principal plus transport provenance |
| One active worker | Bounded parallel workers after isolation and integration probes |
| Loopback portal only | Local portal plus optional authenticated remote control plane |

### Failure behavior

| Current system | Proposed direction |
|----------------|--------------------|
| Task rework and dispatch failures escalate | Every finite budget has a first-class escalation |
| Phase exhaustion pauses or throws | Durable phase escalation with allowed decisions |
| Sensor error becomes gate failure | Separate unknown reading and sensor retry budget |
| Escalation may be reopened through steering | Exact authority command with allowance receipt |
| `needs` reports only questions and approvals | Projection reports every human decision point |
| Driver transition cap throws | Durable invariant or supervisor error with repair path |
| AIU observed but not enforced | Pre-dispatch spend reservation and hard ceilings |

## Known implementation gaps

The current schema validates executor kinds that the standard driver does not
execute. Workflow `concurrency` is capped at one. Plan `parallelizable` metadata
does not affect dispatch. `onUpstreamChange` validates but has no controlling
runtime behavior.

The task frontier accepts its phase when all runtime tasks are closed, without
an exact selected task-set candidate. Phase iteration exhaustion lacks a durable
escalation. An escalated task pauses the run, but the status projection may show
no `needs` action.

Browser commands have caller-supplied idempotency and queryable receipts. Direct
CLI operations depend on synchronous output and internal operation records. The
browser is a held foreground process rather than a durable local service.

The current Beads backend proved useful graph operations but spreads one logical
transition over external graph calls and file-backed state. It is not the target
authority for redesigned runs.

## Reset invariants

* The reset occurs on the redesign branch and remains recoverable through Git.
* One change must not leave a misleading hybrid that appears production-ready.
* The new workspace builds and tests immediately after old implementation removal.
* No new package imports current domain, application, runtime, configuration, or
  compatibility code.
* New names follow redesigned responsibilities rather than current package names.
* Every preserved test is rewritten against a new public contract before it can
  influence implementation structure.
* No placeholder claims compatibility with current runs or definitions.
* No old dependency remains merely because deleting it is inconvenient.
* The default executable exposes only implemented, evidence-backed behavior.

## Slice 1: Canonical work and completion

Implement a new domain-only vertical slice in the reset workspace with an
in-memory test store:

1. Define workflow, phase, task, criterion, asset, completion, candidate, gate,
   approval, closure, and escalation contracts.
2. Compile the current standard workflow and one plan artifact into the new
   graph.
3. Submit one task completion account with workflow-defined evidence.
4. Build one phase candidate and run one gate.
5. Record one approval and closure.
6. Recover from a fresh process after each durable boundary.

Disproof criteria:

* The graph requires more cross-representation joins than the current model.
* Completion omissions remain possible without a durable finding.
* The phase candidate cannot identify its exact task set and inputs.
* Replay depends on mutable current pointers.

## Slice 2: Durable command and supervisor

1. Submit one canonical command over local IPC.
2. Persist its receipt before acknowledging it.
3. Restart the supervisor.
4. Wake one separately fenced runner.
5. Complete or refuse the command exactly once.
6. Observe the same result through CLI query and SSE.

Disproof criteria:

* Lost client output requires guessing whether to resubmit.
* Supervisor process state is required for recovery.
* Direct recovery can race a healthy runner.
* Portal and CLI need different mutation semantics.

## Slice 3: Embedded transactional authority

1. Atomically commit command, graph revision, events, receipt, lease fence, and
   dispatch intent.
2. Stage and install immutable artifact bytes safely.
3. Inject crash, disk-full, stale lease, and failed migration cases.
4. Benchmark status, event stream, claim, and transition workloads.
5. Export and re-import a terminal run deterministically.

Disproof criteria:

* A committed state references missing immutable content.
* Two writers both believe they own one lease or claim.
* Recovery needs backend-specific business logic outside the persistence port.
* Packaging makes the default less distributable than the current external
  dependency.

## Slice 4: Additive amendment

1. Let a scoped agent propose one task and one phase against an exact graph
   revision.
2. Present normalized impact to a human.
3. Approve the proposal digest.
4. Apply at a quiescent boundary.
5. Prove existing unrelated work remains current.
6. Refuse a stale completion for affected work.

Disproof criteria:

* Approval applies a different normalized graph than the reviewed proposal.
* Additive work retroactively changes a completed candidate.
* Unrelated tasks are invalidated only because a global revision changed.

## Slice 5: Context and parallel integration

1. Create exact context bases and a shared phase-input barrier.
2. Run two isolated worktrees from one base.
3. Exercise disjoint success and deliberate same-file conflict.
4. Serialize integration and run a post-integration gate.
5. Restart during integration and reconcile exactly once.
6. Prove every sibling completion ordering creates the same fan-in candidate.

Disproof criteria:

* Siblings observe partial work or changing canonical inputs.
* A task closes before required integration succeeds.
* Late cancelled output reaches the integration target.
* Fan-in depends on completion timing.

## Slice 6: Remote partition simulator

1. Accept a command at a mock control plane.
2. Duplicate delivery to the repository supervisor.
3. Disconnect before and after local acceptance.
4. Attempt stale approval and revoked-runner delivery.
5. Show explicit projection staleness.
6. Prove only local storage authorizes repository effects.

Disproof criteria:

* Central acceptance is mistaken for local execution.
* A partition permits unapproved authority expansion.
* Tenant or repository identity can be supplied by the client.

## Reset and implementation order

1. Tag or record the pre-reset commit through normal Git history.
2. Remove current applications, packages, legacy definitions, demos, and
  implementation-bound tests.
3. Recreate the smallest buildable workspace with one kernel package and one
  test package.
4. Add domain contracts and the pure deterministic reducer.
5. Add completion candidate and escalation semantics.
6. Add the canonical command and receipt service.
7. Add the embedded authority, then supervisor and runner separation.
8. Add additive amendments and context bases.
9. Add isolated parallel workers and integration.
10. Add the remote control plane.

The order may change when a probe exposes a dependency. It must not change to
preserve an old package boundary or runtime format.

## Why not keep a parallel legacy tree

A quarantined vNext tree is useful when users, active runs, or published APIs
need a compatibility window. None do here. Keeping both implementations would:

* Double navigation and build surfaces
* Encourage imports from convenient legacy helpers
* Preserve Beads and file-runtime dependencies longer than necessary
* Make tests ambiguous about which product they describe
* Delay package and terminology cleanup
* Create a compatibility promise the alpha does not need

Git already provides rollback and archaeology. The WIP research and probes
preserve the useful learning. A second executable implementation would add
confusion rather than safety.

## Why not keep only the devcontainer

Deleting documentation, probes, and generic repository tooling would erase the
reasoning and failure evidence that make a clean rewrite safer than a first
attempt. The goal is implementation freedom, not amnesia.

The reset should remove assets that encode the old product while retaining
assets that help falsify the new one.

## Documentation migration

During the redesign:

* These WIP research documents own the proposed direction.
* Retired numbered guide paths remain historical signposts only.
* Probe findings remain authoritative for measured behavior.
* Roads Not Taken remains the durable record of rejected approaches.
* The decision log indexes promotion status.

Once a slice is accepted, create or update the authoritative guide that owns the
concept and remove duplicated proposed contracts from research. Do not let WIP
become a second permanent architecture manual.

## Open reset decisions

* Embedded database library and schema migration tooling
* Exact post-reset package graph and naming
* Which probes remain relevant enough to keep runnable
* Whether root tooling is simplified or recreated
* Minimum supported operating systems and Node version
* Which probes require live model spend

## Current anchors

The principal historical implementation surfaces were
`packages/domain/src/workflow.ts`, `packages/domain/src/runtime.ts`,
`packages/application/src/run-services.ts`,
`packages/application/src/input-manifests.ts`,
`packages/domain/src/commands.ts`, and `packages/browser/src/supervisor.ts`.