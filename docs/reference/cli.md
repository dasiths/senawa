---
title: CLI Reference
description: Local supervisor, workflow, and configuration commands for Senawa alpha
ms.date: 2026-08-14
ms.topic: reference
---

## Commands

Start the local supervisor as a detached process, or retain foreground process
ownership:

```bash
senawa service start
senawa service run
```

`service start` passes no credential on the command line. It writes daemon
stdout and stderr to a private `service.log`, then waits for an authenticated
status response. Runtime files use `$XDG_RUNTIME_DIR/senawa`; durable state uses
`$XDG_STATE_HOME/senawa`. Platform-safe user defaults apply when either variable
is absent.

The outbound remote connector is disabled unless the daemon inherits both
`SENAWA_REMOTE_ENDPOINT` and `SENAWA_REMOTE_KEY_FILE`. The latter names a
bounded, current-user-owned `0600` enrollment file. Connector policy comes from
the locally persisted canonical configuration snapshot named by that file.
Neither value appears in `service status` or `service logs`. The [remote
control-plane reference](remote-control-plane.md) defines the exact enrollment,
endpoint, status, and hosted-service limits.

Manage the running service through authenticated Unix-socket HTTP:

```bash
senawa service status
senawa service drain
senawa service stop
senawa service logs [after]
senawa service recover <repository-id> <run-id>
senawa service recover <repository-id> <run-id> --direct
```

Drain stops new queue claims and effect dispatch. Stop drains before closing
listeners and authorities. Direct recovery opens the same SQLite authority and
run controller. It refuses a live foreign lease and can proceed with a higher
fence only after expiry.

Create and verify deterministic reporting exports:

```bash
senawa report create <repository-id> <run-id> <fresh-directory>
senawa export verify <directory>
```

Report creation captures every section from one SQLite read transaction. It
publishes canonical JSON and JSON Lines files under an exact manifest only when
the destination does not exist. Export verification is read-only and rejects
unknown files, changed bytes, symbolic links, special files, and exceeded
limits. A report export contains secret-safe provenance, not authority state.
`senawa export restore` always refuses; only a verified combined backup can be
restored.

Create, verify, and restore combined authority and SDK state:

```bash
senawa backup create <fresh-directory>
senawa backup verify <directory>
senawa restore verify <directory>
senawa restore apply <backup-directory> <fresh-state-root>
```

Backup creation is an authenticated IPC operation. The service must already be
drained. The operation serializes with cycles, recovery, and stop; shuts down
the owned SDK pool; verifies drained state again; creates SQLite and SDK
bundles; verifies their semantic and byte manifests; then publishes the outer
manifest. A retry for the same destination uses a deterministic request
identity and returns the already verified result. A different request or any
existing unverified destination is refused.

Backup and restore verification are read-only and need no running service.
Restore apply requires the active supervisor socket to be absent and writes
only to a fresh state root. Existing, symbolic-link, special-file, overlapping,
corrupt, or manifest-drifted inputs are refused. The command never replaces the
active database, assets, or SDK store in place.

SDK backup and restore walk every existing fresh-destination ancestor from the
absolute filesystem root, reject symbolic links and noncanonical resolution,
and recheck the destination parent's device and inode before publication. The
alpha uses pathname-only Node filesystem APIs, so it cannot prevent a hostile
process from swapping an ancestor between the final identity check and the
path-based create or rename. Descriptor-relative publication is not part of
this alpha contract.

Inspect and package sanitized maintenance evidence:

```bash
senawa integrity check
senawa diagnostics create <fresh-directory>
senawa repair plan
senawa repair apply <verified-backup> <fresh-state-root>
```

Integrity check opens SQLite read-only and query-only. It reports only fixed
categories and stable `passed`, `failed`, or `not-checked` codes for storage,
structure, migrations, canonical authority, normalized projections, context
and runner state, amendments, workspaces, human authority, portal, supervisor,
remote delivery, and assets. It never returns SQL rows, canonical payloads,
internal paths, stack traces, or underlying exception text.

Diagnostics publishes a fresh `0700` directory with `0600` canonical files and
the manifest last. The bundle contains product and runtime versions, the fixed
integrity report, and an allowlisted service summary. It excludes credentials,
environment variables, local paths, logs, payloads, prompts, answers, and SDK
session content.

Repair is refusal-first. The plan permits only verified backup restoration to
a fresh state root. Apply is the same stopped-service, fresh-destination,
verified-restore operation as `restore apply`. It refuses evidence deletion,
history truncation, digest recalculation, usage or accounting rewrite,
synthetic outcomes, and in-place restore. It does not reindex, rewrite derived
tables, clean staging paths, or repair corrupt authority in place.

Submit workflow commands and query durable results:

```bash
senawa command submit <json-path|->
senawa receipt get <command-id>
senawa receipt list <repository-id> <run-id> [after] [limit]
senawa event list <repository-id> <run-id> [after] [limit]
senawa projection get <repository-id> <run-id>
```

Command files and standard input contain attribution-free protocol submissions.
The service derives principal, transport, request identity, current time, and
allocation facts. Exact retries reuse the durable command identity. Command
files and standard input are limited to 256 KiB before complete buffering and
protocol parsing.

Review and control additive amendments through the same authenticated service:

```bash
senawa amendment list <repository-id> <run-id>
senawa amendment get <repository-id> <run-id> <amendment-id>
senawa amendment source <repository-id> <run-id> <amendment-id>
senawa amendment status <repository-id> <run-id> <amendment-id>
senawa amendment withdraw <repository-id> <run-id> <amendment-id>
senawa amendment approve <repository-id> <run-id> <amendment-id>
senawa amendment reject <repository-id> <run-id> <amendment-id>
senawa amendment recover <repository-id> <run-id>
```

List, get, source, and status are immutable review reads. Withdrawal and human
decisions submit protocol commands bound to the stored proposal digest, base
graph revision, and reviewed result graph revision. Recovery acquires the
existing run lease and drives affected cancellation, reconciliation, and apply.
It never supplies quiescence facts; SQLite rechecks durable affected scopes in
the apply transaction.

Create a one-time portal bootstrap URL when the service has a loopback listener:

```bash
senawa portal
```

The command creates the capability through authenticated IPC and opens no
daemon lifecycle route on loopback. An installed `senawa` package discovers its
packaged portal manifest relative to the CLI module, verifies every declared
asset digest and byte length, and keeps the bytes in memory before serving. A
source build can override discovery with `SENAWA_PORTAL_MANIFEST` for tests and
development. If the selected manifest is missing or invalid, the authenticated
portal shell returns a typed unavailable response while service and query
commands remain operational.

Create a complete `senawa.dev/workflow/v1alpha2` JSON example without
overwriting an existing destination:

```bash
senawa init [path]
```

With no path, init non-recursively creates a real `.senawa` directory when
needed and creates `.senawa/workflow.json`. The one canonical document contains
workflow structure, execution and remote policy, schemas, roles, model policy,
sensors, gates, and projected work. Configuration imports and split files are
not supported.

The default operation creates the file exclusively, writes the complete
content, syncs the file, closes it, syncs `.senawa`, and syncs the project root.
The root sync runs on every successful default init, including when `.senawa`
already existed. Concurrent default invocations allow exactly one file writer.
Existing destination files and directories remain unchanged. A regular file at
`.senawa` fails with `ENOTDIR`; a stable symlink at `.senawa` fails with
`ELOOP`. Init never removes a partial path after a failure.

An explicit path creates exactly the supplied file and syncs only that file and
its immediate parent. The parent must already exist. This distinction also
applies to `senawa init .senawa/workflow.json`: because the path was explicit,
the command does not create `.senawa`.

Stable default-parent symlinks fail closed. The alpha uses pathname-only Node
filesystem APIs, so it cannot prevent a hostile process from swapping the
parent between validation and file creation. Descriptor-relative parent-swap
resistance is not part of this alpha contract.

Validate a JSON workflow configuration and report all deterministic compiler
diagnostics:

```bash
senawa doctor [path]
```

With no path, doctor reads only `.senawa/workflow.json` relative to the current
directory. It does not search ancestors, scan `.senawa`, or fall back to
`senawa.json`. A missing default file exits with code `1` and includes a stable
migration hint. An explicit path reads exactly that path and does not include
the migration hint, even when the supplied string is
`.senawa/workflow.json`. Doctor refuses files above 256 KiB before complete
buffering or JSON parsing.

A valid document exits with code `0`. Invalid configuration, invalid JSON, and
read failures exit with code `1`. JSON failures include a normalized syntax
category and line and column. Filesystem failures expose an allowlisted error
code without stack traces or internal paths. Doctor does not execute sensors,
start work, invoke models, or contact a runner.

Inspect both locations before manually moving an earlier alpha file. The CLI
does not overwrite the destination or provide an automatic migration command:

```bash
mkdir .senawa
mv senawa.json .senawa/workflow.json
senawa doctor
```

You can validate the earlier location without moving it:

```bash
senawa doctor senawa.json
```

Display command help or the alpha version:

```bash
senawa --help
senawa --version
```

The CLI never opens SQLite for normal service or workflow operations. The
explicit `--direct` recovery path remains available when the service is not
available and uses the same lease fence.

## Package support

The alpha package supports Node.js 22.12.0 or newer on Linux x64 with glibc
2.34 or newer. The only supported public executable is `senawa`; service
ownership remains available through `senawa service start` and
`senawa service run`.

The installed package includes prebuilt process and workspace-file helpers,
SQLite migrations, and the verified portal asset manifest. It does not compile
native helpers during installation. The no-credit install and ordinary CLI or
service paths do not declare, resolve, install, or load the Copilot SDK or
Koffi. Live worker operation requires separately available
`@github/copilot-sdk` version `1.0.9` and explicit repository configuration.