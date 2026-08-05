# Provenance and Observability

## Purpose

A run may span many agents and several days. The final diff cannot explain who
did each task, which model ran, how often work was refused, what the human
changed, or what the process cost.

Senawa records that process as a side effect of trusted harness operations. It
does not ask agents to summarize their own compliance.

## Work directory

```text
.agents/.copilot-tracking/<work>/
  work.json
  cache.json
  driver.lock
  steering.jsonl
  driver.log
  journal.jsonl
  report.md
  workers/sessions/<session>/<turn>.jsonl
  snapshot/
  .copilot-home/
  artifacts/
    research/
      v1.json
      current -> v1.json
    plan/
      v1.json
      v2.json
      current -> v2.json
  decisions.md
  questions.jsonl
  sensors/
    cache.json
    runs/<sensor>/<timestamp>.json
  tasks/<task>/
    brief.md
    transcript.md
    verdicts.jsonl
    diff.patch
```

Beads holds graph state and pointers. The work directory holds files, evidence,
and isolated session state. Neither is a writable mirror of the other.

Snapshot inputs name their repository sources explicitly:
`.senawa/workflows/<name>.yaml`, `.senawa/schemas/*.schema.json`,
`.senawa/sensors.yaml`, `.senawa/agents/*.senawa.md`, and the user-facing
`.agents/skills/senawa/SKILL.md` discovery asset. The snapshot stores normalized
workflow and policy representations, each schema under its repository path, the
parsed profiles, and exact profile and skill sources. A content fingerprint
binds the snapshotted representations to the run. Every turn records the
selected profile name and source digest.

Session hook policy, host capability mapping, and the enforcement ceiling are
versioned with the Senawa runtime rather than accepted as repository grants.
Runtime upgrades may tighten enforcement, but they cannot replace snapshotted
profile instructions or requested capabilities during a resumed run.

## Journal contract

The journal is JSON Lines with one writer, monotonic sequence numbers, and no
rewrites:

```json
{
  "seq": 128,
  "ts": "2026-07-28T04:11:09Z",
  "work": "2026-07-28-refactor-ingest",
  "task": "bd-a1b2",
  "event": "gate.evaluated",
  "actor": {
    "role": "implementor",
    "session_id": "0cb916db-26aa-40f2-86b5-1ba81b225fd2",
    "model": "claude-sonnet-4.6",
    "effort": "high"
  },
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "gate": "task-done",
  "verdict": "fail",
  "attempt": 2,
  "failed": ["unit-tests"],
  "evidence": "sensors/runs/unit-tests/20260728T041109Z.json"
}
```

The event vocabulary is small and versioned. It covers work, phase, plan, task,
dispatch, sensor, gate, question, steering, approval, and lifecycle transitions.

Normalized worker events carry stable event, operation, dispatch, session,
turn, owner, attempt, and trace joins. Replayed event IDs are idempotent and a
conflicting replay fails. The event stream is fully durable before final worker
output enters the aggregate commit that wakes browser readers. Task text events
materialize a capped, neutralized transcript; every task also receives either a
reported patch or explicit no-diff evidence.

### Journal rules

* Every event names its actor and channel.
* A worker action causes an event but cannot author arbitrary journal content.
* Evidence is a path, not an embedded output blob.
* Supersession is a later event, never a rewrite.
* Dispatch intent is recorded before its external side effect.
* Journal sequence, graph node, session ID, and trace ID provide independent join
  paths.

## Status and report serve different readers

`senawa work show` is a bounded operational projection. It intentionally omits
history and returns what is actionable now.

`senawa work report` is a complete human artifact. It is regenerated from the
journal, graph, and telemetry, and deliberately retains the process.

A principal agent may request report generation and return its path. It does not
load the unbounded report into its own context.

## Report structure

The report renders eight sections:

1. Request and outcome
2. Work decomposition graph
3. Role, model, effort, attempts, duration, and AIU per task
4. Gate refusals and the changes that followed
5. Human phase rejection and iteration history
6. Human questions, answers, and approvals
7. Work discovered during execution
8. Cost by role and model

The Phase 9 renderer implements these sections from the full graph, journal,
output, and normalized worker-event projection. Usage checkpoints are cumulative
per dispatch, so report aggregation takes the latest checkpoint once rather
than summing repeated cumulative values.

The decomposition diagram is built from graph nodes and parent-child edges. A
plain beads dependency tree is insufficient because sibling children with no
dependency between them disappear from that view.

## Rendering boundary

Journal fields may contain strings influenced by models, source files, test
output, and humans. Reports can later enter pull requests or agent contexts.

The renderer therefore:

* Escapes every interpolated field.
* Removes control characters.
* Rejects raw HTML.
* Applies deterministic length caps.
* Links large evidence by path.
* Never treats journal content as Markdown instructions.

The same rules apply to task titles, summaries, questions, answers, and sensor
findings.

## Trace correlation

Every unit of work must remain reachable from any other after the run:

| Layer | Join key | Works without telemetry collector |
|-------|----------|-----------------------------------|
| Journal | Work, task, actor session ID | Yes |
| Copilot spans | `gen_ai.conversation.id` | No |
| Distributed trace | W3C `traceparent` | No |

The SDK calls `onGetTraceContext` before session creation, resume, and send.
Senawa injects the current dispatch span context. Typed tool handlers receive the
worker's trace context, allowing sensor execution and gate evaluation to nest
under the tool call that requested them.

The subprocess fallback propagates `TRACEPARENT` and work attributes through the
environment.

Read-only `parentAgentTaskId` telemetry does not correlate independent sessions
and is not used as a control or audit key.

## Cost attribution

Hosted sessions expose token, cost, and AIU telemetry. Subprocess `-p` mode does
not export all subagent spans, so the primary subprocess cost source is the JSONL
`session.usage_checkpoint` stream.

Because Senawa dispatches one independent session per task, per-session accounting
maps directly to a task. The journal records checkpoints with the task and role.

Useful operating metrics include:

| Metric | Diagnostic value |
|--------|------------------|
| Rework attempts by role | Brief quality and model-task fit |
| Sensor verdict distribution | Flaky or decaying checks |
| Advisory findings later confirmed | Evidence for promotion |
| AIU per accepted task | Model value by task class |
| Escalation rate | Budget calibration |
| Hook latency tail | Policy checks approaching fail-open timeout |

## Report integrity

`report.md` is derived and never hand-edited. Deleting it loses no source data.
`senawa work finish` renders the final version after closing the epic and
archiving session transcripts.

Committing the report keeps process evidence beside the code under review. The
open repository policy question is whether the full tracking directory also
belongs on the main branch or on an archival branch.

## Next reading

Continue with [Implementation and Operations](07-implementation-and-operations.md)
for package boundaries, command surface, build order, and unresolved decisions.
