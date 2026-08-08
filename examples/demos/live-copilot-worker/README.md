# Live Copilot Worker Demo

> [!WARNING]
> This demo spends GitHub Copilot AI credits and is not part of normal
> production validation.

This guarded example exercises a selected live worker host and may spend GitHub
Copilot AI credits. It is not part of normal validation.

Run it only after reviewing the current production-status limitations:

```bash
pnpm demo:live -- --confirm-cost --host copilot-sdk --goal "Implement the requested change"
```

The launcher defaults to the SDK adapter. Pass `--host copilot-subprocess` to
select the experimental subprocess adapter instead. It uses `--runtime file`
(the explicit development and test adapter) for state storage and persists the
selected host for every worker turn. Resume reads that identity and refuses an
explicit mismatch. Subprocess edit and process capabilities remain withheld
until path-aware containment is proven, so this example is a bounded host check
rather than evidence of a complete live workflow. It does not validate Sonnet 5
or Opus 5 availability, model quality, or tmux behavior.