# Completion plan

This sequences the work left after driving the example workflow against live
agents. [The implementation log](implementation-log.md) records what that
surfaced: twenty-seven findings, of which four remain open and one blocks
everything else. [The redesign plan](plan.md) still carries the v1 checklist;
this carries the order of what happens now and why that order.

## What this is for

The example must produce a working tic-tac-toe game, driven from the portal,
without a person touching the CLI. That is the acceptance test for the whole
branch. It has not passed once.

Everything below is sequenced against that, because a run that cannot finish
cannot show us whether the rest is right. Four of the portal's nine tabs were
empty every time they were measured, and it is still unknown which are empty by
design and which were empty because the run died early.

## Phase 1: make the attempt lifecycle real

A task may have one agent at a time. A later attempt takes the task scope over,
which silences the previous one permanently — this is deliberate and correct.
The defect is that the driver starts the next attempt while the previous agent
can still hand work in, so the work is refused as stale and no attempt ever
finishes. See F-046 and F-047.

The driver currently infers whether an agent is alive from the runner's effect
log. That is guessing at something the system should record. The protocol
already declares `start-phase-attempt` and `record-phase-attempt-transition`,
the daemon already authorises both, and nothing ever submits the second one: the
authority decodes its payload and records nothing.

* Record an attempt as opened when a task is dispatched and closed when the
  worker returns, not when its cancellation is requested.
* Have the authority refuse to open a second attempt for a task while one is
  open, so the one-agent rule is enforced rather than merely respected.
* Delete `spentDispatch`. The retry question becomes whether the attempt is
  closed.
* Report a stale submission as a refusal that says a later attempt owns the
  work. Done already, but it belongs to this phase.

Done when a second dispatch against an open attempt is refused, a closed attempt
permits the next one, and both are proven by breaking them.

This is the shape behind every ordering defect in this branch — the gate
evaluated before the completion landed, the retry that fired while an agent
worked, the phase that waited forever for a turn already over. Each was the
driver reconstructing state that should have been recorded. Fixing the
mechanism is worth more than fixing the next instance.

## Phase 2: drive the example to a finished game

One clean run. No service restarts, because restarting mid-dispatch is what
produced several of the failures already recorded.

* Answer every question through the portal.
* Reach a game in the example workspace and play it.
* Record what the run showed, including which views finally have content.

Done when the game exists, runs, and the run reached its end without a person
using the CLI.

## Phase 3: clear the debts the run exposed

These are recorded and unfixed. None blocks phase 2, and all of them cost a
person something real.

* A question whose guards no longer bind stays queued as a human need forever,
  offers a button, and refuses every answer. Nothing prunes it. F-040.
* `/agents` returned 500 for a healthy run. The coupling that made it fatal is
  fixed; the 500 is neither fixed nor understood. F-039.
* A kernel refusal message is part of the durable receipt, so changing the text
  of one invalidates every database that recorded it. This is correct and is
  written down nowhere. It belongs in the durability documentation. F-035.
* A run that fails to verify takes the whole supervisor down with it, so one
  corrupt run stops every other run on the machine. It should be quarantined and
  reported. F-035.

## Phase 4: simplify the portal

[The analysis](../portal-simplification.md) measured this against a live run and
carries the per-tab and per-component detail. Three small fixes have shipped; the
substance has not. The order there is already decided: content first, so the
layout is judged on legible material, and structure last.

* Names instead of identities, so the agent table stops reporting
  `task_e30bb4a5...` and `unknown (route 0)`.
* Collapse the activity view, which is 23,903 characters and 168 raw digests
  before a person has done anything.
* Fold attempts into the agent that made them: six rows become two.
* Then the structural change: the graph becomes the workflow and nests, and nine
  tabs become two, with every kind of human need folded onto the node it blocks
  rather than scattered across three tabs, two of which are empty on nearly
  every run.

The structural step needs the thirty-four browser tests rewritten first. They
are the safety net for it, and they are currently written against the shape
being replaced.

## What must not change

* The one-agent-per-task rule. Phase 1 enforces it rather than relaxing it.
* Exactness. A refusal that a person or an agent can act on is not the same as
  a refusal that leaks internals, and the difference is worth keeping.
* The attempt ceiling as the only bound on how many turns a phase gets. Nothing
  else should end a phase early, and three separate fixes in this branch existed
  because something else did.
