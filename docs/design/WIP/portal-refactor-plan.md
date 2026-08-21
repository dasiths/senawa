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
and restore pairs already fight it. The redesign adds fold state, selection,
sub-tab and expanded rows, which would make six.

* [ ] View state is one record that rendering reads and never derives
* [ ] The existing capture pairs move into it rather than sitting beside it
* [ ] An explicit fold survives a poll
* [ ] Selection survives a poll and a sub-tab change

Done when a fold, a selection and a scroll position all survive a refresh with no
per-concern capture code.

## Phase 3: the workflow reads as a graph

Edges already carry containment, dependency and supersession. Nodes already carry
run state, attempt and need counts. Artifacts already carry the task that
produced them. This is layout and rendering.

* [ ] `Workflow` carries `Graph` and `Tree` over one selection, graph first
* [ ] Edges are measured from laid-out boxes, not authored as coordinates
* [ ] An artifact renders on the edge leaving the node that produced it
* [ ] A carried edge is distinguishable from one not yet carried
* [ ] A phase folds when its last member lands, and unfolds while work remains
* [ ] An edge whose endpoint is folded away attaches to the group instead

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
