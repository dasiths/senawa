# Portal simplification

The portal has feature parity with the authority and almost no legibility. This
is a plan to keep everything it can do and change what it shows first.

Everything below was measured in a browser against a live run
(`repository_rpi-workflow`), not read off the source.

## What is actually wrong

### The Activity view is 23,903 characters and 168 raw digests

Every other view measures in the hundreds. Activity renders every event fully
expanded, and each one repeats `apiVersion`, `repositoryId`, `runId`, its
`eventId`, and a `payloadDigest` nobody reads:

```
1 command-queued 2026-08-19T18:50:27.621Z
Events detail
$ {10}
apiVersion        senawa.dev/protocol/v1
commandId         command_instantiate-b443f9de4a1b85fe72a437b7b471dfe2
cursor            1
eventId           stream-event-instantiate-b443f9de4a1b85fe72a437b7b471dfe2-1
eventType         command-queued
occurredAt        2026-08-19T18:50:27.621Z
payload {1}
payloadDigest     17ab365136af46de09c8ebe2551731c671e794435203d81a7a1b2bd112ab170c
repositoryId      repository_rpi-workflow
runId             run_b8279f0595b426ed49d57de542bf23cc
```

Three of those lines are the same for every event in the run. One is the line a
person wants: *what happened, and when*.

### The Agents view answers none of the questions it is for

Measured columns: `Persona`, `Working on`, `Attempt`, `Model`, `State`,
`Session`, `Last refusal`. On a two-agent run it renders six rows, because it
lists dispatch *attempts* rather than agents, so `researcher` appears four times.
And:

* `Working on` shows `task_e30bb4a5f7e1cba275d9944df407bf191108eab21c265490a13c3196597c7c12`
  where the answer is `research`.
* `Model` shows `unknown (route 0)` where the answer is `claude-haiku-4.5`.
* `Session` shows a 64-hex dispatch id, which identifies nothing to a person.
* Two rows differ only in `State` (`working` versus `finished`) and are otherwise
  identical, so the table appears to be repeating itself.
* Below the table sit five buttons reading `Steer researcher`, `Steer
  researcher`, `Steer planner`, `Steer researcher`, `Steer planner`. Nothing
  says which is which.

### The Overview leads with seven revision counters

Its entire content is 218 characters, and the terms are `Phases`, `Tasks`,
`Criteria`, `Human needs`, `Active effects`, `Uncertain effects`, then
`contextRevision`, `graphRevision`, `humanRevision`, `lifecycleRevision`,
`portalRevision`, `runnerRevision`, `transcriptRevision`, `workflowCursor`.

Eight of fourteen are internal bookkeeping. None of them is *what is this run
doing and does it need me*.

### Four of nine tabs are empty on a healthy run

Measured row counts: Amendments 0, Workspaces 0, Human needs 0, Artifacts 1.
Amendments and Workspaces are empty for the entire life of most runs, and both
occupy the same visual weight as Agents.

### The same fact is stated three times in the chrome

The banner shows a `Needs 0` button. The status strip below shows
`0 human needs`. A third element repeats `live; current; 0 pending; 0 human
needs`. The right rail then shows `Attention → Pending receipts → No uncertain
commands` permanently, whether or not anything is wrong.

### The graph table mixes four node kinds and internal vocabulary

Columns are `Kind`, `Title`, `Generation`, `Lifecycle`, `Needs`, `Evidence`.
Rows interleave `workflow`, `phase`, `task`, and `criterion`. Two rows are both
titled `phase-executor` and cannot be told apart. `Generation` is 1 for every
row in every run that has never been amended, which is nearly all of them.

Above it sit three sub-tabs — `Diagram`, `Table`, `Tree` — three renderings of
the same eight rows, defaulting to the least visual one.

## What the portal is for

Three questions, in this order:

1. **Does it need me?** A question to answer, an approval to give, an allowance
   to grant.
2. **What is happening?** Which phase, which agent, on what, how long.
3. **What did it produce, and why should I believe it?** Outputs, evidence, and
   the record behind them.

Everything else — revisions, digests, cursors, generations — is the *proof*
layer. It has to remain reachable, because being able to check is the product.
It does not have to be first.

## The vocabulary to move to

The per-tab analysis further down decides the structure. This section decides how
things are *rendered* once they are in it.

### Icons carry the kinds

The vocabulary is small and stable enough to be visual, which removes a `Kind`
column and most of the internal words:

| Concept | Mark | Replaces |
| --- | --- | --- |
| Workflow | ◇ outline diamond | `kind: workflow` |
| Phase | ◆ filled diamond | `kind: phase` |
| Agent | ● dot in persona colour | `kind: task` plus persona column |
| Fan-out member | ●●● | a row per member with no grouping |
| Gate | ▣ | `Evidence` column |
| Question | ? | `kind: question` |
| Approval | ✓? | `kind: approval` |
| Artifact | ▤ | `Artifacts` tab |

State becomes colour and motion rather than a word: waiting is grey and still,
working is blue and pulsing, closed is green, refused is amber, failed is red.
`State`, `Lifecycle`, and half of `Attempt` stop needing columns.

### Names, not identities

Every identity rendered in a cell today has a name available in the same record:

| Shown now | Show instead | Reveal on |
| --- | --- | --- |
| `task_e30bb4a5…` | `research` | hover, and in Record |
| `dispatch_7d1ad146…` | `attempt 2` | expand the agent |
| `unknown (route 0)` | `claude-haiku-4.5` | — |
| `e8b8708138ab` graph | nothing | Record |
| 64-hex payload digests | nothing | Record |

Rule: **a digest is never the primary rendering of anything**. It is what you
open a row to check.

### Attempts fold into the agent

An agent is one row. Its attempts are a strip inside it:

```
● planner · claude-haiku-4.5                    working · 2m
  ① asked "what shape is the plan output?" → answered
  ② working
```

That is the same information as four table rows, in a form where the question it
asked is legible instead of being a `Last refusal` cell reading `nothing
refused`.

### Empty means absent

Amendments and Workspaces appear only when the run has one. An empty section is
noise that trains people to skip the region it occupies.

### One status line

Connection, freshness, and pending commands collapse to a single indicator that
is silent when healthy and explicit when not. The screen-reader duplicate
becomes an `aria-live` region on the same element rather than a second visible
copy.

## The escalation path, component by component

Everything below was exercised in a browser against a live pending question, by
clicking, typing, and pressing keys — not by reading the markup.

### The same question is rendered three times and only one copy can answer it

A single pending question appears simultaneously in:

1. the alert banner above the workspace, with **Answer this question**;
2. the **Human needs** view, with only **Review exact record**;
3. the right rail's **Human queue**, with only **Review exact record**.

The view named for the job cannot do the job. Someone who clicks `Human needs`
because they want to answer a need finds a card with one button that sounds like
an audit action.

It is worse than that: **Review exact record opens the same dialog as Answer this
question.** Identical content, same textarea, same `Submit exact answer`. Two
names, three placements, one behaviour, and the name that sounds read-only is the
one on two of the three copies.

### The primary button can be covered by the attention rail

Measured once at 1052×578 with the rail open: the button's centre hit-tests to
`div.rail-heading` inside `aside.right-rail`, which is `position: fixed;
z-index: 120`. Playwright retried the click for ten seconds and never landed it.

The cause is structural rather than a specific breakpoint: the alert banner spans
the full window and does not reserve the rail's width, and the rail switches
between `fixed` and `sticky` depending on width. At 1600px the alert still
overlaps the rail (`alert.right` 1585 against `rail.left` 1265) and happens to
remain clickable. Whether the most important button in the product is reachable
is therefore incidental.

### The Needs badge was inert

Clicking `Needs 1` in the banner did nothing: it called `toggleRightRail(true)`
on a rail that was already open, so the URL was unchanged and no view was
selected. It looked exactly like the affordance that should take you to the thing
needing you. Fixed in this branch: it now navigates to the needs view when there
is something to see.

### Three minutes old is "Overdue"

The question was flagged `Overdue` in red at three minutes. For a workflow whose
premise is that a person may be away, an overdue marker that is always on carries
no information.

### The answer dialog: what is right

Worth keeping, and worth saying because it is the part that works:

* A native `<dialog>`, genuinely modal (`:modal` is true).
* `Escape` closes it and **focus returns to the trigger**.
* The textarea is `required`, so an empty submit is refused by the browser.
* Submitting shows `answer-question completed` and the need clears.

### The answer dialog: what is wrong

| Observed | Why it matters |
| --- | --- |
| Focus lands on `summary`, the disclosure triangle | The person came to type. They must Tab past a JSON tree to reach the field |
| First line is "This records an immutable answer and requires a fresh dispatch boundary" | "Fresh dispatch boundary" is internal vocabulary in the sentence a person reads before answering |
| `Exact review source $ {2} need {11} question {7}` | A raw JSON tree with key counts, above the answer field |
| Never says who asked or which phase | `namesWhoAsked: false`, `showsPhase: false`. You answer without knowing which agent is blocked or what it is doing |
| No length bound or counter | `maxLength: null` |
| Empty submit gives only "Please fill out this field." | The browser default; no in-app guidance |

On the last two: a 9,000-character answer submitted cleanly and was recorded as
`answer-question completed`. There is no counter, no bound, and no confirmation
step — for a value the dialog itself calls immutable.

### The steer dialog already solves most of this

The same codebase, one view away:

* Title names the target: **Redirect researcher**.
* Consequence in plain words: "This is recorded with your name and the time
  before anything tries to deliver it."
* The delivery select reads **When this turn ends / During this turn / Stop this
  turn and start again** — policy expressed as choices a person can weigh.
* The action reads **Send to the agent**, not "Submit exact steering".

It shares the two structural faults — focus on `summary`, and a raw
`dispatchId`/`taskId` tree above the field — but its *language* is the model the
answer dialog should copy. Nothing needs inventing.

### Chrome duplication measured

* Three renderings of the same fact: `Needs 1` badge, `1 human needs` in the
  status strip, and `live; current; 0 pending; 1 human needs`.
* Two controls to dismiss one rail: `Collapse attention rail` (an aria-labelled
  `›`) and `Close` (**no accessible name at all** — `aria-label` and `title` are
  both null, so it is announced from its text alone and was unreachable by role
  query).
* Plus `Resize attention rail` and `Resize navigation rail` separators: three
  mechanisms per rail.
* Tabs use roving `tabindex`, so only the selected tab is in the tab order. That
  is correct for a tablist, and it means the nine views cost one Tab stop — the
  one piece of the chrome that is already efficient.

### What the escalation path should be

One rule: **the question appears once, where you are, with the answer box in it.**

```
┌──────────────────────────────────────────────────────────┐
│ ◆ research · ● researcher is waiting on you      4m      │
│                                                          │
│ "Which Node.js version should this target?"              │
│                                                          │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ your answer                                          │ │
│ └──────────────────────────────────────────────────────┘ │
│ Nobody can change this once sent.        [ Send ]  ▸ why │
└──────────────────────────────────────────────────────────┘
```

* The phase and the agent are named, because that is what the question is
  *about*.
* The answer field is present, not behind a button. Answering a question is not
  a modal decision; it is a reply.
* The immutability warning is one short sentence in words a person owns.
* `▸ why` opens today's exact-review tree, unchanged, for anyone who wants it.
* `Review exact record` stops being a second door to the same dialog and becomes
  what its name says.

Concretely, in order:

1. **Focus the textarea, not the disclosure.** One line, fixes the worst of it.
2. **Name the agent and phase in the dialog title**, copying the steer dialog.
3. **Rewrite the immutability sentence** without "fresh dispatch boundary".
4. **Make the Needs badge navigate** to the needs view, or remove it.
5. **Give the Human needs view and the rail card a real answer action** — or
   inline the answer box and delete the modal.
6. **Bound the answer** with a counter, matching the authority's limit.
7. **Reserve the rail width in the alert**, or move the alert inside the main
   column so it cannot be covered.
8. **Collapse the three rail controls to one**, and give it a name.
9. **Make "Overdue" mean something** — a threshold the workflow author sets, or
   nothing at all.

Items 1 through 4 are each a few lines and independently shippable.

## Every tab, what it really is, and where it goes

Nine tabs is not nine subjects. It is four subjects, one of them shown four
times.

### The nine, measured

| Tab | What it actually shows | Keyed by | Rows on a live run |
| --- | --- | --- | --- |
| Overview | six counts and eight revision numbers | the run | — (218 chars) |
| Graph | workflow / phase / task / criterion nodes | the tree | 8 |
| Delivery | `Kind · Phase or task · Attempt · State · Metadata` | the tree | 7 |
| Activity | every durable event, fully expanded | the run | — (23,903 chars) |
| Artifacts | `Artifact · Type · Size · Sensitivity · Digest` | a phase output | 1 |
| Human needs | questions, approvals, escalations | a task | 0–1 |
| Amendments | proposals, source, impact, diff | the tree | 0 |
| Workspaces | `Task · Mode · State · Completion · Result` and cohorts | a task | 0 |
| Agents | `Persona · Working on · Attempt · Model · State · Session` | a dispatch of a task | 6 |

Read the `Keyed by` column. **Graph, Delivery, Workspaces, Agents, and Artifacts
are all keyed by a node in the same tree.** They are five renderings of one
structure, split apart by which columns someone wanted to see at the time.

### Graph is not a graph, it is the workflow

`Graph` is the internal word. What the tab shows is the thing the author wrote in
`workflow.yaml`: phases, the work under them, and what each must satisfy. It
should be called **Workflow**, and `Kind` should stop being a column because a
phase and a criterion should not look alike enough to need one.

The evidence that they currently do: clicking the row for the `research` phase
selects `research-produced`, a criterion, because both are rows in one flat table
and the criterion sorts first. The two are different kinds of thing and the table
renders them identically.

### The fold is already half-built

Selecting a node in Graph today produces exactly the right shape:

```
research-produced
[ Copy identity ] [ Focus in diagram ] [ Review linked human need ]
Identity      criterion_8d36921e30caaea…
Source        /phases/research/executor/completionPolicy/criteria/research-produced
Superseded by No successor
──────────────
Agent output   [ Scope to whole run ] [ Copy output ] [ Download output ]
```

A heading, a **toolbar of actions on the selection**, a detail list, and a
transcript panel. That is the docking point for everything else. Agents,
Delivery, Workspaces and Artifacts are not separate views; they are *more panels
for the same selection*.

(Two bugs visible in that same capture: the detail panel says a criterion is
selected while the transcript panel says `No node selected`, and `Review linked
human need` is disabled with no explanation of what would enable it.)

### What each tab becomes

**Overview → the Workflow view's header, plus Record.**
Its six counts are summaries of the tree that the tree itself shows better. Its
eight revision numbers are proof-layer material. Nothing is lost; nothing needs
its own tab.

**Graph → Workflow.** The one structural view. Phases as a vertical list; the
work under each phase nested; criteria shown as a phase's exit conditions rather
than as sibling rows.

**Delivery → attempt state on each node.** `Attempt` and `State` become the badge
on a phase row. `Metadata` becomes part of the selection detail. The dataflow and
task-frontier revisions go to Record.

**Agents → into the phase row, and this is the strongest case.** An agent is not
a separate population; it is *what is executing a phase right now*. Steering it
from a table that names its task as `task_e30bb4a5…` is worse in every way than
steering it from the phase it is working on, where the phase's name, its attempt,
its question and its output are already on screen. Fold the persona, model, and
state into the phase row, and put `Steer` and `Override` in the selection
toolbar that already exists.

**Workspaces → a panel on a task's selection, and its conflicts become needs.**
Git mode, state, completion, and result are *about one task*. The
conflict-and-rework half is not a report at all: `integration-conflict` and
`integration-rework` are human need kinds, so they belong in the queue with the
questions.

**Artifacts → a panel on a phase's selection, and a run-level list.** What a
phase produced belongs with the phase. The flat list stays useful for "show me
everything this run made", so it survives as a section of the Workflow view's
footer rather than a tab.

**Human needs → gone as a tab; the need appears on the node it blocks.** Covered
in the escalation section above. A question about the research phase belongs on
the research phase.

**Activity → Record.** Renamed, collapsed to one line per event, and joined by
receipts, revisions, and the exact-record trees.

**Amendments → a need, not a tab.** See below: `amendment-decision` and
`amendment-application` are two of the eight `PortalHumanNeedKind` values. They
belong wherever the other six appear.

### An amendment is a human need, and so are five other things

The authority already says this. `PortalHumanNeedKind` is:

```
question              an agent asked something
candidate-approval    a phase wants a person to approve it
amendment-decision    approve or reject a proposed change to the workflow
amendment-application apply an amendment that was approved
escalation            a budget or allowance ceiling was reached
integration-conflict  a worktree conflict needs a person
integration-rework    work needs redoing after integration
ending-uncertain      ending the run needs a person
```

Eight kinds, one type, one queue, and each need carries its own
`allowedCommands` — the live question carried `["answer-question"]`. The data
model has already decided that these are one thing and that a surface rendering
them can be generic.

The UI disagrees with its own model. It puts:

* `question`, `candidate-approval`, `escalation` in **Human needs**;
* `amendment-decision` and `amendment-application` in **Amendments**;
* `integration-conflict` and `integration-rework` in **Workspaces**.

So three of the eight ways a run can need you are somewhere other than the place
called "human needs", and two of those places are tabs that are empty on nearly
every run — meaning a person learns to ignore the region where a blocking
decision will eventually appear.

`Amendments` and `Workspaces` are not subjects. They are *renderings of two
need kinds each*, plus a detail panel that belongs on the node.

### The result: four tabs

```
  ◆ Workflow    the tree, its agents, its state, what it needs, what it produced
  ▤ Record      events and receipts, as a table, detail on click
  ▦ Artifacts   what the run made, as a table, content on click
  ● Agents      who is working, as a list, the same detail surface as a node
```

An earlier draft of this document argued for two. That was wrong, and the reason
is worth keeping: `Artifacts` and `Agents` are not renderings of the tree, they
are the two ways a person arrives at the tree from the other direction. "Show me
everything this run made" and "show me who is working right now" are questions
you ask *before* you know which node you want, so they cannot be panels that only
exist once you have selected one.

What made the earlier draft look right is that the *detail* for all four is the
same surface. Selecting an agent and selecting the node it is working are the
same act, and must open the same thing. Four doors, one room.

`Amendments` disappears as a tab: an amendment decision is a need, so it appears
where every other need appears — on the node it concerns, and in the one queue.
Its source, impact, and diff become the detail panel of that need, which is
exactly what they already are.

`Workspaces` disappears the same way: a conflict is a need on the task that
conflicted, and the git state is a panel on that task.

`Human needs` disappears as a tab because a need is never *about* nothing — it
is about a phase, a task, or the run — and it belongs on that thing. The queue
survives in the rail, as the list of everything currently waiting on you, which
is the one legitimate cross-cutting view.

### Sub-structure inside Workflow

The one view that carries the load needs internal shape. Three bands, top to
bottom:

```
┌─ rpi ───────────────────────────────── running · 6m ──┐
│  ● researcher is waiting on you                        │  ← only when true
├────────────────────────────────────────────────────────┤
│ ◆ research    ✓ closed        3 questions · 1 output   │
│ ◆ plan        ● working       planner · haiku · 2m   ▸ │
│ ◆ implement   ○ waiting       fans out over plan.tasks │
├────────────────────────────────────────────────────────┤
│ ▸ What this run produced                    1 artifact │
└────────────────────────────────────────────────────────┘
```

Expanding a phase (`▸`) reveals, in this order:

1. **Who is on it** — persona, model, attempt, elapsed, with `Steer` and
   `Override` right there.
2. **What it is waiting for** — the question with its answer box, or the gate and
   its last reading.
3. **What it produced** — outputs with size and sensitivity, and its workspace if
   it has one.
4. **Its exit conditions** — the criteria, which is where `criterion` nodes stop
   being siblings of phases.
5. **`▸ exact record`** — identities, digests, source pointers, superseded-by.

A fan-out phase expands to its members, each collapsible the same way, which is
the case the current flat table handles worst.

### Retire the three display modes

`Diagram | Table | Tree` are three renderings of eight rows, defaulting to the
one that reads least like a workflow. The nested phase list *is* the tree. Keep
the diagram as a toggle for people who want the picture; drop Table.

### What this removes

* Nine tabs to three, two of which are usually one.
* Four views of one tree to one.
* `Kind`, `Generation`, and `Lifecycle` columns disappear into icons, state
  colour, and the exact record.
* The `Working on` column disappears entirely: an agent is rendered inside the
  thing it is working on.

## Order of work

Grouped so that each step is shippable and the risky one comes last.

**Already done** (in this branch):

* Focus the answer field rather than the exact-record disclosure.
* "The agent reads this as written, and nobody can change it once sent." in
  place of "requires a fresh dispatch boundary".
* The `Needs` badge navigates instead of re-opening an open rail.
* The answer field is bounded at 4,096 characters with a live counter, matching
  the limit the authority now enforces. See F-032: without it a long answer was
  recorded, reported as accepted, and then stranded the run permanently.

**Content, no layout change.** Each independently shippable:

1. **Names over identities.** `research` not `task_e30bb4a5…`, `claude-haiku-4.5`
   not `unknown (route 0)`. Fixes the Agents table and half the Workflow table
   on its own.
2. **Name the agent and phase in every dialog title**, copying the steer dialog.
3. **Collapse Activity** to one line per event, expandable. Removes 23,000
   characters and 168 digests from the default view.
4. **Fold attempts into the agent** that made them. Six rows become two.

**Structure.** Needs the browser tests rewritten:

5. **Rename Graph to Workflow** and nest the tree: phases, their work, their
   criteria as exit conditions rather than sibling rows.
6. **Fold Agents, Delivery, and Workspaces into the selection** that Workflow
   already has, and put `Steer` and `Override` in its existing toolbar.
7. **Fold every need onto the node it blocks**, with its action inline. This is
   one generic surface driven by `kind` and `allowedCommands`, not eight
   special cases, and it retires the Amendments tab and the conflict half of
   Workspaces along with Human needs.
8. **Merge Overview and Activity into Record.**

**Polish.** Once rows are short enough for a mark to matter:

9. Icons for the kinds, state as colour and motion.
10. One rail control with a name, one status line, `Overdue` given a real
    threshold or removed.
11. Reserve the rail width in the alert so the primary button cannot be covered.

Steps 1 through 4 are content-only. Step 5 is where the thirty-four browser tests
become the safety net rather than the obstacle: rewrite them against the nested
structure first, then move the views under them.

## What must not be lost

* Every value visible today stays reachable within one disclosure.
* `Review exact record` stays on every human need, and the exact digests behind
  a decision stay one click away. Being able to check is the product; the change
  is only that checking is a deliberate act rather than the default view.
* Read-only sessions stay visibly read-only.
* The command-submission feedback path — `submitting` → `completed` → the need
  clearing — is the one interaction that already works well and reads clearly.
  It is the model for the rest.

## What a second pass added

The sections above were written from measuring the portal. This one is written
from using it to drive a live run to completion, which surfaced things reading
the screen did not.

### A task with no name cannot be steered

The workflow tree renders two rows both titled `phase-executor`. On a fan-out it
renders four. The identity behind each is a 64-hex task id, so telling them apart
means reading digests.

This is not a cosmetic problem, because the primary destructive action on that
row is `Steer`. Redirecting an agent is a decision about *one* piece of work, and
the surface does not say which piece of work you have selected. The measured
Agents table has the same fault from the other side: five buttons reading `Steer
researcher`, `Steer researcher`, `Steer planner` and nothing to choose between
them.

A task needs a name drawn from what it does — `research the request`, `implement
the CLI entry point` — with the identity available on hover and in the record. A
fan-out member's name comes from the plan item it was materialised from, which is
already in the record.

### The escalation belongs to the node that raised it

An allowance escalation is raised by an operation, which belongs to a dispatch,
which belongs to a task. Rendering escalations as a flat queue loses all of that,
so a person granting one cannot see what asked, what it was doing, or how much it
has already spent.

It is the same rule as every other need: the escalation appears on the node that
raised it, and the queue in the rail is the cross-cutting view.

### Revision, cursor and graph id are not a landing page

Measured on the current home screen: `Mode`, `Graph`, `Cursor` are three of the
first four facts, and two of them are digests. The header should carry what the
run *is* and what it is *doing*. The proof layer is a disclosure.

### Events and artifacts want tables, not expansions

Activity renders every event fully expanded, which is how it reaches 23,903
characters before a person has done anything. The fix is not shorter events; it
is a table with one row per event, and the detail fetched when a row is opened.
The same is true of artifacts: name, size, sensitivity and phase in the row, and
the content loaded on click rather than previewed for all of them up front.

This is a load-time property as much as a legibility one. A tab that renders
everything it might need is a tab that is slow every time, for a detail that is
read once in twenty.

### Answering should feel like answering the agent

The strongest signal from driving the example: answering a question through a
modal form feels like filing a ticket about an agent, and answering it in a
terminal feels like talking to one.

What a person wants on screen when they answer is what the agent has been doing,
in its own words, with the question at the bottom, and a place to type directly
underneath it. The same is true of steering: you are interrupting something, and
you should be able to see what you are interrupting.

**This needs something we do not currently record.** `agent_transcript_lines`
holds one stream, `system`, and its content is:

```text
session started
tool senawa_output_schema success
tool senawa_list_workspace failure: workspace-list-refused: ...
tool submit_question success
session paused: the agent asked a question and is waiting for an answer
```

Sixteen lines for a whole run, none of them the agent's own words. The agent's
prose exists in exactly one place — the `prompt` field of a question — because
that is the only thing it says that we keep.

So the terminal is not a rendering change. It requires capturing an assistant
stream alongside the system one: what the agent said as it worked, not only which
tools it called. Without that, a terminal-styled pane is a system log in a
monospace font, which is worse than the table it replaced because it implies a
conversation that is not there.

### The four-tab shape, and why the detail is shared

`Workflow`, `Record`, `Artifacts`, `Agents`. Four ways in, one detail surface:

* **Workflow** — the tree. Where you go when you know the shape of the work.
* **Agents** — who is working right now. Where you go when you do not.
* **Artifacts** — what the run made. Where you go when you want the output.
* **Record** — what happened. Where you go to check.

Selecting an agent in `Agents` and selecting its node in `Workflow` open the same
panel, because they are the same subject approached from two directions. That
panel carries, in order: what the agent is doing now, the question it is waiting
on with a place to answer, the answers already given, what it produced, and the
controls to steer or override it.

### The tree cannot show a fan-out, so Workflow needs both readings

A tree renders the four `implement` members as four sibling rows. That is a true
statement about containment and a misleading one about execution: it looks like a
sequence when it is four parallel branches off one plan, and it says nothing
about why there are four rather than three.

The fact the tree loses is the one a person most often wants when a run stalls —
*what is this waiting for?* Nesting cannot express it, because the dependency is
not a parent-child relationship. `write the command-line entry point` is waiting
on a sibling's output, and the tree draws sibling as "unrelated".

So `Workflow` carries a segmented control, `Tree` and `Graph`, over one selection:

* **Tree** — what contains what. Compact, scannable, good for a long run.
* **Graph** — what waited for what. Shows the fan-out, the join, and how far the
  work has actually travelled.

Three properties make the graph affordable rather than a second thing to
maintain:

* **The artifact is the edge.** `plan · 4 tasks · fans out` sits on the line
  between producer and consumers, so the fan-out has a visible cause rather than
  appearing as unexplained branching.
* **Carried edges are solid, uncarried ones dashed.** Progress is legible without
  reading a single node.
* **Closed phases fold**, and an edge whose endpoint is folded away reattaches to
  the group that swallowed it. Live work gets the space. This is what keeps a
  whole run on one screen instead of turning the graph into a scrolling map.

The graph needs no data the record does not already hold: phase succession and
plan-to-member fan-out are both already there. Unlike the terminal, it is a
rendering change and nothing more.

[The mocks](portal-redesign-mocks/) render this concretely.
