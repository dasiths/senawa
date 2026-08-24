# Finishing the portal, and removing sensitivity

This document is the research and the plan for the work still open on
`redesign/workflow-state-machine`. It is written against
[the portal refactor plan](../portal-refactor-plan.md), which holds the
per-phase checklists, and records evidence gathered by reading the code and
querying a wedged live run rather than by reasoning about either.

Three kinds of work are open, and they are not equally understood:

* a decision that is now taken, and is mostly mechanical to carry out
* two defects, one diagnosed to a line and one only characterised
* four unbuilt portal behaviours, each small and independent

## Asset sensitivity is removed entirely

The decision is taken: sensitivity goes, everywhere. This section records what
it does today so the removal can be checked off against something, because it
is load-bearing in one place and decorative in four.

### What it actually does

| Area | Behaviour | Evidence |
|---|---|---|
| Context broker | **Denies** an asset read | `packages/runtime/src/context-broker.ts` |
| Storage replay | **Denies** the same read | `packages/storage-sqlite/src/index.ts` |
| Portal | Displayed a column, gated nothing | removed already |
| Reporting | Projected as metadata, filters nothing | `reporting-snapshot.ts` |
| Kernel | An enum-checked string, no ordering | `packages/kernel/src/context.ts` |
| Compiler | Validates the enum, compares nothing | `packages/configuration/src/compiler.ts` |

The only enforcement is one comparison, made twice:

```ts
if (sensitivityRank(binding.sensitivity) > sensitivityRank(grant.envelope.sensitivityCeiling))
  return deny("sensitivity-denied");
```

`sensitivityRank` is `["public", "internal", "confidential", "restricted"].indexOf(value)`.
Nothing else in the system orders these words. The compiler never checks that a
view's ceiling can admit an output's sensitivity, so the only time the two meet
is at runtime, on a read that has already been granted in every other respect.

### Why it goes

The reader of this system is the developer whose run it is. An agent reading an
asset is doing so on their behalf, inside their repository, under a grant they
caused. A ceiling between those two parties models a boundary that does not
exist here, and the cost of keeping it is a field on every declaration, a
column in two tables, three wire fields, and a vocabulary in the authoring
language that an author has to choose from without guidance.

### What has to change

* `AssetSensitivity` and every field typed by it, in kernel and protocol
* `sensitivityCeiling` on `ContextGrantEnvelope`, and the `sensitivity-denied`
  denial code with it
* the two rank comparisons, and `sensitivityRank` in both copies
* `maxSensitivity` in authored evidence views, and `sensitivity` on authored
  outputs, plus their compiler validation
* two SQL columns, one carrying a `CHECK` constraint
* the conformance test that proves the denial, which is deleted rather than
  weakened, because the behaviour it proves is the behaviour being removed
* fixtures and acceptance tests that set the field

The migration is a schema change with no compatibility path, which this branch
permits.

## A dispatch that was never handed to the runner

### What happened

A live run stopped with `waiting for the agent working on implement` on every
cycle, nothing waiting on a person, and mode `running`. Restarting the service
did not move it. The trigger was a supervisor stopped mid-turn, which is
ordinary: any crash or restart reaches the same window.

The run's own tables say it exactly. Of ten dispatches, nine were handed to the
runner and one never was:

```text
researcher-work  task_e30bb4a5…  enqueued: true
researcher-work  task_e30bb4a5…  enqueued: true
researcher-work  task_e30bb4a5…  enqueued: true
implementor-work task_2108bcef…  enqueued: false
```

The three researcher dispatches are the useful control. They were enqueued, ran,
were cancelled, and recovered: the research phase closed. The fourth has no
runner command, no effect intent, no claim and no outcome. It exists only in
`context_dispatches`.

### Why nothing recovers it

Registering a dispatch and enqueuing its runner command are two writes in two
transactions, made by two components on different cycles. `registerDispatch`
stores the dispatch; the production scheduler enqueues it on a later pass.

Recovery keys off the intent. Taking a run lease at a higher fence clears a
claim whose owner died and lets a successor take the attempt, which is what
F-061 added and what recovered the three researchers. It iterates intents, so a
dispatch that never became one is invisible to it.

The fan-in, meanwhile, is correct to wait. A member with no completion is a
member still working, and `spentDispatch` is the release valve:

```ts
return String(details?.dispatchId) === dispatchId && outcome.status !== "completed";
```

That asks for a terminal outcome. No intent means no outcome, so a dispatch that
never started can never be spent, and the phase waits for a process nothing was
ever told to run.

### The fix, attempted and withdrawn

Recovery has to key off the dispatch, not the intent, because the dispatch is
the record that exists in the failure. The first attempt read a dispatch the
runner had never heard of as a turn that never began, and let the existing
retry path open a fresh attempt.

Driven live, that was worse than the wedge it replaced. The run reached the
implement phase and produced **ten dispatches for one task**: one that ran and
completed, and nine created one after another and never enqueued. The scheduler
would not schedule them, so each cycle found the newest dispatch unstarted and
made another. A run that used to stop now grew instead, and still did not move.

The reading was wrong in the same way three earlier guesses were wrong: it
treated "no runner command" as proof the work had not started, when it is also
what the scheduler leaves behind when it deliberately declines a dispatch. An
idle runner does not distinguish those two.

Reverted. What is actually needed first is the answer to a question this
document cannot yet answer: **why does the scheduler decline these dispatches?**
`#scheduleRepository` skips any dispatch whose task is not in the ready
frontier, and `#ready` marks a task `accepted` and drops it. Until that is
established by reading the scheduler against a real stalled run, any recovery
built on top is guessing.

* [ ] Establish why the production scheduler declines a registered dispatch
* [ ] Recovery keyed off that answer, not off the absence of an intent
* [x] The wedged state is reachable in a test without a live model — the
  predicate and its four look-alike states were tested, and the tests were
  sound. The behaviour they proved was the wrong behaviour, which no unit test
  could have told me. The live run did, in twenty minutes.

### What has been ruled out

Two candidates looked decisive and were not. Both are recorded because the next
attempt should not spend the evidence again.

**Ambiguous dispatches are not it.** `selectCurrentDispatches` returns
`undefined` for the whole run when any one task has more than one dispatch
matching its scope, and `schedule()` then quietly does nothing, which would be a
blast radius worth fixing on its own. It does not fire here. Every dispatch
carries a distinct `contextDigest`, and the scope's `current_context_digest`
names exactly one of them, so `matches.length` is never above one:

```text
task_407c053a…  dispatches=10, ten distinct digests
scope           current_context_digest a239353edf9f  (one of the ten)
```

**A lost effect is not it either.** `selectCurrentDispatches` silently skips any
dispatch whose `effect` is `undefined`, and `context_dispatches` has no effect
column, which suggested the effect lived only in the registering process's
memory and could never be scheduled by the daemon. It is persisted, inside the
`context_authority_state` blob under `$.dispatches[].effect`.

### What is left to read

Fresh dispatch requirements are ruled out too. Three answers were given on this
run and each created one, but all three name the superseded *researcher*
dispatches, not the implementor dispatch that is waiting:

```text
fresh dispatch requirements: 3
   stale dispatch: f2226c1f1df3   researcher
   stale dispatch: 67c63ef271cb   researcher
   stale dispatch: 967daa68a5f8   researcher
selected implementor dispatch:  a239353edf9f   not named by any requirement
```

So `schedulableDispatches` passes it through, and the decline is in `#ready`:

```ts
if (!ready.has(dispatch.taskScope.taskId)) continue;
```

`#ready` marks an accepted task and drops it, then asks
`deriveReadyTaskFrontier` which of the rest are ready. A task the frontier does
not return is skipped with nothing recorded to say so. `task_407c053a` has no
acceptance record and no worker effect, so it should read `pending`; whether
the frontier withholds it, and why, is the one thing still unread.

The next step is to run `#ready` against this database and print the facts it
builds and the frontier it gets back. The state is still on disk. A scheduler
that declines a dispatch should say so rather than return `worked: false`,
which is the change this will most likely justify.
so it can be.

## The browser suite fails a different test each run

This one is characterised, not diagnosed, and the plan says so rather than
guessing a fourth time.

| Run | Projects | Result |
|---|---|---|
| 1 | all | `journey.spec.ts:375` failed |
| 2 | three | all passed |
| 3 | three | `panels.spec.ts:418` failed |

`panels.spec.ts` passes twelve of twelve, three times running, on its own. So
the failures are interference between tests rather than defects in the
behaviours they cover. Three fixes aimed at the journey test were wrong for that
reason: they treated a shared symptom as a local one.

What is known: the suite runs one worker against one service, tests share
fixture runs, and the supervisor's drive loop keeps advancing those runs while
assertions are made about them. A test that asserts a run is `running` can lose
to a driver that paused it.

* [ ] The failure is captured with its error context rather than reasoned about
* [ ] Whatever tests share is either isolated per test or made quiescent
* [ ] The suite passes five consecutive full runs

## Four portal behaviours

Each is small, independent, and has no blocker.

### A delivery record hangs off the moment that published it

What a phase produced is listed apart from the history, under
`What the run produced (undated)`, because delivery records carry neither a
cursor nor a time. A reader looking at the moment a phase closed cannot reach
what it produced, and a reader looking at an output cannot reach when it
appeared.

The join exists: a delivery record names its `phaseId` or `taskId`, and a moment
now knows the task it happened to. Records that match no moment keep the undated
list, and it keeps its name, because a record with no time saying so is the
point of that section.

* [x] A delivery record is reachable from the moment that published it
* [x] What cannot be dated still says that it cannot — the undated list keeps
  its name and now holds only what no moment claimed, so it shrinks to the
  records that genuinely have no place in the order.

### `Recently answered`, or the reason it is elsewhere

The rail promises it. Answers are readable on the transcript, which may be the
better home. Build it or delete the promise and say which.

* [ ] `Recently answered` in the rail, or the reason it belongs on the transcript

### An artifact renders on the edge that carried it

An output belongs on the arrow leaving the node that produced it, which is where
a reader looks for it on a graph.

* [ ] An artifact renders on the edge leaving its producing node

### Deltas for live tailing

The transcript is rebuilt from persisted events on every poll. It is correct and
wasteful. Deltas tail the live edge; the durable rebuild stays the source of
truth, because a delta stream cannot be replayed.

* [ ] Live tailing appends deltas rather than refetching the whole transcript

## Proven by driving it

None of the above is finished until the example runs end to end, in a browser,
driven by Playwright rather than asserted.

* [ ] The example completes with every phase closed
* [ ] Every question is answered from the portal
* [ ] The run recovers from a supervisor restart mid-turn

The last one is new, and belongs here rather than in a unit test, because the
wedge above was only ever visible in a live run.
