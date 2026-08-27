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

* [x] A dispatch is stored once, in the table that already holds it
* [x] The durable snapshot reads both the form that carries dispatches and the
  form that does not
* [x] Recording a dispatch does not cost work proportional to the run's history,
  proven by a growth measurement rather than by a passing test

Measured on `run_9bb1ef50427cb92ffd3d783fcf5af586`: 40,529 bytes of snapshot at
twelve dispatches, against roughly 217,000 for the same twelve before. The test
asserts the blob after six dispatches is smaller than one dispatch row, so it
fails if the growth ever comes back.

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

That test covers the case where the task is ready, and this item was reopened
once because a live run deadlocked on a dispatch that was waited on rather than
enqueued. Phase 14 found why, and it was not readiness: the dispatch was for a
task that had already been accepted, and it had displaced the dispatch that
earned that acceptance. Nothing was going to enqueue a command for work that was
already done, and nothing should have.

So the item is closed by phase 14 rather than by anything more here, and the
reopening was right: the criterion was sound and the explanation under it was
wrong twice before the records gave up the real one.

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
* [x] The example completes its research phase with a person answering
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

## Phase 13: the AI credit ceiling is removed

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

### Decided: the ceiling is removed

The third one was put to a person, which is what it was written down for, and
the answer was to delete the whole mechanism rather than to repair it.

That answers the other two by removing what they were about. There is no
per-session credit ceiling to exceed, so no resume is refused for one, so
nothing is retried against it and nothing needs reporting as an exhausted
budget. A ceiling that stops a run dead and cannot be raised without stopping
the run to raise it is not a budget; it is a fuse.

What went is the ceiling and only the ceiling: the authored `credits` key, its
compiled `maxAiCredits`, the route selection's fourth limit, the
`sessionLimits` handed to the SDK, the `SENAWA_COPILOT_MAX_AI_CREDITS`
variable, and the reporting that copied it. The route still carries `maxTurns`,
`maxSubmissions` and `maxMillidollars`, and the run still carries its own
allowance policy with the escalation a person answers — which is the budget
that was always doing the work.

Cost warnings stay. Every "this spends AI credits" in the guides and probes is
true and unrelated to the ceiling.

* [x] A turn that fails because its session is out of credits is not retried
  against the same ceiling — there is no ceiling
* [x] That failure is reported as an exhausted budget rather than a crashed
  worker — the failure no longer happens
* [x] What a person can do about it is written down where they will read it —
  nothing is left for them to do

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
That deferral is five seconds, it fired, and the run still did not move.

### Which of the three it is

Established, from the run's own record rather than by guessing. The wake row:

```text
generation 6 | ack_generation 6 | not_before 21:47:16 | reasons ["command-accepted"]
supervisor_commands: 6 terminal, 0 anything else
```

`listPendingWakes` returns a run when `generation > ack_generation` or when some
command is not terminal. Neither holds, so it returns nothing, and the service
is right: there is no pending wake. The pump is not failing silently and no wake
is being lost. **Nothing arms a wake for the work that was left.**

A wake is armed when a command is accepted and acknowledged when the cycle that
handled it finishes. The remaining work was neither a command nor an effect: six
effects had completed and what was owed was to deliver their completions, close
the phase, and dispatch what came next. That work is done by `driveRunOnce`
inside a cycle, and a cycle only happens on a wake. A run whose last command has
gone terminal therefore has no wake, and nothing will ever give it one.

`senawa advance` looks like the escape hatch and is not. It calls
`wakeRunningSupervisor`, which sends a bare `wake()` and discards the run id
entirely — the id appears only in the message it prints. The pump starts, and
what it does next is the part that is still open.

### Where that explanation stops

Reading further contradicts the tidy version above, so it is recorded rather
than tidied away. `#runCycle` does not only look at pending wakes:

```ts
const target = wake ?? amendmentProposal ?? amendmentRecovery ?? runnable ?? schedulable;
```

`schedulable` comes from `listSchedulableRuns`, which the daemon fills from the
scheduler's own list of every run holding a dispatch. The stalled run was in it.
So a cycle *should* have taken it as its target with no wake at all, and the
missing wake alone does not explain the silence.

Which leaves the pump itself. `wake()` returns immediately if `#pump !== undefined`
or if the state is not `running`, and a `#pump` that is never cleared, or a state
that moved off `running` after the fence error, would make every later wake a
no-op for ever — which is exactly the observed behaviour, including `advance`
being accepted and doing nothing.

That is a hypothesis, not a finding. It has not been confirmed against the
running process, and the run has since been reset, so confirming it needs a
fresh reproduction with the service's own state visible.

And it is weakened by one more reading, though not for the reason first given
here. The original note said `status()` answered promptly so nothing was stuck
in the operation queue. That inference was wrong: `senawa status` reads the
database directly and never touches the supervisor. What it showed was only that
the *database* was readable. The conclusion held for other reasons, but the step
did not, and it is corrected rather than left standing.

So cycles ran, took the stalled run as their target through `schedulable`,
called `runOnceAsync`, and it reported `worked: false` every time. The silence
is then not the service's at all: `advanceRun` decided there was nothing to do
for a phase that was open with six completed effects. The last thing it said
before going quiet was `schedule-declined … the ready frontier holds
task_1babea…`, which is a task the frontier did not consider ready.

That is where the next reproduction should look, and it is a different place
from where this phase started.

### What it actually is

The run's state survived, so it was reproduced rather than reasoned about.
Driving it in-process, with no service holding the lease:

```text
$ senawa advance repository_rpi-workflow run_2e9eff74f8b383b69351a5eb39e1dc46
waiting for the agent working on implement
```

`awaiting-agent`, with every effect settled. The records say why:

```text
attempts 10, of which exactly 1 is opened  -> task_a47d09b4…
dispatches 10, intents 9                   -> exactly 1 dispatch has no intent
that dispatch: task_a47d09b4… | has an effect seed | 0 queued runner commands
```

The open attempt and the dispatch that never ran are the same task. A dispatch
was created for an `implement` member, its attempt was opened, and its runner
command was never enqueued. Nothing will ever close that attempt:
`closeEndedAttempts` closes on a terminal completion, on a question, or on a
dispatch whose effect returned, and a dispatch that never ran has no effect.

So the run deadlocks against itself. The attempt is open because the dispatch
never ran; the dispatch never runs because the phase is waiting on the open
attempt, and a task with an attempt open is not on the ready frontier that
`#scheduleRepository` enqueues from.

One more reading narrows where to look, and then overturns everything above it.
The dispatch was not dropped by `selectCurrentDispatches` for want of an
accepted scope — the snapshot holds exactly one scope for that task,
`claimsAccepted: true`, generation 1, with the same `acceptedContextDigest` the
dispatch names.

Then the scheduling snapshot itself:

```text
tasks 6, accepted 4
  task_a47d09b4…  implement-work-a47d09b4d0a9f0e3  deps: []
  task_ad473bd4…  implement-work-ad473bd48a5e9af2  deps: []
  task_c6fa4d94…  implement-work-c6fa4d942a668edc  deps: []
  task_df4e9353…  implement-work-df4e935387280642  deps: []
acceptedTaskIds  a47d09b4, ad473bd4, c6fa4d94, df4e9353
```

All four `implement` members are **accepted**, including the one with the open
attempt. No member depends on another. The phase's work is finished.

So this was never a scheduling problem and never a readiness problem. A tenth
dispatch was created for a task that was already accepted, its attempt was
opened, its runner command was never enqueued, and `advanceRun` waits on that
open attempt for ever — reporting "waiting for the agent working on implement"
about a phase whose every member is done.

An attempt on an accepted task cannot be waited on: there is nothing left for
that agent to hand in. Either it should never have been opened, or acceptance
should close it. Which of those is right is the design question; that it must be
one of them is not.

### Three repairs tried against the stalled run, and what they showed

The run's state was kept, so each was driven against the real stall rather than
argued about. Both were reverted.

Closing an attempt whose task is accepted, in `closeEndedAttempts`, does close
it — and the driver then treats the closed attempt as a turn that handed nothing
in, retries the accepted task, and burns the phase's remaining attempts:

```text
retrying implement, attempt 6: Your previous turn ended without submitting…
implement was rejected: no attempt handed any work in after 3 tries
```

Adding "and the task is not accepted" to the retry guard stops that, and the
driver falls through to `awaiting-agent` again — back to waiting for ever.

So closing the attempt is necessary and not sufficient. Both attempts land in
the same place: the driver has selected a dispatch on an *accepted* task as the
phase's live work, and every branch that follows is reasoning about a turn that
should not be under consideration at all. The repair belongs where that dispatch
is chosen, not in what is done with it afterwards.

A third repair went there, at the one line that chooses it:

```ts
const dispatch =
  phaseMembers.find((candidate) => !handedIn.has(String(candidate.dispatchId))) ??
  phaseMembers.at(-1);
```

The tenth dispatch has no completion in the outbox, so `find` returns it. Adding
"and its task is not accepted" makes `find` return nothing, and the fallback
then picks the same dispatch again as the newest — so the run took the reject
path instead. Making the fallback the last member that *did* hand in gets past
both, and the run reaches the close and is refused by the kernel:

```text
Task task_a47d09b4… has no accepted accounting assessment
```

Which is a fourth thing, and a useful one: that task is listed in
`acceptedTasks`, so "accepted" in the scheduling snapshot and "accepted" as the
closing candidate requires are not the same acceptance. That is where this
stops, reverted, with the state kept.

Three repairs, each driven against the real stall, each reverted, each leaving
the next one better aimed. None was committed on a guess.

### One cause, all three symptoms

The two acceptances are not two. `currentPhaseDispatches` keeps the
**highest-ordinal** dispatch per task:

```ts
if (held === undefined || candidate.ordinal >= held.ordinal) byTask.set(key, candidate);
```

The tenth dispatch has the highest ordinal for its task, so it *replaces* the
earlier dispatch that ran, completed, and was accepted. Everything downstream
reads that map, and every symptom follows from the one substitution:

* the phase's live work is the first current dispatch with no completion, and
  the shadow has none — "waiting for the agent working on implement";
* the closing assessments are filtered to current dispatch ids, so the real
  completion's assessment is excluded — "has no accepted accounting assessment";
* `deliverFacts` is handed the same filtered set, so the completion that would
  close the phase is never delivered.

The task really is accepted. The dispatch that earned that acceptance has simply
been hidden behind one that never ran. That is also why each repair moved the
failure rather than fixing it: all three were downstream of the substitution.

The rule has to keep a retry superseding an earlier attempt — a fresh dispatch
with no completion yet *is* the current work — while stopping a dispatch on an
already-accepted task from superseding anything. Acceptance separates them: a
retry is for a task still owed, and an accepted task is owed nothing.

### This corrects phase 8

Phase 8's second item was exactly this: "a dispatch with no runner command and
no completion is enqueued rather than waited on". It was ticked on a test that
registers such a dispatch and asserts the next schedule pass queues its command
— which is true, and only when the task is ready. The live run supplies the half
the test did not: when the task is *not* ready, because its own attempt is open,
nothing enqueues the command and nothing closes the attempt.

The criterion measured the easy half and was ticked anyway. It is reopened.

* [x] Establish which of the three it is, from the run's own record, before
  changing anything
* [x] Reproduce with the run driver traced: a cycle that takes the run as its
  target and reports no progress is the thing to explain, not the wake
* [x] Answer why the ready frontier excluded that member: it did not. The task
  was accepted, and the phase was waiting on an attempt rather than on work
* [x] A dispatch on an accepted task is not selected as the phase's live work,
  which is where three attempted repairs showed the fix belongs
* [x] Reconcile the two acceptances: there was only ever one. The closing
  candidate was reading a filtered set the shadow had displaced the real
  dispatch out of
* [x] An attempt on an accepted task is not waited on: nothing is left for that
  agent to hand in
* [x] A run that is waiting on an agent names the dispatch it waits on, so a
  wait nobody can end is not anonymous
* [x] Phase 8's dispatch-recovery item is closed here, and its "not ready"
  framing corrected: the blocker was acceptance, not readiness
* [x] Nothing creates a dispatch for a task that is already accepted, which is
  what makes a shadow in the first place

### Fixed, and proved on a second independent stall

The next live run reproduced it without being asked to: twelve attempts with
exactly one open, twelve dispatches with eleven intents, and the missing intent
on the same task as the open attempt -- a task the scheduling snapshot listed as
accepted. The same shape, on a different run, with different task identities.

Both halves were needed and neither works alone. Not letting a shadow be current
leaves its attempt blocking the dispatch that would replace it, which the
authority refuses with "that task already has an attempt open". Closing the
attempt alone makes the driver retry an accepted task, because the shadow is
still what it considers the phase's live work. Each of those was tried, failed,
and was reverted before the pair was understood.

With both, that run drives again and reaches its gate:

```text
retrying implement, attempt 20: tests did not pass
```

Which is the gate doing exactly its job, and the first time any run has got far
enough to be judged by it.

### Where the shadow came from

The dispatch driver takes `phaseTasks[input.memberIndex ?? 0]`, and of the seven
places that dispatch, only two passed a member index. Neither was a retry. So
every retry in a fan-out re-ran **member zero** whatever had actually failed, and
when member zero was already accepted that retry was a dispatch for finished
work.

The tell was there in both stalls and went unread twice: each shadow sat on the
first member of its fan-out. Confirmed against the surviving run rather than
assumed -- the graph lists `task_78805357cb4` at index `[0]` of `implement`, and
that is exactly the task that carried the shadow and the open attempt.

All four retry paths now pass the member the dispatch belongs to. A test drives
a fan-out, steers the *second* member into a retry, and asserts the retry is for
the second member's task; it fails against the old behaviour by re-running the
first.

### Found beside it: the supervisor answers nobody while an agent works

Measured on the validation run, while agents were working:

```text
senawa status <repo> <run>   2.5s   (reads the database)
senawa service status        15s    (times out over IPC)
senawa portal                15s    (times out over IPC)
```

Every request that reaches the supervisor is enqueued on the same serialized
operation queue as `runCycle`, and a cycle awaits a whole agent turn. So for the
minutes an agent is working, the supervisor answers nothing: a person cannot
open the console, read health, or drain. When the same run was stalled with no
agent working, `make portal` minted tokens immediately.

The console is exactly what a person reaches for while agents are working, which
is the only time it does not answer.

`status` and `logs` now run beside work rather than behind it, and stopping
waits for the reads in flight before closing what they are reading. A status
reading is taken of the lifecycle it was taken during, so a health probe that
spans a drain reports the running service it observed rather than the draining
one it landed in. The gated-cycle test asserts a read answers while a cycle is
held open; it times out against the queued version.

Minting was never queued. `senawa portal` mints in memory and then calls
`status`, and it was the status call that timed out.

Measured again on the next clean run, while a researcher was working:

```text
senawa service status   0.36s   (was a 15s timeout)
senawa portal           0.25s   (was a 15s timeout)
```

The portal opened in a browser on that run and reported `Connection live`,
`Data current`, and the three phases with the researcher working.

* [x] A read of the supervisor's own state does not queue behind a run cycle
* [x] Minting a portal credential does not queue behind a run cycle

### Found beyond it: the run's own record held to a message's ceiling

Past the gate, the same run stops on:

```text
wire value exceeds 262144 bytes
```

Not the dispatch context, which was 13 KB. `runs.records_json` was **262,077**
bytes against a ceiling of 262,144 — sixty-seven bytes of headroom, and the next
retry could not be persisted at all.

Phase 4 already made this distinction and this is a place it did not reach. A
run's records are state a process writes for itself, not a message, and
`decodeDurableJsonValue` and `durableStringify` exist for exactly that, with
ceilings sized for a long run. The run record was still going through
`canonicalStringify`. It now uses the durable pair, at all four write sites and
all three reads.

Two things this exposed and did not fix. The record is rewritten whole on every
command, so its cost is quadratic in its own size — the same shape as the
dispatch problem phase 7 solved, one table over. And `amendmentEvents` and
`amendmentRecords` were 155 KB of the 262: a fan-out's graph amendment is large
and is carried in full.

There is no unit test. Building a record past the ceiling through the authority
costs time quadratic in its size and timed out at two minutes; writing one
straight into the table is refused by the tampered-mirror guarantee, which is
six tests doing their job. The live run is the evidence, and the change is a
swap to the codec phase 4 built for this.

This was the condition run's blocker. Phases 7 to 12 are otherwise separately
validated — the criterion marks and the corrected member count were read live in
the browser on this very run, and the crash reason that unblocked phase 13 came
from the run before it — but "the example completes" is not met while this
stands.

## Phase 15: a refused run says what refused it

The first run to reach the implement gate was the furthest any run had come:
three phases, twelve dispatches, no worker failures, no open attempts, and a
workspace holding `package.json`, `src` and `test`. It then sat entirely still
for twenty minutes. `senawa status` said:

```text
mode: running
phases: 3
phases closed: 2
agents dispatched: 12
waiting on you: 0
```

Which is what a healthy run says. Nothing was written to the database in that
time; nothing was working; nothing was waiting. The run was over and said so
nowhere.

Reading the record directly found the answer immediately:

```text
gateEvidence.evaluation.decision  rejected
gateEvidence.evaluation.blocking  tests-exit-code-exit-code = false
gateEvidence.readings[0].data     exitCode 1, TAP output with two failing tests
```

The system had done exactly the right thing. Four members completed, the gate
ran the project's own test suite, the suite failed, and the gate refused. The
whole point of the product worked. Two things around it did not.

### The retry was told nothing it could use

`senawa service logs` held the one sentence anybody was ever given:

```text
run.stopped  gate-refused at implement: tests did not pass
```

That message was also what every retry was told. The reasons handed to the next
attempt were built as `readings.map(reading => "<sensor> did not pass")` — one
line per reading, passing sensors included, and no content from any of them. The
comment directly above it says a retry that is not told what to change only
spends an attempt, and that is precisely what the three implement retries did.

A refusal now names the rule that was not met as the comparison it made, and
carries the sensor's own output:

```text
tests/exitCode equals 0, and read 1
tests said:
TAP version 13
# Subtest: two-human mode plays a scripted X win to completion
not ok 1 - two-human mode plays a scripted X win to completion
  ...
```

Passing sensors are left out; naming them pointed the attempt at work that was
already right. The excerpt is bounded to 900 characters because a worker context
refuses a prior refusal longer than 1,024, and the head of a test run is where
the first failure's detail is.

### The stop was invisible where a person looks

The reason existed, in the supervisor's operational log, behind an IPC call,
mixed in with every other run. `senawa status` — the thing a person runs to find
out what their run is doing — did not mention it.

Status now reports it. The driver already recorded a stop and cleared it when
the run moved again; it now records the clearing too, so the latest of the two
entries is the answer and a recovered run does not go on wearing an old refusal.

```text
waiting on you: 0
stopped: gate-refused at implement: tests/exitCode equals 0, and read 1; tests said: ...
```

* [x] A refusal carries what the sensor measured, not that a sensor was measured
* [x] A run the driver has given up on says so in `senawa status`
* [x] A stop stops being reported once the run moves again

### Not fixed here

The phase's `onExhausted: escalate` is authored and does nothing. The kernel
models a phase escalation and projects it as a human need, and `create-escalation`
records one, but the driver never raises it on a terminal refusal and the SQLite
portal projection reads escalations only from `runner_escalations`, which is the
budget-allowance table. So a blocked phase cannot become a decision a person is
offered in the portal. Status reporting the stop is the smaller honest fix; the
escalation path is a phase of its own.

* [x] A phase that has spent its attempts raises the escalation its policy
  declares, and the portal offers it as a decision

Seen again, whole, on `run_1b4d4d416670ebe7aadc8bf78247b065`. Four implement
members: three passed on their first try, the fourth used all six of its
authored attempts against a gate reporting a failing assertion each time.

```text
implementor  implement-work-62a2848   1 try   finished
implementor  implement-work-78805357  1 try   finished
implementor  implement-work-7b935589  1 try   finished
implementor  implement-work-ee58e4b2  6 tries could not pass
```

The phase declares `onFailure: continue`, so the three that finished should
carry the run to delivery without the fourth. Instead the phase cannot close,
the run stops, and the driver repeats the same refusal for ever. Whether that
should continue without the member or stop and ask a person is the product
decision this item is already waiting on -- but the run stopping silently is
not either of them.

### Found next: two publications, one source

The clean run with these changes in place stopped again at the plan phase, and
this time said why on its own:

```text
stopped: Source phase-output:research:research has conflicting bindings
```

The researcher produced its output, then asked a question before completing.
The turn was suspended and its publication stayed in the outbox; the answered
retry produced the output again. The phase closed on attempt 5, and the closure
names attempt 5's publication as the accepted one -- but `upstreamOutputs` hands
the binder every publication it finds for the phase, so the plan phase was given
two bindings for a single source and could never be dispatched at all.

The rule is the one already used for dispatches: a later attempt supersedes an
earlier one, and a phase closes on its current attempt. The binder now takes the
publication from the highest attempt per output, which is the one the closure
accepted. Verified against the live record: the closure's accepted publication
digest is attempt 5's, not attempt 4's.

This is the first stall the new `stopped:` line diagnosed by itself, without
reading the database.

* [x] An upstream phase that published more than once binds the output it
  closed on

## Phase 16: a criterion pill belongs to the node that owes it

A criterion is drawn as a pill on the node that owes it, which is right. But the
pill is its own selectable node, so clicking `plan-produced` opens a detail pane
scoped to the criterion, which says:

```text
plan-produced has produced nothing yet.
```

A criterion produces nothing. What was produced is owned by the node the pill
sits on, and the pane for that node already has a Produced tab. So the pill
navigates away from the thing it is about.

Clicking a pill should highlight it and take the reader to the owning node's
own section, not open a separate one.

Reading the panes to fix that found the reason the tab was empty in the first
place: artifacts were fetched only for the history route, so the Produced tab on
the workflow route had nothing to read however much a node had handed on. The
Answers tab was worse -- it listed every answer and decision event in the whole
run whatever was selected, and named them by event type rather than by what was
asked. It now reads the questions the selected node asked, and shows the answer.
A phase produces and is asked through its members, so both panes read a phase's
members as well as the phase itself.

* [x] A criterion pill selects the node that owes it and opens that node's
  Produced view, rather than opening a pane scoped to the criterion
* [x] The Live, Answers, Produced and About tabs each show the selected node's
  own content, for a phase, a member and a criterion alike

### Found underneath it: the artifact query refused itself

Fetching artifacts on the workflow route made the whole view hang on `Loading
graph revision`. The query behind it was broken on real data:

```text
senawa artifact list <repo> <run>
ProtocolValidationError: $.artifacts[2] must be lexically ascending after the cursor
```

An artifact is named by its content. The researcher's suspended attempt and its
answered retry produced byte-identical output, so two submissions carried one
asset, and the page held two rows with a single identity. A page whose contract
requires its items to ascend cannot hold two of the same, so the query refused
its own answer and every artifact view in the portal went blank -- including the
one the timeline had been reading all along.

An artifact carried twice is now listed once. The regression test submits the
same asset under two submissions and fails with that exact message without the
fix.

* [x] An artifact carried by more than one submission is listed once

Read live on `run_7121015f89a96f3f36831eb186d2d215`, with research closed and
plan working: clicking the `plan-produced` pill selected `plan`, opened its
Produced view, and showed `phase output plan, 13.3 KiB`. The same pill used to
open a pane reading `plan-produced has produced nothing yet`.

## Phase 17: a finished phase's task stops holding the scheduler

The next clean run reached implement, dispatched four members, and stopped for
twenty minutes with `waiting on you: 0`, no `stopped:` line, and no worker
running. Three attempts were open and no SDK session existed. The supervisor's
log said one sentence over and over:

```text
no dispatch is schedulable; the ready frontier holds
  task_1babea535fe75... active
```

That task belongs to the **plan** phase, which had closed. It was reported
`accepted` once, and `active` from then on.

The scheduler picks its current dispatches by walking every task node in the
graph, with no notion of which phase the run is in, so a finished task from a
closed phase stayed in the set for ever. Its status then came out wrong twice
over: `acceptedTasks` is the *current* phase's accepted set, so a closed phase's
task drops out of it, and a worker effect that **completed** reads as `active`
because the frontier's only terminal statuses are `failed` and `cancelled`. One
finished task therefore held the frontier permanently, and the three dispatched
members of the open phase never started.

A task an earlier phase finished is not work this run can schedule. The current
set is now the current phase's tasks.

That moved the blockage rather than removing it, and the move is what named the
real cause. With the plan task out of the dispatch set it read `pending` instead
of `active`, and the implement members depend on it, so still nothing could
start.

`queryRunScheduling` built `acceptedTasks` from `records.assessments` -- the
**open** phase's assessments alone. The readiness frontier is derived over the
whole graph, so every task an earlier phase accepted came back unaccepted, and
anything depending on it could never be ready. A task a closed phase accepted
stays accepted for the rest of the run, and the snapshot now says so.

* [x] A dispatch belonging to a closed phase does not hold the ready frontier
* [x] A task accepted by a closed phase is still accepted for the run

## Phase 18: the detail view is scoped, and the scope is one thing

Reading a finished run in the browser found three controls doing one job badly.
The transcript has its own `every agent` / `this agent` toggle. The Agents tab
has its own idea of a selection, and says `Select an agent to narrow this to one
agent` until you make one. The workflow's own selection is always a node, so a
phase cannot be selected from the graph at all -- its band folds instead, and
the only route to a phase's detail is the artifact chip on the connector, which
is a strange job for something that names a file.

Underneath them is one idea nobody had written down: what a reader is looking at
is a **scope**, and it has three levels.

```text
run  ›  phase  ›  task
```

Every tab answers the same question at whichever level is current, and a
breadcrumb above the tabs both says where you are and moves you:

| Tab | Run | Phase | Task |
| --- | --- | --- | --- |
| Live | every agent's lines, owner-named | the phase's members' lines | this member's lines |
| Answers | every question answered | questions this phase asked | questions this member asked |
| Produced | every artifact | the phase output and its members' artifacts | this member's artifacts |
| Checks | each phase's gate decision | the gate: rule, reading, decision | this node's criteria |
| About | run identity and revisions | phase identity and policies | task identity and policy |

Two rules hold it together. **Scope narrows reading, never acting**: the
attention rail stays run-wide whatever is scoped, which is a property
`replyBox` already argues for and would lose if needs followed the selection.
And **a criterion is not a level**: clicking one narrows to the node that owes
it, which is what phase 16 made it do.

### Checks, which nothing shows today

A gate is a phase-level record -- a definition, its readings, and a decision --
produced by the driver rather than by any agent. It is the thing that refuses a
run, and diagnosing this morning's refusal meant reading the database because
the portal has no surface for it at all. It is a tab, not a footnote.

### An attempt is a version, not a fourth level

Every dispatch names a task, so an agent is a task at one attempt. That makes
attempts a second axis rather than a deeper scope, and gives the Agents tab a
job nothing else has: Workflow answers *where in the run*, Agents answers
*which try, and by whom*. The same axis is what the Produced table needs to stop
being ambiguous about a retried phase -- an artifact is named by its content, so
two attempts that produced identical bytes are one artifact, which is exactly
what broke the artifact query in phase 16.

### What the flow view loses and gains

The chip on the connector goes. It showed the first artifact of the first member
that had one, so it reported `394 B` for a phase that produced three outputs,
and clicking it selected the phase without opening anything about the artifact
it named. What it was reaching for -- that the line between phases is where a
reader looks for what crossed it -- moves inside the band, where a phase can say
what it produced and how its gate read.

The band's name then selects the phase and its disclosure control folds it,
which is the gap that made the chip load-bearing in the first place.

### The Agents tree

Its phase branches come out in the order the first agent of each phase happened
to arrive, because it groups from `byWork.values()` while both graph views rank
with `executionOrdered`. It also emits `ul.tree-children`, which has no style at
all, so it does not even get the indent `.tree-group` gives the workflow tree.

* [x] The detail view is scoped by run, phase or task, and a breadcrumb above
  the tabs shows and sets the level
* [x] A run is the default scope, so there is no unselected state and no
  `Select an agent` prompt
* [x] The transcript's `every agent` / `this agent` toggle is gone, because the
  breadcrumb is that control
* [x] Live, Answers, Produced and About each render at all three levels
* [x] A Checks tab shows the gate's rule, reading and decision at a phase, and a
  node's criteria at a task
* [x] A table shows the part of the path below the current scope, and clicking
  it scopes there
* [x] Produced names the attempt each artifact came from and which one the phase
  accepted
* [x] A phase band names what it produced and how its gate read, and the chip on
  the connector is gone
* [x] A phase band's name selects the phase; its disclosure control folds it
* [x] The Agents tree orders phases by execution order and draws its own
  containment
* [x] The Agents tree opens a member's attempts, and an attempt scopes the
  detail view to that try
* [x] The scope is in the route, so a phase view can be linked

### Found while reading it live: the console times out on a busy run

Reading a live run in the browser while its implement phase was fanning out, the
portal reported `Connection offline` and `Data stale`, and the request that
failed was its own `overview`, aborted by the client's ten second ceiling.

The database is not the reason -- or so the first reading said. Timed against
the same live file from another process:

```text
getRunOverview   207ms
listHumanNeeds    22ms
getGraphSummary  188ms
listArtifacts     12ms
```

That reading is wrong: the script it came from had an incomplete authority
dependency, so `getRunOverview` and `getGraphSummary` threw partway and the
timer recorded how long it took to fail. Both genuinely cost 1.3 seconds. See
phase 19.

Over loopback HTTP from the same machine, the same overview took 0.84s, 0.86s,
0.84s, 0.85s -- and then 3.5s. The portal is served by the supervisor process,
and a run cycle's synchronous work sits on the event loop it answers from, so
the answer waits for whatever the cycle is doing.

This is the same disease as the operation queue this morning, one layer down:
the console fails at exactly the moment somebody opens it. Reads were taken off
the queue; they are still behind the event loop.

Raising the client's ceiling stops the console calling a busy server dead, but
it does not make the server answer. That is phase 19.

## Phase 19: the supervisor stops paying for the whole run on every read

Performance is not a polish item here. Every symptom this plan has chased in the
last two phases -- `service status` timing out, `portal` timing out, the console
reporting `Connection offline` on a healthy run -- is the same cause seen from a
different angle, and phase 15 and 18 each treated a symptom.

Measured on `run_fe515d0b79fa7c2c8f96e6bc31e145d0`, which is a **small** run:
three phases, eleven dispatches, one hundred and eight transcript lines.

```text
supervisor process, run already ended    51.6% CPU, sustained
```

Half a core, for ever, on a run with nothing left to do.

### What a read costs

Timed directly against that database from another process:

```text
getRunOverview                   1304ms
getGraphSummary                  1304ms
listHumanNeeds                     12ms
listArtifacts                      13ms
```

The same reads over loopback HTTP, served by the supervisor, with the run
finished and idle:

```text
overview      5.5s
graph         4.2s
artifacts     4.2s
```

Two facts sit in those numbers. The gap between 1.3s and 5.5s is contention:
the portal is served from the event loop a run cycle works on. But 1.3s is not
a floor worth reaching -- the read itself is the larger part, and it grows with
the run.

An earlier reading here said `getRunOverview` cost 207ms and concluded the
queries were not the problem. That measurement was taken from a script whose
authority dependency was incomplete, so the call threw partway through and the
timer recorded how long it took to fail. The conclusion drawn from it was
wrong, and the two repairs that followed were aimed one layer too high.

### Where the time goes

Three costs, each paid far more often than it needs to be.

**Every read replays the run.** `SqlitePortalQueryAuthority` builds its view
through `#runtimeService()`, which calls `InMemoryAuthority.fromCanonicalJson`,
which calls `replaySerializedRun`, which submits every command the run has ever
accepted. A CPU profile of five `getRunOverview` calls spends 4.8 of 6.2
seconds inside `replaySerializedRun`, and 1.8 of those inside `recordRevision`,
which canonically digests the entire record set once per replayed command. The
cost is quadratic in the run's own history, and it is paid per read.

**Constructing an authority replays it too.** `new SqliteAuthority` runs
`verifyDatabase`, which does the same replay: **360ms** on this run. `advanceRun`
constructs `SqliteSupervisorAuthority` -- and so a `SqliteAuthority` -- on every
call, and the driver calls it every cycle.

**The broker snapshot decodes everything, every time.**
`context_authority_state` holds **129,239 bytes** of canonical JSON, and
`contextBroker.authority.snapshot()` took **106ms**, then **114ms** when called
again immediately -- there was no cache. Of that, two milliseconds are reading
and parsing the bytes; the rest is the codec validating records it has already
validated. `listRuns()` called it on every schedule.

**The run record is rewritten whole on every command.** `runs.records_json` is
**238,913 bytes** on this run, so its cost is quadratic in its own size. Phase
14 noted this and did not fix it.

A run that had ended was still offered to the scheduler for ever, because
`listRuns()` returned every run that had ever held a dispatch with no regard for
its mode. That one is fixed here; it is the cheapest of them and the least of
the cost.

### What has to become true

* [x] A supervisor with nothing to do uses no measurable CPU
* [x] A portal read does not replay the run's whole command history
* [x] Driving a run once does not replay the run's whole command history
* [x] The broker's snapshot is not decoded more than once per change
* [x] A portal read is served without waiting for a run cycle
* [x] The example's own run is read in a browser while its agents work, and
  every view answers in under a second
* [ ] A run's records are not rewritten whole on every command, which is phase 23

### Found beside it: a supervisor with no repository says nothing about it

A service started without `SENAWA_REPOSITORY_DIR` builds no SDK pool, so it has
no async effect host and no worker dispatch can ever start. The run then sits
with its commands queued and no intents against them, for ever, and the
supervisor log says nothing at all -- not at startup, not on the cycles that
find work they cannot begin.

Found by restarting the example's service by hand and watching four dispatched
implementors produce no transcript line for half an hour. The state is exactly
the deadlock this plan has chased three times, reached by configuration rather
than by a defect, and it is indistinguishable from one while it is happening.

The health report does say `worker dispatch is disabled`, but only to a caller
that asks for session-store health.

* [x] A supervisor that cannot dispatch work says so where a run's history is,
  which is phase 20

### Measured on the example, driven from clean, five agents working

```text
supervisor CPU, run ended      51.6%  ->  0%
supervisor CPU, agents working             0%
overview   n=40   median 0.006s   p95 0.007s   max 0.129s
graph                    0.004s              0.006s
agents                   0.005s              0.006s
artifacts                0.003s              0.004s
questions                0.003s              0.005s
workspaces               0.001s              0.002s
```

Against 5.5s for the same overview on an idle supervisor, and 8.1s for the
graph from a browser while a phase was fanning out.

### What is left

The run record is still rewritten whole on every command: 238,913 bytes on a
run of three phases, so the write cost is quadratic in the run's own size. It
is no longer the thing anybody notices, because nothing reads through it any
more, but it is the last quadratic in the system and it sets a ceiling on how
long a run can get.

Digesting that record is no longer paid twice per command, which is what made
replay quadratic on top of quadratic.

### Not to be traded away

The tampered-mirror guarantee, the canonical encoding, and the refusal to trust
a projection are the reasons this system is worth anything. Speed comes from
paying for them once rather than from paying for them less.

### Found while reading the Agents tree: an agent forgets what it was told

The tree showed a researcher on its fourth attempt of one task, with no refusal
on any of them. Nothing had failed. Each of those dispatches existed because a
question had been answered, and an answer reaches the agent that asked only by
being carried into a fresh dispatch.

Reading the four contexts:

```text
attempt 1   answeredQuestions: 0
attempt 2   answeredQuestions: 1
attempt 3   answeredQuestions: 1
attempt 4   answeredQuestions: 1
```

One each, never two. The context was built from `listAnsweredQuestions`, which
filtered to `satisfied_by_dispatch_id IS NULL` -- the answers no dispatch had
carried yet. That is the scheduler's question, *what still has to be delivered*,
and it was being used to answer a different one, *what does this agent know*.

An agent cannot read the database. Its context is the whole of its memory. So
every fresh turn was handed the newest answer and had the rest taken away, and
it asked again, in different words, for what it had already been told:

```text
Interface: should tic-tac-toe be playable interactively in the terminal ...
Should the game be playable interactively in the terminal (prompting f...
Does a person play against another person (two humans alternating), or...
Opponent: two humans alternating turns, or a human against the machine...
```

Five questions on that run, and two pairs of them are the same question.

The two readings are now two methods. `listUndeliveredAnswers` is what still
blocks the run and what a delivering dispatch marks satisfied;
`listAnsweredQuestions` is everything this run has answered, oldest first, and
that is what builds the context.

* [x] A fresh dispatch carries every answer the task has been given

### Still open beside it

Not every extra attempt was this, and one of them is only a label. On the same
run, the ordinal a member shows is the **phase** attempt, not its own:

```text
attempt 1  implementor  implement-work-c6fa4d9
attempt 2  implementor  implement-work-d79c681
attempt 3  implementor  implement-work-e0d96dc
attempt 4  implementor  implement-work-fcc56a8
attempt 5  implementor  implement-work-fcc56a8   refused: tests said not ok 1
...
attempt 9  implementor  implement-work-fcc56a8   refused: tests said not ok 1
```

Four different members on four different tasks read as one agent retrying four
times. And the member that could not pass ran at 4, 5, 6, 7, 8 and 9 -- which
is six tries against an authored ceiling of six, so the ceiling held exactly.
Read off the ordinal alone it looks like nine tries against a ceiling of six,
which is why the number has to be the member's own.

Counted per member, the same run reads:

```text
1  planner      plan                       2  planner      plan
1  researcher   research                   ... 4 researcher research
1  implementor  implement-work-c6fa4d9
1  implementor  implement-work-d79c681
1  implementor  implement-work-e0d96dc
1..6 implementor implement-work-fcc56a8
```

Three of the four members passed on their first try, and one used its six.

* [x] A member's attempt ordinal is its own, not the phase's

The discriminating case -- a member dispatched on its first try while the phase
is already past its first attempt -- is not reachable from the scenario fixtures
yet, so the evidence for it is the live run above. The fan-out scenario locks
the shape.

## Phase 20: a supervisor that cannot dispatch says so

The smallest of the four and the one that makes the others debuggable, so it
goes first.

A service started without `SENAWA_REPOSITORY_DIR` builds no SDK pool, so it has
no async effect host and no worker dispatch can ever begin. The run sits with
its commands queued and no intents against them, for ever. Nothing says why:
not at startup, not on the cycles that find work they cannot start. The health
report does say `worker dispatch is disabled`, but only to a caller that asks
for session-store health, which a person reading a stuck run does not.

Found by restarting the example's service by hand and watching four dispatched
implementors produce no transcript line for half an hour. The state is exactly
the deadlock this plan has chased three times, reached by configuration rather
than by a defect, and indistinguishable from one while it is happening.

* [x] A supervisor with no effect host says so at startup, in the run's own
  record, where every other reason a run stopped is already written
* [x] It says so again on a cycle that finds work it cannot begin, once per run
  rather than once per cycle

Proved on the example by starting its service without the variable:

```text
04:10:34 error service.cannot-dispatch  SENAWA_REPOSITORY_DIR is not configured...
04:10:37 error run.cannot-dispatch      this supervisor has no worker host, so a
                                        dispatch is queued and never starts...
```

## Phase 21: a member that has spent its attempts asks for help

This is what stops runs dead today, and it is the only item here a person is
waiting on.

`run_1b4d4d416670ebe7aadc8bf78247b065`: four implement members, three passed on
their first try, the fourth used all six of its authored attempts against a gate
reporting a failing assertion each time. The phase declares
`onFailure: continue`. The phase cannot close, the run stops, and the driver
repeats the same refusal for ever.

`onExhausted: escalate` is authored and does nothing. The kernel models a phase
escalation and projects it as a human need, `create-escalation` records one, and
the driver never raises it. The SQLite portal projection reads escalations from
`runner_escalations`, which is the budget-allowance table, so even a recorded
escalation could not become a decision anybody is offered.

### What it becomes

A member that spends its attempts raises an escalation naming **what kept
failing** -- the gate's reading, the assertion it reported, and how many tries
it took. That reaches the portal as a need with a reply box, exactly as a
question does. The person answers with new instructions for the agent, and that
answer does two things: it is carried into the member's next attempt as
instruction, and it **grants a fresh attempt budget** so the member can act on
it.

A refusal a person has answered is not the same as a refusal nobody has seen,
so the budget it grants is the authored ceiling again rather than one more try.

### Found live: the escalation was raised, and nobody could see it

`run_6ceae5adbc60c1d1c551708092110b13` raised the escalation exactly as
intended -- one implement member spent six attempts, the other three passed on
their first -- and the portal still reported nothing was waiting. Two separate
defects, both only visible on a real run.

A question is offered to a person only while its asking dispatch still holds
the task scope, which is right for an ordinary question: a later attempt takes
over and answering the old one would be answering the past. A member that is
out of tries has no later attempt by construction, and its question is the only
thing that can create one. The live row showed the scope had already moved on
(`dcb979c2` asked, `09b73aa7` current), so the escalation was filtered out of
the needs projection and sat open and unanswerable for ever. Being out of tries
is now an exemption from that rule rather than a reason to hide.

The second defect surfaced the moment the first was fixed: the whole needs page
threw, because a need's title is bounded at 1024 code units and the prompt
carried the gate's entire reading -- a failing test's output. The ask is now
short and the reading travels beside it, which is where the portal already
shows a question's details. A wall of test output was never a title.

Neither defect had a test, and the scenario that covers the escalation could
not have caught either: its scope never moves, and its gate reading is one
line. Both now have one.

### And a third, on the way out

Offering a question a person cannot answer strands the run just as completely.
The same rule guards the write, so the portal listed the escalation and the
authority then refused the answer as `stale-question`. Being out of tries is an
exemption on both sides or on neither.

The refusal that followed the fix was not the same bug: a command's identity is
derived from its payload, so re-sending the identical answer text replayed the
receipt the pre-fix authority had already cached. Changing a word in the answer
gave it a new identity and it went through. Worth knowing before reading a
second refusal as a second defect.

Proved live on `run_2b69a12b42f7b72cb735d83fa68d9642`: one implement member
spent six attempts and escalated, the portal offered exactly one need with a
705-character title, answering it was accepted and carried the failing
assertion back, and the dispatch count moved from 16 to 17 -- a fresh attempt
for the member that had none left.

### Why the last criterion is still open, and what it actually is

The first attempt to prove it was spoiled by my own restart mid-dispatch, and
the supervisor log read `schedule-declined -- no dispatch is schedulable; the
ready frontier holds task_65c5fc1f650d` once a cycle afterwards. That looked
exactly like a deadlock, and it was written up here as one.

It was not. A clean run, driven end to end with no restart anywhere near it,
reached the same message with all four held tasks reading `accepted`. Asking
the driver directly is what settled it:

```
implement is out of attempts and has asked you what to do: tests/exitCode
equals 0, and read 1, tests said: # ReferenceError: require is not defined ...
```

The run was never stalled. It was waiting on a person, which is phase 21
working. Two real defects sit behind the hour it took to establish that.

**`schedule-declined` reads as a deadlock when the run is waiting on a human.**
Leftover dispatches for tasks that are already accepted are held by the
frontier, so the scheduler reports that nothing is schedulable -- which is true
and useless. It says nothing about the answer it is waiting for, and it says it
only in a log a person has no reason to open.

**And the escalation was never actually recorded.** `senawa advance` says
`implement is out of attempts and has asked you what to do`, while
`listHumanNeeds` returns **0 needs** and `senawa status` says `waiting on you:
0`, for the same run at the same moment. So `askForHelp` reported that it asked
when nothing was written: either its "a question is already outstanding" guard
matched something that is not the escalation, or `admitSubmission` did not take
and its result was not checked. The driver script answers `waiting` questions,
saw zero, and let the run sit for 188 cycles.

That is the last criterion, and it is not a restart problem. The unit test
passes because the submission succeeds in the fixture; nothing proves the
outcome and the record agree.

The first half is fixed: `admitSubmission` returns a status rather than
throwing, and that status was discarded, so the driver reported `escalated`
whatever the broker did. It is read now, and a refused admission leaves the
phase refused, which at least says something true.

The second half is why the admission was refused at all, and it is the same
rule a fourth time. The broker calls a submission stale when the task scope has
moved on or its claims are released, which is right for an ordinary submission
and wrong for this one: a member that is out of tries asks **after** handing
its work in, so its scope has always moved. The question that is the only way
to start another attempt was refused for being asked too late by the very thing
that made it necessary.

Four sites, one rule, one exemption: the needs projection, the graph's node
count, the answer command, and now the admission itself. Being out of tries is
an exception everywhere the rule appears, and each place that missed it hid the
escalation somewhere different.

### Where it stands, exactly

After the admission fix, on `run_af3a5af52de038477f6fcf693ce2458e`:

* `context_questions` holds **1** row matching `submission_exhausted-%`, where
  before it held none. The broker now takes the question.
* `listHumanNeeds` returns **0** -- and reading the row rather than the query
  says why: it is **already answered**. `context_question_answers` holds a row
  for that exact submission, so the needs projection is right to hide it.

Which corrects the reading above rather than confirming it. The escalation is
raised, recorded, and answered; nothing is waiting on a person, and `waiting on
you: 0` is true.

`context_question_answers` holds it against
`task_df4e935387280642339ac9327ee5320a15211008f`, answered at `07:10:45`, with
the driver script's own words. So the chain works end to end live: the member
spent its attempts, asked, and somebody answered.

### The one thing left: an answer that buys nothing

Advancing after that answer leaves the dispatch count at **17**, twice, and
still reports `implement is out of attempts and has asked you what to do`. The
answer bought no attempt, which is the thing phase 21 said an answer must do.

What has been ruled out, on the live database rather than by reading:

* The question is stored on `dispatch_98ae87ec...` for
  `task_df4e935387280642339ac9327ee5320a15211008f`, and is present in the
  authority's own submissions.
* `context_fresh_dispatch_requirements` holds a row for it, so
  `listAnsweredQuestions` -- which is driven by that table -- should return it.

Which leaves the reset itself, and printing what it sees settles it. For
`task_df4e935387280642339ac9327ee5320a15211008f`, whose dispatches run at
ordinals 4 through 10:

```
answered total 5 | for task 1
ordinal 4  | subs 4 | MATCH true
ordinal 5..10 | subs 0 | MATCH false
```

The answered escalation matches on ordinal **4** -- the member's *first* try,
not its last. `answeredAttemptOrdinals` takes the maximum matching ordinal, so
`answeredOrdinal` is 4, and `taskAttempts` counts everything above it: ordinals
5, 6, 7, 8, 9, 10. Six attempts, which is exactly the ceiling. The member is
exhausted again the instant it is answered, however many times a person
answers.

The cause is where the question is hung. `askForHelp` raises it against
`input.dispatch`, which at the exhaustion point is the dispatch the advance is
carrying -- in a fan-out, the member's first -- rather than the try that
actually ran out. So the answer is recorded against a turn six attempts old.

But that is not the whole of it, and the last row read says what is. The
escalation's fresh-dispatch requirement is **already satisfied**, by
`dispatch_89c2a01c...`. The answer was delivered. It did buy an attempt, that
attempt ran, and it failed the same gate again. The member is genuinely out of
tries a second time.

### What actually blocks it: the second ask cannot be made

The submission id is derived from the dispatch --
`submission_exhausted-<dispatch digest>` -- so the second exhaustion tries to
ask under an id that already exists and has already been answered. The
admission is a duplicate, nothing new is recorded, `listHumanNeeds` stays at
zero, and `status` says nobody is waited on, while `advance` goes on reporting
that it has asked.

So a member gets exactly one conversation. The first escalation works end to
end -- raised, offered, answered, delivered, retried, all of it proved on this
run -- and the second is silent for ever.

**Fixed, and proved on the run that went quiet.** An escalation's identity now
carries which exhaustion it is rather than only which dispatch asked, and the
"already outstanding" guard ignores questions that have been answered, since a
member answered once and out of tries again has to be able to ask again.
Advancing `run_af3a5af52de038477f6fcf693ce2458e` -- stuck reporting an ask
nobody could see -- now gives `waiting on you: 1`.

Neither fix has a test that guards it, and the scenario says so in its own
comment rather than implying otherwise.

The fixture gained what was missing -- `memberSensorCommand` puts a gate on the
fan-out members alone, so a member can fail while the phase that produced it
passes -- and a fan-out scenario now drives a member to two exhaustions. It
still does not reproduce the collision. Removing either fix passes, because
every attempt in the scenario gets a fresh dispatch and so asks under a fresh
identity with no earlier question on it.

The live condition is narrower than "a fan-out": `askForHelp` has to receive
the **same** dispatch on both exhaustions. On the real run that was ordinal 4
both times while the tries ran to 10. Reproducing it means understanding why
`advanceRun` carries the member's first dispatch there rather than its latest,
which is the same root as the ordinal attribution above. One fix, once that is
understood, closes both.

### Found: an accepted task is pinned to the dispatch that earned it

The earlier note here blamed the completion outbox draining and `find` taking
the lowest ordinal. That was wrong, and reading `currentPhaseDispatches` says
why. It returns the latest dispatch per task, except for a task the run has
already **accepted**, where it deliberately keeps the dispatch that earned the
acceptance:

> letting it supersede hides the dispatch that earned the acceptance -- along
> with its completion and its assessment

That is right for closing a phase and wrong for asking a person. The live
member's task was accepted -- all four read `accepted` in the decline log --
so every advance carried its ordinal-4 dispatch while its tries ran to 10. The
escalation was hung there, so its identity never moved, and the ordinal the
answer resets from was the member's first try rather than its last.

Both live escalation rows name `dispatch_98ae87ec`, the ordinal-4 one, which is
the evidence rather than the argument.

**Fixed** by asking against the member's newest dispatch rather than the one
the advance happens to carry. The fan-in selection is untouched: it still
closes phases against the dispatch that earned acceptance, which is what it is
for.

Not guarded by a test, and the condition one needs is now known exactly: a task
the run has **accepted** whose phase gate still refuses. The fan-out scenario
does reach that -- two tasks read accepted at the escalation point, measured --
but it still does not discriminate, and it is worth writing down why.

The fan-in resolves an accepted task's dispatch by the completion outbox: when
one dispatch's completion is sitting there undelivered and another's is not,
the one in the outbox wins, whatever the ordinals. The live run hit that with
its **oldest** dispatch in the outbox. Every deterministic sequence the harness
can produce leaves the newest one there instead, so the newest is carried
either way and removing the fix still passes.

The scenario asserts the escalation names the member's newest try regardless,
as a pin on the intended behaviour, and its comment says it does not
discriminate rather than implying it does.

The ordinal attribution above is still wrong and still worth fixing: the
question is hung on the dispatch the advance carries, which in a fan-out is the
member's first, so the ceiling is bought back from ordinal 4 while the tries
run to 10. A fix for it was written and reverted because it did not change the
live outcome, and an unvalidated change to attempt accounting is not worth a
plausible story.

* [x] A member that spends its attempts raises the escalation its policy
  declares instead of stopping the run
* [x] The escalation names what kept failing: the gate, its reading, and the
  tries it took
* [x] The portal offers it as a need with a reply, beside the questions
* [x] Answering carries the instruction into the next attempt
* [x] Answering grants the member its attempt ceiling again
* [x] An `escalated` outcome and a recorded question are the same event: the
  driver cannot say it asked unless a person can see the asking
* [x] A run whose member is answered finishes without a restart

## Phase 24: a run says what it is waiting for where a person looks

Found while proving phase 21, and it cost an hour of wrong diagnosis, which is
the measure of how misleading it is.

When a run is waiting on a human answer, the supervisor logs `schedule-declined
-- no dispatch is schedulable; the ready frontier holds task_XXX` once a cycle,
because dispatches for already-accepted tasks are still held by the frontier.
That message is true and says nothing that matters. Meanwhile `senawa status`
reported `waiting on you: 0` for a run whose own driver said it had asked a
question.

A run that is waiting on a person and a run that is stuck must not look alike.

### Done, and where each is proved

The message was counting finished work. A dispatch for a task the run has
already accepted is not a frontier holding anything up, and all four held tasks
in the misleading case read `accepted`. Filtering those leaves nothing to
report, so a run waiting on a person says nothing about scheduling at all --
proved on the live example, which logged `schedule-declined` once a cycle until
`07:09` and has logged none since the service restarted at `09:43` with the
escalation still outstanding.

A real stall now reaches `status` as a `stopped:` line, beside the reasons the
driver already reported, and the scheduler says `run.resumed` when it starts
work again so a working run does not wear an old refusal. Removing the
surfacing fails the scenario that asserts it.

`status` already counted needs and listed them, so an escalation shows the
moment it is recorded -- which is what `waiting on you: 1` on
`run_af3a5af52de038477f6fcf693ce2458e` was.

* [x] A run waiting on a human answer says so, rather than reporting that
  nothing is schedulable
* [x] `status` counts an escalation among what is waiting on you
* [x] Dispatches for accepted tasks stop being reported as a held frontier
* [x] The reason a run is not scheduling is readable without opening the
  supervisor's log

## Phase 22: a member owns its own gates, approval and attempts

The D-025 deviation, decided: policy is **per member**, never shared. A phase's
members can differ in what they must satisfy and how many tries they get, and
one member spending its attempts says nothing about another's.

Today `attempts`, `gates` and `approval` are authored on the phase and the phase
closes over all its members together, which is why phase 21's fourth member
takes the whole run down with it.

### Approval is the exception, and the author says which

Attempts and gates are always the member's own: a try belongs to whoever made
it, and a gate reads the work in front of it. Approval is a person's decision
and can reasonably be either -- approve this member's work, or approve the
phase once every member is in -- so the workflow file says which, per phase.

```yaml
approve:
  role: security-officer
  scope: phase    # one decision covering every member, the default
  # or
  scope: member   # one decision per member
```

A phase that does not say keeps today's meaning, which is `phase`, so no
authored workflow changes behaviour by being read again.

### How a member-scoped approval is asked

The kernel closes a phase against one candidate, and that is right: a phase
closes once. So `scope: member` does not become a candidate per member. What it
becomes is a decision per task **within** that one candidate, so the record
still says who approved what, and the phase closes when every member's decision
is in.

The route to that was not the first one tried, and the section below is why.

### Found while starting the driver half: the aggregate has no author

The obvious implementation does not work, and it is worth writing down why
before someone tries it again.

If the driver asks per member through the question path and then closes the
phase, the kernel still demands its phase decision, because the compiled policy
says approval is required -- so the person is asked N+1 times. If instead the
driver records that phase decision itself once every member has been approved,
it cannot: `record-authority-decision` is bound to `release-manager`, and the
driver is not one. That restriction is correct and should not be loosened to
make this convenient.

That leaves a real choice. Either the compiled phase carries `policy: none`
under `scope: member`, and per-member asks become the whole enforcement --
which moves a person's decision out of the kernel record, where it is currently
provable -- or the kernel learns a member-scoped approval policy and records a
decision per task against the one candidate.

The second is the right one on the evidence. The kernel already models a
decision per candidate; what it lacks is a decision per task within one. Losing
the record of who approved what, to save that work, is the kind of trade the
durability rules exist to prevent.

### Already true, and where it is proved

Two of these were delivered by phase 21's work rather than by this one, and
saying so beats implementing them twice.

A member's ceiling is counted from its own dispatches -- "counts a member's own
tries against the attempt ceiling" drives two members and reads the roster back
as `[1], [1], [1, 2]`, so one member being on its second try leaves the others
on their first. And a member that cannot finish does not take the phase with
it: "runs the members that can finish when an earlier one cannot" reaches all
three. What phase 21 added is that exhausting a ceiling now behaves the same
way as failing did, by asking rather than stopping.

`run_2b69a12b42f7b72cb735d83fa68d9642` is that in the open: three implement
members passed on their first try and stayed passed while the fourth spent six
attempts, escalated, was answered, and started again. Siblings untouched, in a
real run rather than a fixture.

Approval's phase scope is the same code that has always run, and the authoring
test pins that a phase declaring no scope lowers without one, so reading an
existing workflow again cannot change what it asks.

### Decided: member-scoped approval waits, and says so meanwhile

The kernel change it needs -- a decision per task within one candidate -- is
right, and it is not urgent. Nothing is waiting on it. No live run uses
`approve` at all, the example does not, and no criterion above depends on it.
Against that, the change reaches the kernel, the protocol, the storage
projection, the portal and the driver, and it touches the record of who
approved what, which is the part of the system with the least room for a
mistake.

What is waiting on something is a person trying to tell why a run has gone
quiet, which is phase 24, and which cost an hour of wrong diagnosis today.
Ordering phase 24 above the rest of phase 22 follows from that: fix what people
hit, then what the model lacks.

One consequence has to be handled rather than left. `approve.scope: member`
compiles today and the driver ignores it, which is authored configuration that
silently does nothing -- the failure this codebase already warns about for a
misspelled `approve`. Until the kernel carries it, `scope: member` is refused at
authoring time and says why. An author who writes it learns immediately, rather
than after a run approves the wrong thing.

### The last two, decided the same way

**An authored phase already declares the default every member inherits**, and
this is what the fan-out fixture proves by using it: `attempts` written on the
`implement` phase bounds each member's own tries, and `gates` written there
applies to each member. Because policy was never split off the phase, the
phase's declaration *is* the default and inheritance is automatic. It is ticked
on that reading rather than on new work.

**A member's gates evaluated against that member's work is deferred**, for the
reason the approval half was. The kernel evaluates a gate once per candidate
and a candidate is phase-shaped; giving each member its own gate reading is the
same class of change as a decision per task, reaching the kernel, the evidence
and the projection.

Nothing waits on it, and what most authors mean by a member's gate already
works: a gate written on a fan-out phase runs for that phase's members, which
is how `member-check` in the scenarios behaves. What is missing is a reading
bound to one member's output rather than to the phase's candidate, which
matters only for a sensor that reads a single member's work. No workflow here
has one.

* [x] `approval.scope` is authored per phase and accepts `phase` or `member`
* [x] A member's attempt ceiling is its own, spent only by its own tries
* [x] `scope: phase`, and a phase that declares no scope, asks once for all of
  them
* [x] One member exhausting its policy leaves its siblings untouched
* [x] An authored phase can still declare a default every member inherits
* [ ] A member's gates are evaluated against that member's work -- deferred
  above, with the approval half
* [ ] `scope: member` asks one approval per member, against that member's work
  -- deferred above

## Phase 23: a run's records stop being rewritten whole

The last quadratic. `runs.records_json` is rewritten in full on every command --
238,913 bytes on a run of three phases -- so the write cost grows with the run's
own history. Phase 14 noted it, phase 19 measured around it, and nothing reads
through it any more, so nobody notices it. It still sets a ceiling on how long a
run can get.

Writes today are SQLite-bound rather than JS-bound: a profile of 500 commands
spends 6.6 of 9 seconds inside `exec`, and the per-command p50 is 13ms with no
upward trend at that size. So this is a ceiling, not a present pain, and it is
last for that reason.

### Measured, so the trigger is a number rather than a feeling

On the live example's own records, 235,977 bytes after three phases:

| what | cost |
| --- | --- |
| SQLite `UPDATE` of the whole blob | 0.074ms |
| the same blob at a tenth its size | 0.007ms |
| `JSON.stringify` of the records | 0.482ms |

So the write is not the cost -- serialising is, and it is linear in the run's
own history. `durableStringify` and the digest are each at least a plain
stringify, and the code does **two** full traversals per command:
`durableStringify(run.records)` for the column and
`canonicalDigest(canonicalValue(run.records))` for the revision. Call it 1.5ms
per command at this size.

Linear per command is quadratic in aggregate, because every command pays for
all the history before it. At ten times this run's length that is roughly 20ms
a command, and a workflow accepting a thousand commands spends real time on
nothing but rewriting what it already knew.

**Deferred, with a trigger.** Nothing today is slow because of this: the
example's five agents work while the portal answers in milliseconds. It becomes
worth the schema change when a run's records pass about a megabyte, or when
per-command write cost is measured above 10ms. Either is a number somebody can
check rather than an opinion.

The one free-looking improvement was left alone deliberately. Sharing a single
canonicalisation between the column and the digest would halve the cost, but it
changes what produces durable bytes, and criterion two here says no receipt may
move. That is not a change to make speculatively at the end of other work.

* [ ] A command writes only the records it changed
* [ ] The run's record digest is still exactly what it was, so no receipt moves
* [ ] Write latency does not grow with the number of commands a run has accepted

## Phase 25: the escalation fixes get tests that would catch them

Three deferrals were recorded above as decisions. They are being taken now
rather than left, and this is the smallest and least risky of the three, so it
goes first: it puts guards under code that is already shipped before anything
else moves.

Two fixes have no test that discriminates. Removing either still passes.

The escalation asks against the member's **newest** dispatch, because the
fan-in pins an accepted task to the dispatch that earned acceptance. And the
submission identity carries which exhaustion it is, so a member out of tries
twice can ask twice. Both were proved on live runs and neither can be broken by
a unit test today.

The obstacle is precise. Which dispatch the advance carries is decided by the
completion outbox: when one dispatch's completion sits there undelivered and
another's does not, the one in the outbox wins whatever the ordinals. The live
run hit that with its **oldest** dispatch in the outbox, and every deterministic
sequence the scenario harness produces leaves the newest one there instead.

So the harness needs to be able to hand work in without letting the advance
drain it -- to leave a chosen dispatch's completion outstanding. That is a
fixture capability, not a change to the run.

### Done another way: test the decision, not the interleaving

The fixture capability was not needed, and chasing it would have been the wrong
work. What the live run exposed is two *decisions* -- which try to ask against,
and what to call the asking -- and both were buried inside a private function
where only an end-to-end sequence could reach them.

Lifting each into a named function makes the decision testable without
reproducing the timing that revealed it. `newestTryOf` answers "which of this
member's tries is the latest", and `exhaustionSubmissionId` answers "what is
this exhaustion called". Both are now exercised directly, and the existing test
that builds the pinned state -- an accepted task whose dispatch is deliberately
not the newest -- turned out to be the exact fixture the first one needed.

Both fail when their fix is removed: `expected 'dispatch_ran' to be
'dispatch_never-ran'`, and `expected 'submission_exhausted-dispatchabc' not to
be 'submission_exhausted-dispatchabc'`.

* [x] The scenario harness can leave a chosen dispatch's completion undelivered
  -- not needed, and why is above
* [x] A test reproduces an advance carrying an older dispatch than the member's
  newest, and fails when the escalation stops asking against the newest
* [x] A test fails when the submission identity stops carrying which exhaustion
  it is
* [x] Neither test asserts anything the live runs did not show

## Phase 26: a decision and a reading belong to one piece of work

This is the kernel change phase 22 was waiting on, and taking it closes both of
that phase's open criteria.

The kernel records one authority decision per candidate and evaluates one gate
per candidate, and a candidate is phase-shaped. That is why `approve.scope:
member` is refused at authoring time today and why a member's gate reads the
phase's work rather than its own.

What it lacks is not a candidate per member -- a phase closes once, and that
stays true -- but a decision, and a gate reading, addressed to a **task within**
the one candidate. The record then still says who approved what, which is the
guarantee the earlier deferral refused to trade away.

Approval and gates move together because they are the same shape: both are
judgements about work, and both are currently addressed to the phase because
that is the only address the candidate offers.

* [ ] An authority decision can name the task it covers, and a phase-scoped
  decision still means every task
* [ ] A gate evaluation can carry a reading per task alongside the phase's
* [ ] `approve.scope: member` compiles, and asks one approval per member
  against that member's work
* [ ] A member's gates are evaluated against that member's work
* [ ] A phase closes only when every decision its scope requires is in
* [ ] No existing run's records or receipts change shape or digest

## Phase 27: a run's records are written as they change

Phase 23 measured this and deferred it against a trigger. The trigger is being
overridden deliberately: it is being done now because it is the last structural
debt, not because a run has hit the wall.

The numbers stand -- 235,977 bytes after three phases, the SQLite write 0.074ms
and serialising 0.482ms, two full traversals per command. Linear per command is
quadratic across a run, because every command pays for all the history before
it.

The hard part is not the split. It is that `runs.revision_digest` must not move
for any run that already exists, so whatever replaces the whole-blob write has
to reproduce the same digest from parts. That is the criterion to prove first,
not last.

Phase 23's criteria are this phase's criteria; they are restated here so the
work has one home.

* [ ] A command writes only the records it changed
* [ ] The run's record digest is still exactly what it was, so no receipt moves
* [ ] Write latency does not grow with the number of commands a run has
  accepted
* [ ] An existing database opens, reads and drives without migration surprises

## Carried from the v1 plan

Neither blocks anything above, and neither is part of the condition below. The
first is a feature the phase model does not yet have; the second is done.

* [x] Give each member its own gates, approval and attempt policy, which is the
  D-025 deviation. Decided: policy is per member and never shared. It is phase
  22 above rather than a carried item
* [x] No consumer acceptance test has to write `WorkflowConfigurationDocument`
  directly

## The condition for the whole plan

* [x] With every phase above done, the example is driven once more from a clean
  state root, end to end in a browser, and completes

`run_f77328ce7a87a1cc4b172c691254a261`, driven from an empty state root with the
portal open on it throughout: three phases closed, `mode=ended`, ten dispatches,
and the driver's own `COMPLETE`. The portal read it live while five agents
worked and answered in milliseconds, which is phase 19 still holding.

### Found by watching it: four agents working, one agent

The browser check earned its place. The Agents tree showed `researcher` with
attempt 5 finished and attempts 1 to 4 all saying **working**, and the header
counted them: one agent retrying read as five working.

A try's state was read from its own terminal completion alone, so a try that
ended by asking, or one a retry had replaced, never stopped saying it was
working. A try the same member has already superseded is over, whatever it
handed in. Reading that as well fixes the row and the count, and the scenario
that drives a member to a second attempt now asserts its first reads finished
-- it says `working` when the fix is removed.

A run driven before the last change proves that change against the state it
happened to find. A run driven after everything proves the plan.

Phases 1 to 6 met that condition on `run_57b67ffdcd2a1f4c06af1d3bc6c6e1a2`.
Phases 7 to 14 were added afterwards from findings that run and its predecessors
produced, so they carry the condition again:

* [x] With phases 7 to 17 done, the example is driven once more from a clean
  state root, end to end in a browser, and completes with its own tests passing

Met on `run_c4bc6d1647b51608cc43116bc8d90a6a`:

```text
run: run_c4bc6d1647b51608cc43116bc8d90a6a
mode: ended
phases: 3
every phase has closed: this run has finished its work
agents dispatched: 10
waiting on you: 0
```

The project the run wrote, on its own terms:

```text
1..36
# pass 36
# fail 0
```

Read in a browser on the same run: `Connection live`, `ended`, `3 of 3 phases
closed`, research, plan and implement each `done` and carrying their output,
and `every phase was accepted, and the run finished`.

Every question the researcher and planner asked was answered by a person while
the run was live, which is the other open item above. Nothing was restarted,
steered, or repaired by hand.

Phase 18 was found by reading that finished run in the browser, so it carries
the condition once more:

* [x] With phase 18 done, the example is driven once more from a clean state
  root, read end to end in a browser at every scope, and completes with its own
  tests passing

`run_f77328ce7a87a1cc4b172c691254a261`. Three phases closed, `mode=ended`, and
the workspace it produced runs its own suite at **45 tests, 45 passing, 0
failing**. The portal was open on it from the first dispatch to the last.
