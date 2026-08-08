# File-Backed Offline Demo

This no-credit demo builds Senawa, creates an isolated temporary repository, and
runs the standard workflow through the real CLI and loopback browser command
path with explicitly selected simulated workers.

It validates configuration loading, versioned artifacts, approval and rejection,
SSE replay, task dependencies, gate-driven rework, finish, and report rendering.
Every spawned CLI process passes `--runtime file`. The demo does not validate
Copilot behavior or the default Beads production adapter.

Run it from the repository root:

```bash
pnpm demo
```

Keep its browser supervisor running for inspection:

```bash
pnpm demo -- --keep-server
```

The fixture is local to this example under [`fixture/`](fixture/).