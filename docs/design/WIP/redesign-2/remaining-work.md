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

The loop is one phase wide. A phase is not started until the phase before it has
been proved by a run, and a phase is not proved by anything else.

```text
for each phase:
    write the phase into this document, with what is wrong and what would fix it
    implement it, correcting this document wherever the code disagrees with it
    drive the example end to end through the portal in a browser
    read the run's own record, not the driver's message
    commit and push
```

For every phase below:

1. Write the phase down first: the symptom, the evidence, and the items. A
   finding that only exists in the implementation log is a finding nobody will
   act on.
2. Implement, with a test that fails against the old behaviour.
3. `npx tsc -b`, `npx vitest run`, `npx biome check .`,
   `node scripts/check-boundaries.mjs`, `node scripts/check-markdown-links.mjs`.
4. Reset the example's state root, start it fresh, and drive it **through the
   portal in a browser** until it stops or finishes.
5. Read the run's own record for what happened, not the driver's message.
6. Update this document to match what was actually built, then commit, push, and
   only then start the next phase.

A run that stops rather than finishes is not a failed phase. It is the next
phase's evidence, and it gets written down before anything is changed in
response to it — which is where phases 7 to 11 came from.

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

Reading that one out found a second dispatch-shaped hole beside it. A dispatch
is only schedulable through its registered effect, and `selectCurrentDispatches`
drops one stored without an effect from the current set without a word. It has
no runner command, no completion, and no path to either. It cannot be enqueued,
because there is no command to enqueue, so the repair is to name it.

And a third, found while reading the first two. `selectCurrentDispatches`
returns `undefined` when a task has more than one current dispatch or more than
one accepting scope, and `schedule` turns that into `worked: false` and returns
before `#recordDecline` can say anything. An ambiguity that stops a run from
scheduling anything at all is reported as an idle cycle.

* [x] A lease holder renews in time, or says why it could not
* [x] A dispatch with no runner command and no completion is enqueued rather
  than waited on
* [x] A dispatch that registered no effect is named rather than dropped
* [x] A run that cannot decide which dispatches are current says so, rather than
  reporting the same silence an idle run reports

The lease holder now measures its own renewal against when that renewal was due.
A renewal that runs after the lease it renews has already expired says how late
it was and by how much, and a renewal that throws says what it threw. Both reach
`supervisor_logs` through the service.

Recovery keying off the dispatch turned out to be already true in both workspace
modes, and was being taken on trust. It is now held by a test that registers a
dispatch, persists no intent, and asserts the next schedule pass queues its
command.

## Phase 9: the gate the agent cannot see

Written down first as "the workflow's gate is `git diff --check`", and that was
wrong. Reading it out before changing anything found the gate has always been
`node scripts/check.mjs`, a real executable sensor that refuses a project with
no tests as loudly as one with failing tests, wired blocking on `implement`
since the file was created. A red sensor already refuses to close a phase, and
`brief-scenarios.test.ts` holds that with `sensorCommand: "false"`. Both
criteria as written were already true, and ticking them would have recorded a
measurement of the wrong thing.

What was actually observed survives the correction. The nine agents produced
thirty passing tests *and* a `scripts/check.mjs` of their own that cannot run
them: it invokes `node --test test/`, which this Node reads as a module path.
Nothing noticed, because nothing runs it. The gate runs the example's script,
from the project root; the agents' file sits in the workspace, dead.

They wrote it because they were told to. The implementor prompt says "The whole
project is checked by `node scripts/check.mjs`", and that path resolves against
the project root for the sensor and against the workspace for the agent. An
agent reads the sentence, finds no such file where it is standing, and helpfully
supplies one. The prompt names a path the agent can neither see nor reach, so it
manufactures a second runner that rots on the first day.

F-058 in the implementation log already recorded the cost without naming the
cause: two runs in a row spent a question on "I'm attempting to create
scripts/check.mjs but the workspace filesystem tools won't allow writing to a
non-existent parent directory". The missing `mkdir` was fixed. The reason an
agent was trying to write that file at all was not.

A gate is described to an agent by what it requires, not by a command line the
agent is standing in the wrong directory to run.

* [x] The example's gate runs the produced project's own tests (already true)
* [x] A run whose produced tests fail does not close the phase (already true)
* [x] The implementor prompt describes the gate by what it requires, and names
  no path the agent will try to satisfy by writing it

## Phase 10: a criterion is not a piece of work

The `implement` band of the finished run reads:

```text
◆ implement  done  8 members
  implement-work-0778519c6a4a4bc8   implementor claude-sonnet-5   done
  implement-produced                                              done
  implement-work-0b9b3bee3b85e1d7   implementor claude-sonnet-5   done
  implement-produced                                              done
  implement-work-dcb6f9ee98240a30   implementor claude-sonnet-5   done
  implement-produced                                              done
  implement-work-df4e935387280642   implementor claude-sonnet-5   done
  implement-produced                                              done
```

Four pieces of work, and the phase says eight members. `implement-produced` is
the required completion criterion each task is judged against, drawn as a card
beside the task it belongs to.

The portal already knows what a criterion is somewhere else. `render.ts` labels
the kind `exit condition` and carries two comments that the graph contradicts:
"A criterion is how a phase is allowed to finish, not a sibling of the phase",
and "A criterion did not run; the task that had to satisfy it did". The graph
gives it a peer card, a member count, and a green `done` pill.

`graph-flow.ts` flattens task and criterion into one list on purpose — matching
on the direct parent alone left every criterion out of its band and piled them
under the last one — so the fix is to place a criterion *within* its task rather
than to unflatten and regress that.

The identical names are upstream of the portal, in the authoring lowering. A
fan-out member's criterion is named after the phase; an explicitly authored
item's is named after the item:

```ts
criteria: [{ key: `${phase.name}-produced`, ... }]   // taskTemplates, every member
criteria: [{ key: `${item.key}-produced`, ... }]     // explicit items, distinct
```

So every member of a fan-out owes a criterion with one shared name, and a reader
cannot tell which task any of the four boxes belongs to.

### What a criterion should look like

A criterion belongs to the node that had to satisfy it, so it is drawn inside
that node's card rather than beside it: a row of small marks on the task, one
per criterion, each dark while the task still owes it and lit once the task has
produced it. The criterion's name is the mark's accessible name, so four
identically named criteria on four different tasks stop being four anonymous
boxes and become one mark on each of the four cards that owes it.

That also answers the count and the state pill without a separate rule. A mark
is not a member, so the band counts pieces of work; and a mark is lit or unlit
rather than `done`, so nothing claims a criterion ran.

The mark stays selectable, because the detail pane already renders a criterion
correctly as an `exit condition` and that reading should stay reachable.

```text
◆ implement  done  4 pieces of work
  implement-work-0778519c6a4a4bc8   implementor claude-sonnet-5   done  ●produced
  implement-work-0b9b3bee3b85e1d7   implementor claude-sonnet-5   done  ●produced
  implement-work-dcb6f9ee98240a30   implementor claude-sonnet-5   done  ●produced
  implement-work-df4e935387280642   implementor claude-sonnet-5   done  ●produced
```

* [x] A criterion is a mark inside the card of the node that had to satisfy it,
  lit when that node has produced it and dark while it is still owed
* [x] The mark carries the criterion's name, and selecting it still opens the
  criterion in the detail pane
* [x] A phase's member count counts pieces of work
* [x] A criterion displays no run state, because it did not run
* [~] A fan-out member's criterion is named after the member, not the phase
* [x] A criterion whose task is not in the band is still reachable, which is the
  regression the current flattening exists to avoid

The naming item was dropped, and this is the reason rather than an oversight.
It existed to answer "a reader cannot tell which task any of the four boxes
belongs to", and placing the mark inside the card answers that completely: the
card the mark sits on *is* which task owes it. Renaming on top of that would put
`implement-work-0778519c6a4a4bc8-produced` inside the card titled
`implement-work-0778519c6a4a4bc8`, which is longer, no clearer, and repeats what
the reader is already looking at. The key is also a template's, shared by every
member by construction, so making it per-member means deriving a fresh consumer
key at fan-out import for a label that would then be redundant.

The card stopped being a control and became a container: a `<button>` inside a
`<button>` is not valid HTML, and the mark has to be selectable. The node's own
control now fills the card, which keeps `.gnode`, its selection state, and every
locator that reads it exactly as they were.

## Phase 11: a run that has finished is in a finished state

The finished run says two things at once:

```text
mode: running
every phase has closed: this run has finished its work
```

And the portal, on the same run, offers `Pause` and `End run`, and ends the
graph with "the run finishes when every phase is accepted" — future tense about
something already done.

`ended` exists as a mode. It is only reachable from `ending`, which only a
person requests: `advanceRunControlToEndedIfQuiescent` selects
`WHERE mode = 'ending'` and does nothing otherwise. A run that finishes on its
own therefore stays `running` for ever, and every consumer that reads the mode —
the portal's controls, an operator, anything deciding whether a run is worth
driving — is told it is still going.

The driver already knows: `advanceRun` returns `finished`, and the daemon
translates that into "no work" rather than into a state.

* [x] A run whose every phase has closed reaches a terminal mode without a
  person asking
* [x] The portal offers no run controls on a run that has finished, and says so
  in the past tense
* [x] `senawa status` does not report `running` for a run that has finished

A finished run now goes `running` to `ended` directly, recorded as a run control
event with no command and no principal behind it, because nobody decided it: the
run had nothing left to do. A paused or ending run is somewhere a person put it,
and finishing does not overrule that.

`ended` was reused rather than a new mode added. A separate `finished` mode
would have to pass the two SQL check constraints, the mode union, the codecs,
the portal and the CLI, to record a distinction — over versus ended by a person
— that the control event's own history already carries.

The portal and the CLI needed nothing for two of the three: both already read
the mode, and `terminal` is already `mode === "ended"`. Only the graph's closing
line was written in the future tense regardless.

## Phase 12: a turn that stopped to ask has not spent an attempt

Phase 8's live run, `run_f961d4199a40ffe9b51dffb95193810e`, never reached
`plan`. It stopped at `research` with

```text
run.stopped  rejected at research: no attempt handed any work in after 8 tries
```

and eight cancelled worker outcomes, every one of them carrying
`workerStatus: "awaiting-answer"`. Not one turn failed. Not one crashed. Every
single one ended by asking a person something, and the run was rejected for
never handing work in.

`advance-run.ts` already states the rule and gets it right in the moment:

```ts
// A turn that stopped to ask is waiting for a person, not spent.
const asked = state.questions.some((q) => String(q.dispatchId) === dispatchId);
if (!asked && attemptClosed(dispatchId)) { /* counts as a try */ }
```

The flaw is that `asked` reads the *present* — whether a question from that
dispatch is still outstanding. Answer the question and it is no longer
outstanding, so the very act of unblocking the agent converts its suspended
turn into a spent attempt, retroactively. A person who answers promptly burns
the run's attempts faster than one who ignores it.

What a turn did is already recorded durably and does not change when somebody
answers: the effect outcome's `workerStatus`. A turn that ended awaiting an
answer ended awaiting an answer for ever.

* [x] An attempt that ended by asking a person is not counted against the
  attempt ceiling, whether or not its question has since been answered
* [x] A phase whose every attempt ended on a question is not rejected for
  handing no work in
* [ ] The example completes its research phase with a person answering
  every question it asks

A turn that ends by asking is now recorded as `suspended` rather than `closed`,
which is a durable fact about what the turn did rather than a reading of what is
currently outstanding. The ceiling counts everything except those.

The scenario harness cannot reach the ceiling itself: it drives no runner, so no
effect outcome ever returns, and only a returned dispatch or a question closes
an attempt there. The test therefore holds the durable record — three turns that
asked, all three answered, three `suspended` attempts — which is precisely the
fact that was being lost. Breaking the disposition makes it fail; the live run
is what holds the rest.

## Phase 13: a session out of credits is a budget, not a crash

The condition run for phases 7 to 12, `run_c42fa12ae7a3f8fd5dc3532bf5c83f43`,
stopped at `research` with eleven cancelled outcomes. Every one of them said:

```text
crashed Error: Request session.resume failed with message: This session has
already used 30.41 AI credits. The session limit must be above 30.41.
```

That line is itself the phase 8 crash-reporting item earning its keep. Before
it, this record read `crashed Error` and said nothing at all; the same stall on
the previous run cost an hour of guessing.

What it says is exact. The researcher's session is `run`-scoped, so one
conversation carries across phases, and `credits: 30` is the default ceiling.
The session spent 30.41, and every later turn asks the SDK to resume a session
that is already over its own limit. The SDK refuses, for ever, identically.

`maxAiCredits` is compiled into the route selection from the agent's authored
`credits` and fixed at dispatch. The run's own allowance mechanism —
`grant-allowance`, the `review-iteration` and `model-millidollars` units, the
escalation a person answers — is a separate system that never touches it. This
run granted an allowance while it was stalling: "review-iteration may now spend
32". It made no difference, because nothing connects the two.

So a run can be given more budget by a person and still be unable to take
another turn, and the reason is reported as a crashed worker rather than as an
exhausted budget. Nothing escalates, because nothing recognises it as a budget
at all.

Three things are wrong and only two of them are obvious:

* It is retried identically eight times. A resume refused for a fixed, already
  exceeded ceiling will be refused again, and each retry costs an attempt.
* It is classified as a crash. Budget exhaustion has a mechanism — escalate,
  a person grants, the work continues — and this never reaches it.
* Whether a person granting credits *should* raise a session ceiling is a cost
  decision, not an obvious repair. A fresh session would sidestep the ceiling
  entirely and make it meaningless; raising it silently spends somebody's money.
  This one needs deciding rather than implementing.

* [ ] A turn that fails because its session is out of credits is not retried
  against the same ceiling
* [ ] That failure is reported as an exhausted budget, naming the session and
  the ceiling, rather than as a crashed worker
* [ ] What a person can do about it is written down where they will read it

## Phase 14: a failed pump stops driving and cannot be restarted

The second condition run, `run_2e9eff74f8b383b69351a5eb39e1dc46`, got much
further than any before it. Research and plan both closed, the fan-out opened
four members, six worker effects completed, and the agents wrote real code into
the workspace. Then it stopped, and nothing said so.

The last thing the run recorded, at 21:49:41:

```text
error  service.wake-pump-failed  Supervisor background work failed
       reason: Lease runner:2e48d770...bc1d1 no longer accepts fence 32
```

Ten minutes later the record was unchanged. The state was completely quiet:

```text
intents 9 | unsettled 0 | queued commands 9 | pending wakes 1
last log 21:49:41 service.wake-pump-failed
```

Nothing was in flight, one wake was pending, and the phase was not closed. The
service process was alive and answering: `senawa status` returned promptly and
`make portal` minted tokens.

Then the part that makes this a defect rather than a stall. Asking the running
supervisor to drive the run, explicitly, by hand:

```text
$ senawa advance repository_rpi-workflow run_2e9eff74f8b383b69351a5eb39e1dc46
asked the running supervisor to drive run_2e9eff74f8b383b69351a5eb39e1dc46
```

That request was accepted and produced nothing. No log line, no state change,
no dispatch. A service that has stopped driving a run cannot be restarted by
asking it to, and it does not say that it has stopped.

Phase 3 fixed the neighbouring case: a failed pump now defers a wake rather than
assuming another notification will arrive, and `service.ts` says so at length.
That deferral is five seconds, it fired, and the run still did not move — so the
wake is being consumed without the work being done, or the pump is failing
identically and silently, or `listPendingWakes` and the pending row disagree.
Which of those it is has not been established, and guessing is what the plan
exists to stop.

* [ ] Establish which of the three it is, from the run's own record, before
  changing anything
* [ ] A supervisor that has stopped driving a run says so, rather than looking
  idle
* [ ] `senawa advance` on a running supervisor either drives the run or reports
  why it did not
* [ ] A pump that fails repeatedly on the same reason escalates rather than
  retrying silently for ever

This is the condition run's blocker. Phases 7 to 12 are all separately
validated — the criterion marks and the corrected member count were read live in
the browser on this very run, and the crash reason that unblocked phase 13 came
from the run before it — but "the example completes" is not met while this
stands.

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
Phases 7 to 14 were added afterwards from findings that run and its predecessors
produced, so they carry the condition again:

* [ ] With phases 7 to 14 done, the example is driven once more from a clean
  state root, end to end in a browser, and completes with its own tests passing
