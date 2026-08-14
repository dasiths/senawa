---
title: Remote Control-Plane Reference
description: Alpha outbound connector, enrollment, trust, synchronization, and conformance limits
ms.date: 2026-08-14
ms.topic: reference
---

## Scope

Senawa ships an optional outbound repository connector, an ephemeral reference
control-plane authority, and a deterministic in-process fault simulator. It does
not ship or claim a production hosted control-plane service.

The local supervisor remains authoritative. A central acceptance is delivery
evidence, not permission to mutate a repository run. The connector persists and
verifies every envelope, intersects upstream roles with local mappings, and
submits the attribution-free command through the existing local supervisor API.
The local command service repeats authorization, expiry, graph, revision, exact
object, repository, and run checks.

## Production Configuration

The connector is disabled by default. Enable it by setting both variables in the
daemon environment:

```text
SENAWA_REMOTE_ENDPOINT=https://control.example.test/base
SENAWA_REMOTE_KEY_FILE=/private/path/remote-enrollment.json
```

The endpoint must be at most 2,048 characters. It must use HTTPS without user
information, query, or fragment. Plain HTTP is accepted only for `127.0.0.1` or
`localhost`. Senawa appends `/remote/v1alpha1/` beneath the configured base path.

The enrollment file is local operational state. It must be a regular file owned
by the daemon user with exact mode `0600`, cannot be a symbolic-link leaf, and
cannot exceed 64 KiB. Parsing is bounded and rejects unknown or missing fields.
The exact top-level fields are:

```json
{
  "apiVersion": "senawa.dev/remote-connector-enrollment/v1alpha1",
  "binding": {},
  "configurationSnapshotDigest": "<sha256>",
  "controlPlanePublicKeyPem": "<Ed25519 public key PEM>",
  "repositoryPrivateKeyPem": "<Ed25519 private key PEM>",
  "repositoryPublicKeyPem": "<matching Ed25519 public key PEM>"
}
```

The binding is the strict remote protocol repository binding. The referenced
canonical configuration snapshot must already exist in local SQLite state, must
contain a remote policy, and must have a remote component digest equal to the
binding policy digest. Role mappings, maximum authorization lease,
classification ceiling, synchronization allowlist, and disconnected mode come
from that snapshot. Endpoint and key fields never enter the snapshot.

## Client HTTP Contract

The production adapter is an outbound JSON client for these paths beneath the
derived endpoint:

* `POST hello`
* `POST commands/poll`
* `POST reports`

The connector completes `hello` before its first poll. The offer binds `peerId`
to the enrolled connector ID and advertises the one supported protocol version
and required capability set. A selection returns the session ID, server peer,
selected version, and capabilities. Senawa rejects typed negotiation refusals,
unsupported selected versions, and incomplete capabilities. It persists the
selection and includes the session ID in later polls and reports.

Command polls send the session, binding identity, contiguous local sequence,
and a bounded limit. Responses contain a non-negative revocation epoch and
strict deliveries. Each delivery contains the command envelope and the exact
server-created `connector-delivered` receipt entry. The connector validates the
entry against the envelope and central receipt digest, then persists the exact
bytes. It never recreates server evidence from its local clock.

Reports send session, connector, and repository key identities, the classified
report, and its Ed25519 signature. Responses contain one strict signed
acknowledgement whose binding, repository, report identity, sequence, digest,
and pinned key must match the claimed durable report. Response bodies are
bounded by the protocol wire limit, must be UTF-8 JSON, and must use
`application/json` with identity content encoding. The adapter refuses
redirects, declared and streamed bodies above 256 KiB, declared-length
mismatches, and responses that exceed the configured deadline. The default
deadline is 10 seconds and the hard maximum is 300 seconds.

Endpoint syntax validation does not provide SSRF or DNS-rebinding resistance.
Senawa does not resolve and pin destination addresses, disable host proxy
configuration, or reject private, link-local, metadata, and mixed DNS answers
for HTTPS hostnames. Operators must enforce the enrolled destination through an
egress firewall or trusted proxy and apply equivalent DNS and address policy
there. Do not expose the connector to attacker-selected endpoint values.

A compatible service is responsible for implementing these routes, transport
authentication, availability, retention, and production key enrollment. Senawa
does not expose a production hosted server for them.

## Cryptographic Binding

Ed25519 signatures cover fixed domain bytes followed by canonical unsigned
content. The behavior-free protocol package exports the command-envelope,
classified-report, report-acknowledgement, and receipt-entry domains. Protocol
performs no signing, verification, hashing, key loading, clock access, or I/O.
Signature text must be the canonical unpadded base64url encoding of exactly 64
bytes. Key construction and reference authority registration reject non-Ed25519
keys.

The reference authority accepts command actor identity through a separate
server-authenticated context. Extra actor data on the client request is ignored
and cannot select accepted tenant, repository, principal, or transport.

## Receipt And Synchronization State

The receipt chain contains five distinct stages:

1. `central-accepted`
2. `connector-delivered`
3. `local-accepted`
4. `runner-claimed`
5. `local-outcome`

Receipt authority follows the fixed stage sequence and each entry's
`previousEntryDigest`. Every `recordedAt` value remains signed or durable
evidence from the host that owns that stage, but timestamps from different
hosts do not establish receipt order. Server acknowledgements are accepted by
signature and exact report identity even when `acknowledgedAt` is ahead of or
behind the connector's local observation time. Same-host constraints, including
command acceptance before server-owned expiry and local claim time before claim
expiry, remain enforced.

Local service status includes connector and binding identities, lifecycle,
health, partition state, sanitized error code, contact timestamps, pending
counts, cursor lag, explicit `never-synchronized`, `current`, or `stale` state,
and bounded staleness milliseconds. It never includes endpoint, key-file path,
private key, command payload, source path, credential, lease, prompt, SDK
session identity, or asset content.

`continue-authorized-local` preserves already authorized local scheduling during
a partition. `pause-new-local-work` suppresses new production scheduling while
the connector reports a partition. Daemon startup performs one negotiated
contact attempt before recovery scheduling, so pause mode starts fail-closed on
cold start, restart, and endpoint failure. Continue mode may schedule existing
authorized local work after the same failed preflight. Neither mode admits a new
remote envelope, role, lease, policy, key, or revocation epoch without contact.

Local terminal evidence and its exact report are committed in one SQLite
transaction. A crash before commit leaves the inbox revisitable as
`local-accepted`; a crash after commit leaves both `local-result` and the report
outbox row recoverable. If local supervisor acceptance committed before the
inbox transition, replay reads the complete local receipt history and converges
from queued or terminal state.

Event metadata pages begin after a durable checkpoint for the exact binding and
run. Each report stores its run-local cursor advance beside the canonical
outbox row. Enqueue advances only that run's durable checkpoint in the same
transaction, and contiguous acknowledgement advances only the run checkpoints
covered by the acknowledged reports. Continuation reports select the least
recently enqueued relevant run, so overlapping cursor values and a faster run
cannot skip or starve another run. Binding synchronization status aggregates
the run checkpoints for health display; it is never used as a run-local page
cursor. If `synchronizationState` is false, all metadata streams are disabled
and the wire report carries empty receipt, event, and projection arrays plus a
zero, non-disclosing synchronization vector.

## Reference And Conformance Limits

The reference authority and simulator are deterministic under injected clock,
identifier, key, and optional SHA-256 fixtures. They support exact duplicate,
delay, reorder, drop, partition, reconnect, expiry, and revocation scenarios.
Their state is in memory and restart-ephemeral.

System conformance uses an in-process transport adapter and fresh OS-temporary
SQLite state. It proves exact signed delivery and acknowledgement, all five
stages, classification limits, current and stale visibility, fault convergence,
expiry, revocation, stale approval and amendment refusal, and no local authority
gain during a partition. It performs no Git or worktree operation.