# Completion plan

This sequences the work left after driving the example workflow against live
agents. [The implementation log](implementation-log.md) records what that
surfaced: fifty-eight findings. [The redesign plan](plan.md) still carries the v1
checklist; this carries the order of what happens now and why that order.

`[x]` is done and proven by a test that fails when the fix is removed. `[ ]` is
not.

## What this is for

The example must produce a working tic-tac-toe game, driven from the portal,
without a person touching the CLI. That is the acceptance test for the whole
branch.

Everything below is sequenced against that, because a run that cannot finish
cannot show us whether the rest is right.

## Where this stands

A run has produced a working game and its tests, and a run has driven three
phases including a fan-out to four members with no driver failure at all. The
remaining gap to the acceptance test is that questions are still answered from
the terminal, and the agents ask several.

Ten defects found by watching live runs were fixed after this plan was written,
recorded as F-049 to F-058. Four of them stopped every run dead: a live clock
made a command conflict with itself, a tool declaration named a schema it did
not carry, a fan-out could not wait for its own members, and a retried member
claimed a sibling's ordinal.

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

* [x] Stop a worker reporting it finished before it has. F-047.
* [x] Report a stale submission as a refusal that says a later attempt owns the
  work. F-046.
* [ ] Record an attempt as opened when a task is dispatched and closed when the
  worker returns, not when its cancellation is requested.
* [ ] Have the authority refuse to open a second attempt for a task while one is
  open, so the one-agent rule is enforced rather than merely respected.
* [ ] Delete `spentDispatch`. The retry question becomes whether the attempt is
  closed.

Done when a second dispatch against an open attempt is refused, a closed attempt
permits the next one, and both are proven by breaking them.

This is the shape behind every ordering defect in this branch — the gate
evaluated before the completion landed, the retry that fired while an agent
worked, the phase that waited forever for a turn already over. Each was the
driver reconstructing state that should have been recorded. Fixing the
mechanism is worth more than fixing the next instance.

F-057 is the same lesson from another angle: the phase attempt ordinal carried
both "which try" and "which member", and only came apart when a live fan-out
retried one.

## Phase 2: drive the example to a finished game

One clean run. No service restarts, because restarting mid-dispatch is what
produced several of the failures already recorded.

* [x] Reach a game in the example workspace and play it. A run produced
  `game.js`, `cli.js` and `test.js`, its own nine tests passed, and it was played
  to "Player X wins!".
* [x] Record what the run showed, including which views finally have content.
* [x] Answer every question through the portal rather than the terminal. A
  question and two budget grants were done entirely from the browser, and the
  receipts came back `answer-question completed` and `grant-allowance completed`.
* [ ] One run, start to finish, with no fix applied in the middle.

Two more defects stood in the way and are now fixed. F-059: a gate that refused
left a candidate behind, so the retry it started could never hand its work in.
F-060: a granted allowance never restarted the work that asked for it, because
the planner excludes a command that has escalated and the answered request stayed
in the runner's snapshot for ever.

Done when the game exists, runs, and the run reached its end without a person
using the CLI.

What stands between here and that: the agents ask three or four questions a run,
and the one thing with no command at all is `grant-allowance`, so a run that
exhausts a budget can only be freed from the portal.

## Phase 3: clear the debts the run exposed

These are recorded and unfixed. None blocks phase 2, and all of them cost a
person something real.

* [ ] A run does not survive its supervisor stopping. An effect in flight when
  the process ends keeps its intent and its claim and never gets an outcome, so
  the phase waits for an agent that no longer exists. Taking the run lease at a
  higher fence is the moment to close the abandoned attempt. F-061.
* [x] A question whose guards no longer bind stays queued as a human need
  forever, offers a button, and refuses every answer. Nothing prunes it. F-040.
* [x] `/agents` returned 500 for a healthy run. F-039.
* [x] A kernel refusal message is part of the durable receipt, so changing the
  text of one invalidates every database that recorded it. Now written down, in
  the durability documentation. F-035.
* [x] A run that fails to verify takes the whole supervisor down with it. Scoped
  honestly: one record holds every run in a project, so there is no per-run unit
  to quarantine. It now says which record it is and how to recover. F-035.
* [x] `grant-allowance` is authorised and has no command-line surface. F-050.
  `senawa grant` reads the request, defaults the increase to the room the policy
  already allows, and names what is blocking when nothing is grantable.
* [x] An escalation for a budget that now has room stays queued and ungrantable.
  Three requests for one unit needed a single grant; the other two became
  permanent entries with disabled buttons. F-050. A request whose unit now has
  the room it asked for is no longer listed.

## Phase 4: simplify the portal

[The analysis](../portal-simplification.md) measured this against a live run and
carries the per-tab and per-component detail. Three small fixes have shipped; the
substance has not. The order there is already decided: content first, so the
layout is judged on legible material, and structure last.

* [x] Names instead of identities, so the agent table stops reporting
  `task_e30bb4a5...` and `unknown (route 0)`.
* [x] Collapse the activity view, which was 23,903 characters and 168 raw
  digests before a person had done anything. Measured at zero digests now.
* [x] Fold attempts into the agent that made them: six rows become two.
* [ ] Then the structural change: the graph becomes the workflow and nests, and
  nine tabs become two, with every kind of human need folded onto the node it
  blocks rather than scattered across three tabs, two of which are empty on
  nearly every run.

The structural step needs the thirty-four browser tests rewritten first. They
are the safety net for it, and they are currently written against the shape
being replaced.

Two things the live runs added to this. The attention rail can hold a button
that cannot be scrolled to, so the only copy of a control was unreachable. And
the same need renders twice with the two copies disagreeing about whether it is
actionable while data reloads.

## Phase 5: find out why the commands are slow

Every `senawa status` costs about a third of a second of process start before it
reads anything, and driving a run from the terminal means running it repeatedly.
Nothing has measured where that goes.

* [ ] Measure the phases of a command: process start, module load, store open,
  query, render.
* [ ] Measure the supervisor cycle separately, since that is what a run's own
  progress waits on.
* [ ] Record the findings in `command-latency.md` beside this plan, with the
  numbers and the method, so a later change can be compared against them.

Done when the cost of a command is attributed rather than guessed at.

## What must not change

* The one-agent-per-task rule. Phase 1 enforces it rather than relaxing it.
* Exactness. A refusal that a person or an agent can act on is not the same as
  a refusal that leaks internals, and the difference is worth keeping.
* The attempt ceiling as the only bound on how many turns a phase gets. Nothing
  else should end a phase early, and three separate fixes in this branch existed
  because something else did.
