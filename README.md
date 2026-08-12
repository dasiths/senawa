# Senawa

Senawa is being rebuilt as the deterministic workflow kernel of a
consumer-defined software factory.

The repository is in an alpha implementation reset. The current executable
exposes version and help information only. Product direction and implementation
phases are documented in the [redesign research](docs/design/wip/research/README.md)
and [comprehensive plan](docs/design/wip/research/07-comprehensive-implementation-plan.md).

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