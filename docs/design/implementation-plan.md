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
* Optional parallel task execution in isolated workspaces with serialized
  integration
* A Senawa-owned embedded transactional authority with no Beads dependency
* A supervisor process with one API shared by CLI and portal
* Local HTTP and SSE plus an authenticated remote control-plane protocol
* An installable alpha with initialization, diagnostics, backup, export, and
  end-to-end tests
* Major decisions and plan deviations recorded while implementation proceeds
* A commit and push after the reset and after every implementation phase
* A final research-backed consumer documentation phase covering philosophy,
  architecture, usage, operations, security, and troubleshooting
* One pull request for the complete implementation after every phase is
  validated, committed, and pushed

## Scope boundary

The alpha includes a complete local product and a complete remote protocol with
a deterministic control-plane simulator. It does not include operation of a
production hosted multi-tenant service, billing, production OIDC, regional
failover, cloud object storage, or distributed execution leases.

Initial product limits:

* One active run per repository
* Additive phase and task amendments only
* One serialized repository integration slot
* Repository workspace execution by default, with one writer and no Git
  worktree operations
* Git worktree execution only through explicit consumer configuration
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
| `packages/execution-host` | Worker, sensor, bounded-process, optional Git worktree, integration, and context-read adapters |
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

## Phase 10: Optional parallel workspaces and integration

### Goal

Execute dependency-ready tasks under a configured workspace mode with one
serialized integration slot. The default repository mode is serial. Explicit
worktree mode enables isolated parallel writers.

Phase 10A through 10E are complete. Configuration, pure planning, bounded
runner scheduling, durable capacity, workspace and integration authority,
trusted barriers, deferred completion, execution-host Git effects, and scoped
workspace file tools are implemented. Production composition now selects
repository or worktree behavior per immutable run, dispatches exact workspace
effects, rechecks completion eligibility, and converges publication after
restart. The first Phase 10F independent review rejected the implementation.
The review repairs add authority-derived production stage emission, immediate
fail-fast cancellation, current integration-slot fencing before publication,
exact successful-barrier completion selection, and descriptor-confined
single-file workspace mutations. A second Phase 10F re-review also rejected the
implementation. Its repairs require exact current task-generation dispatch and
integration cohorts, durable admission of later runner scopes without resetting
accounting, authority reassertion in the final publication window, bounded
two-attempt semantic rework, and parent-directory swap confinement. Final
independent re-review, validation, and delivery remain in Phase 10F.

### Acceptance

* Effective concurrency respects workflow, supervisor, host, and resource limits.
* `execution.workspaceMode` accepts `repository` or `worktree` and defaults to
  `repository` when omitted.
* Repository mode creates no worktrees and limits effective writer concurrency
  to one.
* Worktree mode requires explicit configuration, a verified Git repository,
  isolated worktrees, and an immutable base for every writer.
* Siblings cannot observe partial work.
* Integration is fenced, durable, restartable, and followed by configured gates.
* Publication inspection and compare-and-swap require the exact live current
  integration-slot owner and fence.
* Production derives restartable stable stage commands from graph, status,
  dispatch, completion, workspace, integration, and barrier authority.
* Workspace patch authority accepts one file per operation and performs
  descriptor-confined compare-and-rename under a root lock.
* Fan-in digest is independent of completion order.
* Failed siblings do not cancel unrelated work unless workflow selects fail-fast.
* Fail-fast aborts still-pending admitted siblings and durably records every
  observed failure or cancellation.

### Validation

* Configuration default, explicit opt-in, invalid modes, and worktree-disabled
  execution that never calls Git worktree operations
* Disjoint edits, same-file conflicts, semantic conflicts, cancellation, and
  task-local failure in explicit worktree mode
* Post-integration failure and rework
* Restart while integration owns or has expired the slot, including higher-fence
  takeover and a crash between trusted runtime barrier and workspace barrier
* Every sibling completion permutation
* Resource and spend cap scheduling
* Failed-first and successful-later semantic rework, plus ambiguous successful
  barrier refusal
* Parent and target symlink swaps and concurrent expected-text patch races
* Worktree tests create a fresh temporary Git repository outside the Senawa
  checkout, including when Senawa is mounted into a devcontainer

### Disproof

* Task closes before required integration.
* Late cancelled output reaches the target.
* Fan-in depends on timing.
* Parallel execution can mutate canonical state outside Senawa.
* Default execution creates or requires a Git worktree.
* A test adds, removes, or mutates a worktree in the Senawa repository.

### Commit

`feat: add isolated parallel execution`

## Phase 11: Local portal

### Goal

Provide an operational portal for graph inspection, artifacts, questions,
approvals, amendments, escalations, receipts, and run control.

Phase 11A is complete. Exact human authority commands, immutable question
answers, policy-bounded allowance grants, and durable pause, resume, ending,
and ended modes now precede portal query and UI work.

Phase 11B is complete. Browser-safe bounded portal DTOs, revision-vector query
authority, authenticated loopback static hosting, exact session descriptors,
and verified optional manifest composition now precede the protocol-only
browser application. No frontend package or browser automation was added.

Phase 11C is complete. A frameworkless protocol-only browser package now builds
verified static assets and implements immutable state, bounded transport,
cursor-vector resynchronization, exact pending command recovery, hostile-safe
rendering, review dialogs, and responsive operational views. Real browser
journeys, screenshots, overlap inspection, and delivery remain Phase 11D.

The Phase 11C allowance review gap is closed before Phase 11D. One exact,
browser-safe authority projection now binds an unresolved escalation to its
current budget, allowance policy, graph, and run mode. The portal can construct
`grant-allowance` only from that complete projection and remains locked when any
fact is missing, inconsistent, resolved, or stale.

Phase 11D is complete. Deterministic desktop, mobile, visual, reconnect,
session-expiry, authority-decision, cross-run overlap, same-run event race, and
run-control journeys now execute against a fresh temporary SQLite authority and
the production loopback composition. The browser harness composes no worker or
model adapter and performs no inference. Independent review repairs preserve
reviewed form values, close authority on run changes, retain pending identities
for lookup-only rebootstrap, fence run/route assemblies and stream generations,
clear stale expired projections, scope artifact previews by run, and remove
closed compact rails from the accessibility tree.

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
* Human authority duplicate, stale, unauthorized, crash, race, and reopen tests
* Run-control revision, cancellation, stale-output, and restart convergence

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

Phase 12 is complete. The alpha now includes strict behavior-free remote wire
contracts, canonical repository remote policy, transactional SQLite inbox,
outbox, per-run event checkpoints and independent history commitments, an
Ed25519-authenticated supervisor connector, an optional fail-closed daemon
composition, and a restart-ephemeral protocol-only reference control plane with
deterministic partition simulation. Every command remains locally reauthorized;
central acceptance and delivery never imply local execution.

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

Phase 13 is complete. The Linux x64 glibc alpha now packages and installs from
deterministic local tarballs, includes portal assets, migrations, and native
helpers, and keeps the optional paid worker outside the core install graph.
Default init creates and durably syncs `.senawa/workflow.json`. Deterministic
secret-safe reports and non-restorable exports, bounded maintenance operations,
security ceilings, hostile fixtures, and one complete no-credit acceptance
journey are implemented and independently reviewed.

### Acceptance

* Default `senawa init` durably creates `.senawa/workflow.json` without
  overwriting an existing directory or file. An explicit path continues to
  create exactly that file path.
* The alpha keeps workflow structure, schemas, roles, model policy, sensors,
  gates, and execution policy in the one canonical `.senawa/workflow.json`
  document. Configuration splitting and import resolution remain deferred
  unless Phase 13 research proves a deterministic contract is necessary.
* Reports reconstruct graph, trajectory, actors, models, assets, context,
  amendments, escalations, gates, approvals, costs, and uncertainty.
* Backup, restore, export, integrity, repair, diagnostics, and service operations
  are documented and tested.
* npm package installs cleanly on declared platforms.
* Security ceilings cover payloads, outputs, processes, paths, networks, secrets,
  sessions, and retention.
* Public documentation matches only implemented behavior.

### Validation

* Default and explicit-path init journeys, including existing destination,
  partial-write, file-sync, and parent-directory-sync failures
* Clean-install matrix
* Deterministic report and export golden tests
* Backup/restore and corruption journey
* Hostile schema, artifact, output, archive, path, and network tests
* Full no-credit workflow with completion, approval, amendment, configured
  worktree integration in a temporary Git repository, escalation, crash
  recovery, portal observation, and remote simulation
* Opt-in live worker smoke test with cost warning

### Disproof

* Installation depends on undeclared global tools.
* Report cannot explain an accepted transition.
* Recovery or export loses provenance.
* Documentation advertises unimplemented authority or hosting.

### Commit

`feat: complete senawa alpha`

## Phase 14: Standard delivery workflow authoring

### Goal

Make the default workflow a complete define, research, plan, implement, and
verify delivery method. Add external agent prompts, arbitrary consumer schemas,
typed phase dataflow, schema-selected task fan-out, plan import, bounded
iteration and rework, and human exit approvals without treating prompts, model
output, or files as workflow authority.

### Required research

Run a fresh RPI research cycle after Phase 13. The research must:

* Compare the historical `standard-delivery.yaml` semantics with the final
  kernel, configuration, context broker, amendment, scheduler, portal,
  reporting, packaging, and security boundaries.
* Define a breaking alpha configuration contract for external prompt resources,
  arbitrary JSON Schemas, phase executors, typed data mappings, output
  artifacts, iteration, plan import, and per-item task-frontier loops.
* Threat-model prompt and template injection, path escape, resource replacement,
  schema substitution, stale phase output, unstable task identity, duplicate
  fan-out, plan-import races, resumed-session drift, and unbounded loops.
* Select deterministic migration diagnostics. Do not add legacy runtime
  compatibility or silently reinterpret v1alpha2 documents.

Research artifacts remain temporary. Record accepted choices and rejected
alternatives in the implementation log.

### External prompts

* Consumers define each agent role's system prompt through a project-relative
  external UTF-8 file, such as `.senawa/prompts/researcher.md`. Prompt bodies do
  not live inline in the workflow JSON.
* Prompt resource paths are relative to the configuration root, normalized,
  bounded, regular-file-only, symlink-refusing, and confined beneath `.senawa`.
  Absolute paths, parent traversal, alternate separators, special files, and
  replacement races fail closed.
* Configuration compilation reads prompt resources through an injected port,
  stores their exact content digests and byte lengths in the immutable snapshot,
  and reports drift when bytes change. Runtime replay never resolves current
  path contents for a historical dispatch.
* Agent roles reference one prompt resource and one model policy by exact key.
  Prompt bytes and digests flow through immutable contexts, dispatches, resumed
  sessions, and local audit records.
* Default reports, exports, diagnostics, portal DTOs, and remote synchronization
  expose prompt identity and digest only. They do not expose prompt bodies.

### Schemas and dataflow

* Schemas remain arbitrary consumer-owned JSON Schema 2020-12 resources. Senawa
  validates schema safety, references, bounds, and instances, but does not impose
  domain-specific definition, research, plan, task, or verification shapes.
* Schema declarations may reference project-relative external JSON files beneath
  `.senawa/schemas` instead of embedding schema bodies in workflow JSON. Schema
  resources use the same confined, regular-file-only, symlink-refusing,
  content-addressed loading boundary as prompt resources. Historical snapshots
  retain exact schema bytes and never resolve the current file for replay.
* Workflow input, each named phase output, and each generated task input declare
  schema references independently. Senawa binds the schema key and digest into
  the configuration snapshot and validates values at every publication boundary.
* Phase outputs are content-addressed immutable JSON artifacts. Publication
  binds phase generation, attempt, output name, schema digest, content digest,
  producing dispatch, context, graph revision, and configuration snapshot.
* A phase input map uses exact source references and JSON Pointers. A mapping
  may read workflow input, a dependency phase's accepted output, the current
  fan-out item, or allowlisted implementation evidence. It writes one declared
  input key or JSON Pointer in the destination object.
* A mapping equivalent to
  `phase2.input.abc = phase1.output.blah.abc.xyz` is represented as a source
  phase/output plus source pointer `/blah/abc/xyz` and destination pointer
  `/abc`. No JavaScript, JSONPath, shell, property evaluation, or arbitrary
  expression language is executed.
* Mappings are dependency-checked, cycle-free, bounded, collision-free, and
  evaluated over immutable source digests. Missing pointers, changed source
  generations, type conflicts, duplicate destinations, and schema-invalid
  assembled inputs fail closed.

### Prompt templates

* External prompt files may contain deterministic substitutions such as
  `${{ input.abc }}`. The template language supports only declared input paths
  and an explicit small namespace. It has no function calls, conditionals,
  loops, environment access, file reads, network access, or authority APIs.
* Scalar values render as bounded text. Structured values render as canonical
  JSON inside an explicit untrusted-data delimiter. Missing tokens, undeclared
  paths, invalid UTF-8, output overflow, and recursive substitutions fail closed.
* The rendered prompt separates Senawa's trusted authority boundary, the
  consumer's configured system prompt, and quoted untrusted mapped data. Prompt
  text cannot approve, close, grant allowance, import plans, dispatch effects,
  or mutate graph authority.

### Schema-constrained agent outputs

* Each agent dispatch receives one `submit_phase_output` custom tool for its
  declared output slot. Senawa derives the tool parameter schema from the exact
  accepted output schema and immutable phase context. The SDK schema guides the
  model, but Senawa always performs authoritative runtime validation again.
* The tool accepts a bounded wrapper containing `output` and optional
  agent-declared change notes. `output` is arbitrary consumer data governed only
  by the declared JSON Schema. Change notes are non-authoritative metadata.
  Actual repository changes remain host-observed workspace and Git evidence.
* The tool handler canonicalizes the payload, enforces output byte and node
  limits, validates the accepted schema resource and profile, installs the
  content-addressed JSON asset, creates the exact validation receipt, and submits
  the existing metadata-only `phase-output` fact through the context broker.
* Invalid output is not accepted or published. The tool returns a bounded,
  machine-readable failure to the same agent session with stable code, instance
  JSON Pointer, schema pointer, and keyword. It never returns schema bodies,
  secrets, repository content, or internal exception text.
* The agent may correct and resubmit within a finite output-attempt budget.
  Invalid attempts, findings digests, tool-call identities, and the eventual
  accepted submission are durably attributable without treating rejected bodies
  as phase authority. Exhaustion follows the phase iteration or escalation
  policy.
* Exact accepted replay is idempotent. Reusing an output slot, submission
  identity, or tool-call identity with different canonical content conflicts.
  A crash after asset, validation, submission, or outbox commit converges without
  duplicate publication.
* A phase cannot submit successful completion while a required output slot is
  absent. An accepted output still does not close or approve the phase: normal
  completion assessment, exit gate, human approval, and closure authority remain
  required.
* Writing `output.json` in a temporary workspace is only a research fallback if
  the SDK cannot express the accepted schema as a custom tool. Mutable file
  polling is not the production contract. Any fallback must use a confined,
  exclusive path, exact digest, explicit submit action, and the same validation
  and feedback semantics.

### Structured output research and proof

* Phase 14G first probes the pinned Copilot SDK custom-tool behavior in isolation.
  The probe uses an accepted consumer schema, an intentionally invalid first
  tool call, a structured Senawa validation response, a corrected second call,
  and one accepted canonical output. It records whether the model receives and
  acts on tool failure feedback in the same session.
* The deterministic fake SDK probe is mandatory and no-credit. An optional live
  probe remains separately gated by explicit model, credit ceiling, timeout, and
  cost/data acknowledgement settings.
* Phase 14H implements the dispatch-scoped output coordinator, generated tool
  schema, staged canonical asset, validation receipt, broker submission, outbox
  delivery, retry ledger, crash recovery, and resume binding only after the
  probe establishes a viable SDK feedback path.
* Phase 14I proves the complete standard workflow with fixture agents that fail
  schema validation once and recover, plus an optional live probe. It covers
  multiple output schemas, repository edits alongside structured output,
  restart, replay, stale context, output-slot conflicts, attempt exhaustion,
  prompt injection, and reporting and portal secrecy.
* Senawa must not claim the structured-output path is production-ready until the
  Phase 14I proof gate passes. Passing unit codecs or accepting a manually built
  phase-output descriptor is insufficient evidence.
* Create and retain `docs/design/production-enhancements.md`. Every deferred
  production hardening item records observed evidence, current pragmatic
  behavior, risk and tradeoff, deferral reason, trigger for revisiting it, and a
  concrete acceptance test. The log cannot be used to defer correctness,
  authority, data-loss, secret-exposure, or unbounded-cost defects required by
  this phase.

### Schema-selected task loops

* A task-frontier phase may declare a finite `forEach` fan-out over one accepted
  phase output or mapped phase input. The source names the phase and output, a
  bounded JSON Pointer selects the collection, and a declared collection schema
  must validate the selected value as an array.
* Each selected item is validated against a declared item schema. A required
  stable identity pointer selects an opaque item identity. Duplicate, missing,
  non-string, oversized, or changed identities fail closed.
* A task template declares the generated task key namespace, role, prompt,
  model policy, budgets, completion policy, repository-change policy,
  dependencies, and input mappings from the current item and immutable phase
  data. Generated input must validate against its task input schema.
* Fan-out order is deterministic by stable item identity, not source array
  order. The selected collection, item schema, identity pointer, template,
  source output digest, and generated task set digest are immutable authority.
* Re-evaluating the same fan-out is idempotent. Added items propose new task
  generations through additive amendment authority. Removed or changed items do
  not silently delete or rewrite accepted work; they produce an explicit stale,
  supersession, or amendment review requirement.
* The loop declares hard bounds for selected items, active concurrency, total
  generated tasks, per-task dispatch failures, rework attempts, phase
  iterations, and exhaustion behavior. Exceeding any bound escalates or refuses
  according to the declared policy.
* Every generated task follows normal claim, workspace, completion, evidence,
  gate, integration, report, and replay authority. A loop selector cannot grant
  execution or graph authority by itself.

### Standard delivery behavior

* `define`, `research`, `plan`, and `verify` use schema-bound agent phase
  executors with external role prompts, named typed inputs and outputs, finite
  iterations, exact exit gates, and human approval.
* `plan` uses an explicit `import-plan` action. The approved plan output is
  schema-validated and translated into bounded additive task proposals. Import
  never mutates graph authority directly.
* `implement` uses a task-frontier executor with `forEach` over the approved plan
  task collection. Each task receives schema-mapped plan data, bounded rework,
  resumable session policy, finite dispatch failures, repository-change policy,
  and exhaustion escalation.
* `verify` maps definition, research, plan, and allowlisted implementation
  evidence into its typed input and produces a schema-bound verification output.
  Workflow completion requires the exact accepted verification gate and human
  decision.

### Acceptance

* All external prompt, schema, phase output, mapping, template, fan-out, import,
  iteration, rework, approval, and completion contracts above are enforced end
  to end and represented in deterministic reports.
* Default `senawa init` creates `.senawa/workflow.json`, external prompt files,
  and external schema files required by the standard authoring layout.
  Initialization remains exclusive, durable, non-overwriting, and fully
  validated by default `senawa doctor`.
* The repository's seeded `.senawa` example uses the same template and includes
  define, research, plan, implement, and verify with a schema-selected
  implementation loop.
* Consumer schemas remain domain-neutral. Senawa examples may provide opinionated
  schemas, but runtime behavior depends only on declared schema and mapping
  contracts.

### Validation

* Prompt path confinement, replacement race, size, UTF-8, drift, historical
  digest, secret-exclusion, and injection-separation tests
* JSON Pointer mapping, dependency cycle, missing source, destination collision,
  schema mismatch, stale output, and deterministic substitution tests
* Fan-out collection and item schema, stable identity, duplicate identity,
  source reorder, add/change/remove, bounds, concurrency, crash, replay, and
  amendment review tests
* Plan import duplicate, stale graph, stale approval, crash, authority widening,
  and concurrent import tests
* Complete no-credit define-to-verify journey with fixture agents, human
  approvals, imported plan tasks, per-task implementation loop, rework,
  implementation evidence, verification, and closure
* SDK custom-tool probe with invalid-first, feedback, corrected resubmission,
  exact acceptance, exhaustion, cancellation, and optional live behavior
* Generated output-tool schema tests for arbitrary consumer schemas, external
  references, bounds, canonicalization, and SDK adapter conversion
* Structured output plus repository-change tests proving model claims remain
  metadata while host-observed changes remain exact workspace authority
* Output staging and broker crash tests before and after asset, validation,
  submission, outbox, and phase-publication commits
* Default and packed-install init/doctor tests for workflow, prompts, and schemas
* Desktop and mobile portal journeys for outputs, approvals, iterations,
  generated tasks, rework, and verification

### Disproof

* Consumers must edit Senawa source to define prompts, schemas, mappings, or a
  per-task implementation loop.
* Prompt text, template expansion, a plan item, or an output file directly grants
  workflow authority.
* Fan-out task identity depends on source array order or current file contents.
* Plan import bypasses additive amendment or stale checks.
* Init generates files that doctor accepts but runtime cannot enforce.
* An invalid agent payload is accepted, silently repaired, or loses validation
  feedback needed for a bounded retry.
* A model-authored change list is treated as proof of repository changes.
* Production readiness is declared before invalid-first correction, restart,
  replay, and no-credit proof pass.

### Commit

`feat: add standard delivery workflow authoring`

### Current implementation status and session handoff

Status captured on 2026-08-15 from branch
`redesign/workflow-state-machine` at pushed checkpoint `9c7b899`. Phase 14 is
still in progress, but its authoring foundation is committed and the worktree is
clean at this handoff. Do not restart the phase or rewrite the checkpoint.

#### Completed implementation

* [x] Phase 14A is implemented. Workflow v1alpha3, confined external prompt and
  schema resources, immutable resource snapshots, deterministic migration
  diagnostics, prompt template substitution, and historical prompt binding are
  present.
* [x] Phase 14B is implemented. Workflow input binding, JSON Pointer input mapping,
  append-only phase attempts, schema-validated immutable output publication,
  output acceptance, and candidate and closure output binding are present.
  SQLite migration 010 owns durable phase dataflow authority.
* [x] Phase 14C is implemented. Finite iteration transitions, exhaustion behavior,
  upstream-change policy, exact resume lineage, and context, prompt, graph,
  generation, attempt, and input-binding drift refusal are present.
* [x] Phase 14D is implemented. Schema-selected `forEach` fan-out, stable item
  identities, current-item mappings, deterministic generated task sets,
  reviewed plan import through additive amendments, generated dependencies,
  bounded task-frontier scheduling, dispatch failures, rework, supersession,
  and restart replay are present. SQLite migration 011 owns durable frontier
  authority.
* [x] Phase 14E is implemented. Default and explicit init atomically publish the
  standard `.senawa` tree from one packaged inventory. The tracked tree contains
  `workflow.json`, five external prompt files, and twelve external schema files.
  Default doctor validates the generated tree. Portal Delivery and deterministic
  reporting expose bounded metadata only.
* [x] The default standard workflow declares `define`, `research`, `plan`,
  `implement`, and `verify`; human approvals; finite attempts; `import-plan`;
  a `/tasks` fan-out with `/id` stable identity; generated dependency mappings;
  bounded rework and dispatch failure policy; implementation evidence; and
  verification closure.
* [x] Focused suites for resources, mappings, phase outputs, iteration, resume,
  fan-out, plan import, scheduler behavior, portal metadata, reporting, atomic
  init, packaging, and the earlier operational no-credit journey have passed.
* [x] The last recorded broad green gate before the consolidated acceptance test was
  93 files and 1,214 tests passed with one opt-in live SDK test skipped. The last
  recorded browser gate was 15 Chromium tests passed. These results are stale
  until rerun after the current failing test is repaired.

#### Resolved Phase 14F blocker

`apps/senawa/src/standard-delivery-acceptance.test.ts` now passes. It drives
generated init and doctor, define, research, plan, reviewed plan import, two
generated implementation tasks with rework, implementation evidence, verify,
closure, portal Delivery, and secret-safe reporting without model credit.

The failure was a fixture ordering defect. The implement phase attempt was
started against the pre-import configuration snapshot and graph revision while
generated implementation contexts bound the post-import result snapshot, and
`compileWorkerContextBase` requires those digests to be equal. The attempt now
starts after the reviewed amendment applies. Repairs also corrected worker
context capabilities, authority reopen after each service stop, the projection
read path, and the delivery-kind assertion. Applying an approved amendment now
links its originating plan import, so the delivery ledger reaches `applied`.
Decision D-090 records the single command lifecycle phase per run.

#### Added structured-output subphases

* [ ] Phase 14G: research and probe the pinned SDK custom-tool feedback loop with
  arbitrary accepted output schemas and invalid-first correction.
* [ ] Phase 14H: implement the dispatch-scoped `submit_phase_output` coordinator,
  authoritative schema validation, canonical staging, structured feedback,
  bounded retries, broker publication, and crash replay.
* [ ] Phase 14I: prove schema correction plus repository changes through the
  complete no-credit workflow, add the optional live probe, and create the
  retained production-enhancements log.
* [ ] Phase 14J: run final independent authority, resource, output, replay,
  secrecy, SDK-feedback, and production-readiness review before delivery.

#### Remaining Phase 14 work

* [x] Repair the consolidated standard-delivery acceptance journey at the exact
  phase-attempt/input-binding mismatch and rerun that test until green.
* [x] Remove all lint and editor diagnostics from
  `apps/senawa/src/standard-delivery-acceptance.test.ts` with precise types.
* [ ] Confirm the test proves two generated tasks execute in stable dependency
  order, one bounded rework occurs, plan-import crash replay is idempotent,
  verification closes the run, and SDK adapter/model invocation counts remain
  zero.
* [x] Create and push authoring-foundation checkpoint `9c7b899` before starting
  the structured-output implementation. The checkpoint intentionally records
  the failing consolidated acceptance and unchecked continuation work.
* [ ] Complete Phase 14G SDK research and persist its evidence and selected
  implementation path in the implementation log.
* [ ] Complete and push the Phase 14H structured-output implementation checkpoint.
* [ ] Complete Phase 14I proof, production-enhancement logging, and any required
  repairs; push the validated checkpoint.
* [ ] Run focused Phase 14 suites for configuration resources and templates,
  kernel dataflow/fan-out/iteration/resume, runtime dataflow/import/prompt,
  SQLite migrations 010 and 011, supervisor plan import, standard template,
  atomic init, portal Delivery, reporting, packaging, and both no-credit tests.
* [ ] Run the full repository gates: build, typecheck, lint, complete offline
  tests, architecture boundaries, documentation links, package install, `git
  diff --check`, and the complete inference-free Playwright matrix.
* [ ] Run independent Phase 14J reviews for resource confinement and migration,
  output and closure authority, mapping and template injection, resume drift,
  fan-out identity and replay, amendment import, projection secrecy,
  schema-feedback correction, output staging, and the complete define-to-verify
  journey. Repair every critical and high finding and assess all medium findings.
* [ ] Regenerate or verify the tracked `.senawa` tree and browser screenshots
  only through their owning deterministic generators. Confirm default `senawa
  doctor` and packed-install doctor both pass.
* [ ] Remove temporary Phase 14 tracking artifacts and update the implementation
  log with final validation and review evidence.
* [ ] Create the final Phase 14 commit `feat: add standard delivery workflow
  authoring` if any phase changes remain after the pushed checkpoints, and push
  it.
* [ ] Add and push the Phase 14 delivery-record commit.
* [ ] Start Phase 15 consumer documentation only after Phase 14 is delivered.

#### Workspace constraints

* `/workspaces/senawa` is the only Git worktree. Any worktree-mode test must
  create and clean a fresh OS-temporary Git repository outside this checkout.
* Checkpoint `9c7b899` is pushed. No final Phase 14 delivery commit or delivery
  record has occurred.
* Phase 15 consumer documentation has not started. It remains the final
  implementation phase after Phase 14 delivery, followed by the single final
  pull request.

## Phase 15: Consumer documentation and adoption journeys

### Goal

Publish consumer-facing documentation that explains why Senawa exists, how its
authority model works, how the major components fit together, and how to adopt,
configure, operate, and troubleshoot the alpha without reading implementation
history or source code.

### Required research

Run a fresh RPI research cycle after Phase 14. The research must:

* Identify the primary consumer audiences and their first successful journeys.
* Review the final CLI, configuration schema, examples, package exports,
  operational limits, and security boundaries from the delivered code.
* Compare the implemented terminology with common workflow-engine, software
  factory, agent, and local-control-plane concepts without copying product
  documentation.
* Inventory questions that current README and reference pages do not answer.
* Select a documentation information architecture and record rejected
  alternatives in the implementation log.

Research artifacts remain temporary. The active repository retains only the
approved consumer documentation and the implementation log decision record.

### Acceptance

* A consumer overview explains the design philosophy: deterministic authority,
  immutable context, proposal-only agents, evidence-backed transitions,
  intent-before-effect execution, durable recovery, and local-first control.
* An architecture guide explains protocol, kernel, configuration, runtime,
  SQLite authority, execution host, supervisor, CLI, portal, control plane,
  reporting, and testing responsibilities without exposing obsolete packages.
* A getting-started journey covers installation, `senawa init`, configuration,
  `senawa doctor`, service startup, command submission, status, events, and
  shutdown using only implemented commands.
* Workflow authoring documentation covers workflow input, external prompt files,
  arbitrary schemas, phase executors, mapped inputs, output artifacts, template
  substitution, schema-selected task loops, plan import, iteration, rework,
  approvals, completion, roles, model routes, budgets, sensors, gates,
  projected work, and the default `execution.workspaceMode: repository`
  behavior.
* Optional worktree documentation states that `worktree` mode requires explicit
  configuration. Its examples and tests use a fresh temporary Git repository,
  never the mounted Senawa checkout.
* Operations documentation covers private local paths, credentials, loopback
  sessions, backup, restore, recovery, drain, logs, SDK session state, platform
  requirements, live-probe opt-in, and failure handling.
* Security documentation distinguishes principals, capabilities, grants,
  approvals, proposals, stale results, local transport trust, and remote
  control-plane trust.
* Troubleshooting and limitations describe the alpha platform matrix, required
  native build tools, JSON-only configuration, explicit live-model costs, and
  unsupported or deferred behavior.
* Examples are complete, bounded, link-checked, and executable without credits
  unless explicitly labelled as opt-in live examples.
* README becomes a concise entry point and links to the consumer documentation,
  references, examples, and design records.
* Documentation describes only behavior proven by the final implementation and
  clearly labels optional, experimental, and future features.

### Validation

* Fresh-install documentation journey in a temporary directory
* Default init assertions for `.senawa/workflow.json`, including nested sensor
  and gate configuration and non-overwrite behavior
* Command and configuration examples checked against built executables and exact
  codecs
* Documentation links, anchors, frontmatter, and terminology checks
* Consumer review by independent subagents for onboarding, architecture,
  operations, and security
* Hostile-copy and secret-leak review of examples and diagnostic output
* Desktop and narrow-width rendering checks for documentation pages where the
  chosen publishing surface supports them
* Final diff review proving no historical, WIP, or tracking artifacts remain

### Disproof

* A first-time consumer must inspect source code to complete the getting-started
  journey.
* Documentation advertises a command, option, authority, platform, or hosted
  service that the alpha does not implement.
* An example requires Git worktree support by default or mutates the Senawa
  repository during validation.
* Agent proposals, model text, central receipts, or prompt content are described
  as workflow authority.
* Backup, recovery, security, cost, or platform limits are omitted.

### Commit

`docs: add consumer adoption guides`

## Final pull request

After Phase 15 is independently approved, committed, and pushed:

* Fetch and compare the branch with the remote base branch.
* Generate a complete branch reference and review it in parallel chunks.
* Run every repository validation check from a fresh install.
* Run the complete desktop, mobile, visual, reconnect, session, and authority
  Playwright matrix in deterministic fixture mode. This mode must not compose a
  worker adapter, invoke a model, require credits, or honor live-worker opt-in.
* Present the final portal screenshots and offline interaction journey for human
  review before creating the pull request. Keep any paid live-worker smoke test
  separate, explicitly opted in, and clearly cost-labelled.
* Generate a consumer-readable pull request description covering the complete
  redesign, migrations, security model, validation, and known limits.
* Create one pull request from the implementation branch to the repository's
  default branch and report its URL.
* Remove temporary PR reference XML and subagent chunk artifacts while retaining
  the final PR analysis and description for local reference.

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
* Phase 15 consumer documentation passes its fresh research, journey,
  independent review, and link validation gates.
* The complete implementation branch is pushed and has one final pull request.
* The final implementation review states which planned contracts were accepted,
  changed, disproved, or deferred.