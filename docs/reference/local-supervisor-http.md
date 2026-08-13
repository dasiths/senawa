---
title: Local Supervisor HTTP Reference
description: Alpha Unix-socket and loopback HTTP transport and security contracts
ms.date: 2026-08-13
ms.topic: reference
---

## Transports

The supervisor package provides one `SupervisorHttpHandler` over the
transport-neutral `SupervisorApi`.

Authenticated local IPC uses HTTP/1.1 over a Unix socket. The runtime directory
must be owned by the current user with mode `0700` and no symbolic-link path
components. The socket must be owned by the current user with mode `0600`. A
stale socket is removed only after its type, owner, mode, and lack of a live peer
are verified.

The IPC credential contains 32 random bytes encoded as base64url. It is created
exclusively with mode `0600`, then the file and parent directory are synced.
Every IPC request presents the credential as an `Authorization: Bearer` token.
Comparison is constant-time, and the credential is never included in errors or
logs.

Node does not expose `SO_PEERCRED`. The accepted alpha IPC boundary is therefore
the private runtime directory, private socket, and private bearer credential
together. This design does not claim kernel peer-credential authentication.

Portal HTTP binds exactly to `127.0.0.1`. Wildcard and IPv6 listeners are not
accepted. Requests require the exact address and port in `Host`, reject
forwarding headers, and emit no CORS headers.

## Workflow Routes

The shared handler exposes these exact routes:

* `GET /api/v1alpha1/capabilities`
* `POST /api/v1alpha1/commands`
* `GET /api/v1alpha1/commands/{commandId}/receipt`
* `GET /api/v1alpha1/repositories/{repositoryId}/runs/{runId}/receipts`
* `GET /api/v1alpha1/repositories/{repositoryId}/runs/{runId}/events`
* `GET /api/v1alpha1/repositories/{repositoryId}/runs/{runId}/events/stream`
* `GET /api/v1alpha1/repositories/{repositoryId}/runs/{runId}/projections/phase-lifecycle`

Receipt and event page queries accept optional `after` and `limit` parameters.
The SSE route accepts optional `after`; `Last-Event-ID` is also accepted when it
does not conflict with the query cursor.

Command acceptance returns status `202`, the exact canonical acceptance DTO,
and a receipt `Location`. Other JSON responses use canonical protocol DTOs or a
safe `ErrorEnvelope`. JSON responses set `Content-Type: application/json;
charset=utf-8`, `X-Content-Type-Options: nosniff`, and `Cache-Control: no-store`.

## Operational Routes

Authenticated Unix-socket clients can use these exact routes:

* `GET /supervisor/v1alpha1/status`
* `POST /supervisor/v1alpha1/drain`
* `POST /supervisor/v1alpha1/stop`
* `POST /supervisor/v1alpha1/recoveries`
* `GET /supervisor/v1alpha1/logs?after={cursor}&limit={count}`
* `POST /api/v1alpha1/portal-sessions`

Loopback requests receive `404` for every `/supervisor/v1alpha1` route. Recovery
accepts only repository and run identities. The server supplies owner, fence,
attempt, and current-time facts.

Status is local and exact. It reports durable desired mode, live lifecycle,
health, process and start facts, listeners, database-derived pending counts,
sanitized lease facts, and SDK session-store health. Missing expected
nonterminal SDK session metadata degrades health and blocks runner redispatch.

Supervisor logs are persisted with monotonically increasing cursors and bounded
pages. ANSI escapes, control characters, bearer values, and sensitive
structured fields are removed or redacted before commit.

## Service Lifecycle

The live lifecycle is `stopped`, `starting`, `running`, `draining`, `drained`,
`stopping`, then `stopped`. A degraded health value overlays the current
lifecycle without replacing it. Startup scans durable wakes and claimed queue
records. One serialized cycle drains command work, delivers a completion outbox
fact when configured, and invokes the synchronous or asynchronous fenced runner
for runnable effects under the same lease resource.

Run leases last 30 seconds. While an asynchronous worker host is pending, the
controller renews the lease every 10 seconds or sooner when expiry is nearer.
The runner reloads trusted time and the current lease before each authority
call, including the final effect commit. Renewal failure aborts the worker and
leaves the uncertain lease and durable effect claim for higher-fence takeover
after expiry. Graceful completion stops renewal and releases the exact lease.

## Copilot Worker Composition

Set `SENAWA_REPOSITORY_DIR` to an explicit repository directory to enable the
production Copilot worker host. The daemon keeps the SDK working directory and
session base under private Senawa state paths outside that repository. Without
this variable, command and query service remains available, health is degraded,
and worker effects are not dispatched.

Worker effect input contains a durable dispatch identity, exact validated model
route selection, operation timeout, and grant policy. The context broker loads
the registered context and dispatch, issues fresh per-asset grants, and retains
raw grant tokens only in worker-call closures. Accepted worker completion facts
are converted to deterministic engine-service `submit-completion` commands and
admitted through the supervisor queue. The context outbox acknowledges delivery
only after queue acceptance commits.

## Portal Sessions

Authenticated IPC creates a portal bootstrap through
`POST /api/v1alpha1/portal-sessions`. The response contains a loopback bootstrap
path with a one-time 32-byte capability that expires within 60 seconds. Only the
capability digest is retained.

`GET /portal/bootstrap?token=...` consumes the capability once and redirects
with status `303` to `/portal/`. It sets a host-only `senawa_session` cookie with
`HttpOnly`, `SameSite=Strict`, and `Path=/`. Loopback HTTP is intentionally not
marked `Secure`. The raw session token is stored only in the cookie; the server
retains its digest.

`GET /api/v1alpha1/session` returns the separate CSRF token once for an
authenticated session. The server retains only its digest. Every other loopback
API request requires a valid session cookie. Mutations also require the exact
loopback `Origin` and `X-Senawa-CSRF`; reads reject a present nonmatching
`Origin`. Initial bootstrap consumption does not require `Origin`.

## Request Hardening

The handler validates the raw origin-form target before decoding path segments.
It rejects absolute form, network-path references, backslashes, null bytes,
invalid percent escapes, encoded slashes or backslashes, encoded or literal dot
segments, duplicate separators, oversized targets, duplicate query keys, and
unknown query keys.

Commands accept only `application/json` with an optional UTF-8 charset, reject
content encoding and ambiguous framing, and bound streamed bodies to the
protocol wire limit plus framing allowance. `GET` requests do not accept a
body. Internal failures return a generic safe error without reflecting request
content.

## Server-Sent Events

SSE subscribes to the run notifier before its first bounded replay query, then
performs immediate catch-up after registration. It reads pages of at most 256
events and keeps no memory backlog. Frames use canonical JSON:

```text
id: 42
event: phase-started
data: {canonical protocol event}

```

Heartbeats are cursor-free comments every 15 seconds. A replay gap emits one
typed `gap` event and closes. Cursor-ahead requests fail before streaming with
status `400`.

When a write reports backpressure, the source waits for drain without queuing
more frames. The queued frame becomes the last delivered cursor only after
drain. A 30-second stall, request abort, or service stop closes the stream.

## State Backup

Combined state backups contain the SQLite authority bundle and an opaque SDK
session-store bundle under one exact outer manifest. SDK traversal accepts only
regular files and directories, refuses symbolic links, enforces file and byte
bounds, records modes, lengths, and SHA-256 digests, and restores only to fresh
destinations. SQLite restore verification runs against a disposable bundle copy
so SQLite sidecars cannot mutate the source backup.

A combined backup is an offline operation. The service must remain in
`drained` state for the full operation, with command admission and listeners
unable to mutate state. The service operation queue supplies the drained-state
proof and excludes cycles, recovery, and stop. Backup stops the owned Copilot
SDK client, verifies the service is still drained, then copies SQLite and SDK
state. The client is not restarted by the backup operation.

Portal static files remain outside the current alpha surface. Worktree
execution remains assigned to Phase 10.