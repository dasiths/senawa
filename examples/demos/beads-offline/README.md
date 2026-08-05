# Beads-Backed Offline Demo

This no-credit demo builds Senawa, creates an isolated temporary repository, and
runs the standard workflow through the real CLI and loopback browser command
path with deterministic workers. Mutable run, phase, task, dependency, gate,
and terminal state is stored in a real Beads database. Immutable documents and
append-only evidence remain in the work directory.

The demo selects the Phase 7 adapter explicitly. The ordinary CLI composition
still defaults to the file runtime until the Phase 8 production switch.

Run it from the repository root:

```bash
pnpm demo:beads
```

Keep its browser supervisor running for inspection:

```bash
pnpm demo:beads -- --keep-server
```

The fixture is local to this example under [`fixture/`](fixture/).