# File-Backed Offline Demo

This no-credit demo builds Senawa, creates an isolated temporary repository, and
runs the standard workflow through the real CLI and loopback browser command
path with deterministic workers.

It validates configuration loading, versioned artifacts, approval and rejection,
SSE replay, task dependencies, gate-driven rework, finish, and report rendering.
It does not validate Copilot behavior or the pending Beads production adapter.

Run it from the repository root:

```bash
pnpm demo
```

Keep its browser supervisor running for inspection:

```bash
pnpm demo -- --keep-server
```

The fixture is local to this example under [`fixture/`](fixture/).