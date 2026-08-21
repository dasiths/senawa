# Open decisions

[The completion plan](completion-plan.md) has five unticked items. None of them
is unfinished typing. Each one is a question about how the system should behave
that somebody has to answer before the code can be written, and answering it
badly is worse than leaving it open.

This records what each question is, what the evidence says, and what the options
cost, so the decision can be made deliberately rather than at the end of a long
session. [The implementation log](implementation-log.md) has the findings these
came from.

There is also one thing that is not a decision but is worth saying out loud: a
fix that shipped without a test to guard it.

## The attempt lifecycle cannot say which task an attempt is for

Three of the five items are the same question wearing different clothes:

* Record an attempt as opened when a task is dispatched and closed when the
  worker returns.
* Have the authority refuse to open a second attempt for a task while one is
  open.
* Delete `spentDispatch`.

They are one piece of work. The run has a rule — a task may have one agent at a
time — and nothing records whether that rule is being kept. The driver infers it
instead, by reading the runner's effect log and asking whether a dispatch ended
without handing anything in. That is `spentDispatch`, and it is a guess at
something the system should simply know.

The mechanism appears to exist already. `record-phase-attempt-transition` is
declared in the protocol and authorised in the daemon for `engine` and
`release-manager`. Nothing submits it, and the authority's handler decodes the
payload and records nothing.

The obstacle is the payload as declared:

```text
attemptDigest      a digest
transitionDigest   a digest
triggerDigest      a digest
disposition        iterate | escalate | fail | closed | refused
```

There is no task in it. An attempt transition, as the protocol currently
declares it, cannot say which task it belongs to, so it cannot be used to
enforce "one open attempt per task". `start-phase-attempt` is not the answer
either: it refuses with `phase-already-current`, so it advances between phases
rather than opening an attempt within one.

### What has to be decided

Whether the attempt is a first-class record with an identity of its own, or a
property of the task.

Making it first-class means extending the declared payload to name the task and
generation it belongs to, and adding an open-attempts table the authority checks
before admitting a dispatch. That is a protocol change, and this branch has
already learned that a refusal message is part of a durable receipt, as [the
durability documentation](../../durability.md) records, so contract changes here
are not free.

Making it a property of the task is smaller: the authority already holds task
scopes, and "has an open attempt" could live beside `claimsAccepted`. It
enforces the same rule with no new record, but leaves no history of attempts,
which is the thing a reader wants when a task has been retried five times.

### Why it is worth doing at all

Every ordering defect on this branch has the same shape: the driver
reconstructing state that should have been recorded. The gate that evaluated
before the completion landed, the retry that fired while an agent was working,
the phase that waited forever for a turn that was already over, the finished run
that re-ran a closed phase. Each was fixed individually. The mechanism is worth
more than the next fix.

## Nothing tries again when a lease expires

This is F-061, and it is diagnosed to the end.

A supervisor that stops mid-turn leaves an effect intent with no outcome and a
claim naming an owner that no longer exists. Everything below the supervisor
handles this correctly, and there is a test for it: once the dead owner's lease
expires, the transition scheduler offers a `reconcile` plan for the abandoned
intent, and a successor is allowed to claim it. `listRunnableRuns` already counts
a run with an intent that has no terminal outcome, so the run is offered too.

What fails is above all of that. The successor starts while the dead owner's
lease is still live, `acquireRunLease` raises `LeaseUnavailableError`, and the
cycle catches it and reports that it did no work. The supervisor is wake-driven
and has no timer anywhere in it. A cycle that reports no work stops the pump, and
nothing revisits the run when its lease expires a minute later.

So the run is reachable in principle and unreached in practice: runnable,
unblocked shortly afterwards, and asked about by nobody. In the live case it sat
that way indefinitely, with `senawa status` reporting agents dispatched, nothing
waiting on a person, and the mode still running.

### What has to be decided

How the service learns that time has passed.

Re-enqueuing a wake on `LeaseUnavailableError` is the obvious patch and the wrong
one: it retries immediately and spins until the lease expires. What is wanted is
a retry at the expiry the authority already knows, which means the supervisor
gains scheduled work it does not currently have.

That is a change to the shape of the service, not a line in a catch block. It
raises questions worth answering on purpose: whether a single timer serves every
deferred cause or each gets its own, what happens to a scheduled retry when the
service drains, and whether a run blocked on a lease should be visible as
blocked rather than silently idle.

The last of those may matter most. Whatever is decided about retrying, a run
that cannot be driven because something else holds its lease should say so.

## Reading a record costs four seconds, and the fix is not a faster reader

[Command latency](command-latency.md) attributes this. `senawa status` takes
4166 ms, of which opening the record is 2470 ms and verifying it 1539 ms. One
fix shipped from the measurement: opening a record parsed its canonical state
twice, which was 32% of the cost.

The measurement also changed what the answer should be. The median gap between
supervisor receipts on a working run is 126 ms, and the long gaps are agents
thinking. The four seconds is the cost of *starting a command*, not of running
the system. The service opens the record once, verifies it once, and then drives
cycles an eighth of a second apart. Every `senawa status` pays the whole opening
again, from a cold process, to read something the running service already holds
open.

### What has to be decided

Whether a read-only command asks the running service or opens the record itself.

Asking the service is the obvious answer and the reason it is not already done
is a real one: it makes every read depend on a service being up, and it means a
command behaves differently depending on whether one is. The supervisor already
serves a portal over exactly this data and the CLI already knows how to talk to
it, so the mechanism is there; the question is what happens when it is not.

Underneath that sits a second question the latency work surfaced and did not
answer: whether reading requires verifying at all. `SqlitePortalQueryAuthority`
opens the same record in two milliseconds without verifying it, so there is
already precedent for reading without the check. Extending that precedent
weakens an integrity guarantee, which is a product decision rather than a
performance one.

### The item that follows from this

`waits for the members still working whichever one finishes first` takes
seventeen seconds on its own, because every `advance` opens and verifies the
record. It has already timed out once under the parallel suite. That is not a
test problem to be fixed with a longer timeout; it is this latency showing up
somewhere it can be measured, and it goes away when the cost does.

## One fix has no test guarding it

F-063 is fixed and the fix is not held by anything.

A finished run drove itself into a permanent `command-id-conflict`: the driver
re-offered completions the outbox had already delivered, and re-ran a phase it
had already closed. Both are fixed, and the live record proves it — `senawa
advance` against it threw deterministically before each change and reports
`every phase is done` after.

What does not exist is a test that fails when the fix is removed. Both changes
were removed and the fan-out scenario still reported `finished` and still
submitted nothing new. The harness never reaches the conflict, because it never
gets the accepted-task set to move after a close.

This is worth carrying as an open item rather than a closed one. The behaviour is
correct today and nothing will notice if it stops being correct. Reproducing the
sequence in the harness is the work: a phase that closes, an accepted-task set
that changes afterwards, and a driver asked to run again.

## What must not be decided away

Two of these questions have a tempting cheap answer that costs something the
branch has already paid for once.

The attempt lifecycle can be skipped by fixing the next ordering defect
individually, as the previous six were. That works every time and never stops
working, because the driver keeps reconstructing state nobody recorded.

The lease retry can be answered by polling every run continuously, which removes
the symptom and gives up the property that makes this service cheap to run: it
does nothing when there is nothing to do.
