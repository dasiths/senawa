# Portal refactor plan

This sequences the work in [the gap analysis](portal-gap-analysis.md) against the
shape in [the mocks](portal-redesign-mocks/).

`[x]` is done and proven by a test that fails when the fix is removed. `[ ]` is
not.

## The order, and why

Naming comes first because a surface that cannot say which piece of work you are
about to redirect is not safe to act on, and because it is the smallest change
with the largest effect.

View state comes second because the graph, the folding and the tables all need it
and because retrofitting it after two more capture pairs exist is worse than
doing it now.

Streaming comes last of the substantive work despite being the largest, because
it is independent, and because nothing that promises narration should ship before
there is narration to show.

## Phase 1: every task has a name

The compiler gives every agent phase executor the literal key `phase-executor`,
and the display name for every node is derived from that key. Fan-out members
already have a human title in the plan they came from, unprojected.

The key is identity. It feeds digests, graph revisions, and every comparison that
detects an added, changed or removed task across replans, so this adds a title
beside the key and never renames one.

* [x] `ParsedWork` and the compiled definition carry an optional title
* [x] A phase executor takes its title from the phase, not from its reserved key
* [x] A fan-out member takes its title from the plan item it was materialised from
* [x] Node name resolution prefers the title and falls back to the key
* [x] Existing digests are unchanged, proven by a test over a fixture run

Done when the workflow tree shows four differently named members for the example
fan-out, and no graph revision moves.

## Phase 2: view state has somewhere to live

Rendering replaces the whole tree on every poll, and four hand-written capture
and restore pairs already fight it.

Reading the code changed this phase. `PortalUiState` already exists and already
holds the decisions that matter: the selected node, the workflow mode, the rail
layout, the transcript view. Those already survive a poll. The four capture pairs
are not decisions at all: focus, scroll position and uncommitted dialog text are
measurements the DOM owns, and no reducer should hold them.

So the distinction to enforce is between the two kinds, not the collapsing of
both into one:

* [x] A decision lives in `PortalUiState`, and rendering reads it
* [x] Selection survives a poll and a mode change, because it already did
* [x] Fold state joins the decisions rather than becoming a fifth capture pair
* [x] DOM-owned measurements stay captured, and are named as such

## Phase 3: the workflow reads as a graph

Edges already carry containment, dependency and supersession. Nodes already carry
run state, attempt and need counts. Artifacts already carry the task that
produced them. This is layout and rendering.

More of this existed than the analysis found. `graph-layout.ts` and
`graph-diagram.ts` already lay out a container graph with pan and zoom, already
share selection with the tree through `focusedRecord`, and are already covered by
browser tests.

* [x] `Workflow` carries `Graph` and `Tree` over one selection, graph first
* [x] A carried edge is distinguishable from one not yet carried
* [x] The graph carries a need's action, not only its count
* [x] A phase folds when its last member lands, and unfolds while work remains
* [x] An edge whose endpoint is folded away attaches to the group instead
* [ ] An artifact renders on the edge leaving the node that produced it

## Phase 4: a record is built when it is opened

Reading the code corrected this phase twice.

Activity does not render every event expanded any more: the record already sits
behind a closed disclosure. But hiding is not the same as not building, and the
JSON tree for every row was still constructed on first render, so a hundred
closed disclosures cost a hundred JSON trees.

And fetching on open would be wrong here. Events and receipts arrive over the
event stream and are already in memory, so a round trip would buy nothing. What
costs is the DOM, not the network. Artifact content is the case that genuinely
needs fetching, and it already does.

* [x] A record's detail is built only while it is open
* [x] Opening a record survives the next render, because it is a decision
* [x] Artifacts render as one row per artifact

## Phase 5: a need always names its node

Questions already carry a task and a dispatch. An escalation carried neither, so
the whole point of moving escalations onto their node was unreachable.

* [x] An escalation carries the work that ran out of budget
* [x] A need that cannot name a node has a defined rendering

## Phase 6: capture what the agent says

The largest phase, and the only one that needs data we do not record.

* [x] Decide the storage shape for prose, given lines cannot hold newlines
* [x] Turn streaming on and subscribe to the persisted events
* [x] Build the durable transcript from persisted events, never from deltas
* [x] Decide whether sub-agent events enter the transcript, and how they read
* [ ] Classify transcript sensitivity the way artifacts are classified
* [ ] Use deltas for live tailing

## Phase 7: answering feels like answering the agent

* [x] The reply box attaches to the transcript it answers
* [ ] Steering uses the same surface, because it interrupts the same thing
* [ ] An escalation is granted from the node that raised it

## Phase 8: the portal looks like the mocks

The phases above changed what the portal knows and how it behaves. They did not
change how it looks, and a screenshot beside
[the mocks](portal-redesign-mocks/) shows a different product: a rail of four
destinations down the left, four competing status pills, digests where questions
belong, and six-pixel type in the graph.

This phase is measured against the mocks component by component. Every row names
a mock class and the portal element that has to carry it, so "true to source" is
checkable rather than a matter of taste.

### What is actually different, beyond the styling

Reading the mocks as a restyle was wrong. Four things about how the portal
behaves are different, and each of them changes markup rather than css.

**One detail surface, driven by selection.** Every tab is a list on the left and
the same detail card on the right. Selecting a node in Workflow, an agent in
Agents, or a row in Artifacts fills the same card, because they are the same
subject approached from different directions. The portal today renders a
different panel per tab and puts the transcript somewhere else again.

**The detail card has its own tabs.** `Live`, `Answers`, `Produced`, `About`.
What the agent is doing now leads; what it was told, what it made, and what it is
are behind it. The portal today shows identity and normalized input first and has
no notion of answers already given.

**Input is given in the terminal, not in a modal.** The reply box is welded to
the bottom of the transcript it answers, with the agent's words above it and the
question last. Answering, steering and granting budget are all the same gesture
on the same surface. The portal today opens a `dialog` that covers the thing the
reader is deciding about, which is why the mocks argue it feels like filing a
ticket rather than replying to an agent.

**Detail is fetched when a row is opened, and says so.** The mock's tables show
one row per thing and load the record on click, with a visible `Loading the exact
record...` beat. That beat is the point: it makes the cost visible and paid once,
on the row the reader asked about.

### Chrome, on every tab

| Mock | Portal | State |
| --- | --- | --- |
| `topbar` with `brand`, `run-picker`, `topbar-right` | `.app-header` | [x] |
| `health` dot, silent when healthy | `.status-badge` in header | [x] |
| `needs-pill`, emphasised only above zero | `.rail-toggle` | [x] |
| `tabs` / `tab` across the top | `.primary-nav` / `.nav-item` | [x] |
| `run-head`: request as the heading, state, elapsed | `.run-head` | [x] |
| `elapsed` beside the state | `.run-progress` | [x] |
| `split`: work beside one detail surface | `.portal-body` | [x] |
| `card` with `header` carrying a heading and a `count` | `section` elements | [x] |
| `state` pill: `is-working`, `is-closed`, `is-refused` | `.status-badge` | [x] |
| `proof`: identities and revisions, folded | `.proof` | [x] |
| Palette, type scale, radius and shadow | `styles.css` tokens | [x] |

### Rail

| Mock | Portal | State |
| --- | --- | --- |
| `queue` of things waiting on a person | `.pending-list`, needs list | [x] |
| `q-where`: phase and task, named | `.q-where` | [x] |
| `q-what`: the question itself, not a digest | `.q-what` | [x] |
| Action named for the decision | `needChipLabel` | [x] |
| `Recently answered` | absent | [ ] |

### Workflow

| Mock | Portal | State |
| --- | --- | --- |
| `seg` / `seg-btn`: Graph and Tree over one selection | `.segmented-control` | [x] |
| `band` grouping a phase, `band-body` its members | `.diagram-container` | [x] |
| `gnode`: name, who, model, state, `asks` | `.gnode` in `graph-flow.ts` | [x] |
| `chip`: an artifact on the edge that carried it | `.chip` | [x] |
| `finish`: what the run is waiting to finish | `.finish` | [x] |
| `graph-legend` with carried and not yet | `.graph-legend` | [x] |
| `legend-actions`: unfold all, follow the work | `.legend-actions` | [x] |
| `tree` rows: `node-mark`, `node-name`, `who`, `model`, `asks` | `.node` | [x] |
| `card detail` with `detail-title` and `where` | `.detail` | [x] |
| `detail-actions` beside the title | `.node-toolbar` in the card header | [x] |
| `detail-tabs`: Live, Answers, Produced, About | `.detail-tabs` | [x] |
| `terminal` with `t-meta`, `t-say`, `t-tool`, `t-ask`, `t-fail` | `.agent-terminal-row` | [x] |
| `reply` attached to the transcript | `.reply` under the terminal | [x] |
| `answered`: `a-q`, `a-a`, `a-when` | `.answered` | [x] |
| `kv`: what this work is, folded under About | `.kv` under About | [x] |

### Agents

| Mock | Portal | State |
| --- | --- | --- |
| `grid`: one row per agent, named work | `.agent-roster` of `.node` rows | [x] |
| Selecting an agent opens the same detail surface | `graphDetail` | [x] |

### Artifacts

| Mock | Portal | State |
| --- | --- | --- |
| `grid`: one row per artifact | `.grid` rows | [x] |
| Content fetched when a row is opened | `loadArtifact` | [x] |

### Record

| Mock | Portal | State |
| --- | --- | --- |
| `grid`: one row per event and receipt | `.activity-list` rows | [x] |
| Detail built when a row is opened | `recordDisclosure` | [x] |
| `proof` at the bottom | `.proof` | [x] |

### Starting the stylesheet again rather than steering it

Patching the old stylesheet toward the mock was the wrong approach and it showed:
every edit fought a rule written for a dark header, a sidebar, and a sixteen
pixel base, and the result converged slowly while the tests kept breaking on
assumptions nobody had stated.

So the stylesheet was written again from the mock, and the component blocks that
were still correct were carried across rather than retyped: the workflow diagram,
the JSON viewer, the asset overlay, the confirmation dialog, and the rail width
tokens. Eighteen hundred lines became fifteen hundred, and the parts that carry
the redesign are now the parts that were written for it.

What did not change: the state store, the transport, the event stream, the
codecs, the graph layout, the transcript view model and the bounded JSON model.
The functionality lives there and none of it is presentation.

### Checking it against the mock rather than against memory

Reading a mock and then writing markup from a description of it is how the last
pass drifted. Every component table row above was ticked honestly and the result
still did not look like the mock, because "carries the same facts" and "looks
like the source" are different claims and only the first was being checked.

So the check is a picture beside a picture. The mocks are static files with a
file server already wired up, so both sides can be driven by the same browser at
the same viewport, and the difference is looked at rather than recalled.

* [x] `compare.spec.ts` serves the mocks, drives both surfaces at 1440x900 and
  at Pixel 5, and writes `mock.png` beside `portal.png` per tab
* [x] Workflow graph: bands, gnodes, chips, finish nodes, legend
* [x] Workflow tree: marks, names, who, model, asks, state
* [x] Agents: grid of agents, and the terminal the selection opens
* [x] Artifacts: grid, and the content a row opens
* [x] Record: grid, and the record a row opens

A row is ticked when the two pictures are the same layout with the run's real
words in it, not when the classes match.

The first pair of pictures paid for the harness immediately. Beyond the graph and
the terminal, which were known, it showed a skip link rendering visibly at the
top of every page, the tabs in a different order from the mock, a run head
titled with a run identity rather than with the request, a status strip and an
attention banner the mock does not have at all, and an Agents tab whose roster
had lost its layout entirely and read `implementerverifyworking`. None of those
were on the component tables, because a table of components cannot fail the way
a page can.

### What this phase deliberately removes

The left navigation rail, its resize handle, its collapse control and its
`Mode / Graph / Cursor` facts. Four fixed destinations do not need a resizable
rail, and the facts it carried are the ones the mocks argue should never have
been a landing page. The right rail keeps its handle, because what it holds
grows with the run.

## Phase 9: fewer words, and each fact in one place

Phase 8 made the portal look like the mocks. Reading it screen by screen after
that shows the next problem: it says too much, says several things twice, and
says a good deal of it in the machinery's words rather than the reader's. Two
audits, one per pair of screens, produced the list below; every item names what
is wrong rather than describing a preference.

### One vocabulary for state

`STATE_LABELS`, `STATE_TONES` and the `statePill` that reads them exist twice,
once in `render.ts` and once in `graph-flow.ts`. Two copies of the same mapping
is how the tree and the graph start disagreeing about what a lifecycle is called.

* [ ] One module owns the marks, the labels and the tones; both readings import it

### Say a thing once

| Fact | Said in | And again in | Keep |
| --- | --- | --- | --- |
| The run's mode | run head pill | `mode-band` badge, `Run running` | run head |
| Steer, Accept anyway | tree row | detail card header | detail card |
| The word `Workflow` | the tab | the card heading under it | the tab |
| How much workflow there is | `3 phases · 6 pieces of work` | `8 of 8 nodes` | the first |
| Whose output this is | detail card title | `Agent output` heading in the pane | the title |

* [ ] Each row above says its fact once

### Name the decision, or draw a mark

A control that describes what it does to the machine makes a reader translate.
A control used constantly and understood instantly can be a mark with a name
only assistive technology reads.

| Now | Becomes |
| --- | --- |
| `Copy identity` | a clipboard mark, named `Copy identity` |
| `Focus in graph` | a target mark, named `Show this in the graph` |
| `Fold this phase` / `Unfold this phase` | a chevron, named `Collapse` / `Expand` |
| `Scope to whole run` / `Scope to selected node` | `All agents` / `This agent` |
| `145 retained lines` | `145 lines` |
| `Normalized input` | `Input as given` |
| `Bounded utf8 preview` | `Preview` |
| `Active preview prohibited for this media type` | `No preview for this kind of file` |
| `read as written · cannot be changed` | `sent as written` |
| `outputName`, `schemaKey`, `contentDigest` in delivery | the words for those things |

* [ ] Every control above reads as the decision or carries a mark

### One baseline per row

A row that mixes fourteen and twelve pixel text with a pill and a bare span has
no baseline, and that is what reads as misalignment.

* [ ] Everything in a `node-right`, a `g-foot` and a band summary is 12px on one
  baseline
* [ ] `where` under a detail title is 12px and quiet, not body text
* [ ] Every control in a toolbar is the same height, and toolbars share one gap

### Reading the pictures for what the code cannot show

A stylesheet cannot be read for alignment. Two rules can be individually correct
and still produce a row whose baseline wanders, a gutter that is eleven pixels on
one card and fourteen on the next, or an icon that renders as an empty box
because the machine has no glyph for it. Those are found by looking.

So the comparison captures are read as evidence, not kept as a record: every tab
at both viewports, looked at against the mock beside it, with a list of what is
wrong written down before anything is changed. Three defects already came from
this and from nowhere else: a mark rendered as tofu because the chosen code point
is absent from the container's fonts, a filter placeholder that said `Filter
loaded records` on a screen with no records, and a status line whose prose ran the
header off a narrow screen.

* [ ] Every tab captured at 1440 and at 390, and read for spacing rather than for
  content
* [ ] Gutters and card padding come from one scale, and the same scale on both
  viewports
* [ ] No control renders as a missing glyph on a machine with only default fonts
* [ ] Nothing overflows, and nothing is clipped, at either viewport
* [ ] What is written down here is the defect, not the preference

### Delivery reads as a timeline

The weakest screen. It is meant to answer *what happened, in what order*, and it
answers with a table of delivery records that carry no time at all.

The audit found why: `PortalDeliveryRecord` has no timestamp and no defined
order, while `EventStreamFrame` carries both `occurredAt` and `cursor`. So the
timeline has to be built from the event stream, which is the only thing in the
portal that knows when anything happened, and delivery records attach to it
rather than standing beside it.

* [ ] One chronological column: time, what happened in the reader's words, where
* [ ] Events grouped under the phase they belong to, newest last
* [ ] A delivery record hangs off the event that published it
* [ ] What cannot be dated says so rather than pretending to an order

## Phase 10: one design language, proven by looking

Phase 9 removed words and duplication. What it cannot prove is that the result
is *one* thing: a card on Record and a card on Workflow can each be defensible
and still not look like siblings, and no amount of reading the stylesheet
settles it. That is a question about pictures.

So this phase is adversarial and visual. An independent reader is given every
captured state at both viewports and asked to find what is wrong, with no
knowledge of why any of it was written and no obligation to be kind about it.
The corpus is the eighteen images the browser suite already writes
(`packages/portal/tests/screenshots/`) plus the eight comparison captures, which
between them cover every tab, every dialog, the mobile rail, and the terminal
states.

### The motif, stated so it can be checked

A rule nobody wrote down cannot be broken. So:

* One surface: white cards on a paper background, one rule colour, one radius,
  one shadow, and nothing else framed.
* One type scale: 14px body, 13px controls and card headings, 12px row
  furniture, 11.5px quiet metadata, monospace only for machine text.
* One spacing scale: 4, 6, 8, 10, 14, 16, 20. Nothing between and nothing else.
* One control: the same height, border, radius and hover for every button; a
  mark button is the same height and square.
* One state vocabulary: a dot and a word, coloured by tone, everywhere.
* Colour carries state and nothing else. Nothing is coloured for decoration.

### What the adversarial pass has to answer

* [ ] Does every card have the same padding, radius, border and shadow?
* [ ] Does every card header have the same height and the same internal gaps?
* [ ] Is any text at a size not in the scale?
* [ ] Do two adjacent controls differ in height, radius or weight?
* [ ] Does any row's baseline wander?
* [ ] Is any gutter off the spacing scale?
* [ ] Does anything read as a different product from the tab beside it?
* [ ] Is anything clipped, overlapping, or touching an edge it should not?
* [ ] Does the mobile capture use the same language as the desktop one, or a
  different one that merely fits?

Every finding is recorded with the image it came from and the rule it breaks,
then fixed, then re-captured and looked at again.

## Log

Findings and deviations are appended here as phases land.

### Phase 1

The title sits on every definition rather than only on tasks, because
`compileCommon` is shared by workflows, phases, tasks and criteria, and a name is
the same idea in all four.

It is excluded from the digest by construction rather than by convention. The
digest is built from a named field list, not a spread of its input, so a title
cannot reach it by accident. A test compiles the same fixture twice, once titled
and once not, and asserts that every node digest and the graph revision are byte
identical. Letting the title into the digest fails thirty-five tests, two of them
that one.

The generated key for a fan-out member turned out to be `implement-<digest>`,
which is worse than the analysis assumed: not a slug, a digest. The naming test
asserts that shape directly, so the reason the title is needed stays visible.

Deviation: phases do not yet take an authored title. The authoring surface
normalizes before the compiler sees it, so `title:` in `workflow.yaml` is a
separate change through the normalizer. Defaulting a phase executor's title to
its phase name removes the defect that two rows both read `phase-executor`
without touching the authoring surface, so the authored title can wait until
there is a reason to prefer one.

`taskName` and `phaseName` were bounded at 128 characters in the portal codec
while a planned task's title may be 256. A long title would have failed
validation and broken the Agents page, so the bound now matches the record.

### Phase 3, first pass

Making the graph the default turned out to be premature, and the browser tests
said why. Five of them failed looking for a need's action, because that action is
rendered on a tree row and the graph carries only a count badge. Leading with the
graph therefore hid the controls a person needs to unblock a run.

That is a better acceptance criterion than the one the plan had. The graph cannot
lead until it carries what the tree carries: the action for a need, on the node
the need is about. Reverted to the tree until it does.

Kept from the pass: the two readings are now named `Graph` and `Tree` rather than
`Diagram` and `Outline`, because one says what it is and the other described a
drawing. And an edge that work has actually travelled is now solid while one it
has not stays dashed, so how far a run has got reads without opening a node.

The portal is served from a built bundle, so a source edit is invisible to the
browser tests until `vite build` runs in `packages/portal`. Ten failures became
five after rebuilding, and only the five were real.

### Phase 3, second pass

The action was already there and badly named. `nodeActions` offered `Review
linked human need` on whatever node was selected, which is a label about the
machinery rather than the decision, so a person had to open the need to find out
what it was. It now reuses the same wording the tree uses, and reads `Answer this
question` or `Review the budget it asked for`.

That is what the graph was missing, and with it the graph can lead. `Focus in
diagram` became `Focus in graph` for the same reason the tabs were renamed.

The three tests that had failed were asserting tree behaviour without asking for
the tree, which was invisible while the tree was also the default. They now
select it. A fourth test was added for the claim that earns the flip: from the
graph, a node with a need offers the named action and opens it.

That fourth test immediately found a second defect. The graph decided which node
owned a need with `candidate.taskId === node.nodeId`, while the tree used
`needBlocks`, which also gives a need with no task to the run root. So a run-level
need was counted by a badge the controls beside it refused to act on, and the two
readings of the same workflow disagreed about who was blocked. Both now use
`needBlocks`.

### Phase 3, folding

The fold is a transformation applied to the graph before layout rather than a
change to the layout itself, which kept `graphLayout` untouched and
deterministic. `foldFinishedPhases` drops the members of a phase whose work is
done and reattaches their edges to the phase that swallowed them, deduplicating
the lines that then coincide. Nothing about a fold is stored.

What is stored is disagreement. `unfoldedNodes` records only the phases a reader
opened by hand, which is the one part that has to outlive a poll, and it lives in
`PortalUiState` beside the other decisions rather than becoming a fifth capture
pair around the DOM replacement. That settles the Phase 2 question in practice:
decisions go in state, measurements stay captured.

Both halves of the rule were proven by breaking them. Removing the guard that
keeps a phase open while it carries a need fails the test that says so; removing
the edge deduplication fails the test that says four members feeding one
successor become one line.

The fold control sits after `Focus in graph` and is disabled on anything that is
not a phase, because folding is a decision about a group.

### Phase 5

The answer to the open question was neither of the two the gap analysis offered.
An escalation did not reach its task indirectly: it did not reach it at all. The
stored `RunnerEscalation` carried a command, an operation, a unit and an amount,
and `operationId` is a runner idempotency key rather than a pointer to work.

But the task is right there when the escalation is written. Two lines above the
insert, the same code fences `command.taskScope`, which carries `taskId` and
`definitionGeneration`. So the escalation now records what ran out of budget, and
the need projects it.

Old escalations stay readable: the fields are optional, the digest is computed
from the stored body, and a need with no task still has a defined home at the run
root where both readings agree.

### A node can be waiting on more than one thing

Giving an escalation a task exposed a defect nothing had reached before. A node
offered exactly one need control, chosen with `find`, so the first match won and
every other need on that node was invisible. While escalations had no task they
never collided with a question, and the bug could not happen.

The browser test that had just been written for the graph failed the moment the
escalation landed on `task_verify` beside its question: the control was there,
named for the escalation, and the question had vanished.

A node waiting on an answer and stopped for budget is two decisions. The toolbar
now offers one control per need, each named for what it is, so a badge that
counts two things is backed by two controls rather than one.

### Phase 6

The storage question answered itself once the constraint was read properly. A
transcript line may not contain a newline, which sounded like a reason to give
prose its own table. It is the opposite: the sink already splits on newlines,
because one captured record is one displayed row. A terminal is lines. So prose
needs a stream of its own, not a table of its own, and `assistant` joins
`stdout`, `stderr` and `system` on the existing column.

That reuses the whole path: the same write, the same replay and conflict rules,
the same retention, the same paging, the same codec, and the same pane, which now
colours the agent's voice apart from the machinery reporting on it.

The schema change edits the baseline rather than adding a second migration. The
durability document already says why: a chain exists to carry an installed base
forward, and v1 has none. The cost is that an existing development database no
longer matches the packaged checksums and must be reinitialised, which is now
written down beside the policy.

Only `assistant.message` is taken. Delta events are marked ephemeral by the SDK
and are not replayed when a session resumes, so a record assembled from them
would have holes wherever a worker restarted, and one insert per token would
turn a synchronous append into a firehose. An event carrying an `agentId` is a
sub-agent, whose words are not the agent's, so it is dropped:
`includeSubAgentStreamingEvents` stays off and the filter says so in the code.

The subscription is optional on the port. A port that cannot report the agent's
words is still usable, and the transcript falls back to the tool calls it already
records rather than inventing narration it never heard.

Left undone deliberately: transcript lines still have no sensitivity
classification, while assistant prose may quote repository contents. Artifacts
have one and transcripts do not, and that gap should be closed before this is
shown to anyone outside the machine that ran it.

### Phase 8, what the pictures found

Reading the mocks and writing markup from a description of them is how the first
pass drifted, so the second pass drove both surfaces with one browser and looked
at the two pictures side by side. Every defect below was invisible to the
component tables and obvious in the first pair of screenshots.

The skip link had no rule in the rewritten stylesheet, so it rendered as visible
body text at the top of every page. The tabs were in a different order from the
mock. The status band and the attention banner do not exist in the mock at all:
health is a cluster of quiet dots beside the product name, and how long a
question has been waiting belongs on the question in the queue, not on a band
across the work. Agents had lost its layout entirely and read
`implementerverifyworking`, because the rewrite dropped ninety-five class rules
the portal still emitted; those are restored and the list was derived by
differencing emitted class names against styled ones rather than by eye.

Two defects were structural rather than cosmetic. A card in the graph was a
`button` with need `button`s inside it, which is invalid, flattens in the
browser, and was what the clipping check caught. The mock is right: the card is
one control, what it waits for is a badge, and the control that acts on it lives
on the detail surface beside it. And a tree row selected its outermost ancestor,
because rows nest and every ancestor row heard the click; nothing had reached it
while the tests selected from the diagram instead.

The graph is now the mock's reading rather than a box-and-line drawing:
`graph-flow.ts` renders phases as bands, members as cards, what a phase handed on
as a chip on the line, and measures the lines from the laid-out flow after mount
so the picture survives wrapping, renaming and folding. The zoom and pan toolbar
went with the canvas, because a flow that wraps does not need a viewport.

A full-page screenshot repaints sticky chrome over the content it covers, which
looked at first like two portal defects that were not there. The comparison
projects use a viewport tall enough that no resize happens. Neutralising the
sticky rules from the test was tried first and the portal's own content security
policy refused the inline stylesheet, which is the policy working.

### Phase 9

Two audits, one per pair of screens, found more duplication than the component
tables had. The run's mode was stated twice, `Steer` was offered from two places
on one screen, `Workflow` was the tab and the card heading under it, and the
event stream was listed twice: once as a timeline and once as a column of
`cursor eventType occurredAt`. Each now has one home.

The state vocabulary existed twice in source, once in `render.ts` and once in
`graph-flow.ts`, which is how a tree and a graph begin disagreeing about what a
lifecycle is called. One module owns the marks, the words and the tones now.

Delivery was the weakest screen and the audit found why: `PortalDeliveryRecord`
carries neither a timestamp nor an order, while `EventStreamFrame` carries both.
So the timeline is built from the event stream and the delivery records hang off
it under a disclosure, rather than standing beside it pretending to a sequence
they do not have. `timeline.ts` turns an event type into words, names where it
happened from the graph rather than by identity, and is covered by a unit test
proven by breaking the ordering.

Three controls became marks with accessible names. The first attempt used code
points borrowed from the text font and two of them rendered as empty boxes in
the container, which is a defect a stylesheet cannot show; they are drawn now.

The header lost its band. Health is a quiet cluster beside the product name, the
narrator is a live region that announces rather than a sentence of machinery
prose across the top, and the counts a reader checks rather than forms a view
from are still in the region for assistive technology without taking the eye.

### Phase 10

An adversarial reader was given the eighteen captured states and the four mocks
and asked to find what was wrong, with no knowledge of why any of it was written.
Some of what it returned was a matter of taste and was rejected: the terminal is
dark because the mock is, selection is a border because the mock's is, and blue
carries the working state rather than being chrome.

The rest was right and is fixed. The dialog was a second design system inside the
first: its own radius, its own padding, its own background, its own title size,
its own button metrics. It is a card that floats now. Controls came in four
heights across the toolbar, the header, the dialog and the terminal; there are
two now, a standard and a small, and both are tokens. `Phases 5 Tasks 1` was
four bordered boxes for four numbers, which is furniture; it is one line of
facts. And Record framed a card inside a card inside a card, which the picture
showed at a glance and the stylesheet did not.

The touch-target rule taught the lesson twice. Raising `min-height` on `button`
lost to `.rail-toggle` on specificity, so the control never grew. Raising the
token inside the media query raises every control at once and cannot lose,
because there is nothing to lose to.

### Phase 10, second pass

A second adversarial reader was given both viewports of all four tabs beside
their mocks. Most of what it returned was wrong in an instructive way: it read
the mock's invented data as a layout requirement and reported the Agents,
Artifacts and Record tabs as "completely broken" because the fixture has fewer
rows than the mock draws. A reviewer that cannot tell a fixture from a defect
will call every empty state a failure, so its findings were taken as claims to
check rather than as work to do.

What survived checking was the spacing. Twelve distinct off-scale values were in
the stylesheet: 3, 5, 7, 9, 11, 12, 13, 15, 18, 26, 28 and 96 pixels, sixty-four
declarations in all. Every one that is a padding, a margin or a gap now snaps to
the scale. The three that remain are measurements rather than choices: the rail
offset in the timeline, the gap between nodes in the graph flow, and the summary
that sits astride its own band border.

That is the difference the phase was for. A spacing scale nobody can enumerate is
not a scale, and now it can be enumerated by a script in one pass.
