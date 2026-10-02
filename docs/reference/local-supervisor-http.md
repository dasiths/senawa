# Local Supervisor HTTP Reference

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

Node does not expose `SO_PEERCRED`. The accepted IPC boundary is therefore
the private runtime directory, private socket, and private bearer credential
together. This design does not claim kernel peer-credential authentication.

Portal HTTP binds exactly to `127.0.0.1`. Wildcard and IPv6 listeners are not
accepted. Requests require the exact address and port in `Host`, reject
forwarding headers, and emit no CORS headers.

## Workflow routes

The shared handler exposes these exact routes:

* `GET /api/v1/capabilities`
* `POST /api/v1/commands`
* `GET /api/v1/commands/{commandId}/receipt`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/receipts`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/events`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/events/stream`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/projections/phase-lifecycle`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/amendments`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/amendments/{amendmentId}`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/amendments/{amendmentId}/source`
* `GET /api/v1/repositories?after={repositoryId}&limit={count}`
* `GET /api/v1/repositories/{repositoryId}/runs?after={runId}&limit={count}`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/overview`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/graph`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/delivery?after={cursor}&limit={count}`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/transcript/{ownerKind}/{ownerId}?after={cursor}&limit={count}`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/graph/nodes?revision={digest}&after={offset}&limit={count}`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/graph/edges?revision={digest}&after={offset}&limit={count}`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/records/{kind}/{digest}`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/needs`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/allowances/{escalationCommandId}`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/questions`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/questions/{submissionId}`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/artifacts`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/artifacts/{artifactId}`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/artifacts/{artifactId}/content?offset={offset}&length={count}`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/artifacts/{artifactId}/download`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/workspaces`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/integrations`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/activity/receipts`
* `GET /api/v1/repositories/{repositoryId}/runs/{runId}/activity/events`

Receipt and event page queries accept optional `after` and `limit` parameters.
The SSE route accepts optional `after`; `Last-Event-ID` is also accepted when it
does not conflict with the query cursor.

Portal discovery pages are lexically ordered and contain at most 100 entries.
Graph node and edge pages require the exact graph revision and contain at most
200 entries. Delivery pages accept an integer `after` cursor and contain at most
256 entries. Transcript pages address exactly one owner: `{ownerKind}` is
`dispatch`, `task`, `phase`, or `run`, and any other value returns `404`. They
accept an integer `after` cursor and contain at most 200 records. The `run` kind
is a read-only projection that merges the durable dispatch, task, and phase rows
of one run; capture never writes it. Activity windows accept either `after` or
`before`, never both, contain at most 100 entries, and remain ascending within
each returned window. Artifact previews read at most 64 KiB and advertise the
browser JSON viewer's 500-node budget.

The run overview contains workflow, context, runner, workspace, human, portal,
graph, and lifecycle cursors. A client loads overview A, bounded resources, then
overview B. Any vector change invalidates the assembled view. Portal DTOs omit
canonical repository paths, grant tokens, SDK session identities, worker prompt
packs, secrets, target refs, and raw process output.

Human needs are derived from immutable question, candidate, amendment,
escalation, integration, and ending records. No portal table owns mutable need
status. An escalation permits `grant-allowance` only when its exact allowance
review joins the unresolved escalation, matching-unit current budget, allowance
policy, run control, and runtime graph authority. The response supplies the
escalation and policy digests, current limit, ceiling, maximum increase,
resulting maximum, and graph plus run-mode guards. Missing, resolved,
inconsistent, or stale facts produce no grantable review. Worker artifact
metadata remains `metadata-only` until the exact digest, size, media type, and
installed bytes verify. Downloads always use a fixed server-derived filename,
`application/octet-stream`, attachment disposition, and `nosniff`.

Command acceptance returns status `202`, the exact canonical acceptance DTO,
and a receipt `Location`. Other JSON responses use canonical protocol DTOs or a
safe `ErrorEnvelope`. JSON responses set `Content-Type: application/json;
charset=utf-8`, `X-Content-Type-Options: nosniff`, and `Cache-Control: no-store`.

## Operational routes

Authenticated Unix-socket clients can use these exact routes:

* `GET /supervisor/v1/status`
* `POST /supervisor/v1/drain`
* `POST /supervisor/v1/stop`
* `POST /supervisor/v1/recoveries`
* `POST /supervisor/v1/backups`
* `GET /supervisor/v1/logs?after={cursor}&limit={count}`
* `POST /api/v1/portal-sessions`

Loopback requests receive `404` for every `/supervisor/v1` route. Recovery
accepts only repository and run identities. The server supplies owner, fence,
attempt, and current-time facts. Backup accepts one bounded request identity and
destination directory, and returns only that identity plus verified status.

Status is local and exact. It reports durable desired mode, live lifecycle,
health, process and start facts, listeners, database-derived pending counts,
sanitized lease facts, and SDK session-store health. Missing expected
nonterminal SDK session metadata degrades health and blocks runner redispatch.

When the optional outbound connector is enabled, status also reports sanitized
connector and binding identities, lifecycle, partition health, contact times,
pending counts, cursor lag, explicit `never-synchronized`, `current`, or `stale`
state, and staleness milliseconds. It never reports the remote endpoint,
enrollment path, public or private key material, or report content. See the
[remote control-plane reference](remote-control-plane.md) for configuration and
trust limits.

Supervisor logs are read in bounded pages, against cursors that only ever count
up. ANSI escapes, control characters, bearer values, and sensitive
structured fields are removed or redacted before commit. The log table retains
the latest 10,000 entries. Receipts, events, assets, configuration snapshots,
contexts, SDK session references, remote inbox and outbox records, reports, and
other authority history have no automatic age or count pruning in v1.
They remain immutable while referenced. Backup and export do not delete source
history, and no retention interval is claimed for operator-created bundles.

## Service lifecycle

The live lifecycle is `stopped`, `starting`, `running`, `draining`, `drained`,
`stopping`, then `stopped`. A degraded health value overlays the current
lifecycle without replacing it. Startup scans durable wakes and claimed queue
records. One serialized cycle drains command work, delivers a completion outbox
fact when configured, and invokes the synchronous or asynchronous fenced runner
for runnable effects under the same lease resource.

Startup and normal cycles also discover worker amendment source records and
approved unapplied amendments. App composition injects the configuration
compiler into a supervisor-owned bridge. The bridge claims the exact historical
source and context, loads the registered base configuration snapshot, submits a
deterministic proposal command, and records a sanitized durable compiler or
terminal delivery outcome. A compiled source is acknowledged only after the
proposal command has a terminal queue receipt.

Approval installs durable affected-scope fences and cancellation requests in
the SQLite command transaction. Recovery reconciles affected effects under the
existing run lease while unrelated scopes continue. A supervisor quiescence
read only decides whether an apply attempt is useful. The apply command carries
only exact proposal, decision, and reviewed graph digests; SQLite rechecks live
claims and nonterminal effects and constructs trusted quiescence inside the
same `BEGIN IMMEDIATE` transaction that commits the reviewed graph.

An enabled connector starts after the supervisor reaches `running`. It polls
independently of run scheduling. Service drain first drains the connector, and
service stop closes it and its SQLite connection even after connector drain
errors or later listener failures.

Run leases last 30 seconds. While an asynchronous worker host is pending, the
controller renews the lease every 10 seconds or sooner when expiry is nearer.
The runner reloads trusted time and the current lease before each authority
call, including the final effect commit. Renewal failure aborts the worker and
leaves the uncertain lease and durable effect claim for higher-fence takeover
after expiry. Graceful completion stops renewal and releases the exact lease.

## Copilot worker composition

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

Each grant permits at most 1,024 operations, 256 MiB total bytes, and 64 KiB per
read. Asset ingress permits at most 256 MiB per object. SQLite applies the
configured repository object-count and total-byte quotas in the same write
transaction before it creates a staging file.

## Portal sessions

Authenticated IPC creates a portal bootstrap through
`POST /api/v1/portal-sessions`. The response contains a loopback bootstrap
path with a one-time 32-byte capability that expires within 60 seconds. Only the
capability digest is retained.

`GET /portal/bootstrap?token=...` consumes the capability once and redirects
with status `303` to `/portal/`. It sets a host-only `senawa_session` cookie with
`HttpOnly`, `SameSite=Strict`, and `Path=/`. Loopback HTTP is intentionally not
marked `Secure`. The raw session token is stored only in the cookie; the server
retains its digest.

`GET /api/v1/session` returns the session expiry, capabilities, and a
secret-free CSRF mode. Before issuance the mode is `available`. After another
tab or the current tab claims the token, subsequent GET responses report
`read-only`. `POST /api/v1/session` returns the separate CSRF token once
and then returns conflict. The server retains only its digest and never returns
the cookie or token through the descriptor.

Every other loopback API request requires a valid session cookie. Mutations also
require the exact loopback `Origin` and `X-Senawa-CSRF`; reads reject a present
nonmatching `Origin`. Initial bootstrap consumption does not require `Origin`.
Session expiry terminates SSE and makes API, shell, and asset requests fail.
Session lifetime is at most eight hours, and the supervisor admits at most
1,024 active sessions. Expired sessions are purged before capacity checks.

## Portal static assets

The app may inject a verified `PortalAssetSource` loaded from
`SENAWA_PORTAL_MANIFEST`. The manifest and every asset must be canonical,
regular, unique, within one canonical root, free of symbolic-link components,
and exact for SHA-256 digest, byte length, and allowlisted content type. Files
that are unknown, unmanifested, or requested through traversal are not served.
The manifest contains at most 64 files, each file is at most 16 MiB, and the
declared uncompressed aggregate is at most 64 MiB. Aggregate refusal occurs
before asset bytes are loaded.

Authenticated loopback requests can read only `GET /portal/` and exact
`GET /portal/assets/{name}` entries. The shell uses `Cache-Control: no-store`.
Hashed assets use one-year immutable caching and a digest ETag. Both set the
fixed no-inline content security policy, `Cross-Origin-Resource-Policy:
same-origin`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`,
and `X-Frame-Options: DENY`. No CORS, service worker, arbitrary path fallback,
or IPC static route exists.

When the manifest is missing or invalid, the loopback shell returns a typed
`503` response. Daemon IPC and portal query APIs remain available.

## Request hardening

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

CLI workflow and command inputs are capped at 256 KiB before complete buffering
or JSON parsing. Executable sensors admit at most 256 arguments and 64 KiB of
aggregate UTF-8 argument bytes. Their explicit inherited-environment allowlist
contains at most 128 names and 64 KiB of aggregate UTF-8 names and values. A
process stream is capped at 64 MiB, configured retries share a 1 GiB aggregate
output budget, and active process and workspace capacity cannot exceed 32.

## Server-sent events

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

## State backup

Combined state backups contain the SQLite authority bundle and an opaque SDK
session-store bundle under one exact outer manifest. SDK traversal accepts only
regular files and directories, refuses symbolic links, enforces file and byte
bounds, records modes, lengths, and SHA-256 digests, and restores only to fresh
destinations. SQLite restore verification runs against a disposable bundle copy
so SQLite sidecars cannot mutate the source backup.

A combined backup is an authenticated IPC operation while the service is
drained. The service must remain in `drained` state for the full operation,
with command admission unable to mutate state. The service operation queue
supplies the drained-state proof and excludes cycles, recovery, and stop.
Backup stops the owned Copilot SDK client, verifies the service is still
drained, then copies and verifies SQLite and SDK state before publishing the
outer manifest. The SDK client is not restarted by the backup operation.

The request identity is derived from the destination by the CLI. An exact retry
for an already verified destination returns the prior success, which covers a
lost HTTP response without taking another snapshot. Existing destinations with
a different request identity, invalid outer or nested manifests, changed
bytes, unknown files, symbolic links, hard-linked files, special files, and
exceeded limits are refused.

Backup verification, restore verification, integrity checks, diagnostics, and
fresh-root restore are app and storage operations rather than loopback routes.
Restore requires a stopped service and absent runtime socket. Report exports
are never accepted as restore sources.

The browser application is implemented in `packages/portal` and served through
the loopback shell and asset routes above. See the [portal
guide](../guide/portal.md) for the console itself, and run `pnpm test:portal`
for the Playwright browser journeys under `packages/portal/tests/browser`.
