# Portal redesign mocks

Static, high-fidelity mocks of the four-tab portal described in
[the simplification analysis](../portal-simplification.md). No framework and no
build step: four HTML files, one stylesheet, and forty lines of JavaScript for
selection and lazy expansion.

```sh
make serve          # http://127.0.0.1:842/
make open           # the same, and opens a browser at it
```

## What each page is arguing

| Page | The claim it is making |
| --- | --- |
| `index.html` | The workflow is a graph of named work, and selecting anything opens one detail surface |
| `index.html` → Tree | The same work read as containment, for scanning a long run |
| `agents.html` | Arriving from "who is working" opens the *same* surface as arriving from the tree |
| `artifacts.html` | What the run made is a table; content loads when a row is opened |
| `record.html` | What happened is a table; the exact record loads when a row is opened |

## The decisions worth arguing about

**The graph is the default reading; the tree is the alternate.** The segmented
control in the Workflow card header swaps between them and the selection survives
the swap, because they are the same six pieces of work. The graph leads because
the question a person arrives with is *what is happening and what is it waiting
for*, and only the graph answers the second half. The tree stays for scanning a
long run, where compactness beats structure.

**The artifact is the edge.** `plan · 4 tasks · fans out` sits on the line
between the phase that produced it and the four tasks it produced, so the fan-out
has a visible cause. Edges are dashed until the thing upstream has actually been
carried, so an unfinished run reads as unfinished at a glance.

**Phases stay as groups.** The dashed lane around `implement` is what makes the
four members read as one fan-out rather than four unrelated branches, and it is
where the phase's own state and counts live.

**Folding follows the work.** A phase is open while anything in it is still
running, and folds itself when the last member lands — plus it stays open while
something is waiting on a person, because moving a need onto its node achieves
nothing if that node is folded shut. Nothing is stored: the fold is a function of
state. Press `Finish next (mock)` four times to watch `implement` fold itself,
and `Unfold all` to see why the rule exists at all — the run stops fitting.

**A folded label is all that is left to read, so it is derived too.** A band
still reading `working · 1 asks · 1 needs budget` after its last member landed is
worse than no label. The state chip, the counts, the run header and the waiting
queue all recompute from the members.

**An explicit fold wins.** Opening or folding by hand is a decision, so the
automatic rule stops arguing with that phase; `Follow the work` hands control
back. Edges whose endpoints are folded away reattach to the group that swallowed
them, and duplicates collapse into one, so folding never deletes structure.

**Layout is measured, not authored.** Edges are drawn from the laid-out boxes
after render, so nothing needs coordinates and the picture survives wrapping,
resizing, folding and renaming.

**Every task has a name.** `write the game rules module`, not `phase-executor`
and not `task_9adb8a1d…`. Steering is a decision about one piece of work, and
the current portal cannot say which piece you have selected. The identity moves
into `About`.

**The terminal is the answering surface.** The agent's output is a scrolling
monospace pane, the question is the last thing in it, and the reply box is
attached to the bottom of the same pane rather than being a modal about the
agent. Steering uses the same surface, because interrupting something should
show you what you are interrupting.

**The escalation is on the node that raised it.** `write the check script` shows
it has stopped for budget, in the agent's own words, with the grant control in
the reply line. It is not a separate queue of a separate kind of thing.

**Revisions are a disclosure.** The header carries the request, the state, and
the elapsed time. `Identities and revisions` is a closed `<details>` at the
bottom of the page.

**Tables load, detail fetches.** Row click expands, and the mock deliberately
shows a `Loading the exact record…` beat so the cost is visible: one beat, once,
on the row you asked about, rather than every row rendered up front.

**One status element.** `live` with a dot, silent when healthy. The needs pill
is the only other chrome, and it disappears when nothing is waiting.

## What these mocks cannot honestly show

The `Live` pane renders the agent narrating what it is doing. **We do not record
that.** `agent_transcript_lines` has one stream, `system`, and its content is
`session started`, `tool X success`, `session paused`. Sixteen lines for a whole
run, none of them the agent's own words.

So the lines in these mocks styled as `t-say` are invented. Everything styled as
`t-tool`, `t-meta` and `t-ask` is real and comes from
`run_5ca08c936624267661c839c96cc46620`.

Building this pane for real needs an assistant stream captured alongside the
system one. Without it the pane is a system log in a monospace font, which is
worse than the table it replaces because it implies a conversation that is not
there.

The task names are also aspirational in the same way: today the compiler emits
`phase-executor` for every phase task, and fan-out members are named by digest.
The names here come from the plan items, which the record already holds.

The graph is honest by comparison. Every edge it draws is a dependency the
record already knows: phase succession, and the fan-out from a plan output to
its members. It needs no new data, only a second way of drawing what is there.
