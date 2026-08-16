---
title: Operations
description: Local paths, credentials, sessions, backup, restore, recovery, diagnostics, platform limits, and failure handling
ms.date: 2026-08-16
ms.topic: how-to
---

Everything Senawa needs to run lives on one host. This page covers where that
state lives, how to protect it, and what to do when something goes wrong.

## Local paths

The daemon resolves two roots from the environment:

* Runtime files use `$XDG_RUNTIME_DIR/senawa`. When that variable is absent, a
  per-user directory under the system temporary directory is used instead.
* Durable state uses `$XDG_STATE_HOME/senawa`. When that variable is absent,
  `~/.local/state/senawa` is used.

The exact files are:

```text
$XDG_RUNTIME_DIR/senawa/supervisor.sock   authenticated local IPC socket
$XDG_RUNTIME_DIR/senawa/credential        private bearer credential
$XDG_STATE_HOME/senawa/authority.db       SQLite authority
$XDG_STATE_HOME/senawa/assets             content-addressed asset store
$XDG_STATE_HOME/senawa/copilot-sdk        SDK session store
$XDG_STATE_HOME/senawa/copilot-work       SDK working directory
$XDG_STATE_HOME/senawa/service.log        detached daemon output
```

Directories are created with mode `0700` and private files with mode `0600`.
The runtime directory must be owned by the current user, have mode `0700`, and
contain no symbolic-link path components. A stale socket is removed only after
its type, owner, mode, and lack of a live peer are verified.

Isolate an experiment by pointing both roots somewhere disposable:

```bash
export XDG_RUNTIME_DIR="$(mktemp -d)/run"
export XDG_STATE_HOME="$(mktemp -d)/state"
```

## Credentials

The IPC credential is 32 random bytes encoded as base64url, created exclusively
with mode `0600`, then synced along with its parent directory. Every local
request presents it as a bearer token, comparison is constant-time, and the
value never appears in errors, logs, status, or diagnostics.

`senawa service start` passes no credential on the command line. It reads the
private file, exactly as every other command does.

Node does not expose peer credentials over a Unix socket. The accepted local
boundary is therefore the private runtime directory, the private socket, and the
private credential together. Anyone who can read those files can drive the
service.

## Loopback sessions

The portal listener exists only when `SENAWA_PORTAL_PORT` is set in the daemon
environment. It binds exactly to `127.0.0.1`; wildcard and IPv6 listeners are not
accepted.

`senawa portal` mints a one-time bootstrap capability that expires within 60
seconds. Consuming it sets a host-only session cookie. Sessions last at most
eight hours, the supervisor admits at most 1,024 active sessions, and expired
sessions are purged before capacity is checked. Mutating requests additionally
require the exact loopback origin and a CSRF token issued once per session.

Every `/supervisor/v1alpha1` route returns `404` on loopback, so the browser
cannot reach daemon lifecycle operations.

## Service lifecycle

```bash
senawa service start            # detached, waits for authenticated readiness
senawa service run              # foreground ownership in your shell
senawa service status           # exact local status
senawa service drain            # stop claiming work and dispatching effects
senawa service stop             # drain, then close listeners and authorities
```

The live lifecycle is `stopped`, `starting`, `running`, `draining`, `drained`,
`stopping`, `stopped`. Health is `healthy` or `degraded` and overlays the
lifecycle rather than replacing it.

Drain before any operation that must observe a quiet system, including backup.

## Logs

```bash
senawa service logs
senawa service logs 42
```

Logs are persisted with monotonically increasing cursors. The CLI returns at most
100 entries per call; pass the last cursor to continue. ANSI escapes, control
characters, bearer values, and sensitive structured fields are removed or
redacted before commit. The log table retains the latest 10,000 entries.

Receipts, events, assets, configuration snapshots, contexts, SDK session
references, remote records, and reports have no automatic age or count pruning
in this alpha. They stay immutable while referenced.

## Backup

A combined backup contains the SQLite authority bundle and an opaque SDK session
bundle under one outer manifest:

```bash
senawa service drain
senawa backup create /path/to/fresh-backup
senawa backup verify /path/to/fresh-backup
```

Backup creation is an authenticated IPC operation and requires a drained
service. It serializes with cycles, recovery, and stop, shuts down the owned SDK
pool, verifies drained state again, creates both bundles, verifies their
semantic and byte manifests, and only then publishes the outer manifest.

Retrying the same destination reuses a deterministic request identity and
returns the already verified result. A different request, or any existing
unverified destination, is refused:

```text
{"code":"backup-refused","status":"failed"}
```

Verification is read-only and needs no running service.

## Restore

```bash
senawa restore verify /path/to/backup
senawa restore apply /path/to/backup /path/to/fresh-state-root
```

Restore apply requires the supervisor socket to be absent and writes only to a
fresh state root. It never replaces the active database, assets, or SDK store in
place. Existing, symbolic-link, special-file, overlapping, corrupt, and
manifest-drifted inputs are refused with:

```text
{"code":"restore-refused","status":"failed"}
```

Stop the service, restore to a fresh root, then point `XDG_STATE_HOME` at the
restored root before starting again.

Restore walks every existing destination ancestor from the filesystem root,
rejects symbolic links and noncanonical resolution, and rechecks the destination
parent's device and inode before publication. The alpha uses pathname-only
filesystem APIs, so it cannot prevent a hostile process from swapping an ancestor
between the final identity check and the create or rename. Restore into a
directory only you control.

## Integrity, repair, and diagnostics

```bash
senawa integrity check
senawa repair plan
senawa repair apply /path/to/verified-backup /path/to/fresh-state-root
senawa diagnostics create /path/to/fresh-directory
```

Integrity check opens SQLite read-only and query-only and reports fixed
categories with stable `passed`, `failed`, or `not-checked` codes. It never
returns SQL rows, canonical payloads, internal paths, stack traces, or exception
text. It exits `1` when the report is not `passed`.

Repair is refusal-first. The plan permits only verified backup restoration to a
fresh state root. Apply is the same stopped-service, fresh-destination operation
as `restore apply` and refuses with `repair-refused` otherwise. Repair never
deletes evidence, truncates history, recalculates digests, rewrites usage or
accounting, synthesizes outcomes, or restores in place.

Diagnostics publishes a fresh `0700` directory with `0600` canonical files and
writes the manifest last. The bundle contains product and runtime versions, the
fixed integrity report, and an allowlisted service summary. It excludes
credentials, environment variables, local paths, logs, payloads, prompts,
answers, and SDK session content, which makes it safe to attach to a report.

## Reports and exports

```bash
senawa report create <repository-id> <run-id> /path/to/fresh-directory
senawa export verify /path/to/directory
```

A report captures every section from one SQLite read transaction and publishes
canonical JSON and JSON Lines files under an exact manifest, only when the
destination does not exist. Verification is read-only and rejects unknown files,
changed bytes, symbolic links, special files, and exceeded limits.

A report is secret-safe provenance, not authority state. `senawa export restore`
always refuses; only a verified combined backup can be restored.

## Recovery

A crash leaves durable intent, not silent duplication. Recovery reconciles the
uncertain boundary under a fence:

```bash
senawa service recover <repository-id> <run-id>
senawa service recover <repository-id> <run-id> --direct
senawa amendment recover <repository-id> <run-id>
```

The service form runs inside the daemon, which supplies owner, fence, attempt,
and current-time facts. The `--direct` form opens the same SQLite authority and
run controller without a running service; it refuses a live foreign lease and
proceeds with a higher fence only after expiry.

Run leases last 30 seconds. While an asynchronous worker is pending, the
controller renews every 10 seconds or sooner. A renewal failure aborts the worker
and leaves the uncertain lease and durable claim for higher-fence takeover after
expiry, rather than writing under a stale fence.

## SDK session state

`senawa service status` reports SDK session-store health. Missing expected
nonterminal session metadata degrades health and blocks runner redispatch, so a
lost session cannot silently restart paid work.

Without `SENAWA_REPOSITORY_DIR`, health is degraded with the message
`SENAWA_REPOSITORY_DIR is not configured; worker dispatch is disabled`. Command
admission, queries, projections, and the portal remain fully available. This is
the expected state for every credit-free journey in this guide set.

Backups include the SDK session bundle, so a restored state root keeps sessions
consistent with the authority that references them.

## Environment variables

| Variable | Effect |
| --- | --- |
| `XDG_RUNTIME_DIR` | Base for the private runtime directory |
| `XDG_STATE_HOME` | Base for durable state |
| `SENAWA_PORTAL_PORT` | Enables the loopback portal listener; `0` selects an ephemeral port |
| `SENAWA_REPOSITORY_DIR` | Enables the Copilot worker host for that repository |
| `SENAWA_SUPERVISOR_WRITER_LIMIT` | Supervisor writer concurrency, default `1` |
| `SENAWA_HOST_WRITER_LIMIT` | Execution host writer capacity, default `1` |
| `SENAWA_PORTAL_MANIFEST` | Development and test override for portal assets |
| `SENAWA_REMOTE_ENDPOINT` | Optional outbound connector endpoint |
| `SENAWA_REMOTE_KEY_FILE` | Optional connector enrollment file |

The remote connector is disabled unless the daemon inherits both remote
variables. Neither value appears in status or logs. See the
[remote control-plane reference](../reference/remote-control-plane.md) for
enrollment, classification, and the reference-server limits.

An installed package discovers its verified portal manifest relative to the
`senawa` package. `SENAWA_PORTAL_MANIFEST` exists for source builds and tests.

## Platform requirements

| Requirement | Value |
| --- | --- |
| Operating system | Linux |
| Architecture | x64 |
| C library | glibc 2.34 or newer |
| Node.js | 22.12.0 or newer |
| Public executable | `senawa` |

The installed package ships the standard workflow template, prebuilt process and
workspace-file helpers, SQLite migrations, and the verified portal asset
manifest. Installation never compiles native code. Building from source needs a
C17 compiler available as `cc`.

The core install does not declare, resolve, install, or load the Copilot SDK or
Koffi.

## Live worker opt-in

Everything above runs without model credits. Live model execution is separate,
explicit, and cost-labelled.

The bounded live probe requires all of these variables:

```bash
export SENAWA_COPILOT_ACKNOWLEDGE_COST_AND_DATA=1
export SENAWA_COPILOT_MODEL=<model>
export SENAWA_COPILOT_MAX_AI_CREDITS=<positive number>
export SENAWA_COPILOT_TIMEOUT_MS=<positive integer>
pnpm test:live-worker
```

The runner sets `SENAWA_COPILOT_LIVE=1` itself and prints a cost and data
warning before it starts. It validates `SENAWA_COPILOT_TIMEOUT_MS` first, while
`scripts/test-live-worker.mjs` is still loading and before it reads the
acknowledgement:

```text
Error: Live Copilot probe requires SENAWA_COPILOT_TIMEOUT_MS
```

With a positive timeout set and no acknowledgement, it refuses next:

```text
Error: Live worker testing can spend AI credits and send data. Set SENAWA_COPILOT_ACKNOWLEDGE_COST_AND_DATA=1 with the bounded live probe variables to continue.
```

`SENAWA_COPILOT_MODEL` and `SENAWA_COPILOT_MAX_AI_CREDITS` are read by the
Vitest lane the runner spawns, so their absence surfaces after both checks pass.

Live worker operation also requires `@github/copilot-sdk` version `1.0.9` to be
available separately and a repository worker configured through
`SENAWA_REPOSITORY_DIR`. The live lane is never part of default validation or
packaging validation.

## Git executable

Worktree-mode integration runs Git through a bounded argument-vector port. The
daemon resolves the executable from `SENAWA_GIT_EXECUTABLE` and falls back to
`/usr/bin/git`. Set it when Git lives elsewhere on your host. Repository mode,
the default, never invokes Git.

## Failure handling

* An operational command against a stopped or unreachable service prints
  `Operational command failed` and exits `1`. Start the service and retry.
* Backup, restore, repair, and diagnostics failures return a fixed status object
  with a stable code rather than an internal message. Read the code, fix the
  precondition, and retry.
* Command submission failures return a safe error envelope. A refusal is a
  durable outcome with a reason, not a transient error.
* An exact retry of the same command file reuses the same durable command
  identity, so retrying is safe.
* If the portal shell reports itself unavailable, the portal asset manifest is
  missing or invalid. Service and query commands stay operational.
* If `senawa service start` reports `Supervisor did not become ready`, read
  `service.log` in the state directory for the daemon's own output.

## Related reading

* [CLI reference](../reference/cli.md) for the exact command surface.
* [Local supervisor HTTP](../reference/local-supervisor-http.md) for routes and
  transport contracts.
* [Durability](../design/durability.md) for schema families, content addressing,
  and the exact crash-recovery guarantees.
* [Security](security.md) for the trust model behind these boundaries.
