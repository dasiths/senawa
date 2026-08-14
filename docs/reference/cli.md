---
title: CLI Reference
description: Local supervisor, workflow, and configuration commands for Senawa alpha
ms.date: 2026-08-13
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
allocation facts. Exact retries reuse the durable command identity.

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

Create a sensor-free `senawa.dev/workflow/v1alpha2` JSON example without
overwriting an existing destination:

```bash
senawa init [path]
```

The path defaults to `senawa.json`. The command uses exclusive creation, so
concurrent invocations allow exactly one writer. Existing files, including
partial files, remain unchanged. Success means the complete content and its
parent directory have been synced. A failed write or sync can leave the newly
created partial path in place; init does not remove it because another actor
could have replaced the pathname.

Validate a JSON workflow configuration and report all deterministic compiler
diagnostics:

```bash
senawa doctor [path]
```

The path defaults to `senawa.json`. A valid document exits with code `0`.
Invalid configuration, invalid JSON, and read failures exit with code `1`.
JSON failures include a normalized syntax category and line and column.
Filesystem failures expose an allowlisted error code without stack traces or
internal paths. Doctor does not execute sensors, start work, invoke models, or
contact a runner.

Display command help or the alpha version:

```bash
senawa --help
senawa --version
```

The CLI never opens SQLite for normal service or workflow operations. The
explicit `--direct` recovery path remains available when the service is not
available and uses the same lease fence.