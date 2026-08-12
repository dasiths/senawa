# Canonical Domain Model and Workflow Authoring

This document records proposed redesign research. It does not define current
architecture or settle the final YAML grammar. See
[Product Vision and Design Principles](01-product-vision-and-principles.md) for
the product boundary and terminology classifications.

## Executive finding

Senawa should compile consumer-owned workflow definitions and admitted artifact
content into one revisioned, typed run graph. Storage may use a shared node
envelope, but distinct entities retain distinct semantics. A generic node that
can behave as phase, task, criterion, evidence, or approval would weaken type
safety and authority.

Workflow and artifact files remain ergonomic authoring formats. The canonical
graph is the normalized execution model.

## Canonical entities

### Workflow

A workflow is a versioned consumer process definition. It declares initial graph
shape, role bindings, dataflow, completion policy, gate use, approval points,
amendment policy, recovery behavior, and finite limits.

### Run

A run is one durable workflow instance for one request. It has immutable
definition ancestry, a revisioned effective graph, an append-only history,
current projections, budgets, and an artifact namespace.

### Phase

A phase is an executable or aggregate stage. It may contain tasks, depend on
other phases, declare phase criteria, consume and publish assets, run gates, and
require approval. Its completion is represented by an immutable candidate and
closure record, not only a mutable status.

### Task

A task is the narrowest independently assignable work contract. It has stable
identity, one owning phase, dependencies, criteria, role binding, context inputs,
completion policy, and finite limits. Dispatch attempts do not change task
identity.

### Criterion

A criterion is an explicit obligation. It has stable identity, required or
optional policy, an applicability rule, and workflow-defined accounting and
evidence requirements.

### Asset

An asset is immutable content with a logical name, version, digest, schema,
media type, provenance, trust, and sensitivity. Plans, research, reports,
completion submissions, readings, and source excerpts may all be assets without
sharing authority.

### Completion submission

A completion submission is an actor's immutable disposition and account. It is
not closure. The reducer checks its completeness and applies workflow policy.

### Sensor, condition, and gate

A sensor measures an external condition and emits a reading. A condition is a
pure predicate over exact readings and a bounded state projection. A gate
combines acquisitions and conditions into an evaluation. Lifecycle consequences
belong to the workflow node that invokes the gate.

### Approval

An approval is an authority decision over an exact immutable object. It records
principal, channel, policy, object digest, decision, reason or note, and time.

### Amendment

An amendment proposal describes typed graph operations against an exact base
revision. An approved amendment creates a child definition revision. It never
rewrites completed history.

### Escalation

An escalation is a durable statement that autonomous policy cannot legally
continue. It names the trigger, exhausted or missing authority, unresolved work,
and workflow-permitted human responses.

### Dispatch

A dispatch is one attempt to perform phase or task work. It freezes role,
profile, model resolution, capabilities, context basis, repository base, limits,
session, operation, and trace identity.

## Graph model

The graph needs typed edges rather than one ambiguous dependency relation.

| Edge | Meaning |
|------|---------|
| `contains` | Phase owns task or criterion |
| `depends-on` | Readiness requires accepted predecessor result |
| `consumes` | Dispatch or artifact used an exact asset |
| `produces` | Actor or work item created an asset |
| `satisfies` | Account or evidence addresses a criterion |
| `supports` | Evidence is cited in support of a claim |
| `contradicts` | Reading or finding disputes a claim |
| `supersedes` | New generation replaces an earlier generation without erasing it |
| `approved-by` | Exact candidate received an authority decision |

Containment and executable dependency graphs must be acyclic. Supersession chains
must also be acyclic and terminate in a current generation.

Every canonical entity has:

* Immutable internal identity
* Stable consumer-facing key scoped by kind and parent
* Definition revision and generation
* Definition digest
* Source artifact, version, digest, and JSON Pointer when materialized
* Created event and actor provenance

Status, attempt counters, sessions, and budgets exist only on entity kinds that
own those behaviors.

## Definition and run revisions

The initial workflow snapshot is definition revision 1. An amendment creates a
child revision with:

* Parent revision and digest
* Typed operations
* Proposer and proposal context
* Human approval identity and digest
* Impact analysis
* Normalized resulting definition
* Application event and resulting graph revision

Commands include expected definition and graph revisions. Semantic conflicts are
reported rather than automatically rebased.

Pending work may be added or replaced after whole-graph validation. Active work
requires cancellation fencing and reconciliation. Completed work is immutable;
changed obligations create superseding or revalidation work.

V1 should begin with additive phases and tasks applied at a quiescent driver
boundary. Removal, dependency rewiring, gate weakening, and completed-work
invalidation require separate decisions and probes.

## Executable-work boundary

Consumer artifacts are immutable source documents, not mutable runtime state.
Senawa needs an explicit admission boundary that produces a canonical
`executable-work` manifest.

Credible integration forms are:

1. The consumer artifact embeds a canonical executable-work section.
2. A declarative, version-bound mapping projects a compatible document.
3. A frozen deterministic adapter transforms a document when mapping cannot.

Schema identity or annotations never grant graph-mutation authority. A workflow
must explicitly authorize materialization. Senawa validates the source schema,
projection, canonical schema, graph invariants, roles, capabilities, limits, and
source provenance before committing one graph revision.

Software-specific properties such as repository paths and change expectations
belong in typed effects or profile payloads. They should not be mandatory fields
of every canonical task.

## Workflow responsibilities

A workflow definition owns:

* Initial phases, tasks, dependencies, and dataflow
* Role assignments and allowed overrides
* Input and output asset contracts
* Completion and evidence policy
* Gate references and lifecycle consequences
* Human approval points
* Amendment classes and required authority
* Rework, dispatch, sensor, integration, and iteration limits
* Restart, invalidation, and supersession policy
* Concurrency and isolation requests

The kernel implicitly supplies identity, validation, deterministic readiness,
atomic claims, revisions, receipts, leases, immutable history, recovery, and
authority enforcement. Supervisor, HTTP, storage, and portal settings do not
belong in workflow YAML.

## Illustrative workflow

The following example demonstrates minimum semantics. It is not a selected
grammar.

```yaml
apiVersion: senawa.dev/workflow/vNext
kind: Workflow
metadata:
  name: research-plan-implement

spec:
  input:
    schema: ../schemas/request.schema.json

  amendments:
    allow: [phase.add, task.add]
    propose: [agent, human]
    apply: human

  defaults:
    task:
      limits:
        workAttempts: 3
        dispatchFailures: 2
      onExhausted: escalate
      completion:
        summary: required
        evidence: workflow-defined

  phases:
    research:
      tasks:
        investigate:
          role: researcher
          output:
            name: research
            schema: ../schemas/research.schema.json

    plan:
      dependsOn: [research]
      tasks:
        prepare:
          role: planner
          context: [research]
          output:
            name: plan
            schema: ../schemas/plan.schema.json
      exit:
        approval: human

    implement:
      dependsOn: [plan]
      concurrency: 4
      isolation: worktree
      tasks:
        implement-change:
          role: implementor
          context: [plan, research]
      exit:
        gate: implementation-ready

    verify:
      dependsOn: [implement]
      tasks:
        assess:
          role: verifier
          context: [plan, implementation-results]
      exit:
        approval: human
```

Unsettled authoring alternatives include:

* Maps keyed by IDs versus lists containing `id`
* Nested tasks versus flat tasks with phase references
* `dependsOn` versus `needs` versus top-level typed edges
* Direct phase executors versus phases containing synthetic tasks
* Inline context declarations versus reusable dataflow policies
* Embedded executable work versus a digest-bound sidecar

## Sensors and gates

Completion accounting is kernel behavior. Sensors exist only for external
measurement. A sensor-free workflow is valid when it references no gate.

Illustrative sensor configuration:

```yaml
apiVersion: senawa.dev/sensors/vNext
kind: SensorPolicy

sensors:
  typecheck:
    uses: command
    with:
      argv: [pnpm, typecheck]

  tests:
    uses: command
    with:
      argv: [pnpm, test]
      timeout: 10m

gates:
  implementation-ready:
    all:
      - sensor: typecheck
        expect: pass
      - sensor: tests
        expect: pass
```

Gate location remains undecided. Named gates colocated with sensors, inline
workflow conditions, and a separate gate file can compile to the same typed
condition tree. Undefined references and unknown blocking readings fail closed.

Retry, rework, escalation, and approval do not belong to the sensor definition.
They are lifecycle policy on the workflow node invoking a gate.

Command sensors need argument-vector execution without a shell, closed stdin,
constructed secret-free environments, bounded output, process-group timeout,
explicit network and write capabilities, and isolated execution. Repository
configuration cannot grant a sensor access beyond Senawa's security ceiling.

## Role and model policy

Workflow tasks name semantic roles. A role profile supplies durable instructions
and requests capabilities. A separate model policy resolves portable tiers,
provider mappings, permitted task hints, escalation rules, and spend ceilings.

The dispatch records both requested and resolved values. Model changes never
widen tools or data access. Escalation to a stronger model normally starts a
fresh session with immutable prior outputs and failure evidence.

## Current divergence

The current implementation splits semantics across:

* Static `WorkflowPhase` definitions
* Small mutable `RuntimePhase` records
* Plan phases that compile away into task dependencies
* `RuntimeTask` values coupled directly to the built-in plan schema
* Nested criteria and evidence references
* Special `import-plan` and divergent additive `plan revise` paths

The task frontier associates imported tasks with one implementation phase and
accepts that phase when all runtime tasks are closed. It has no durable phase
candidate, explicit membership revision, or general structural amendment.

The redesign should compile the existing workflow and plan into the canonical
model before replacing the driver. A compatibility projection can preserve old
queries while migration proceeds.

## Open decisions

* Final workflow and sensor grammar
* Phase execution model
* Evidence identity and sharing granularity
* Canonical JSON serialization and digest rules
* Amendment operations and authority levels
* Whether accepted work can become stale without explicit revalidation nodes
* Condition-tree operators and state projection
* Policy-module imports and minimum organizational policy
* Model-tier vocabulary and provider portability

## Research provenance

This synthesis incorporates the 2026-08-12 ontology, active-run mutation,
executable-work, schema-extensibility, workflow-sketch, sensor-policy, command
UX, approval-authority, and model-routing reviews. Current implementation anchors
included the former `packages/domain/src/workflow.ts`,
`packages/domain/src/artifacts.ts`, and `packages/domain/src/sensors.ts` files.