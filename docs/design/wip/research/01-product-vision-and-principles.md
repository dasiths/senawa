# Product Vision and Design Principles

This document records proposed redesign research for the alpha reset. The former
numbered guides are retired. Research becomes authoritative only after focused
implementation and probe evidence is promoted through the
[decision log](../decision-log.md).

## Research status

The product direction in this document comes from the redesign discussion and
independent tradeoff reviews performed on 2026-08-12. It has not yet passed an
implementation probe.

Use these classifications throughout the research set:

| Classification | Meaning |
|----------------|---------|
| Established direction | Product intent clarified during the redesign discussion |
| Working recommendation | Preferred option after tradeoff analysis; still requires evidence |
| Current fact | Behavior observed in the repository today |
| Open decision | Product choice or technical question that remains unresolved |

## Product thesis

Senawa is the deterministic kernel of a consumer-defined software factory. A
consumer decides what delivery means: which phases exist, what work is
assignable, which artifacts matter, where human judgment is required, which
evidence accompanies completion, and how failure or discovery changes the
process.

Senawa supplies the rails that make those choices executable:

* Durable workflow and run state
* First-class phases, tasks, criteria, assets, and dependencies
* Deterministic legal transitions
* Finite attempts, failures, time, concurrency, and spend
* Capability ceilings and scoped worker dispatch
* Completion accounting and workflow-defined evidence requirements
* Sensors, gates, approvals, amendments, and escalations
* Crash recovery, immutable history, receipts, and reports

Research-plan-implement is one workflow profile, not the product model. The same
kernel should support migrations, release trains, incident response, compliance
review, design work, and consumer-specific delivery loops without acquiring
domain-specific scheduling policy.

## Responsibility boundary

### Consumers own

Consumers define:

* Workflow topology and phase meaning
* Task decomposition and dependency policy
* Artifact schemas and domain terminology
* Worker roles and durable role instructions
* Evidence requirements
* Sensor configuration and gate composition
* Approval points and authorized amendment classes
* Rework, escalation, restart, and supersession policy
* Model-routing requests within Senawa ceilings
* Data sensitivity and remote-synchronization policy

### Senawa owns

Senawa defines and enforces:

* Stable identity, revisions, and immutable generations
* Graph, lifecycle, and dependency invariants
* Command validation and deterministic reduction
* Completion-accounting semantics
* Authority checks and exact-object decision binding
* Worker capability ceilings and asset grants
* Leases, claims, cancellation fences, and integration serialization
* Durable receipts, events, recovery, and audit
* Finite effective limits for every autonomous loop
* Content integrity and provenance

The kernel owns the semantics of a phase, task, criterion, claim, evidence
attachment, sensor reading, gate evaluation, approval, amendment, escalation,
and closure. It does not own the consumer's delivery sequence or artifact
payload shape.

## Deterministic spine

LLMs contribute semantic judgment and content. They do not own canonical control
state.

Agents may:

* Research and create artifacts
* Propose phases, tasks, criteria, and dependencies
* Implement assigned work
* Submit completion summaries and evidence
* Report blocked work and ask questions
* Suggest amendments or stronger validation

Agents may not:

* Choose an unvalidated transition
* Apply their own graph amendment
* Close work by assertion
* Approve an artifact or authority expansion
* Weaken gates, budgets, or capability ceilings
* Rewrite accepted assets or history

A deterministic reducer validates every proposal against the exact run revision,
workflow policy, graph invariants, authority, budgets, and context basis. The
same state and accepted command must produce the same transition regardless of
which model proposed it.

This does not make model-authored content reproducible. It makes the control
decision independently inspectable and replayable.

## Bounded autonomy

Every autonomous cycle needs a finite effective limit. A repository may select
the limit, but an omitted limit must resolve to a finite kernel or organizational
default rather than infinity.

Independent counters are required for:

* Valid work attempts followed by a refused gate
* Worker dispatch and infrastructure failures
* Sensor execution failures
* Human-rejected candidate iterations
* Context rebases and integration conflicts
* Wall-clock deadlines
* Concurrent workers and integration slots
* Model usage or monetary spend

Exhaustion creates a durable escalation. The engine cannot silently add budget,
switch authority, weaken policy, or keep retrying.

## Human authority

Human decisions are explicit commands over exact immutable objects. Positive
language, silence, a request to continue, or a principal agent's interpretation
is not approval.

Phase-level approval is the normal semantic checkpoint for workflows that need
human review. Additional authorization may be required before high-risk effects,
such as deployment, destructive mutation, credential use, permission changes,
gate weakening, budget expansion, or cancellation of active work.

Agents may propose graph expansion during any workflow step. A proposal contains
its base revision, rationale, impact, and exact candidate operations. It changes
nothing until an authorized human approves the proposal digest. Senawa then
applies it at a safe transition boundary.

## Completion as accounting

Senawa should not pretend it can prove every evidence claim. The basic safeguard
is explicit accounting:

* Every task receives a terminal disposition
* Every declared criterion receives an explicit outcome
* Every completion includes a summary of the work
* The workflow decides which evidence attachments are mandatory
* Sensors or verifiers may evaluate evidence when configured
* Gates and approvals remain separate from the worker's claim

Asking an agent to name what it did, including relevant files, lines, artifacts,
or commands, forces it to revisit the task instead of relying on a vague claim of
completion. The attachment is attributed evidence, not verified truth.

## Durable trajectory

Workflow trajectory lives in durable state and immutable assets, not model
memory. A fresh process or fresh agent can reconstruct the exact accepted plan,
research, decisions, dependency results, and current work contract.

Crash recovery resumes from the last durable transition and reconciles any
in-flight effect. An explicit restart from an earlier phase creates new
iterations and supersedes affected downstream results. It never deletes prior
artifacts, approvals, or evidence.

Agents consume exact, content-addressed context bases. Provider transcripts are
optional execution aids, not workflow authority.

## Operating model

The local supervisor is the normal process boundary. The CLI and portal submit
the same typed commands to its durable inbox and observe the same projections
and receipts. A fenced runner performs transitions, invokes workers and sensors,
and reconciles effects.

The supervisor provides liveness, not correctness. The run store and immutable
assets provide durability. A direct foreground path remains available for
recovery, diagnostics, and CI, and it acquires the same lease as the supervisor.

Remote portals use a separate authenticated control plane. Repository
supervisors connect outbound and retain source, credentials, leases, and final
command authorization locally. An internet-facing tunnel to a repository
supervisor is not a substitute for identity and authorization.

## Agent and model strategy

The design separates four concerns:

| Concern | Purpose |
|---------|---------|
| Role | Provider-neutral semantic responsibility such as planner or implementor |
| Worker profile | Durable instructions and requested capabilities |
| Model policy | Allowed model tiers, routing, escalation, and spend ceilings |
| Dispatch | Exact resolved model, effort, context, capabilities, attempt, and outcome |

Workflows select roles, not arbitrary provider flags. A deterministic policy may
resolve an expensive tier for high-leverage planning and an economy or standard
tier for narrow implementation. Task hints remain bounded requests. A stronger
model never receives stronger capabilities merely because it costs more.

## Experience goals

A consumer should be able to:

1. Install Senawa and initialize versioned example assets without starting paid
   work.
2. Define workflows, schemas, roles, sensors, gates, and approval policy.
3. Validate the complete definition set before starting a run.
4. Start and observe durable work through the CLI or portal.
5. Review artifacts, questions, completion accounts, escalations, and amendment
   proposals.
6. Recover after process loss without redoing accepted phases.
7. Export a deterministic report showing trajectory, inputs, actors, models,
   evidence, decisions, costs, and remaining uncertainty.

The command grammar and portal composition remain design questions. The command
service, identity, receipt, and authority semantics must be shared across every
client.

## Current facts

The repository currently demonstrates several principles worth preserving:

* A deterministic driver selects transitions.
* Workers request completion but do not directly close tasks.
* Phase artifacts are versioned and approvals can bind version and digest.
* Task attempts and dispatch failures are separate counters.
* Resolved phase inputs are persisted with exact versions and digests.
* Driver leases, atomic claims, intent records, and reconciliation support
  restart.
* Browser commands already use durable idempotent receipts.

The current product is not the target design:

* The standard workflow and artifacts are software-delivery-specific.
* Workflow phases, plan phases, and runtime tasks use different representations.
* Production state is split between Beads and files.
* Only one worker turn can run, and plan parallelism is advisory.
* Structural phase amendments and first-class escalations are absent.
* Browser receipt guarantees are stronger than direct CLI guarantees.
* Run-wide spend limits are described but not enforced.

## Working recommendations

The research currently favors:

* One typed canonical run graph compiled from consumer artifacts
* A clean implementation reset in the existing repository rather than an
  in-place refactor or legacy-compatible strangler
* Controlled, revisioned amendments rather than unrestricted live mutation
* A Senawa-owned embedded transactional store for redesigned runs
* Content-addressed immutable assets outside worker-writeable paths
* Layered context packs with lazy authorized reads
* Snapshot isolation for every dispatch
* A local supervisor with HTTP semantics and durable asynchronous receipts
* Serial execution until worktree isolation and integration fencing are proven
* Portable model tiers resolved by deterministic policy

Each recommendation needs a focused probe before it becomes current guidance.

The reset recommendation preserves Git history, redesign research, measured
probes, and useful generic tooling. It does not preserve current public or
internal contracts. New package and type boundaries should follow the redesigned
responsibilities rather than mirror current names.

## Open decisions

* Which amendment operations V1 permits beyond adding phases and tasks
* Whether a phase executes directly, contains tasks, or supports both forms
* Whether canonical executable work is embedded in consumer artifacts or stored
  as a digest-bound sidecar
* Which evidence floor the kernel requires before workflow overrides
* Which remote deployment profile follows local V1
* How human principal identity and step-up authentication work across clients
* Which operating systems and embedded-database distribution are supported first
* When parallel workers and multiple active runs enter the product
* Which model-routing and spend policies are justified by measured runs

## Research basis

This synthesis draws on the current code and design guides plus the 2026-08-12
tradeoff reviews for transition authority, agent routing, human interaction,
approval authority, persistence, distribution, and supervisor topology. The
companion documents in this folder carry the detailed domain, completion,
context, runtime, and migration analysis.