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
  evidence/
    implementation/v2.json
    repository/tasks/<task>/attempt-<n>/<dispatch>/
      baseline.json
      delta.json
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
    "model": "claude-sonnet-5",
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
turn, owner, attempt, trace, worker-host, adapter, and configured-model joins.
Model events distinguish requested and resolved model and effort. Reports mark
an invoked model only for a non-simulated host with model evidence. Replayed event IDs are idempotent and a
conflicting replay fails. The event stream is fully durable before final worker
output enters the aggregate commit that wakes browser readers. Task text events
materialize a capped, neutralized transcript; every task also receives either a
reported patch or explicit no-diff evidence.

Resolved input manifests record each consumer's logical reference, owner, path,
version, digest, and schema kind. Repository baselines and deltas record trusted
task-change evidence separately from worker claims. The verifier consumes a
Senawa-owned manifest that joins accepted artifacts, task outcomes, repository
deltas, deterministic gate evidence, and typed read paths.

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

The report renders these sections:

1. Request and outcome
2. Work decomposition graph
3. Host, adapter, execution classification, evidence kind, configured,
   requested, resolved, and invoked model and effort, attempts, duration, usage,
   and cost per dispatch
4. Gate refusals and the changes that followed
5. Human phase rejection and iteration history
6. Human questions, answers, and approvals
7. Work discovered during execution
8. Usage and cost by role, execution classification, and invoked model
9. Exact consumed input manifests
10. Trusted task-delta references
11. Per-criterion acceptance outcomes, verdicts, and resolved evidence
12. Evidence inventory

The Phase 9 renderer implements these sections from the full graph, journal,
output, and normalized worker-event projection. Usage checkpoints are cumulative
per dispatch, so report aggregation takes the latest checkpoint once rather
than summing repeated cumulative values. Aggregate usage and cost are nullable:
a role whose dispatches reported no usage renders `unreported`, because a
zero total would claim a measurement that never arrived.

The acceptance section renders each criterion with its required flag, the
outcome the worker claimed, the verdict the driver authored, and every resolved
reference with its resolution and source. Advisory references stay labelled as
advisory. The contract that produces them belongs to
[Sensors, Gates, and Enforcement](04-sensors-gates-and-enforcement.md#acceptance-evidence).

The decomposition diagram is built from graph nodes and parent-child edges. A
plain beads dependency tree is insufficient because sibling children with no
dependency between them disappear from that view.

## Evidence classification

Reports and findings use evidence labels as claims about provenance, not quality:

| Label | Meaning |
|-------|---------|
| `measured` | Senawa measured repository or substrate state through a trusted adapter |
| `offline` | A production contract passed without an authenticated model invocation |
| `simulated` | The explicit no-model worker adapter exercised lifecycle behavior |
| `live-model` | A non-simulated host emitted model execution evidence |
| `documentation` | A claim is based on documentation or declarations only |
| `unreported` | Durable evidence cannot support a stronger classification |

A configured model never proves invocation. The current report and exact
evidence contracts are [confirmed offline](wip/probe-findings.md#live-default-and-evidence-contracts).
Authenticated role-model quality and live trace delivery remain unvalidated.

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

The SDK adapter normalizes native events into Senawa event records and does not
expose the SDK event-history cursor. Offline fake-client tests cover native
assistant text and deltas, tool lifecycle, model resolution, cumulative usage,
typed phase artifacts, and explicit cancellation. Live trace joining and SDK
event delivery remain unvalidated.

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
`senawa work report` renders the current version from the journal, graph, and
telemetry at any point, not only at the end. `senawa work finish` marks the run
`finished`, which the Beads adapter reflects as the epic's closed coarse status;
it does not itself render a report or archive session transcripts.

Committing the report keeps process evidence beside the code under review. The
open repository policy question is whether the full tracking directory also
belongs on the main branch or on an archival branch.

## Next reading

Continue with [Implementation and Operations](07-implementation-and-operations.md)
for package boundaries, command surface, build order, and unresolved decisions.
