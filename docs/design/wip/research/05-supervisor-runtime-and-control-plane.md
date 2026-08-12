# Supervisor, Durable Runtime, and Control Plane

This document records proposed redesign research for process topology,
persistence, command delivery, local clients, and remote portals. It does not
define current architecture.

## Executive finding

Redesigned runs should use one Senawa-owned transactional authority for graph
state, revisions, events, leases, command receipts, dispatches, and current
projections. A local supervisor provides process liveness and a versioned API. A
separately fenced runner performs transitions and external effects.

Beads is not the redesigned authority. It may remain a compatibility reader for
old runs or receive one-way projections, but it does not decide transitions for
new redesigned runs.

## Authority layers

| Layer | Responsibility | Must not do |
|-------|----------------|-------------|
| State machine | Validate commands and compute legal transitions | Own processes or external sessions |
| Run store | Atomically persist authoritative coordination state | Invent workflow policy |
| Artifact store | Persist immutable content and evidence by digest | Act as mutable graph authority |
| Runner | Acquire lease, perform transitions, invoke workers and sensors, reconcile effects | Choose transitions outside the reducer |
| Supervisor | Accept commands, manage runner liveness, wake runs, serve clients | Store truth only in memory or bypass leases |
| Worker | Perform one scoped assignment and submit claims or proposals | Approve, schedule, or mutate canonical state |
| Sensor | Produce one bounded reading | Apply lifecycle consequences |
| Control plane | Authenticate remote users, route commands, synchronize allowed projections | Hold repository credentials or local execution leases |

The supervisor is important but replaceable. Killing it must not lose a command
that was reported durable or make a run unrecoverable.

## Transactional run authority

The initial production target is a single-host embedded relational database,
subject to packaging and durability probes. SQLite is the leading candidate, not
a settled library choice.

One transaction should be able to commit:

* Expected and resulting graph revisions
* Definition child revision
* Command receipt state
* Domain events and event cursor
* Phase, task, candidate, and escalation projections
* Claims and cancellation fences
* Lease fences and heartbeats
* Dispatch intent or outcome
* Active-run ownership

Immutable artifact bytes may live in a content-addressed file or blob store. The
database records their descriptors and digests. A committed transition must not
reference bytes that were never durably installed. Blob staging and transaction
recovery therefore need an explicit protocol.

Repository files remain useful for consumer definitions, exported reports, and
deterministic diagnostic bundles. They are not credible concurrent coordination
state.

## Why Beads is removed from authority

The current production composition distributes authority between Beads and
multiple file-backed stores. That design proved useful graph and claim behavior,
but it imposes an external installation, multi-authority recovery, adapter
latency, and Beads-specific lifecycle rules on every consumer.

The redesigned kernel needs transactions spanning command receipts, graph
revisions, events, leases, and dispatch state. A Senawa-owned store can define
that contract directly.

Migration rules:

* New redesigned runs use the embedded authority.
* Existing run identities keep their recorded backend for read, report, and
  controlled resume while compatibility is supported.
* Active backend identity is never silently rewritten.
* Terminal runs may be exported and imported through a validated neutral format.
* Beads projection, if retained, is asynchronous and non-authoritative.

## Durable command service

Every mutation uses a canonical envelope containing:

* API version and command ID
* Authenticated principal and transport attribution
* Repository and run identity
* Typed intent and payload digest
* Expected graph and definition revisions
* Exact candidate version and digest when applicable
* Optional expiry

The service returns a durable receipt. Reusing a command ID with identical
content returns the same receipt. Reusing it with different content is refused.

Receipt stages include:

```text
queued
  -> claimed
  -> completed
  -> refused
  -> expired
  -> cancelled
  -> unknown-effect
```

Remote delivery adds stages before local acceptance:

```text
accepted-by-control-plane
  -> delivered-to-repository
  -> accepted-locally
  -> claimed-by-runner
  -> completed-or-refused
```

HTTP `202 Accepted` means durably queued at the accepting layer. It never means
the workflow transition completed.

## Runner contract

A runner performs one bounded transition:

1. Acquire a fenced lease.
2. Read one exact state revision and queued command or ready-work trigger.
3. Ask the deterministic reducer for the legal transition plan.
4. Persist intent before any external effect.
5. Invoke the worker, sensor, integration operation, or artifact write.
6. Heartbeat the lease and record bounded output.
7. Reconcile the result against intent and semantic freshness.
8. Atomically persist outcome, events, projections, and receipt.
9. Release the lease or return a declared waiting boundary.

Repeated `run once` calls must be idempotent under crash and duplicate wake-up.
The supervisor may optimize by keeping a runner alive across several transitions,
but the durability contract remains one transition at a time.

## Local supervisor

The local per-user supervisor is the normal V1 deployment shape. It:

* Discovers registered repositories
* Accepts typed commands into durable inboxes
* Serves versioned queries and streams
* Starts and restarts runners
* Wakes runs after approvals, answers, timers, or capacity changes
* Enforces local worker and resource capacity
* Manages process logs, graceful drain, upgrades, and shutdown
* Hosts the local portal

It does not choose the next transition, infer human approval, own model context,
or provide durability through process lifetime.

V1 can support one active run per repository and one worker at a time while the
parallel contracts are probed. One supervisor may manage several repositories,
provided repository identity and per-repository leases are explicit.

## Local transports

The CLI and portal are clients of one semantic API.

* CLI automation should prefer a Unix socket or Windows named pipe protected by
  operating-system ownership and a user-only credential where needed.
* The portal uses loopback HTTP and SSE.
* Both transports call the same command and query handlers.
* Direct foreground execution remains a recovery, diagnostic, and CI path. It
  acquires the same lease and cannot race a healthy runner.

The local HTTP adapter needs host and origin validation, short-lived bootstrap,
revocable sessions, secure rendering, bounded payloads, and no permissive CORS.

## HTTP API shape

Illustrative resources:

```text
GET  /api/v1/capabilities
GET  /api/v1/repositories/{repository}/runs/{run}
GET  /api/v1/repositories/{repository}/runs/{run}/events?after={cursor}
POST /api/v1/repositories/{repository}/runs/{run}/commands
GET  /api/v1/repositories/{repository}/runs/{run}/commands/{command}
GET  /api/v1/repositories/{repository}/runs/{run}/receipts/stream
GET  /api/v1/repositories/{repository}/runs/{run}/artifacts/{artifact}
```

SSE is sufficient for run and receipt updates because commands use ordinary
HTTP requests. WebSockets are justified only by a future bidirectional feature,
such as a live terminal.

Stable contracts should cover commands, receipts, projections, principals,
authorization decisions, event replay, artifact descriptors, runner intents,
and capability negotiation. Cookie names, static routes, bootstrap URLs, and
exact SSE paths are implementation details.

## Remote portal topology

Repository supervisors should not expose their authoritative API directly to a
LAN or public internet. They sit beside source, Git and model credentials,
workers, artifacts, and repository write authority.

Remote access uses a separate control plane:

```text
remote portal or CLI
        |
        | HTTPS, identity, authorization
        v
portal and control plane
        ^
        | outbound authenticated connection
        |
repository supervisor -> runner -> workers and sensors
        |
        v
local run store, assets, and repository
```

The control plane owns remote identity, sessions, repository membership,
object-aware authorization, command routing, and bounded synchronized
projections. The repository supervisor connects outbound, validates protocol and
capabilities, and rechecks every delivered command against local policy,
revisions, candidate digests, and authority.

Repository credentials, model credentials, source, full artifacts, and
execution leases remain local. Workflow and organizational policy decide which
status, logs, evidence, artifacts, or excerpts may be synchronized.

## Remote identity and authorization

Remote clients require durable principal identity, not a client-supplied actor
channel. The accepting service derives issuer, subject, tenant, authentication
assurance, and repository membership.

Initial roles may include viewer, operator, approver, and repository
administrator, but authorization remains object-aware. It considers command
kind, repository, run, exact candidate, workflow policy, principal relationship,
and required assurance. High-impact decisions may require recent MFA or another
step-up mechanism.

Portal sessions use HTTPS, secure host-only cookies, CSRF protection, exact
origins, expiration, and revocation. VPNs and tunnels protect transport but do
not replace user authorization.

## Network partitions

During a partition:

* The local supervisor may continue deterministic work already authorized by
  local policy and available budget.
* Remote approvals, amendments, and authority expansions remain pending until
  delivered and accepted locally.
* Every remote projection exposes repository cursor and observation time.
* Duplicate command delivery is harmless through command IDs and payload
  digests.
* Execution leases remain repository-local.
* Unknown delivery or effect state remains explicit rather than guessed.

## Worker and sensor channels

Workers are not general supervisor clients. A runner gives each worker a scoped
binding for its assignment. It can read granted context, submit completion,
publish candidate assets, ask questions, report discoveries, and propose
amendments.

Sensors receive only the declared candidate and capability-limited execution
context. Neither channel can approve, mutate arbitrary graph state, enumerate
other runs, or widen authority.

## Service lifecycle

The supervisor needs:

* Per-user installation, start, stop, status, and logs
* Authenticated discovery through a conventional runtime location
* Atomic binary and database-schema upgrades
* Drain and rollback behavior
* Crash-loop detection
* Log rotation and bounded retained diagnostics
* Backup, integrity check, deterministic export, and repair commands
* A direct foreground recovery path independent of service startup

Supervisor version, store schema, runner protocol, workflow API, and worker-host
capabilities negotiate independently.

## Distribution

The first channel should be a published npm CLI and supervisor package matching
the current Node implementation, plus versioned scaffold assets. Standalone
binaries and a container image can follow after native dependencies, database
packaging, signing, and platform behavior are proven.

`init` should create an example workflow profile and sensor policy, record
template versions and generated-file digests, never overwrite existing policy,
and never start paid work. A workflow-free blank initialization may remain an
explicit option.

## Current foundations and divergence

Useful current foundations include:

* A loopback HTTP server with host and origin checks
* Versioned API routes and SSE cursors
* Durable browser command IDs, payload digests, and receipts
* Driver and web leases
* Intent and outcome reconciliation
* Full persistence ports that can become the redesign boundary

Current limitations include:

* The browser supervisor is tied to a foreground command and one run.
* Direct CLI mutations lack equivalent caller-recoverable receipts.
* Actor channels are attribution, not authenticated human identity.
* The production authority is split between Beads and files.
* Current leases are same-host and do not establish distributed authority.
* Output sanitation is not a general secret-redaction boundary.

Historical implementation anchors included
`packages/browser/src/supervisor.ts`, `packages/domain/src/commands.ts`, and
`packages/application/src/ports.ts`.

## Open decisions

* Embedded SQLite integration and Node distribution
* One supervisor per user or per repository
* Repository identity across moves, clones, forks, and worktrees
* Local authentication and peer-credential portability
* Remote synchronized-data classes and retention
* First remote profile: hosted, enterprise self-hosted, or private gateway
* Disconnected execution policy
* Human identity and step-up assurance
* Cross-host workers and leases
* Backup, export, and active-run migration guarantees

## Required probes

* Compare embedded-database packaging options on supported platforms.
* Commit graph, receipt, event, lease, and dispatch state in one transaction.
* Inject crashes before and after every external effect and commit boundary.
* Exercise duplicate commands, lost responses, lease takeover, and supervisor
  restart.
* Conformance-test command and receipt contracts across local transports.
* Simulate remote duplicate delivery, partitions, revocation, and stale approval.
* Threat-model daemon discovery, portal bootstrap, artifacts, and upgrades.