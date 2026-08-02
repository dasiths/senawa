---
title: Worker Sessions Probe
description: Whether worker sessions resume with their own memory and stay out of the human's session history
author: Senawa
ms.date: 2026-08-02
ms.topic: reference
keywords:
  - session resume
  - session isolation
  - rework loop
  - copilot home
estimated_reading_time: 3
---

## Goal

Senawa dispatches one session per task. That design only pays off if a resumed
session still remembers what it built, because handing sensor failures back to
the worker that wrote the code is cheaper and better than re-briefing a fresh
one. It is also only tolerable if those sessions stay out of the human's session
picker, since a fifty-task work item would otherwise bury their own history.

## What it proves

Session identity is durable and caller-chosen. `--session-id <uuid>` creates a
session at an identifier senawa picks, and `--resume=<uuid>` continues it
non-interactively. Asked which word it had written to a file, without reading the
file, the resumed worker answered correctly. A fresh session asked the same
question had no prior context.

The rework loop is therefore sound as designed, and `--share` writes a transcript
that senawa can archive per task.

Cost accounting does not need a collector. `--output-format json` emits
`session.usage_checkpoint` events alongside `assistant.message`,
`model.call_start`, and a terminal `result`, so per-session accounting is
available directly from the subprocess path. Since senawa dispatches one session
per task, per-session attribution is per-task attribution.

Isolation works on both dispatch paths. A default client saw 34 sessions before
a worker was created under an isolated `baseDirectory` and 34 after, while the
isolated client saw its own. `COPILOT_HOME` achieves the same for the subprocess
path, and `deleteSession` removes the session once its transcript is archived.

## What it does not prove

* Whether trace context genuinely joins spans across two sessions, which needs a
  collector rather than a session listing
* Whether a session parked on a human gate survives a multi-day pause

## Layout

| Path             | Role                                                                  |
|------------------|------------------------------------------------------------------------|
| `resume.sh`      | Creates a session at a chosen UUID, resumes it, tests recall, checks JSONL |
| `isolation.mjs`  | Creates a worker under an isolated home and asks a default client whether it can see it |
| `run.sh`         | Runs both                                                             |

## Running

```bash
bash poc/worker-sessions/run.sh   # spends AI credits
```

## Change log

| Date       | Change                                                                                                                              |
|------------|-----------------------------------------------------------------------------------------------------------------------------------------|
| 2026-07-28 | Session resume probe. Confirmed caller-chosen identity, genuine recall on resume, control isolation for a fresh session, and the `session.usage_checkpoint` cost path. |
| 2026-07-28 | Session isolation probe. Confirmed `baseDirectory`, `COPILOT_HOME`, and `deleteSession`, and established that `parentAgentTaskId` is intra-session telemetry that cannot correlate dispatched sessions. |
| 2026-08-02 | Merged `05-session-resume` and `10-session-isolation` into one folder covering the worker session lifecycle. Corrected the earlier claim that this probe demonstrated cross-session tracing; it does not. |
