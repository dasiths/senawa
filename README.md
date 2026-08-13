---
title: Senawa
description: Deterministic workflow kernel and alpha command-line tooling
---

Senawa is being rebuilt as the deterministic workflow kernel of a
consumer-defined software factory.

The repository is in an alpha implementation reset. The executable creates and
validates versioned workflow configuration, starts the local supervisor, and
uses authenticated Unix-socket HTTP for workflow and operational commands.
Product direction and implementation phases are documented in the
[comprehensive plan](docs/design/implementation-plan.md), with decisions in the
[implementation log](docs/design/implementation-log.md).

The Node-local supervisor package exposes authenticated HTTP over a private Unix
socket and session-authenticated HTTP on `127.0.0.1`. See the [local supervisor
HTTP reference](docs/reference/local-supervisor-http.md) for routes and the alpha
security boundary. The daemon owns durable command recovery, bounded wake
processing, service lifecycle, persisted logs, SDK session-store health, and
state backup composition.

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm check:boundaries
pnpm docs:links
```

The alpha execution host targets Linux x64 with glibc 2.34 or newer. Builds
require a C17 compiler available as `cc` and package the resulting
`senawa-process-supervisor` executable under `@senawa/execution-host/dist`.
Runtime sensor execution never invokes a compiler.

## CLI

`senawa init [path]` exclusively creates the destination, writes and syncs the
complete example, closes it, then syncs its parent directory. Existing files
are never overwritten. A failed write or sync can leave the exclusively
created partial path in place; init never removes that pathname.

`senawa doctor [path]` reads JSON and reports deterministic syntax locations,
safe filesystem error codes, and all configuration diagnostics. It does not
execute sensors, invoke models, start work, or contact a runner. See the
[CLI reference](docs/reference/cli.md) for the complete alpha surface.

`senawa service start` launches the detached local supervisor and waits for an
authenticated status response. Use `senawa service run` for foreground service
ownership, or `status`, `drain`, `stop`, `logs`, and `recover` for lifecycle
operations. Workflow commands, receipt and event queries, projection reads, and
portal bootstrap all use the same authenticated local client.

Measured historical substrate behavior remains under
[experiments/probes](experiments/probes/README.md). Those probes do not imply
that their former production integrations remain supported.