---
title: CLI Reference
description: The senawa command surface: the run loop, decisions, and the local supervisor
ms.date: 2026-08-15
ms.topic: reference
---

## Commands

### The run loop

These are the commands a consumer uses, in the order they use them.

```bash
senawa init                         # write a working .senawa tree
senawa doctor                       # compile it and report every problem at once
senawa start request.json [run-id]  # start a run and drive it
senawa advance <repository> <run>   # drive an existing run one step at a time
```

`start` blocks and reports what the run is waiting for. Pass `--detach` to
return as soon as the first phase is dispatched.

Both `start` and `advance` stop as soon as the run needs something senawa cannot
supply, and say which:

| Output | Meaning |
|---|---|
| `dispatched <phase> as <id>` | An agent has work |
| `waiting for the agent working on <phase>` | The agent has not finished |
| `waiting for a decision on <phase>` | A person owes an approval |
| `<phase> did not pass: <sensor>` | A blocking gate refused |
| `closed <phase>` | The phase closed and the run moved on |
| `finished` | No phase remains |

A gate refusal exits non-zero. Waiting for an agent or a person does not,
because neither is a failure.

### Deciding

```bash
senawa approve <repository> <run>
senawa reject <repository> <run> <reason>
senawa answer <repository> <run> <text>
```

A rejection must carry a reason. The next attempt is a guess without one.

### Measuring

```bash
senawa run-gates <phase>
```

Runs the phase's sensors and reports what they measured. It spends no attempt,
so an agent or a person can ask before submitting.

### The agent channel

```bash
senawa worker context
senawa worker output-schema
senawa worker complete --output <name>=<file> [--evidence <kind>=<file>] [--summary <text>]
senawa worker ask <question>
senawa worker escalate <reason>
```

A phase that requires completion evidence refuses a completion that owes it,
naming the kind and how much is still missing:

```text
This completion owes evidence: this completion needs 2 of task-completion and carries 0
```

Nothing is published by a refused completion, so the phase is left exactly as it
was and the next call can carry the missing files. Write `--evidence
<kind>@<criterion>=<file>` when the phase counts evidence per criterion rather
than per completion; a bare kind is evidence for the completion itself.

These require `SENAWA_WORKER_DISPATCH` and `SENAWA_WORKER_CREDENTIAL`, which
senawa sets on a dispatched agent. `SENAWA_WORKER_CREDENTIAL` names a file
rather than carrying a token, so the credential can be withdrawn from a process
that already read it. `senawa start` prints both values when it dispatches. An
agent never writes these by hand: the generated operating contract in its prompt
tells it which are available.

`context` and `output-schema` answer today. `complete`, `ask`, and `escalate`
refuse with a message saying submissions are not accepted yet, rather than
accepting work and dropping it. The channel is served by the local supervisor,
so it needs `senawa service start`.

### Managing the service

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
Senawa uses pathname-only Node filesystem APIs, so it cannot prevent a hostile
process from swapping an ancestor between the final identity check and the
path-based create or rename. Descriptor-relative publication is not part of
v1 contract.

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

Create a complete `senawa.dev/workflow/v1` standard delivery tree without
overwriting an existing destination:

```bash
senawa init [project-directory]
```

With no directory, init targets the current project root. An explicit argument
selects an existing project directory. In both forms, init publishes a
`.senawa` tree containing `workflow.yaml`, `agents.yaml`, `sensors.yaml`, the
agent prompts, and the schemas the standard workflow declares. The authored
surface is YAML; there is no lowered document to write by hand.

Init creates a private lock and staging directory beneath the project root. It
creates every file exclusively with private permissions, syncs each file,
syncs every staging directory, verifies that the final `.senawa` name remains
absent, renames the complete staged directory into place, and syncs the project
root. Cleanup removes only staging and lock directories whose device and inode
still match the objects created by this invocation. Concurrent invocations
allow one publisher. Any existing `.senawa` filesystem object is refused as
`already exists` and remains unchanged.

The tracked repository tree, packaged template assets, default init, and
explicit-directory init come from one generated template inventory and have
byte-identical files. The installed-package test verifies this equality.

Validate a JSON workflow configuration and report all deterministic compiler
diagnostics:

```bash
senawa doctor [workflow-path|project-directory]
```

With no path, doctor reads `.senawa/workflow.yaml` relative to the current
directory. A directory argument resolves that same file beneath it. Doctor does
not search ancestors. A missing file exits with code `1`. Doctor refuses
workflow files above 256 KiB before complete buffering or parsing.

A valid document exits with code `0`. Invalid configuration and read failures exit with
code `1`. Parse failures name the file and where in it the problem is. Filesystem failures expose an allowlisted error
code without stack traces or internal paths. Doctor loads every declared prompt
and schema through the confined, symlink-refusing resource reader and compiles
the complete immutable snapshot. It does not execute sensors, start work,
invoke models, or contact a runner.

Display command help or senawa version:

```bash
senawa --help
senawa --version
```

The CLI never opens SQLite for normal service or workflow operations. The
explicit `--direct` recovery path remains available when the service is not
available and uses the same lease fence.

## Package support

Senawa package supports Node.js 22.12.0 or newer on Linux x64 with glibc
2.34 or newer. The only supported public executable is `senawa`; service
ownership remains available through `senawa service start` and
`senawa service run`.

The installed package includes the standard workflow template, prebuilt process
and workspace-file helpers, SQLite migrations, and the verified portal asset
manifest. It does not compile
native helpers during installation. The no-credit install and ordinary CLI or
service paths do not declare, resolve, install, or load the Copilot SDK or
Koffi. Live worker operation requires separately available
`@github/copilot-sdk` version `1.0.9` and explicit repository configuration.
