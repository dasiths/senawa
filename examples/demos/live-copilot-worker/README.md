# Live Copilot Worker Demo

This guarded example exercises the current Copilot subprocess worker path and
may spend GitHub Copilot AI credits. It is not part of normal validation.

Run it only after reviewing the current production-status limitations:

```bash
pnpm demo:live -- --confirm-cost --host sdk --goal "Implement the requested change"
```

The launcher defaults to the SDK adapter. Pass `--host copilot` to select the
subprocess adapter instead. It uses deterministic phase preparation and the
selected live host for implementation workers. Every later resume must retain
the same worker-host selection. Subprocess edit and process capabilities remain
withheld until path-aware containment is proven, so this example is a bounded
host check rather than a complete implementation workflow.