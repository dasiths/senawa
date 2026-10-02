# Portal

The portal is a local browser run console served by the supervisor over
loopback. It observes durable authority and submits exact human decisions. It
never holds authority of its own and never invents a fact the server did not
publish.

## Open the console

Export a loopback port before starting the service, then ask for a one-time
bootstrap URL:

```bash
export SENAWA_PORTAL_PORT=0
senawa service start
senawa portal
```

```text
http://127.0.0.1:44775/portal/bootstrap?token=imdOYE6TxlrLo-V-zfbPD99yQPAk6sFgwfbY2km2fGQ
```

The capability is single-use and expires within 60 seconds. Consuming it
redirects to `/portal/` and sets a host-only session cookie. A session lasts at
most eight hours. Reloading the bootstrap URL replays a consumed token and
returns HTTP 401 with `Portal bootstrap is invalid`, so navigate inside the
console instead of reloading it. Run `senawa portal` again for a fresh session.

A session carries one CSRF token and issues it once. The tab that claimed it
keeps the token in `sessionStorage`, so reloading `/portal/` in that tab stays
read-write. A second tab on the same session, or a tab whose session storage was
cleared, finds the token already claimed and stays read-only. Run
`senawa portal` for a fresh read-write session.

Without `SENAWA_PORTAL_PORT`, the service has no loopback listener and the
command reports that the portal listener is not enabled.

## Layout

The console is a three-column workspace:

* A left navigation rail with the run views and the current mode, graph
  revision, and cursor.
* A main workspace for the selected view.
* A right attention rail with pending receipts and the human queue.

Both rails are resizable and collapsible on wide viewports. Drag the divider, or
focus it and use the arrow keys. `Home` and `End` jump to the minimum and
maximum width, and `Shift` with an arrow key takes a larger step. The layout
persists locally between sessions.

Press `Control+K` or `Command+K` to focus the run switcher. Press `Escape` to
close an open dialog or full-screen asset overlay.

## Views

Three views exist, each addressable by URL hash as
`#/runs/{repositoryId}/{runId}/{view}`. The display name in the navigation rail
is the exact `{view}` token, in lower case:

* Workflow, `workflow`, shows the run as phases, the work inside each phase, and
  what that work produced, as a diagram or a tree. Selecting a piece of work
  opens what it is doing beside it.
* Agents, `agents`, shows who is working, grouped by the phase they are working
  in, and reaches the same detail surface as Workflow.
* Timeline, `timeline`, shows what happened in order, what the run produced, the
  commands this browser submitted, and the counts and revisions a reader checks
  a claim against.

Both Workflow and Agents open with the whole run's agent output and narrow to
one agent when a reader selects it. A hash with an unknown token, an
unparsable repository or run identity, or a different segment count resolves to
Workflow with no run selected.

A view assembles from an overview read, bounded resource reads, and a second
overview read. Any change to the authority vector invalidates the assembly and
the view reloads rather than mixing two revisions.

## The workflow diagram

The graph view has three modes: Diagram, Table, and Tree. Diagram renders the
canonical graph as an inert SVG.

Each node shows its title, its role when it has one, and its run state. Badges
appear on the right of a node when it carries open human needs or evidence
records.

### Node run states

Six run states exist, all derived from durable records rather than stored as
mutable status:

* `not-started` means no attempt, dispatch, or outcome exists yet.
* `running` means a phase attempt started or a task has a current dispatch.
* `awaiting-human` means the node carries at least one open human need, such as
  a pending approval, question, or escalation.
* `accepted` means the phase closed, the task reached an accepted disposition,
  or the criterion was satisfied or waived.
* `failed` means the phase escalated or failed, the task was blocked or failed,
  or the criterion was unsatisfied.
* `superseded` means a newer definition generation replaced this node.

The workflow node aggregates its phases. It is `accepted` only when every phase
is accepted or superseded, `failed` when any phase failed or the run ended,
`awaiting-human` when run-scoped needs are open, and `running` once any phase
has left `not-started`.

### Selecting and traversing

Click a node to select it. Selected nodes are marked with `aria-pressed` and a
selection outline. Container nodes such as phases are traversed by keyboard
rather than by clicking their interior, because a contained task rectangle sits
above the container.

Every node is focusable. With focus on a node:

* `Enter` or `Space` selects it.
* Arrow keys move focus along the deterministic row and column order of the
  layout, so traversal is stable across renders.

Selecting a node reveals its detail panel below the canvas and scopes the agent
output view to that node.

### Fit, zoom, pan, and focus

The diagram toolbar offers Fit, Zoom out, Zoom in, and Focus selected, plus the
current zoom percentage. Zoom steps through a fixed ladder of 50, 75, 100, 150,
200, and 300 percent. Drag the canvas to pan. The viewport is clamped to the
laid-out graph, so panning cannot lose the diagram. Focus selected centres the
selected node and is disabled while nothing is selected; at a zoom level where
the whole graph already fits, it changes nothing.

### Node toolbar

The selected node's detail panel carries a small toolbar with roving tab focus:
`Home`, `End`, and the arrow keys move between its buttons while only one is in
the tab order. It offers Copy identity, Focus in diagram, and, when the node has
a linked human need, Review linked human need.

## Agent output

The graph view includes a terminal-style pane titled Agent output. It reads the
durable agent transcript for the current scope.

### What it captures

The transcript records session and tool lifecycle lines that the execution host
observed:

* `session started`
* `session ended <status>`
* `tool <name> <resultType>`
* `tool <name> refused`
* `tool <name> failure`

### What it does not capture

Model prose is deliberately never captured. The pane shows what the host
observed, not what the model said. It is not a chat log, not a shell, and not an
input surface. You cannot type into it, and nothing you do there reaches the
worker.

Sensor and process output is also not streamed here. Sensor readings reach gates
as bounded structured readings, and raw process output never enters portal DTOs.

### Scope

The pane follows the selected node by default. A selected task or phase resolves
to its current dispatch when one exists, and otherwise to the task or phase
itself. Criterion and workflow nodes have no transcript owner, so the pane asks
you to select a phase or task.

Scope to whole run merges every owner of the run into one stream and labels each
row with the owner that produced it. Press the same button again to scope back
to the selected node. Changing owner discards retained lines, so two owners
never share one view.

### Retention and controls

Each line is at most 4,096 UTF-8 bytes, a page carries at most 200 records, and
the pane retains at most 5,000 lines per owner. Beyond that, the oldest lines
are evicted. Records merge by sequence rather than arrival, so duplicates
collapse and order is stable.

The pane header offers Copy output and Download output for the exact retained
text, and reports the retained line count. The log region is focusable, and
pressing `End` inside it jumps to the newest line. Scrolling away from the tail
unpins the view and shows a Jump to latest button with the unseen count.
Scrolling back to the tail repins it.

New lines arrive within one poll. Transcript delivery advances an isolated
component of the authority vector, so an actively writing run does not
invalidate the rest of the assembled view.

## Questions, approvals, and allowances

Human work arrives in the Human needs view and the right attention rail. A need
is derived from immutable question, candidate, amendment, escalation,
integration, and ending records. No portal table owns mutable need status.

The oldest unanswered question also raises an attention banner above the
workspace with the exact time it has waited, a direct Answer this question
button, and an Overdue marker once it has waited 60 seconds or more. The banner
announces once per question identity rather than on every rerender, and the
browser tab title carries an answer-needed prefix while one is pending.

Choosing Review exact record opens a modal that loads and verifies every
referenced digest and revision before it enables submission. The dialog states
the consequence of the decision, shows the exact review source, and offers the
field the decision needs:

* An answer dialog takes free text. Drafts persist per question identity while
  the session lasts, so a rerender or a detour does not lose your typing.
* An approval or amendment dialog takes an approve or reject decision on the
  exact record.
* An allowance dialog shows the unit, current limit, requested amount, available
  amount, ceiling, and maximum result, and takes an integer increase. The
  resulting limit is computed as you type and refuses anything above the
  ceiling.

Submission is disabled until verification completes. A decision the session
lacks the capability for, or a need with no allowed commands, stays disabled.

Every submitted decision becomes a pending command in the right rail with its
intent, command identity, and receipt status. A command narrator announces
progress in a polite live region, so the outcome is available to assistive
technology without stealing focus.

## Run control

The Overview view carries the run control buttons. Pause appears while the run is
running, Resume appears while it is paused, and End run appears until the run is
terminal. Each opens the same verified modal. Ending a run additionally requires
an explicit confirmation checkbox stating that the run cannot resume, and the
submit button is styled as destructive.

Run control requires the `portal-write-run-control` capability. Without it the
buttons render disabled.

## What the run produced

The Timeline view lists worker artifact metadata after the history. Metadata stays
`metadata-only` until the exact digest, size, media type, and installed bytes
verify. Previews read at most 64 KiB and the JSON viewer renders at most 500
nodes. Opening a preview full screen uses a modal overlay that traps focus,
closes on `Escape`, and returns focus to the control that opened it. Downloads
always use a fixed server-derived filename and an attachment disposition.

## What the portal cannot do

* It cannot apply an amendment. Amendment review is inert data; application is a
  trusted local operation.
* It cannot start or advance a run. Both are command-line operations, and the
  portal observes the state they produce.
* It cannot reach daemon lifecycle routes. Every `/supervisor/v1` route
  returns `404` on loopback.
* It cannot see canonical repository paths, grant tokens, SDK session
  identities, worker prompt packs, secrets, target refs, or raw process output.
  Portal DTOs omit them.
* It cannot widen its own session. Capabilities come from the session
  descriptor.

## The portal is optional

Every decision the portal offers is also a command, and a run can be taken from
start to finish without opening a browser:

| In the portal | On the command line |
|---|---|
| Approve a candidate | `senawa approve <repository> <run>` |
| Reject with a reason | `senawa reject <repository> <run> "<reason>"` |
| Answer a question | `senawa answer <repository> <run> "<text>"` |
| Read a run's artifacts | `senawa artifact list\|read <repository> <run>` |
| Watch what a run is waiting for | `senawa status <repository> <run>` |

The portal and the command line read the same durable records, so they cannot
disagree about what is pending. What the portal adds is the graph, the agent
transcript, and seeing several runs at once.

A run blocked on a decision stays blocked until someone makes it, in either
surface. `senawa advance` reports `waiting for a decision` and does not submit
one on a person's behalf.

## When a session ends

Expiry terminates the event stream and fails API, shell, and asset requests. The
workspace replaces itself with a Session expired notice. Run `senawa portal`
again for a new bootstrap URL.
