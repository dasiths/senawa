# Beads-Backed Offline Demo

This no-credit demo builds Senawa, creates an isolated temporary repository, and
runs the standard workflow through the real CLI and loopback browser command
path with deterministic workers. Mutable run, phase, task, dependency, gate,
and terminal state is stored in a real Beads database. Immutable documents and
append-only evidence remain in the work directory.

The demo omits `--runtime` so every spawned CLI process exercises the default
Beads composition. It fails rather than substituting file state when Beads is
missing, incompatible, or returns an error.

Run it from the repository root:

```bash
pnpm demo:beads
```

Keep its browser supervisor running for inspection:

```bash
pnpm demo:beads -- --keep-server
```

The fixture is local to this example under [`fixture/`](fixture/).