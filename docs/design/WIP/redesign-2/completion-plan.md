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

The acceptance test passes. `run_fb73180e` went from a one-line request to a
playable tic-tac-toe game without a person touching the CLI for any decision:
four questions and one budget grant, all answered in the browser. Its three
phases closed, its own seventeen tests pass, and it plays to `X wins`.

It also says when it is done, which it did not before: `senawa status` now
reports that every phase has closed. Ending a run stays a person's decision, so
the mode is unchanged.

Sixty-three defects found by watching live runs are recorded as F-001 to F-063.
Seven of them stopped every run dead: a live clock made a command conflict with
itself, a tool declaration named a schema it did not carry, a fan-out could not
wait for its own members, a retried member claimed a sibling's ordinal, a
refused gate left a candidate that locked out its own retry, a granted allowance
never restarted the work that asked for it, and a finished run re-ran a phase it
had already closed until every command conflicted with its own history.

The portal is done. Nine tabs are four: `Workflow`, `Record`, `Artifacts` and
`Agents`. The workflow reads as a workflow — nested, named, with every need, the
agent on the work, where that work is happening, and the controls for redirecting
it rendered on the node they belong to. Forty-two browser tests hold that shape.

What is left is two deliberate decisions rather than two omissions: the attempt
lifecycle in Phase 1, whose declared protocol payload cannot say which task an
attempt belongs to, and the scheduled retry in F-061, which changes how the
service decides when to wake.

[Open decisions](open-decisions.md) states every remaining item as the question
it actually is, with what the evidence says and what each answer costs.
[Limits](limits.md) records every bound the system enforces, who feels it, and
which handful of them cost an agent a turn.

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
* [x] One run, start to finish, with no fix applied in the middle.
  `run_fb73180e` closed all three phases, four questions and one budget grant
  were answered from the browser and nowhere else, and the workspace it left
  behind runs: `node scripts/check.mjs` passes seventeen tests, and `play.mjs`
  plays to `X wins`.
* [x] Say when a run is done. F-062. The overview counts the phases that have
  closed, and `senawa status` says `every phase has closed: this run has
  finished its work`. Ending the run stays a person's decision.

Two more defects stood in the way and are now fixed. F-059: a gate that refused
left a candidate behind, so the retry it started could never hand its work in.
F-060: a granted allowance never restarted the work that asked for it, because
the planner excludes a command that has escalated and the answered request stayed
in the runner's snapshot for ever. Both were confirmed on the live run: the
escalated operation restarted the moment the allowance was granted, and the
implement phase gated, closed, and published.

Done when the game exists, runs, and the run reached its end without a person
using the CLI.

What stands between here and that: the agents ask three or four questions a run,
and the one thing with no command at all is `grant-allowance`, so a run that
exhausts a budget can only be freed from the portal.

## Phase 3: clear the debts the run exposed

These are recorded and unfixed. None blocks phase 2, and all of them cost a
person something real.

* [ ] A run does not survive its supervisor stopping. F-061, now diagnosed to
  the end: everything under the supervisor recovers, and there is a test for it.
  The supervisor is wake-driven with no timer, so a cycle blocked by a lease the
  dead owner still held reports no work, stops the pump, and nothing revisits the
  run when that lease expires a minute later. The remedy is a scheduled retry at
  the expiry the authority already knows, which is a change to how the service
  decides when to wake and should be made on purpose.
* [x] A finished run drove itself into a conflict with its own history. The
  driver re-offered delivered completions and re-ran a phase it had already
  closed, so every cycle ended in `command-id-conflict`. F-063. Proven on the
  live record rather than in the harness, which does not reach the conflict;
  reproducing it there is still owed.
* [x] Say nothing where a person can read it when a run stops being driven. The
  throw that ended F-063 reached stderr and nowhere else, and `supervisor_logs`
  recorded only the service starting and stopping. A failed drive is now an
  `error` log against the run, and a workflow that will not compile names the
  file, the pointer and the fault rather than counting diagnostics.
* [x] Tests that only hold when the machine is quiet. Three process-sensor cases
  failed under the parallel suite and passed alone, repeatedly. Every one was an
  instantaneous assertion about asynchronous cleanup, or a two-second budget that
  killed the process tree before it had finished starting. Reaping is now waited
  for rather than sampled, and the budgets in tests that are not about budgets
  have headroom. Two full suites in a row are green.
* [ ] `waits for the members still working whichever one finishes first` takes
  seventeen seconds alone, because every `advance` opens and verifies the record.
  That is the latency of Phase 5 showing up as a test that is one slow machine
  away from timing out.
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
* [x] The graph becomes the workflow. The tab is `Workflow`, the default view
  is the nested outline rather than the table, and `Table` is gone: it was three
  renderings of eight rows defaulting to the one that reads least like a
  workflow. A row now reads `phase research closed` instead of a `Kind`,
  `Generation` and `Lifecycle` column, and a need appears as a button on the
  node it blocks. The thirty-four browser tests were moved with it and pass.
* [x] Fold Agents, Delivery and Workspaces into the selection the workflow view
  already has. Where a task's work is happening and who is doing it now render
  inside the task, and the delivery and integration records moved to `Record`,
  which is where a run's history already lives. Seven tabs are now five.
  Redirecting an agent, and accepting work it could not finish, are controls on
  the node rather than on a list that named the work by identity.
* [x] Retire the Human needs tab. Every need renders on the node it blocks with
  its action inline, and the queue survives in the rail, so the tab was
  rendering the same needs a second time. That second copy is the one the live
  run caught disagreeing with the first about whether a need was actionable.
* [x] Retire the Amendments tab. An amendment's source, impact and diff are
  already the detail panel of the need that carries it, which is where a person
  meets one; the tab was a second rendering of the same records as raw JSON,
  reachable only by knowing to look. Five tabs are now four.
* [x] Merge Overview and Activity into one `Record` tab. What a run is and what
  has happened to it are the same question asked at two lengths, and splitting
  them made the first tab seven revision counters and the second an
  undifferentiated log. Nine tabs are now seven, and `Workflow` leads.

Two things the live runs added to this. The attention rail can hold a button
that cannot be scrolled to, so the only copy of a control was unreachable. And
the same need renders twice with the two copies disagreeing about whether it is
actionable while data reloads.

## Phase 5: find out why the commands are slow

Every `senawa status` costs about a third of a second of process start before it
reads anything, and driving a run from the terminal means running it repeatedly.
Nothing has measured where that goes.

* [x] Measure the phases of a command: process start, module load, store open,
  query, render. `senawa status` was 4166 ms, of which opening the record was
  2470 ms and verifying it 1539 ms.
* [x] Measure the supervisor cycle separately, since that is what a run's own
  progress waits on. The median gap between supervisor receipts on a working run
  is 126 ms; the long gaps are agents thinking. The four seconds is the cost of
  starting a command, not of running the system.
* [x] Record the findings in `command-latency.md` beside this plan, with the
  numbers and the method, so a later change can be compared against them. One
  fix shipped from it: opening a record parsed its canonical state twice, which
  was 32% of the cost, measured A/B on the same record.

Done when the cost of a command is attributed rather than guessed at.

The measurement changed what the answer should be. Making verification faster
helps a process that verifies and does nothing for a service that already did,
so the change worth making is that a read-only command asks the running service
rather than opening the record itself. That is written up in `command-latency.md`
and is not done.

## What must not change

* The one-agent-per-task rule. Phase 1 enforces it rather than relaxing it.
* Exactness. A refusal that a person or an agent can act on is not the same as
  a refusal that leaks internals, and the difference is worth keeping.
* The attempt ceiling as the only bound on how many turns a phase gets. Nothing
  else should end a phase early, and three separate fixes in this branch existed
  because something else did.
