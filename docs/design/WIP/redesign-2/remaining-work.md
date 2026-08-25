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

* [ ] The attempt transition payload names its task

Finished when a live run reaches every phase closed without a member holding two
dispatches.

## Phase 2: a stopped supervisor wakes again

F-061, diagnosed to the end. Everything under the supervisor recovers and there
is a test for it. The supervisor is wake-driven with no timer, so a cycle blocked
by a lease the dead owner still holds reports no work, stops the pump, and
nothing revisits the run when that lease expires a minute later.

The remedy is a scheduled wake at the expiry the authority already knows, which
changes how the service decides when to wake and should be made on purpose.

* [ ] The service wakes at a lease expiry it already knows about
* [ ] A run left by a dead owner resumes without a person restarting anything

## Phase 3: a run's state does not have to fit in one value

Every dispatch a run has ever made lives in one canonical blob, which must fit a
single 256KB wire value. A live run reached it and could no longer persist a
dispatch at all:

```text
ProtocolValidationError: $ wire value exceeds 262144 bytes
```

A run that cannot record anything is a worse failure than one that stops, and a
long run reaches this honestly.

* [ ] A run's durable context state is not bounded by one wire value

## Phase 4: the browser suite means what it says

Three full runs failed three different tests, each of which passes alone. That is
interference between tests, not three defects, and three fixes aimed at the
symptom were wrong for that reason.

* [ ] The failure is captured with its error context rather than reasoned about
* [ ] Whatever the tests share is isolated per test, or made quiescent
* [ ] The suite passes five consecutive full runs

## Phase 5: live tailing stops refetching

The transcript is rebuilt from persisted events on every poll. It is correct and
wasteful. Deltas tail the live edge; the durable rebuild stays the source of
truth, because a delta stream cannot be replayed.

* [ ] Live tailing appends deltas rather than refetching the whole transcript

## Phase 6: a slow test that is really a slow feature

`waits for the members still working whichever one finishes first` takes
seventeen seconds alone, because every `advance` opens and verifies the record.
That is the latency of the phase-5 design showing up as a test one slow machine
away from timing out.

* [ ] Advancing a run does not re-verify the whole record each time

## Carried from the v1 plan

Neither blocks anything above.

* [ ] Give each member its own gates, approval and attempt policy, which is the
  D-025 deviation. Members run and the phase closes over all of them; per-member
  policy still needs the phase model
* [ ] No consumer acceptance test has to write `WorkflowConfigurationDocument`
  directly

## The condition for the whole plan

* [ ] With every item above done, the example is driven once more from a clean
  state root, end to end in a browser, and completes

A run driven before the last change proves that change against the state it
happened to find. A run driven after everything proves the plan.
