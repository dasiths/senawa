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

## The shape to move to

### One run page, three bands

Replace the nine-tab workspace with a single scrolling run page:

```
┌─────────────────────────────────────────────────────────┐
│  ● rpi · building a tic-tac-toe game        [needs you] │  ← state, one line
├─────────────────────────────────────────────────────────┤
│  ◇ research  ✓ closed      3 questions asked            │
│  ◆ plan      ● working     planner · haiku · 2m         │  ← the workflow
│  ○ implement   waiting                                  │
├─────────────────────────────────────────────────────────┤
│  ▸ Record                                               │  ← collapsed proof
└─────────────────────────────────────────────────────────┘
```

* **Band 1** is the answer to "does it need me". When something is pending it is
  the question itself with an answer box, not a badge that counts them.
* **Band 2** is the workflow as a vertical list of phases, each expandable to its
  agents and their attempts. This replaces Overview, Graph, Delivery, Agents, and
  Workspaces for the ordinary case.
* **Band 3** is `Record`, collapsed. Opening it reveals today's Activity,
  Artifacts, Amendments, and the revision counters, unchanged.

Nothing is removed. Four views become one band and a disclosure triangle.

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

## Order of work

1. **Names over identities.** Highest value, lowest risk, no layout change.
   Fixes the Agents table and half the Graph table on its own.
2. **Collapse Activity.** One line per event, expandable. Removes 23,000
   characters and 168 digests from the default view.
3. **Fold attempts into agents.** Six rows become two.
4. **Merge the nine tabs into three bands.** The structural change; do it after
   the content is legible so the layout is judged on the right material.
5. **Icons and state colour.** Once rows are short enough for a mark to matter.
6. **Hide empty sections.**

Steps 1 through 3 are content-only and can ship one at a time. Step 4 is the one
that needs the browser tests rewritten, and the existing thirty-four are the
safety net for it.

## What must not be lost

* Every value visible today stays reachable within one disclosure.
* `Review exact record` stays on every human need, and the exact digests behind
  a decision stay one click away. Being able to check is the product; the change
  is only that checking is a deliberate act rather than the default view.
* Read-only sessions stay visibly read-only.
* The command-submission feedback path — `submitting` → `completed` → the need
  clearing — is the one interaction that already works well and reads clearly.
  It is the model for the rest.
