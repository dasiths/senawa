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
| `index.html` | The workflow is a tree of named work, and selecting anything opens one detail surface |
| `agents.html` | Arriving from "who is working" opens the *same* surface as arriving from the tree |
| `artifacts.html` | What the run made is a table; content loads when a row is opened |
| `record.html` | What happened is a table; the exact record loads when a row is opened |

## The decisions worth arguing about

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
