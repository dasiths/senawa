---
title: Senawa
description: Deterministic workflow kernel and alpha command-line tooling
---

Senawa is being rebuilt as the deterministic workflow kernel of a
consumer-defined software factory.

The repository is in an alpha implementation reset. The current executable
supports version and help output, creates a versioned JSON example with
`senawa init`, and validates JSON workflow configuration without executing work
through `senawa doctor`. Product direction and implementation phases are
documented in the [comprehensive plan](docs/design/implementation-plan.md), with
decisions and deviations in the
[implementation log](docs/design/implementation-log.md).

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

Measured historical substrate behavior remains under
[experiments/probes](experiments/probes/README.md). Those probes do not imply
that their former production integrations remain supported.