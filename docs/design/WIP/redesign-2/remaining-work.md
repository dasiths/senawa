# What is left, and the order to do it in

This is the one open list. It consolidates what was scattered across
[the portal refactor plan](../portal-refactor-plan.md),
[the completion plan](completion-plan.md) and [the v1 plan](plan.md), all of
which describe finished work plus a few unfinished items that had drifted out of
agreement with each other.

Everything below is open. Anything not here is done, and the documents above
keep the history of how.

## How a phase is finished

Each phase ends with a live browser run, not a green suite. That is not
ceremony: in this branch, four consecutive attempts at one defect each passed
their tests and failed the run. A suite proves the change does what I meant; a
run proves I meant the right thing.

For every phase below:

1. Implement, with a test that fails against the old behaviour.
2. `npx tsc -b`, `npx vitest run`, `npx biome check .`,
   `node scripts/check-boundaries.mjs`, `node scripts/check-markdown-links.mjs`.
3. `senawa hard-reset` the example, start it fresh, and drive it **through the
   portal in a browser** until it stops or finishes.
4. Read the run's own record for what happened, not the driver's message.
5. Commit, push, and only then start the next phase.

## Phase 1: an attempt is recorded, not inferred

This is the mechanism behind every ordering defect on this branch, and it is
already designed. The protocol declares `start-phase-attempt` and
`record-phase-attempt-transition`, the daemon authorises both, and nothing ever
submits the second: the authority decodes its payload and records nothing.

Because no attempt is recorded, the driver infers whether an agent is alive from
the runner's effect log. That guess is what produces the live symptom four runs
in a row have shown:

```text
task_5d0d691e   ord 1 OPEN | ord 5 handed-in | ord 6 OPEN
```

Ord 5 does the work. Ord 6 is opened while ord 5 is still live, can never be
scheduled once the task is accepted, and the fan-in waits on it for ever.

Three guards on the answer path did not close it — refusing when the task is
accepted, when it has a durable completion, and while the member's own turn is
running. Each is correct and none is the creator, which is the argument for
fixing the mechanism instead of the next instance.

* [x] Record an attempt as opened when a task is dispatched, and closed when the
  worker returns, not when its cancellation is requested
* [x] Have the authority refuse to open a second attempt for a task while one is
  open, so the one-agent rule is enforced rather than merely respected
* [x] Delete `spentDispatch`; the retry question becomes whether the attempt is
  closed
* [x] Prove a second dispatch against an open attempt is refused, and that a
  closed attempt permits the next one, by breaking both

### The obstacle, and the route through it

`record-phase-attempt-transition` cannot carry the rule as declared:

```text
attemptDigest      a digest
transitionDigest   a digest
triggerDigest      a digest
disposition        iterate | escalate | fail | closed | refused
```

There is no task in it, so it cannot enforce "one open attempt per task".
`start-phase-attempt` is not the answer either: it refuses with
`phase-already-current`, so it moves between phases rather than opening an
attempt within one.

Nor can the context broker enforce it alone. It knows its own dispatches and
their terminal completions, but not whether a worker is still running — that
lives in the runner, on the other side of a boundary the architecture keeps
deliberately.

So the route is a protocol change: the attempt transition names the task it
belongs to, the authority records open and closed against it, and the refusal
lives where the record does. That is a breaking change to a declared payload,
which this branch permits, and it should be made deliberately rather than
approximated by a fourth guard in the driver.

* [x] The attempt transition payload names its task

Finished when a live run reaches every phase closed without a member holding two
dispatches.

## Phase 2: a stopped supervisor wakes again

F-061, diagnosed to the end. Everything under the supervisor recovers and there
is a test for it. The supervisor is wake-driven with no timer, so a cycle blocked
by a lease the dead owner still holds reports no work, stops the pump, and
nothing revisits the run when that lease expires a minute later.

The remedy is a scheduled wake at the expiry the authority already knows, which
changes how the service decides when to wake and should be made on purpose.

* [x] The service wakes at a lease expiry it already knows about
* [x] A run left by a dead owner resumes without a person restarting anything

## Phase 3: a run's state does not have to fit in one value

Every dispatch a run has ever made lives in one canonical blob, which must fit a
single 256KB wire value. A live run reached it and could no longer persist a
dispatch at all:

```text
ProtocolValidationError: $ wire value exceeds 262144 bytes
```

A run that cannot record anything is a worse failure than one that stops, and a
long run reaches this honestly.

* [x] A run's durable context state is not bounded by one wire value

## Phase 4: the browser suite means what it says

Three full runs failed three different tests, each of which passes alone. That is
interference between tests, not three defects, and three fixes aimed at the
symptom were wrong for that reason.

* [x] The failure is captured with its error context rather than reasoned about
* [x] Whatever the tests share is isolated per test, or made quiescent
* [x] The suite passes five consecutive full runs

## Phase 5: live tailing stops refetching

Already true. Read before writing, and the code disagreed with the plan:

* `PortalTranscriptPage` carries `nextAfter`, and `mergeTranscriptPage` merges
  by `(owner, sequence)` while advancing that cursor.
* `#performTranscriptSync` sends `state.ui.transcript.nextAfter`, so a poll asks
  only for what it has not seen.
* The store reads `WHERE sequence > ? ORDER BY sequence LIMIT ?` and appends a
  line durably as the agent streams it, rather than deriving the transcript from
  events on read.
* A poll re-syncs only when the transcript revision moved, so a run with no new
  agent output costs nothing.
* `terminal.spec.ts` already asserts the delta path end to end: one durable
  append raises the line count by exactly one while the assembly stays fresh.

The durable rebuild is still available from sequence zero, which is what the
plan wanted preserved.

* [x] Live tailing appends deltas rather than refetching the whole transcript

## Phase 6: a slow test that is really a slow feature

`waits for the members still working whichever one finishes first` takes
seventeen seconds alone, because every `advance` opens and verifies the record.
That is the latency of the phase-5 design showing up as a test one slow machine
away from timing out.

Skipping the cross-checks at open was tried and reverted: six tests assert that a
tampered mirror row is refused at startup, and the durability documentation
states the same guarantee. It is a real property, not an accident — the mirrors
are what queries read, so a tampered mirror serves wrong data silently.

The measured cost of opening a record is 1539 ms, of which about 964 ms is the
authority reparse the caller needs anyway and about 570 ms is the cross-checks.
Three ways out were weighed: make the cross-checks cheaper, verify only what
changed behind a verified-revision marker, or stop trusting the mirrors at all.
The first won, because the suspicion behind it was right. `verifyAmendmentTables`
re-read and reparsed the authority singleton that `verifyDatabase` had just
parsed, and the context singleton that `verifyContextTables` had just parsed.
Opening a record parsed the same two blobs four times between them.

Each singleton is now parsed once per pass and handed down. Measured against a
3 MB live record, `senawa status` fell from about 1950 ms to about 1478 ms, and
the six tests that defend the tampered-mirror guarantee still pass, because the
guarantee was never what cost the time.

* [x] Decide which of those three, and why
* [x] Advancing a run does not re-verify the whole record each time

## Phase 7: a run's state stops growing with the run

Phase 3 stopped a long run breaking. It did not stop a long run getting slower,
and the two findings behind that were recorded rather than bundled into it.

Every dispatch a run has ever made lives in one canonical blob that is rewritten
whole on every change. A run that has made a hundred dispatches rewrites all
hundred to record the hundred and first, so the work is O(n) per dispatch and
O(n²) over the run. Measured on the live example, the blob grows about 20 KB per
dispatch and the dispatches themselves are 78% of it:

| dispatches | durable context state |
| --- | --- |
| 3 | 59,709 bytes |
| 5 | 107,718 bytes |
| 7 | 146,678 bytes |
| 9 | 221,686 bytes |

The blob also duplicates a table that already exists. `context_dispatches` holds
one row per dispatch, written from the blob as a mirror, so the same content is
stored twice and only one of the two costs anything to write.

The route is the one task scope currentness already takes: keep the dispatches
in the table, leave them out of the serialized snapshot, and overlay them when
the authority is loaded. `overlayContextTaskScopeCurrentness` is the shape to
follow. It needs two columns the mirror does not carry yet — the task scope and
the effect seed — and a durable snapshot version that reads both the old form
and the new.

The 64 MiB ceiling is what makes this a performance question rather than an
outage, so it is worth doing properly rather than quickly.

* [ ] A dispatch is stored once, in the table that already holds it
* [ ] The durable snapshot reads both the form that carries dispatches and the
  form that does not
* [ ] Recording a dispatch does not cost work proportional to the run's history,
  proven by a growth measurement rather than by a passing test

## Phase 8: the two recovery gaps a live run found

Both were reproduced once, understood, and left. Neither is a guess.

A supervisor can let its own lease expire under itself. Under load the service
held its runner lease, did not renew it in time, and then failed on the fence
when it next used it. It recovers now, because a failed pump looks again, but
nothing has measured why a holder got that far behind its own renewal window.

A dispatch can be created and never enqueued. The window is between writing the
dispatch at the context layer and enqueuing the runner command for it. A process
that dies inside it leaves work that every recovery mechanism is blind to,
because they all key off an intent that was never persisted. Recovery has to key
off the dispatch: one with no runner command and no completion has not started,
and the honest repair is to enqueue it.

* [ ] A lease holder renews in time, or says why it could not
* [ ] A dispatch with no runner command and no completion is enqueued rather
  than waited on

## Phase 9: the example gates on its own work

The nine agents produced thirty passing tests and a `scripts/check.mjs` that
cannot run them: it invokes `node --test test/`, which this Node reads as a
module path. The phase closed anyway, because the workflow's gate is `git diff
--check`.

A gate that only checks whitespace teaches the example's reader the wrong thing
about what a gate is for, and it let broken work through on the first run that
produced any.

* [ ] The example's gate runs the produced project's own tests
* [ ] A run whose produced tests fail does not close the phase

## Carried from the v1 plan

Neither blocks anything above, and neither is part of the condition below. The
first is a feature the phase model does not yet have; the second is done.

* [ ] Give each member its own gates, approval and attempt policy, which is the
  D-025 deviation. Members run and the phase closes over all of them; per-member
  policy still needs the phase model
* [x] No consumer acceptance test has to write `WorkflowConfigurationDocument`
  directly

## The condition for the whole plan

* [x] With every phase above done, the example is driven once more from a clean
  state root, end to end in a browser, and completes

A run driven before the last change proves that change against the state it
happened to find. A run driven after everything proves the plan.

Phases 1 to 6 met that condition on `run_57b67ffdcd2a1f4c06af1d3bc6c6e1a2`.
Phases 7 to 9 were added afterwards from findings that run and its predecessors
produced, so they carry the condition again:

* [ ] With phases 7 to 9 done, the example is driven once more from a clean
  state root, end to end in a browser, and completes with its own tests passing
