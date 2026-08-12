# Redesign Research

This folder is the proposed research record for rethinking Senawa as the
deterministic kernel of a consumer-defined software factory. It replaces the old
single-document redesign narrative and historical architecture monolith with
focused documents that can be challenged, probed, and promoted independently.

The former numbered guides are retired compatibility pages. These research
documents and the comprehensive plan govern the reset until validated phases are
promoted into new authoritative guides. Probe Findings remains the authority
for measured historical behavior.

## Reading order

| Order | Document | Question |
|-------|----------|----------|
| 1 | [Product Vision and Design Principles](01-product-vision-and-principles.md) | What product are we building, and where is authority? |
| 2 | [Canonical Domain Model and Workflow Authoring](02-canonical-domain-and-workflows.md) | What are the kernel primitives, and how do consumers compose them? |
| 3 | [Completion, Gates, Escalation, and Closure](03-completion-gates-and-escalation.md) | How does Senawa prevent false completion and stop safely? |
| 4 | [Cross-Agent Context and Parallel Execution](04-context-and-parallel-execution.md) | How do zero to many agents share trajectory and work concurrently? |
| 5 | [Supervisor, Durable Runtime, and Control Plane](05-supervisor-runtime-and-control-plane.md) | How is work persisted, driven, observed, and accessed remotely? |
| 6 | [Current-System Divergence and Redesign Migration](06-current-divergence-and-migration.md) | Where does the repository diverge, and how can the redesign be disproved cheaply? |

## Established product direction

The discussion has established these intentions, subject to implementation
evidence:

* Consumers define workflows, approvals, evidence policy, and delivery loops.
* Senawa provides deterministic workflow primitives and enforcement rails.
* Agents can propose phases and tasks, but humans authorize graph amendments.
* Completion is an explicit account with workflow-defined evidence, not a force
  close operation or a claim of universal verification.
* Runs and accepted assets survive process loss and can restart from durable
  boundaries.
* Sensors associated with an exit gate run before a phase becomes eligible for
  approval or closure.
* The local supervisor is the normal process boundary for CLI and portal clients.
* Remote portals use an authenticated control plane and outbound repository
  supervisor connections.
* Redesigned runs use a Senawa-owned embedded transactional authority. Beads is
  not part of the new authority model.
* Senawa is alpha software. The redesign may break every current API, file
  format, package, command, and persisted run without a compatibility layer.
* Cross-agent context comes from immutable assets and exact context bases rather
  than chat-history inheritance.
* Parallel execution requires snapshot isolation, isolated workspaces,
  deterministic fan-in, and serialized integration.

## Evidence and decision discipline

The research deliberately does not treat old decisions as constraints. Existing
code and design are used to identify proven strengths, failure modes, migration
risks, and cheap disproof tests.

Before promoting a recommendation:

1. Add or update the matching decision-log entry.
2. State one falsifiable question.
3. Build the smallest probe that can disprove the recommendation.
4. Record measured behavior in Probe Findings.
5. Promote accepted contracts into a new authoritative guide.
6. Move rejected rationale into Roads Not Taken.

## Research provenance

The consolidated documents incorporate independent 2026-08-12 reviews of
ontology, mutation, completion, sensors, transition authority, executable work,
agent routing, persistence, supervisor lifecycle, command UX, schema
extensibility, parallelism, approvals, distribution, network topology, context
dataflow, and context consistency.

Those exploratory notes were inputs, not architecture authorities. The focused
documents in this folder are the maintained WIP synthesis.