# Senawa

Senawa is being rebuilt as the deterministic workflow kernel of a
consumer-defined software factory.

The repository is in an alpha implementation reset. The current executable
exposes version and help information only. Product direction and implementation
phases are documented in the [comprehensive
plan](docs/design/implementation-plan.md), with decisions and deviations in the
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

Measured historical substrate behavior remains under
[experiments/probes](experiments/probes/README.md). Those probes do not imply
that their former production integrations remain supported.