---
title: Orchestration Probe
description: Whether the harness can own the task loop and run a declarative workflow from durable state
author: Senawa
ms.date: 2026-08-02
ms.topic: reference
keywords:
  - orchestration
  - workflow engine
  - backpressure
  - beads
  - rework loop
estimated_reading_time: 5
---

## Goal

This is the probe closest to the product. It covers both levels of the
orchestration loop: the per-task loop where the harness dispatches a worker,
refuses its work, and hands back findings, and the workflow above it that
compiles phases into durable state and advances them without a human watching.

## What it proves

### The workflow engine, offline

Structural errors are found before anything is dispatched. Against an invalid
workflow, `doctor` reported a dependency cycle, a missing gate, a missing rework
budget, and a missing dispatch-failure budget in one pass. `workflow list`,
`workflow info`, and a Mermaid preview describe the run before it costs anything.

Kickoff is one transaction. `work start` validates the merged input against the
workflow input schema, copies the workflow, sensor and gate configuration, and
schemas into the work directory, records a single content fingerprint, then
creates the epic and five phase beads with their dependency edges.

The run follows its frozen snapshot. The probe edits the source workflow
immediately after kickoff; the run completes from the snapshot and reports
`sourceChanged: true` rather than silently adopting the edit.

Advancing is restart-safe. Nine separate processes each called `tick` and
advanced exactly one transition, refreshing phase, task, and epic status from
beads rather than trusting a cached projection:

```text
define closed
research closed
plan closed, two dependent implementation beads imported
implement-api failed attempt 1
implement-api passed attempt 2 in the same recorded session
update-caller passed attempt 1
implementation frontier closed
verification closed
work closed
```

The task-frontier loop honours dependencies, bounded rework, and closure by the
harness. The epic ended closed in the real beads database.

### The per-task loop, live

Capability removal is practical. The worker's environment is constructed rather
than filtered: a directory containing exactly the executables it may reach, with
`bd` deliberately absent. The worker could reach `senawa` and could not reach
`bd`.

The bead status is the proof. Across every run, including failed ones, task
status changed only when the orchestrator changed it, and the worker never
edited the test that judged it.

Instruction-only compliance is unreliable, and it does not matter. In one run the
worker submitted through `senawa task done` as instructed; in another it silently
skipped the call, edited the file, and ended its turn. The outcome was correct
both times because the orchestrator's gate run is authoritative.

Execution hints cannot be forwarded blindly. Passing `--effort` to a model that
does not support it is a hard error that kills the dispatch before the worker
starts, and because the session was never created, the follow-up resume attempts
failed too. One bad flag consumed an entire task budget and reported it as the
worker's fault, which is why dispatch failures need their own event and their own
budget.

## What it does not prove

* Real agent phases submitting schema-valid artifacts, since the workflow hosts
  are deterministic fakes
* Human approval parked across a restart while sibling work continues
* Crash safety between a graph write and the journal or state write
* Parallel task-frontier execution, worktrees, and merge-slot integration

## Layout

| Path             | Role                                                                    |
|------------------|--------------------------------------------------------------------------|
| `engine.mjs`     | Workflow validation, kickoff, snapshotting, and the bounded tick engine   |
| `run.sh`         | Offline workflow run: doctor, preview, kickoff, nine ticks, final state   |
| `senawa.mjs`     | Throwaway per-task harness: graph, sensors, gate, journal, run report     |
| `end-to-end.sh`  | Live run: constructed worker environment, real dispatch, refusal, rework  |
| `workflows/`     | A valid five-phase workflow and a deliberately invalid one               |
| `schemas/`       | Work request input schema                                                |
| `sensors.yaml`   | Gates and sensor declarations used by the engine                         |
| `fixture/`       | The small buggy program the live worker is asked to fix                  |

## Running

```bash
bash poc/orchestration/run.sh          # offline, slow because it uses a real beads database
bash poc/orchestration/end-to-end.sh   # spends AI credits
```

## Change log

| Date       | Change                                                                                                                                            |
|------------|-----------------------------------------------------------------------------------------------------------------------------------------------------|
| 2026-07-28 | End-to-end probe. Established that capability removal works, that only the orchestrator changes bead status, that worker compliance is unreliable but harmless, and that forwarding an unsupported effort hint destroys a task budget. |
| 2026-08-02 | Added the workflow engine: declarative phases, structural validation before dispatch, frozen definition snapshots, plan expansion into dependent beads, and restart-safe bounded ticks. |
| 2026-08-02 | Merged the workflow engine and the end-to-end probe into one folder, since they are the same loop at two levels. Corrected the engine to refresh lifecycle status from beads on every tick rather than trusting its own JSON cache. |
