# Senawa Design

The design is split by reader question. Numbered guides describe the current
architecture. The [design working record](wip/README.md) holds proposed
decisions, probe findings, abandoned approaches, and the historical monolith.

Current guidance wins when the working record disagrees with it. Probe findings
remain the authority for what was measured.

## Recommended reading order

Read the guides in order on a first pass. The sequence moves from mental model to
behavioral contracts, then into implementation internals.

| Order | Guide | Question it answers | Concepts introduced |
|-------|-------|---------------------|---------------------|
| 1 | [System Model](01-system-model.md) | What is Senawa, and who controls it? | Nested loops, principal agent, driver, workers, bounded autonomy |
| 2 | [Workflows and Lifecycle](02-workflows-and-lifecycle.md) | How does a request become restartable work? | Workflows, phases, artifacts, iteration, approval, resume |
| 3 | [Agents and Interaction](03-agents-and-interaction.md) | What may each session do, and how does the human participate? | Principal agent, worker roles, command authority, interaction modes, isolation |
| 4 | [Sensors, Gates, and Enforcement](04-sensors-gates-and-enforcement.md) | How does Senawa decide that work is sound? | Sensor extensions, assessments, gates, backpressure, frozen set, policy layers |
| 5 | [Runtime and State](05-runtime-and-state.md) | Where does live state reside, and how does execution recover? | Beads graph, driver transitions, leases, reconciliation, cache, parallelism |
| 6 | [Provenance and Observability](06-provenance-and-observability.md) | How can a run be audited after its sessions are gone? | Work directory, journal, report, traces, costs, rendering safety |
| 7 | [Implementation and Operations](07-implementation-and-operations.md) | How should the system be built and operated? | Packages, CLI groups, build slices, substrate limits, open decisions |

## Reading paths

### Product and architecture review

Read [System Model](01-system-model.md),
[Workflows and Lifecycle](02-workflows-and-lifecycle.md), and
[Agents and Interaction](03-agents-and-interaction.md). These establish the
human experience, authority boundaries, and lifecycle without requiring beads or
SDK implementation detail.

### Quality and policy implementation

Read [Sensors, Gates, and Enforcement](04-sensors-gates-and-enforcement.md), then
the command authority and containment sections in
[Agents and Interaction](03-agents-and-interaction.md).

### Runtime implementation

Read [Runtime and State](05-runtime-and-state.md), followed by
[Provenance and Observability](06-provenance-and-observability.md) and
[Implementation and Operations](07-implementation-and-operations.md).

### Decision archaeology

Start with the [Probe Findings](wip/probe-findings.md), then use
[Roads Not Taken](wip/roads-not-taken.md) and the
[original monolith](wip/multi-agent-orchestration.md) for rationale and context.

### Maturing a new idea

Start an entry in the [Decision Log](wip/decision-log.md), identify the owning
guide and evidence needed, then use the smallest coherent probe to resolve it. The
[working record guide](wip/README.md) defines the full promotion path.

## Concept ownership

Each concept has one primary home. Other guides link to it rather than redefining
it.

| Concept | Primary guide |
|---------|---------------|
| Nested control loops and authority | [System Model](01-system-model.md) |
| Consumer `.senawa` layout, workflow schema, worker profiles, phase iteration, and artifacts | [Workflows and Lifecycle](02-workflows-and-lifecycle.md) |
| Principal agent, workers, sessions, and human interaction | [Agents and Interaction](03-agents-and-interaction.md) |
| Sensor policy location, gate language, backpressure, and enforcement | [Sensors, Gates, and Enforcement](04-sensors-gates-and-enforcement.md) |
| Beads mapping, state machine, driver, resume, and concurrency | [Runtime and State](05-runtime-and-state.md) |
| Snapshot inputs, journal, report, traces, and cost attribution | [Provenance and Observability](06-provenance-and-observability.md) |
| Package boundaries, initialization, CLI grouping, build plan, and open questions | [Implementation and Operations](07-implementation-and-operations.md) |
| Proposed decisions and promotion status | [WIP Decision Log](wip/decision-log.md) |
| Measurements and invalidated assumptions | [WIP Probe Findings](wip/probe-findings.md) |
| Discarded approaches and revival conditions | [WIP Roads Not Taken](wip/roads-not-taken.md) |

## Documentation rules

* Current-state behavior belongs in exactly one numbered guide.
* Cross-cutting summaries link to the owning guide instead of copying contracts.
* New ideas begin in the decision log, not in a current-state guide.
* Measurements belong in the probe README and findings record.
* Displaced rationale belongs in Roads Not Taken.
* The WIP monolith is preserved and does not receive new current-state design.
* A behavior described as measured links to the evidence that established it.

## Relationship to probes

Each folder under [experiments/probes/](../../experiments/probes/README.md) owns
one subject and includes its
goal, limits, reproduction command, and dated changes. When evidence changes the
architecture:

1. Create or update the decision-log entry.
2. Update the owning probe.
3. Record the result in the findings document and decision entry.
4. Update the numbered guide that owns an accepted concept.
5. Move rejected or superseded rationale to Roads Not Taken.
