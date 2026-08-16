---
title: Troubleshooting and limits
description: Platform matrix, build requirements, common failures with exact messages, and deferred behavior
ms.date: 2026-08-16
ms.topic: troubleshooting
---

This page covers what the alpha requires, what it deliberately does not do, and
what its failure messages mean.

## Platform matrix

| Requirement | Value | Notes |
| --- | --- | --- |
| Operating system | Linux | The `senawa` package declares `os: linux` |
| Architecture | x64 | The package declares `cpu: x64` |
| C library | glibc 2.34 or newer | Prebuilt helpers target this floor |
| Node.js | 22.12.0 or newer | Declared in `engines` |
| Package manager for source builds | pnpm 10.34.5 | Declared in `packageManager` |
| Public executable | `senawa` | The only supported public binary |

macOS, Windows, arm64, and musl are not supported by this alpha. There is no
hosted Senawa service; everything runs on your host.

## Native build tools

Installing the packaged alpha never compiles native code. If an install log
mentions `node-gyp`, `gyp info`, `cmake`, or building from source, something is
wrong with the environment rather than with the package; the packaging check
treats that evidence as a failure.

Building from this repository is different. `pnpm build` compiles the
`senawa-process-supervisor` and `senawa-workspace-files` helpers and needs a C17
compiler available as `cc`. Without it, the build fails at the native step while
TypeScript compilation has already succeeded.

The core install also does not declare, resolve, install, or load the Copilot SDK
or Koffi. A live-enabled installation must make `@github/copilot-sdk` version
`1.0.9` available separately.

## Configuration is JSON only

`.senawa/workflow.json` is JSON. There is no YAML form, no comment syntax, no
include or import mechanism, and no environment interpolation. Duplicate object
members are rejected rather than last-one-wins.

Workflow files are refused above 256 KiB before buffering or parsing. Prompt
files are capped at 32 KiB, schema files at 256 KiB, and all declared resources
together at 8 MiB.

JSON syntax errors report a normalized category with a line and column:

```text
.senawa/workflow.json: invalid JSON: expected a property name at line 12, column 3
```

## Common failures

### `.senawa: already exists`

`senawa init` refuses any existing `.senawa` filesystem object and changes
nothing. Move or remove the existing tree yourself, or pass a different project
directory that already exists:

```bash
mkdir other-project
senawa init other-project
```

```text
other-project/.senawa: created
```

The project directory is never created for you. Without the `mkdir` step the
command exits `1`:

```text
other-project/.senawa: unable to durably publish standard workflow (ENOENT)
```

### `unable to read workflow configuration (ENOENT)`

```text
.senawa/workflow.json: unable to read workflow configuration (ENOENT)
Run senawa init to create it. Earlier alpha files at senawa.json must be moved to .senawa/workflow.json or passed explicitly.
```

Doctor reads `.senawa/workflow.json` relative to the current directory. It does
not search ancestor directories and does not fall back to the earlier root
`senawa.json` location. Migrate manually:

```bash
mkdir .senawa
mv senawa.json .senawa/workflow.json
senawa doctor
```

Filesystem failures expose an allowlisted code such as `EACCES`, `EISDIR`,
`ELOOP`, `ENOENT`, `ENOTDIR`, or `EPERM`, never a stack trace or an internal
path.

### `invalid (N diagnostics)`

Doctor reports every diagnostic at once, each with a stable code, a locator, and
a JSON Pointer:

```text
.senawa/workflow.json: invalid (2 diagnostics)
- [unknown-reference] .senawa/workflow.json#/phases/0/executor/inputSchema: Input schema definition-inpt is not declared
- [unknown-reference] .senawa/workflow.json#/phases/0/input/schema: Phase input schema definition-inpt is not declared
```

Fix all of them rather than the first. [Workflow authoring](workflow-authoring.md)
explains the rule behind every code, including `unknown-reference`,
`missing-field`, `invalid-field`, `unknown-field`,
`mapping-destination-collision`, `phase-dependency-violation`,
`current-item-not-allowed`, `undeclared-prompt-input`, `unused-prompt-input`,
and `authority-widening`.

### `Operational command failed`

Every operational command needs the private credential and a reachable socket.
When the service is not running, or its runtime directory is elsewhere, the CLI
reports this generic message and exits `1`. Internal details are deliberately
withheld.

```bash
senawa service start
senawa service status
```

Check that `XDG_RUNTIME_DIR` and `XDG_STATE_HOME` match the environment the
daemon was started with.

### `Supervisor did not become ready`

Start spawns the detached daemon and polls for an authenticated status response.
When readiness never arrives, read the daemon's own output:

```bash
tail "${XDG_STATE_HOME:-$HOME/.local/state}/senawa/service.log"
```

### `loopback portal listener is not enabled`

`senawa portal` needs a loopback listener, which exists only when the daemon
inherited `SENAWA_PORTAL_PORT`. Export it and restart the service:

```bash
export SENAWA_PORTAL_PORT=0
senawa service stop
senawa service start
senawa portal
```

### `Request validation failed`

A submitted command failed protocol validation. The usual cause is encoding:
command files must be canonical JSON with sorted object members, no
insignificant whitespace, no duplicate keys, and no trailing newline. Pretty
printed JSON is refused.

Other causes are an `apiVersion` other than `senawa.dev/protocol/v1alpha3`, a
`commandId` that is neither a lowercase UUID nor a `command_` identity, a
`payloadDigest` that is not 64 lowercase hexadecimal characters, or an unknown
field such as `principal` or `transport`, which clients may never supply.

### `Command input exceeds 256 KiB`

Command files and standard input are bounded before buffering and parsing. Split
the work rather than raising the limit.

### `"health":"degraded"` in service status

Health degrades whenever the SDK session store cannot be confirmed. The common
and expected case has an explicit message:

```text
SENAWA_REPOSITORY_DIR is not configured; worker dispatch is disabled
```

Command admission, queries, projections, and the portal remain available. This
is the normal state for every credit-free journey. Health also degrades when
expected nonterminal session metadata is missing, which blocks runner redispatch
on purpose.

### A refused receipt

A refusal is a durable outcome, not a transport error. The terminal receipt
names the exact reason:

```text
"error":{"code":"run-control-unavailable","message":"Run control is not initialized","retryable":false}
```

`retryable` tells you whether resubmitting can help. Resubmitting the identical
command file always reuses the same durable command identity.

### `backup-refused`, `restore-refused`, `repair-refused`

These operations are precondition-driven and return a fixed status object rather
than an internal message:

* Backup requires a drained service and a destination that does not already
  exist, unless it is the identical verified request.
* Restore and repair require the supervisor socket to be absent and a fresh
  destination state root.
* Neither ever writes in place.

See [Operations](operations.md) for the exact sequence.

### The portal shell reports itself unavailable

The portal asset manifest is missing or invalid. Daemon IPC and portal query
APIs stay available. On an installed package the manifest is discovered relative
to the `senawa` package; on a source build, `SENAWA_PORTAL_MANIFEST` selects it.

### A reloaded bootstrap URL returns `Portal bootstrap is invalid`

The bootstrap URL is a one-time capability. Reloading it replays a consumed
token, and the supervisor answers HTTP 401 with this message instead of a
session. Navigate inside the console rather than reloading the bootstrap URL,
and run `senawa portal` for a fresh URL.

### A portal tab is read-only

A session carries one CSRF token and issues it once. The tab that claimed it
keeps the token in `sessionStorage`, so reloading `/portal/` in that tab stays
read-write. A second tab on the same session, or a tab whose session storage was
cleared, finds the token already claimed and stays read-only. Run
`senawa portal` for a fresh read-write session.

## Live model costs

Nothing in this guide set spends credits by default. Costs apply only when you
configure a repository worker or run the opt-in live probe.

The live probe validates `SENAWA_COPILOT_TIMEOUT_MS` first, while
`scripts/test-live-worker.mjs` is still loading and before it reads the
acknowledgement:

```text
Error: Live Copilot probe requires SENAWA_COPILOT_TIMEOUT_MS
```

With a positive timeout set and no acknowledgement, it refuses next:

```text
Error: Live worker testing can spend AI credits and send data. Set SENAWA_COPILOT_ACKNOWLEDGE_COST_AND_DATA=1 with the bounded live probe variables to continue.
```

The probe then prints a cost and data warning and starts the Vitest lane, which
requires `SENAWA_COPILOT_MODEL` and a positive `SENAWA_COPILOT_MAX_AI_CREDITS`.
Live tests are excluded from default and packaging validation.

Model routes carry their own `maxTurns`, `maxSubmissions`, and
`maxMillidollars` ceilings, and every autonomous loop carries a finite budget
that escalates instead of running unbounded.

## Not implemented in this alpha

* No hosted Senawa service and no production control-plane server. The optional
  connector is outbound only and speaks to a service you operate.
* No CLI command instantiates a run, registers a configuration snapshot, or
  drives a phase directly. The only workflow entry point is
  `senawa command submit`.
* No automatic migration command from the earlier root `senawa.json` location.
* No portal control applies an amendment, and no portal route reaches daemon
  lifecycle operations.
* No retention or pruning policy for receipts, events, assets, snapshots,
  contexts, reports, or remote records. Only supervisor logs are bounded, at the
  latest 10,000 entries.
* No in-place restore or repair. Restoration targets a fresh state root only.
* No kernel peer-credential authentication on the local socket, and no
  descriptor-relative publication for backup and restore.
* No SSRF or DNS-rebinding resistance for the connector endpoint. Enforce the
  destination with egress policy.

## Deferred behavior

Evidence-backed deferrals are recorded in
[Production enhancements](../design/WIP/redesign-1/production-enhancements.md), each with its
observed evidence, current behavior, risk, deferral reason, revisit trigger, and
acceptance test. The current entries are:

* `PE-001`: staged canonical output assets survive a refused submission. The
  bytes are content-addressed, bounded, and never observable as authority, but
  no collector removes them yet.
* `PE-002`: one accepted output slot per dispatch. A context declaring more than
  one phase output slot exposes only the first.
* `PE-003`: model correction behavior is unproven without credits.
* `PE-004`: one command-driven lifecycle phase per run.

Nothing in that log is a correctness, authority, data-loss, secret-exposure, or
unbounded-cost defect. Those classes are repaired where they are found.

## Getting more detail

* Read `service.log` in the state directory for daemon output.
* Run `senawa service logs` for the redacted, cursor-paged supervisor log.
* Run `senawa integrity check` for a fixed-category storage report.
* Run `senawa diagnostics create <fresh-directory>` for a secret-safe bundle you
  can share.
* Read the [CLI reference](../reference/cli.md) for exact argument shapes and
  exit codes.
