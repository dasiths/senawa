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

## Phase 4: tables that load their detail on click

Activity renders every event fully expanded. Every collection it needs is already
paginated.

* [ ] Record and Artifacts render one row per thing
* [ ] Row detail is fetched when the row is opened, never up front
* [ ] Opening a row shows that it is loading

## Phase 5: a need always names its node

Questions already carry a task and a dispatch. Allowance escalations reach their
task only indirectly.

* [ ] Decide whether an escalation guarantees a task, or carries its dispatch
* [ ] A need that cannot name a node has a defined rendering

## Phase 6: capture what the agent says

The largest phase, and the only one that needs data we do not record.

* [ ] Decide the storage shape for prose, given lines cannot hold newlines
* [ ] Turn streaming on and subscribe to the persisted events
* [ ] Build the durable transcript from persisted events, never from deltas
* [ ] Use deltas for live tailing only
* [ ] Decide whether sub-agent events enter the transcript, and how they read
* [ ] Classify transcript sensitivity the way artifacts are classified

## Phase 7: answering feels like answering the agent

* [ ] The reply box attaches to the transcript it answers
* [ ] Steering uses the same surface, because it interrupts the same thing
* [ ] An escalation is granted from the node that raised it

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
