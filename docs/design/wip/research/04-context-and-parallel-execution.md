# Cross-Agent Context and Parallel Execution

This document records proposed redesign research for workflows with zero, one,
or many agents. It treats context as durable dataflow rather than inherited chat
history and treats parallelism as isolated execution plus deterministic
integration rather than simultaneous writes to one workspace.

## Executive finding

Every dispatch should receive one immutable, content-addressed context basis.
The prompt contains a bounded trajectory and asset catalog. Agents read complete
accepted assets lazily through scoped Senawa capabilities. Every result remains
bound to the exact context from which it was produced.

Parallel siblings share one frozen input barrier and cannot observe each other's
partial work. Fan-in uses an immutable contributor set. Repository-writing
agents require isolated workspaces and a serialized integration boundary before
their results satisfy downstream dependencies.

## Context is workflow data

An agent should not need another agent's transcript to understand trajectory.
Research, plans, decisions, completion reports, findings, and accepted outputs
are immutable workflow assets. A fresh agent or process can reconstruct the
exact state without relying on provider session retention.

Generated summaries help navigation but are not authoritative. Raw event streams
provide provenance but are too noisy and instruction-bearing for direct prompt
injection. Retrieval may improve discovery later, but it cannot replace exact
declared inputs.

The recommended model combines:

* Immutable assets with stable logical names and exact digests
* Explicit dataflow declarations
* Snapshot-isolated context bases
* Bounded deterministic prompt packs
* Lazy, capability-scoped full-asset reads
* Audited read receipts
* Result-bound dependency and aggregation barriers

## Asset contract

Each asset records:

* Content-addressed identity
* Stable logical name and monotonic version
* Media type, byte size, and canonical digest
* Optional schema identity and digest
* Producing run, phase, task, dispatch, actor, and context basis
* Trust classification
* Sensitivity classification
* Supersession relationship
* Senawa-owned content reference

Mutable aliases such as `current plan` remain catalog metadata. Senawa resolves
an alias to an exact asset version before dispatch. Workers never receive an
unresolved mutable alias as an authority-bearing input.

Canonical assets should be outside worker-writeable repository paths. A worker
may publish a candidate through a typed Senawa operation but cannot overwrite an
accepted plan or research result.

## Context basis

A context basis is the canonical dispatch snapshot. It contains:

* Run, workflow, definition, graph, and event revisions
* Phase and task contract generations and digests
* Exact dependency and phase-input barrier identities
* Exact asset bindings
* Repository or isolated-workspace base revision
* Role, profile, model-policy, and capability digests
* Criteria, limits, steering, and prior findings
* Sensitivity and provider-egress decisions
* One canonical digest over the complete basis

The context basis is persisted before external worker execution. Crash recovery
reuses it rather than resolving present-day aliases or mutable statuses.

## Prompt pack

The initial prompt is a bounded rendering of the context basis, not a second
source of identity. It contains four layers in descending authority:

1. Senawa control instructions and role policy
2. Work contract, criteria, capabilities, and limits
3. Deterministic trajectory projection
4. Asset catalog with summaries and opaque read handles

Small required assets may be included inline. Large assets use summaries and
handles. The trajectory projection can list accepted phases, current work,
approved amendments, predecessor outcomes, and declared asset summaries. It
must not invent conclusions that are absent from authoritative assets.

All artifact content, source excerpts, retrieval results, and worker-authored
summaries are labelled as data. Instructions found inside them cannot override
the role, task, capability, or workflow policy.

## Lazy asset reads

The worker receives typed operations similar to:

```text
senawa.context.list
senawa.context.read <handle> [--pointer <json-pointer>] [--cursor <cursor>]
```

An opaque handle binds:

* Run, dispatch, session, turn, and context-basis identity
* Exact asset digest
* Declared purpose
* Sensitivity ceiling and provider policy
* Expiry, maximum reads, and byte allowance

It is not a filesystem path, external URI, object-store URL, or general asset
identifier. One asset may not transitively grant another merely because its
content contains a reference.

Reads are bounded by JSON Pointer or opaque chunk cursor. Every allowed, refused,
and completed read produces an audit receipt with exact bytes and digest. A
workflow may require a read receipt before completion. That proves delivery, not
understanding.

## Workflow dataflow

Illustrative syntax:

```yaml
tasks:
  implement-change:
    role: implementor
    context:
      required:
        plan:
          from: phase.plan.output
          delivery: summary-and-reference
          freshness: current-at-completion
        research:
          from: phase.research.output
          delivery: reference
      available:
        - accepted-upstream-assets
```

The final syntax remains open. Equivalent forms include phase-level inputs,
typed `consumes` edges, and reusable context policies. Direct inputs should be
the default. Transitive asset visibility must be explicit rather than implied by
ancestry.

Useful freshness policies include:

| Policy | Meaning |
|--------|---------|
| `snapshot` | Result may complete against the original exact inputs |
| `current-at-dispatch` | Dispatch resolves current aliases once |
| `current-at-completion` | Relevant aliases must still resolve to the same versions |

Every policy still produces an immutable dispatch basis. A worker never receives
read-committed live context during one turn.

## Zero and one agent

The same contracts apply when no model runs. Human tasks, sensor-only work, and
external operations consume and publish assets through the same graph.

With one agent, context bases and barriers may appear more elaborate than a
direct prompt, but using them from the start prevents serial execution from
becoming a special case that blocks later parallelism and reliable recovery.

## Parallel fan-out

Before a phase dispatches parallel siblings, Senawa creates an immutable phase
input barrier containing:

* Exact phase and selected task-set revisions
* Shared accepted plan, research, and decision assets
* Upstream dependency results
* Repository integration base
* Policy and capability ceilings

Each sibling receives that barrier plus explicit task-specific dependencies.
Sibling completion order creates no implicit visibility or dataflow. One sibling
cannot silently update the plan seen by another.

An agent that discovers missing or conflicting work submits an amendment or
finding. The discovery does not become live shared context. Human approval and a
new graph revision determine whether affected tasks are rebased, superseded, or
allowed to finish against the prior basis.

## Fan-in and aggregation

Mutable statuses such as `all predecessors closed` are not a sufficient fan-in
contract. Senawa creates an immutable barrier candidate containing the exact
contributor task generations, accepted outputs, completion accounts, integration
results, and digests.

An aggregator or downstream task consumes that candidate. Results accepted after
the barrier was created are excluded until a new candidate is built. Every
completion ordering of the same compatible contributor set must produce the
same candidate digest.

Conflicting discoveries remain separate attributed claims until a human,
aggregator task, or deterministic policy resolves them.

## Repository isolation

Parallel repository writers cannot share a worktree safely. The first parallel
mode should use:

* One immutable Git base per dispatch wave
* One worktree and branch per task attempt
* Task-local validation inside each worktree
* Content-addressed commit or patch results
* Conservative overlap-aware scheduling
* One fenced integration slot
* Post-integration gates on the combined target

Disjoint declared paths are scheduling hints, not proof of semantic independence.
Shared definitions and canonical state remain inaccessible to worker writes.

Task completion, gate acceptance, integration, and dependency satisfaction are
separate states. A task result does not unlock dependents until its required
integration and post-integration checks succeed.

## Concurrency control

Effective parallelism is bounded by all applicable ceilings:

$$
\text{active workers} = \min(
\text{workflow limit},
\text{supervisor capacity},
\text{worker-host capacity},
\text{resource budget})
$$

The scheduler computes a dependency-ready frontier, applies stable deterministic
ordering, excludes conflicting workspace claims, and atomically claims up to the
effective limit. Graph and event writes remain serialized through Senawa even
when external workers execute concurrently.

## Stale results

Every output and completion submission includes its context-basis digest. Before
acceptance, Senawa atomically rechecks:

* Task contract generation
* Consumed asset versions
* Dependency and phase-input barrier
* Repository base and integration state
* Capability and policy generation
* Cancellation fence

An unrelated graph amendment should not invalidate a task. A changed consumed
plan, criterion, dependency, authority, workspace base, or aggregation set does.

Stale output remains immutable attributed evidence but cannot close current work
or satisfy a barrier. Staleness does not consume a logical rework attempt,
although usage, elapsed time, and repository effects remain recorded.

## Resume and rebase

Resume a provider session only when its context-basis digest remains unchanged.
A fresh dispatch is required after a material contract, input, dependency,
capability, model-tier, repository-base, or aggregation change.

A bounded additive change may create a rebased dispatch with an explicit context
delta. The worker still receives immutable prior findings and outputs through the
asset catalog rather than relying on an opaque transcript.

## Failure outcomes

Useful explicit outcomes include:

* `stale-before-evaluation`
* `stale-after-evaluation`
* `superseded`
* `rebase-required`
* `barrier-incomplete`
* `barrier-conflict`
* `integration-conflict`
* `integration-gate-failed`
* `context-corrupt`

Missing immutable content or a digest mismatch pauses the run as corruption.
Replay must never substitute current content for a missing historical asset.

## Security boundary

Context and repository access are separate capabilities. Asset grants do not
permit arbitrary source reads; source access does not permit canonical asset or
graph mutation.

Credentials are never assets. Logs and transcripts are restricted by default
and become downstream context only through explicit redacted excerpt assets.
External URIs are references, not worker fetch instructions. A trusted ingestion
service may retrieve approved content, enforce network and size policy, and store
the result by digest.

For remote workers, the repository supervisor remains the asset authority and
audits every read. It should broker content rather than distribute unrestricted
presigned URLs.

## Staged delivery

1. Keep concurrency at one while adding context bases, barriers, stale-result
   outcomes, and atomic semantic acceptance.
2. Probe two local worktrees with disjoint success, deliberate conflict,
   cancellation, local failure, post-integration failure, and restart.
3. Enable one active run with a small worker cap, wave dispatch, and one
   integration slot.
4. Standardize commit or patch result envelopes for local and remote workers.
5. Add multiple active runs and remote sandboxes only after resource scheduling,
   credential, retention, and cancellation policy are measured.

## Current divergence

The current resolved input manifest pins accepted artifact versions and digests,
which is a strong foundation. It is not a complete context basis: it lacks graph
and contract revisions, exact dependency-result barriers, repository base,
policy and capability digests, sensitivity policy, read budgets, and one
encompassing digest.

Current prompts eagerly include bounded content and derive some dependency state
from mutable runtime values. There is no authorized lazy full-asset read API.
Completion can be evaluated against pre-turn state and committed after a generic
revision retry without an atomic semantic-freshness check.

Current execution supports one active worker turn. `parallelizable` is authoring
metadata, and workflow concurrency is capped at one. Worktrees and integration
are explicitly deferred.

Historical implementation anchors included
`packages/application/src/input-manifests.ts`,
`packages/application/src/prompts.ts`, and `packages/domain/src/runtime.ts`.

## Open decisions

* Direct versus transitive asset visibility
* Required-read receipts
* Canonical JSON and digest serialization
* Prompt and read byte budgets
* Sensitivity classes and provider egress
* Rebase rules and provider-session reuse
* Quiescent-only versus provably disjoint amendment application
* Commit, patch bundle, or both as worker result
* Per-task, per-wave, and final integration gates
* Whether task closure waits for wave integration

## Required probes

* Prove canonical asset, context-basis, and barrier digests across restarts.
* Exercise lazy reads, limits, denials, sensitivity, and audit receipts.
* Test every sibling completion order and obtain one fan-in digest.
* Attempt stale completion before and after gate execution.
* Run the two-worktree conflict, cancellation, and integration matrix.
* Verify late cancelled output cannot alter the integration target or graph.