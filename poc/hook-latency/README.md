---
title: Hook Latency Probe
description: Whether a bundled Node CLI starts fast enough to run as a preToolUse hook on every tool call
author: Senawa
ms.date: 2026-08-02
ms.topic: reference
keywords:
  - hook latency
  - esbuild
  - preToolUse
estimated_reading_time: 3
---

## Goal

A `preToolUse` hook runs before every tool call, and a command hook that exceeds
its timeout fails open rather than closed. Startup cost therefore decides
whether hook-based gating is viable at all, and how `senawa` should be packaged.

## What it proves

Best of twenty cold starts, measured in this dev container:

| Invocation                                          | Measured |
|-----------------------------------------------------|----------|
| `/bin/true`, the process floor                      | 1 ms     |
| `node -e ''`, the V8 floor                          | 16 ms    |
| Bundled hot path, 260 KB, `yaml` only               | 33 ms    |
| Bundled full CLI, 1.2 MB, commander, zod, execa     | 66 ms    |
| The same full CLI resolving through `node_modules`  | 183 ms   |

Two conclusions follow, and both are now design rules.

Ship two entry points from one codebase. `senawa-hook` carries only what a hook
decision needs and stays near 33 ms. `senawa` is the full CLI, where 66 ms is
irrelevant next to sensor runtime and the 300 to 500 ms that any `bd` call costs.

Bundling requires a `createRequire` banner. esbuild's ESM output cannot
`require` CommonJS dependencies, and both `commander` and `yaml` are CommonJS,
so without the banner the bundle throws at import time rather than at build time.

## What it does not prove

* Hook cost on slower hardware or a cold filesystem
* Whether `senawa prime` fits inside a `sessionStart` budget, which depends on
  the graph read cache that does not exist yet

## Layout

| Path                | Role                                              |
|---------------------|---------------------------------------------------|
| `src/cli.mjs`       | Realistic CLI module graph, including the gate config |
| `src/hot-path.mjs`  | The same decision with no argument parsing or schema layer |
| `run.sh`            | Bundles both, benchmarks five invocations, checks the deny path |

## Running

```bash
bash poc/hook-latency/run.sh   # offline
```

## Change log

| Date       | Change                                                                                                   |
|------------|----------------------------------------------------------------------------------------------------------|
| 2026-07-28 | First run. Established 33 ms hot path against 66 ms full CLI and 183 ms unbundled, correcting the design's single 34 ms figure. Found that the missing `createRequire` banner breaks the bundle at import time. |
| 2026-08-02 | Renamed from `01-hook-latency` during probe consolidation. Re-measured at 35 ms, 72 ms, and 196 ms, so the split-binary conclusion holds. |
