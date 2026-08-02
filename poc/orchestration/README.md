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

Structural errors are found before anything is dispatched. Against a deliberately
invalid workflow, `doctor` reported ten violations in one pass: a dependency
cycle, a missing gate, an unknown approval value, a non-finite `iteration.max`,
an unknown staleness policy, `reentrant` on an agent phase,
`resumeAcrossIterations` on a task frontier, missing rework and dispatch budgets,
and a `completesWhen` naming a phase that does not exist.

Kickoff is one transaction. `work start` validates the merged input against the
workflow input schema, copies the workflow, sensor and gate configuration, and
schemas into the work directory, records a single content fingerprint, then
creates the epic and five phase beads with their dependency edges. It then
drives, in the foreground, until it needs a human.

Runtime state lives in the graph, not beside it. Phase status, iteration, session
identifier and artifact version are held in bead metadata; transitions go through
`bd set-state`, so a `senawa:awaiting_approval` label answers "what needs a
human" without reading a local file; and waiting for approval is a beads `human`
gate that genuinely blocks the phase. `work.json` holds only run identity, and
the probe deletes `cache.json` mid-run to prove nothing depends on it.

The run follows its frozen snapshot. The probe edits the source workflow
immediately after kickoff; the run completes from the snapshot and reports
`sourceChanged: true` rather than silently adopting the edit.

Phases stop for approval and can be sent back. The probe rejects the plan with a
reason, and the planner's own session resumes to produce v2, which contains the
task the rejection asked for. Artifacts are versioned rather than overwritten, so
v1 remains readable next to v2.

A killed driver is recoverable. The probe kills the process after the worker has
acted but before the outcome is journalled. On resume, reconciliation finds the
intent with no outcome, sees that the turn completed, and gates the work the
worker actually produced rather than dispatching it again.

Iteration is additive. After verification the probe adds a task with
`plan revise`, the implementation frontier re-opens, the new task runs, and the
three already-closed tasks are untouched. Verification runs a second time, and
the run ends only when the human accepts it.

A representative run:

```text
define        approved, iteration 1
research      approved, iteration 1
plan          rejected, then approved at iteration 2 (v2 adds error handling)
implement     driver killed mid-dispatch, reconciled, one refusal, three tasks closed
verify        reached, then superseded by a plan revision
implement     re-opened, add-logging closed
verify        iteration 2, approved
work          accepted
```

Final state: five accepted phases, four closed tasks, plan at v3, verify at
iteration 2, 64 journal events, and every session under the work directory's own
home rather than the user's.

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
* Parallel task-frontier execution, worktrees, and merge-slot integration
* Inline TTY controls, which the design specifies but this probe replaces with
  separate command invocations
* That a real Copilot session resumes usefully across many phase iterations,
  which is where background compaction eventually bites

## Layout

| Path             | Role                                                                    |
|------------------|--------------------------------------------------------------------------|
| `engine.mjs`     | Validation, kickoff, the blocking driver, approvals, iterations, reconciliation |
| `run.sh`         | The full human journey: approve, reject, crash, resume, revise, accept    |
| `senawa.mjs`     | Throwaway per-task harness: graph, sensors, gate, journal, run report     |
| `end-to-end.sh`  | Live run: constructed worker environment, real dispatch, refusal, rework  |
| `workflows/`     | A valid five-phase workflow and a deliberately invalid one               |
| `schemas/`       | Work request input schema                                                |
| `extra-tasks.json` | The tasks added after verification, to prove revision is additive      |
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
| 2026-08-02 | Replaced the scheduler model with a blocking driver. `work start` now drives to completion and exits 2 when a human is needed; `work resume` reconciles and continues. Added phase approvals, rejection with iterations that resume the phase session, versioned artifacts, additive `plan revise`, human acceptance as the completion condition, and an injected mid-dispatch crash proving intent-before-side-effect journalling is enough to recover. |
| 2026-08-02 | Moved runtime state into beads, where the design always said it belonged. Phase status, iteration, session and version now live in bead metadata, transitions write `senawa:<state>` labels, and approvals are real `human` gates. Two bugs surfaced immediately: `bd list` hides closed issues, so finished tasks vanished from the frontier and `plan revise` would have recreated them, and reopening a phase without resolving its outstanding gate left the phase bead permanently blocked. |
