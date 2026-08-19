# Security

Senawa's security model is one sentence: authority flows one way, and nothing a
model, a prompt, a client, or a remote peer says can widen it. This page states
the boundaries that sentence implies and where each one is enforced.

## Principals

A principal is the authenticated identity behind a command. It carries an
issuer, a subject, a tenant, an assurance level of `single-factor`,
`multi-factor`, or `hardware-backed`, and a sorted, deduplicated role list.

Clients never supply attribution. A command submission is attribution-free: it
carries `apiVersion`, `commandId`, `repositoryId`, `runId`, `intent`, `payload`,
`payloadDigest`, and optional expectation fields. The service derives principal,
transport kind, request identity, current time, and allocation facts. A submitted
envelope that tries to include `principal` or `transport` is refused as an
unknown field.

Transport kind is one of `cli`, `http`, `runner`, `portal`, or `remote`, and is
also derived, not claimed.

## Workflow roles

Configuration roles decide who may do what inside a run:

* An `agent` role executes work. It requires a prompt and a model policy.
* A `human` role makes decisions. It carries capabilities only.
* An `authority` role approves and closes. It carries capabilities only.

A non-agent role that carries a model policy, or that is named to execute
generated work, is refused at compile time with `authority-widening`. A
non-agent role that carries a prompt is refused with `forbidden-role-prompt`. The
compiler rejects these before any run exists, so an escalation of role authority
cannot be introduced at run time.

## Portal capabilities

A portal session carries an explicit capability set. Read capabilities cover
activity, artifacts, discovery, graph, human needs, integrations, records, and
workspaces. Write capabilities are exactly four:

* `portal-write-answer-question`
* `portal-write-grant-allowance`
* `portal-write-record-amendment-decision`
* `portal-write-record-authority-decision`

plus `portal-write-run-control` for pause, resume, and end. A control the
session lacks the capability for renders disabled. The session cannot widen its
own capability set, and the portal cannot reach daemon lifecycle routes at all.

## Worker capabilities and grants

A dispatched worker gets a closed tool set and an explicit capability list:

* `asset.read`
* `worker.submit.completion`
* `worker.submit.question`
* `worker.submit.asset`
* `worker.submit.discovery`
* `worker.submit.amendment-proposal`
* `worker.submit.phase-output`

Tools outside that set do not exist for the session. A tool call without its
capability is refused with a generic message that reveals nothing about the rest
of the surface.

Asset reads use per-asset grants issued by the context broker for one dispatch.
Each grant permits at most 1,024 operations, 256 MiB total bytes, and 64 KiB per
read. Asset ingress permits at most 256 MiB per object, and configured
repository object-count and byte quotas are applied inside the same write
transaction that stages a file. Raw grant tokens exist only inside worker-call
closures. They are never persisted in a portal DTO, a report, a log, or a
diagnostic bundle.

## The worker channel

An agent never holds the operator's credential. If it did it could approve its
own phase, which would make every gate decoration.

Each dispatch is minted its own credential: 32 random bytes in a mode `0600`
file under the private runtime directory, scoped to one repository, run,
dispatch, context, and principal, with an explicit capability list, an expiry,
and a submission budget. The worker is given the path, not the value.

A file is the only delivery that can be withdrawn from a process that has
already started. An environment variable cannot be taken back and propagates to
every descendant; a value in `argv` is world-readable through the process table.
Revoking is an unlink.

`SENAWA_WORKER_CREDENTIAL` names that file and `SENAWA_WORKER_DISPATCH` names
the dispatch. `senawa start` prints both when it dispatches.

Worker and operator identities are mutually exclusive. A worker route does not
resolve for an operator, and an operator route does not resolve for a worker.
Both refusals are `404` rather than `403`, so a worker cannot enumerate the
surface it is missing by watching which paths answer differently.

Reads spend nothing, so an agent that crashed can re-read its context without
losing an attempt it never used. The submission budget is spent only once a
submission names a kind the channel offers, so a malformed body cannot burn one.

### What this scheme does not do

It bounds what the worker's own identity can do. It does not stop a worker that
can read arbitrary files from reading the operator's credential, which sits at a
predictable path with mode `0600` owned by the same user. The SDK worker cannot
do that because it has no shell and no general file read; a worker command line
necessarily reopens the capability.

So this prevents privilege by identity, not privilege by theft. Narrowing it
further needs a different uid or a sandbox, which v1 does not attempt.

## Proposal-only agents

Agents propose. Humans and workflow policy approve.

* Model output is evidence, never a decision. A model asserting that a phase is
  complete does not close it; completion accounting is derived from immutable
  records.
* Prompt text is not authority. The rendered prompt says so explicitly and marks
  every substituted value as quoted, digested, non-authority data.
* Consumer text is never spliced into instructions. Template tokens become
  numbered references and the values follow as separate bounded blocks.
* A worker cannot approve, close, grant an allowance, import a plan, mutate the
  graph, or dispatch an effect. No tool exists for any of it.
* An amendment proposal from a worker is a proposal. Human decision and trusted
  supervisor recovery own application. The portal shows amendment source and
  diff as inert data with no application control.

## Approvals

An approval is an immutable human decision bound to exact facts. The portal
loads and verifies every referenced digest and revision before it enables
submission, and the submitted command carries the exact candidate digest, base
graph revision, and reviewed result graph revision.

A decision therefore applies to exactly the record that was reviewed. If the
underlying record moved on, the command does not silently apply to the new one.

The same rule holds on the command line. `senawa amendment approve` reads the
stored proposal, extracts its proposal digest, base graph revision, and reviewed
result graph revision, and submits those exact values.

## Stale results

Distributed work fails in the middle. Senawa refuses stale writers rather than
letting them win a race:

* Every effect persists its intent with a fence before it acts and reconciles
  before it commits, so a crash never silently duplicates work.
* A run lease lasts 30 seconds and is renewed every 10 seconds while an
  asynchronous worker is pending. Renewal failure aborts the worker and leaves
  the uncertain claim for a higher fence after expiry.
* The runner reloads trusted time and the current lease before every authority
  call, including the final commit.
* A superseded dispatch is never published as the current one. Dispatch rows are
  ordered by their ordinal, and the fenced current context wins.
* Projections are derived. A stale projection can be rebuilt; it can never be
  the source of a decision.

See [Authority model](../design/authority-model.md) for the exact transitions.

## Local transport trust

Local IPC is HTTP/1.1 over a Unix socket in a private runtime directory. The
directory must be owned by the current user with mode `0700` and no
symbolic-link components; the socket must be owned by the current user with mode
`0600`. Every request presents a 32-byte base64url bearer credential compared in
constant time and never echoed.

Node does not expose peer credentials for a Unix socket. Senawa therefore
claims the private directory, private socket, and private credential together as
the boundary, and does not claim kernel peer-credential authentication. Anyone
who can read those files can drive the service. Protect them the way you protect
an SSH private key.

Loopback HTTP binds exactly to `127.0.0.1`, requires the exact address and port
in `Host`, rejects forwarding headers, and emits no CORS headers. Portal assets
are served only from a verified manifest under a fixed no-inline content security
policy, with no service worker and no arbitrary path fallback.

## Remote control-plane trust

The outbound connector is optional and disabled unless the daemon inherits both
`SENAWA_REMOTE_ENDPOINT` and `SENAWA_REMOTE_KEY_FILE`. Senawa ships an ephemeral
reference authority for conformance work and does not ship or claim a production
hosted service.

The local supervisor stays authoritative:

* A central acceptance is delivery evidence, not permission to mutate a run.
* The connector persists and verifies every envelope, intersects upstream roles
  with local mappings, and submits an attribution-free command through the same
  local API a CLI would use.
* The local command service repeats every authorization, expiry, graph,
  revision, exact object, repository, and run check.
* Ed25519 signatures cover fixed domain bytes plus canonical unsigned content.
  The protocol package performs no signing, hashing, clock access, or I/O.

Two limits deserve attention. Endpoint syntax validation gives no SSRF or
DNS-rebinding resistance, so enforce the enrolled destination with an egress
firewall or trusted proxy. And the enrollment file is local operational state: a
regular file owned by the daemon user with mode `0600`, at most 64 KiB, never a
symbolic-link leaf.

## What never leaves the host

Without an enabled connector, nothing leaves the host at all except what a
configured model provider receives during live worker execution.

With a connector enabled, synchronization is allowlisted and bounded by a
classification ceiling of `public` or `internal` declared in the workflow's
remote policy. The following never synchronize and never appear in portal DTOs,
reports, or diagnostic bundles:

* Repository source and canonical repository paths
* Credentials, grant tokens, and session tokens
* Run leases and internal fence state
* SDK session identities and session content
* Worker prompt packs and raw model text
* Target refs and raw process output
* Environment variables and local filesystem paths

Diagnostic bundles are built from an allowlist rather than a denylist: product
and runtime versions, the fixed integrity report, and an allowlisted service
summary. Report exports carry secret-safe provenance, not authority state, and a
release-time scanner checks generated template and bundle files for secret-shaped
content.

## Practical checklist

* Keep `$XDG_RUNTIME_DIR/senawa` and `$XDG_STATE_HOME/senawa` private to one
  user.
* Treat a portal bootstrap URL as a credential. It is single-use and expires
  within 60 seconds; do not paste it into shared channels.
* Restore backups only into a directory you control.
* Attach diagnostic bundles, not raw state directories, to reports.
* Leave the remote connector off unless you operate the destination and its
  egress policy.
* Review what a workflow declares before running it. Sensors are local processes
  and `sensitivity` values decide what can leave.

## Related reading

* [Design overview](../design/overview.md) for the governing principles.
* [Authority model](../design/authority-model.md) for fences, leases, and
  receipts.
* [Local supervisor HTTP](../reference/local-supervisor-http.md) for exact
  transport contracts.
* [Remote control plane](../reference/remote-control-plane.md) for enrollment
  and classified synchronization.
* [Operations](operations.md) for the paths and credentials this page protects.
