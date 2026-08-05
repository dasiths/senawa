# Roads Not Taken

> [!NOTE]
> This is decision history, not a list of current alternatives. Start with the
> [numbered design guides](../README.md), then return here before reviving a
> discarded approach.

## Purpose

The architecture document describes the shape we intend to build. It does not
describe the shapes we tried first, and that omission is expensive. Without a
record, a discarded idea comes back looking new, gets argued for on the same
grounds it was argued for the first time, and costs the same time to reject.

This document holds the discards. Each entry states what the approach was, why it
was attractive, what removed it, and what would justify revisiting it. The last
part matters most: almost nothing here was wrong in principle, and several
entries would be correct again under different constraints.

Nothing here is a live proposal. If an idea returns to the architecture document,
its entry here should be deleted rather than left contradicting it.

## The shape of the run

### The scheduler and `senawa tick`

The first orchestration shape had no long-running process. State advanced one
transition at a time through a `senawa tick` command, called repeatedly by
whatever was watching: a principal agent in a chat session, a cron entry, a CI
step. It was appealing because it made every transition inspectable, kept senawa
stateless between calls, and meant the orchestrator could not hang.

It went because a loop with no owner is not a loop. Something had to decide to
call `tick` again, and in practice that something was a model in a chat session,
which put the control flow inside a context window: non-reproducible, re-reading
the whole run state on every iteration, and gone the moment the session closed.
A run that stopped mid-flight had nobody to restart it and no way to tell that it
had stopped.

The blocking driver replaced it. `senawa work start` validates, snapshots, and
then drives until the run needs a human or finishes. The inspectability that made
`tick` attractive survives as `senawa work step`, which performs exactly one
transition and is kept for debugging and CI rather than as the normal path.

*Revisit if* the driver needs to run somewhere that cannot hold a process open,
such as a serverless runner. The step command is already the primitive that would
be needed; what is missing is the durable scheduler, which is a much larger thing
to own than it first looks.

### The principal agent as the orchestrator

For several iterations the principal agent was the orchestrator. It read the
graph, chose the next phase, dispatched workers, and interpreted gate results.
This is the obvious design if you start from "an agent that can use tools", and
it has a real advantage: the thing deciding what runs next can also explain its
decision in a sentence.

It went because deciding what runs next is a graph question with a deterministic
answer. Answering it with a model costs reproducibility, costs the ability to run
headless, and makes "two runs of one workflow did the same thing" unprovable.
Worse, it puts a model in the position of enforcing its own constraints, which is
the failure the whole backpressure design exists to avoid.

The principal agent became a skill on the outside of the harness. It turns a
vague goal into a valid work request, reads status back in a sentence, explains a
refusal by quoting the sensor that produced it, and drafts the rejection reason
you half-articulated. It does not decide what runs. A live probe confirmed the
boundary holds: a real Copilot session carrying the skill started a run, read the
pause back as an approval request, and approved a phase, without ever reaching
for `bd` even though the run's state lived there. It held once, under one model,
which is evidence and not proof; see
[the principal agent surface](probe-findings.md#the-principal-agent-surface).

*Revisit if* the command surface ever grows a decision that genuinely has no
deterministic answer. So far every candidate has turned out to be a missing
policy field rather than a judgment call.

### Separate commands for the ways a run can stop

Pausing, crashing, and being cancelled were originally three situations with
three recoveries: a resume for a deliberate pause, a repair for a crash, and
nothing at all for cancellation. The distinction felt principled, because the
three really do differ in what was in flight.

It went because the distinction is invisible at the point of use. The person
typing the command does not always know why the run stopped, and if they guess
wrong they get an error instead of progress. Splitting it also meant the
reconciliation logic existed twice.

There is one `senawa work resume`. It clears the pause flag if set, reconciles
anything that was in flight, and starts driving. Whether a human paused the run,
the process was cancelled, or the machine died, the command is the same. A killed
driver recovering through this path is measured in
[a killed driver is recoverable](probe-findings.md#a-killed-driver-is-recoverable).

## Where state lives

### `work.json` as the run's state machine

Phase status, iteration counts, session identifiers, and artifact versions all
lived in a local `work.json`, mirrored into beads for visibility. Local JSON is
fast, easy to read in a terminal, and has no dependency to install.

It went because a mirror is a second source of truth, and second sources of truth
diverge. Moving the state into beads immediately exposed two invariant violations
the local file had been silently tolerating: work was being reopened without its
approval gate being resolved, and a stale frontier query was recreating tasks
that had already closed. The graph refused operations the JSON had been happy to
perform. That is not a cost of the migration; it is the entire argument for it.

`work.json` now holds identity only, written once: workflow, epic, fingerprint,
and input. `cache.json` is a derived projection and is safe to delete at any
moment, which the probe asserts by deleting it mid-run and resuming. The detail
is in
[holding state in the graph](probe-findings.md#holding-state-in-the-graph-and-the-two-bugs-that-found).

*Revisit if* beads becomes a bottleneck at a scale we have not reached. The
answer then is a read cache with explicit invalidation on write, not a second
writable copy.

### Reading the frontier with a plain `bd list`

The frontier query was `bd list --metadata-field senawa_work=<epic>`, which reads
as though it returns the work item's tasks. It does not: it hides closed issues.
Finished tasks vanished from the projection, so a later `plan revise` saw them as
missing and recreated them.

The fix is `--all` plus a filter that drops event beads and anything without a
senawa key. The lesson generalises past this one flag: any listing command in an
external tool may have a default filter that is reasonable for a human at a
terminal and wrong for a program reconstructing state. Every such query in senawa
should be read as "what does this hide?" before it is trusted.

## Sensors and gates

### A fixed sensor taxonomy with inline commands

Sensors were originally one of two kinds, `deterministic` or `inferential`, with
their behaviour inline: `run:` for a shell command, `agent:` and `rubric:` for a
review. This is compact, and for the two kinds that existed it read well.

It went for two reasons. The taxonomy could not grow without changing senawa, so
any new kind of perception meant a release rather than a package. And `run:` made
every deterministic sensor a shell command, which pushed all the interesting
parts — parsing, baselines, scoping to changed files — into ad hoc fields that
accumulated with no schema.

Sensors are now extensions: a declared package or path, with JSON Schema
contracts for config, input, and output. `@senawa/sensor-command` covers what
`run:` used to, and owns its own parser vocabulary. Senawa validates four
boundaries and never parses tool output itself.

### Discovering extensions by scanning

Extension discovery was going to work by scanning `node_modules` for packages
matching a naming convention, the way many plugin systems do. Zero configuration
is a real benefit.

It went because it executes code merely because it is present, which is a supply
chain problem dressed as convenience, and because it makes two identical
checkouts resolve different sensor sets depending on what else happens to be
installed. Extensions are declared in `.senawa/sensors.yaml`. The cost is one
line per extension; the benefit is that the sensor set is a property of the
repository rather than of the machine.

### Gates as three lists

A gate was `requires`, `advisory`, and `must_not_regress`: one list that had to
pass, one that could fail loudly without blocking, and one that had to not get
worse. Each list read clearly on its own.

It went when sensors gained structured `data`. Three lists of sensor identifiers
cannot express "this sensor passed, but read the `regression` field of its
output". Adding a fourth list for that, and a fifth for the next case, is how
configuration languages accrete.

A gate is now a list of checks, each naming a sensor, a JSON Pointer into its
assessment, an operator from a closed set, and an expected value. `advisory` is a
flag on a check rather than a separate list. Counter-metrics need no syntax at
all: a regression check is an ordinary check pointed at `/data/regression`. The
operator set stays closed deliberately, because the moment it opens, gates become
a programming language and the design has lost the property it was built for.

### `human_approval` on a senawa gate

Human approval was a boolean on the gate that measured the artifact. One gate,
one answer, one place to look.

It went because the two things fail differently and recover differently. A sensor
gate is recomputable from readings at any time; a human approval is an event that
has either happened or not and must survive a crash. Collapsing them meant the
approval state was reconstructed rather than recorded.

Approval is now declared on the workflow phase as `approval: human`, and the
driver implements it as a beads gate that sits alongside the sensor gate. A phase
that needs both waits for both, and a driver killed between them recovers
correctly because the beads gate is durable.

### `cost` and `trust` inside extension config

Both fields started inside the extension's `config` block, next to everything
else describing the sensor.

It went because senawa uses them and the extension does not. `cost` drives
cheapest-first ordering, and `trust` decides whether a reading may block work.
Leaving them in extension-owned configuration would have let an extension promote
itself to blocking by writing a field into its own config. They are now sensor
level fields that senawa owns, and `config` is validated against the extension's
schema without senawa needing to understand any of it.

## Instructions

### `.senawa/prompts/<phase>.md`

Phase instructions had three layers rather than two: the role profile, a prompt
file the workflow referenced, and the composed brief. The argument was
separation of concerns, letting a workflow author tune what a phase asks for
without touching the role.

It went because the middle layer is not repository configuration. The phase
scaffolding has to stay in step with the submission tool and the artifact schema
that senawa generates, so a file the repository can edit is a file that can
silently break a phase. It also gave `senawa doctor` a third reference to
validate while providing nothing the role profile could not already carry.

Scaffolding lives in senawa's code. Persona and model configuration live in
`.github/agents/<role>.agent.md`. `senawa phase brief` composes the two with the
situational parts at dispatch.

That profile location was superseded. Current repository worker profiles live
under `.senawa/agents/<role>.senawa.md`; the rejected extra prompt layer remains
rejected.

*Revisit if* the same workflow needs to run with materially different phase
framing in different repositories. The current answer is that this is what role
profiles are for, and no case has yet needed more.

### Instructions as enforcement

Early briefs told workers not to edit sensor configuration, test files, or
hooks, and the design initially treated that as sufficient. Agents follow
instructions most of the time, and the brief is right there.

Most of the time is the problem. One probe observed a worker ignoring its brief's
instruction to submit through `senawa task done` entirely, editing the file and
ending its turn. Another observed a model explaining a denial by inventing a git
pre-commit hook that did not exist. Neither was adversarial; both were ordinary.

The frozen set is enforced at the `preToolUse` boundary, and the orchestrator's
own gate evaluation after a worker's turn is authoritative regardless of whether
the worker declared itself finished. Compliance is reported in the run report and
never load bearing.

### Worker-declared completion

The first task loop let a worker close its own bead when it believed the work was
done, with the gate as a check afterwards. This is the natural shape if you think
of the gate as validation.

It went because it makes the gate advisory in practice. If the bead is already
closed, a failing gate has to reopen it, and a loop that can undo its own
refusals is not backpressure. `senawa task done` is a completion *request* that
the harness may refuse, and the refusal arrives with the readings and the
remaining attempt count. The worker never holds the authority it would need to
game.

## Interface and reporting

### `bd dep tree --format=mermaid` for the run report

The report's decomposition diagram looked like a solved problem: beads renders a
dependency tree as Mermaid already.

It went on inspection. The command follows dependency edges only, so an epic with
two children and no dependencies between them renders as a single node. The
diagram it produces is not wrong, it just answers a different question than the
report is asking. The report builds its diagram from the graph directly,
including parent-child edges.

### A TUI as the primary interface

A full-screen terminal interface was the assumed shape for watching a run: panes
for the phase graph, live worker output, and pending approvals.

It is deferred rather than abandoned, which is the one entry in this document
that may well come back. It needs the driver to expose an event stream and a
command channel, both of which are cheap given an append-only journal with a
monotonic `seq` and a single writer. The reason to wait is that it should be
built against a measured complaint rather than a guess. Streamed stdout, inline
controls, and `senawa work show` from a second terminal may be enough; if they
are not, the missing thing will be specific.

*Revisit after* a real work item has been run start to finish by someone who is
not the author.

## Related

* [multi-agent-orchestration.md](multi-agent-orchestration.md) — the design as it
  currently stands
* [probe-findings.md](probe-findings.md) — the measurements that forced several of
  these changes
