# Portal redesign: gap analysis

This compares the redesigned portal in [the mocks](portal-redesign-mocks/) with
what the system can actually do today, and separates the work into three kinds:
rendering we can do now, projection we can add cheaply, and capture we do not
have at all.

The argument for the redesign is in
[the simplification analysis](portal-simplification.md). This document does not
repeat it. It asks a narrower question: what has to be true underneath before
each promise in the mocks can be kept.

## How this was verified

Every claim below was read from source rather than inferred. Where something
does not exist, the search that found nothing is named so the claim can be
rechecked when the code moves.

## The verdict

Of seven gaps, one needs data we never capture, two need a projection that
carries a name or a link we already hold, and four are rendering work against
contracts that already exist.

| Gap | The mock promises | Today | Kind of work |
| --- | --- | --- | --- |
| G1 | The agent narrates what it is doing | Only tool names and lifecycle notes are recorded | Capture, storage, protocol |
| G2 | Every task has a human name | Every phase task is named `phase-executor` | Compiler and projection |
| G3 | A dependency graph with fan-out and joins | Nodes and typed edges are already served | Rendering |
| G4 | Escalations render on the node that raised them | Needs already carry a task id, unevenly | Projection |
| G5 | Phases fold, and what a reader opened stays open | The renderer replaces the whole tree each poll | Portal architecture |
| G6 | Tables whose detail loads on click | Every collection is already paginated | Rendering |
| G7 | Answering and steering from the same surface | The commands already exist | Rendering |

G1 is the only one that cannot be started as a portal change. Everything else
can proceed against contracts that are already shipped.

## G1: the agent has no voice to render

### What the mocks assume

The `Live` pane shows the agent explaining itself: what it read, what it decided,
why it stopped to ask. Lines are coloured by kind, so narration, tool calls,
failures and questions are distinguishable at a glance.

### What is actually recorded

The SDK session is created with streaming switched off, in two places that must
agree:

* `packages/execution-host/src/copilot-sdk-port.ts:54` declares
  `readonly streaming: false`, so the port's type forbids any other value.
* `packages/execution-host/src/copilot-worker.ts:441` passes `streaming: false`
  alongside `includeSubAgentStreamingEvents: false`.

Nothing subscribes to session events. Searching the execution host for `.on(`
returns only child-process pipes in `workspace-files.ts`, `process-sensor.ts` and
`configuration-resource-files.ts`. The session is driven by a single blocking
`sendAndWait`, and `CopilotSdkSessionPort` exposes no subscription method at all.

Durable transcript lines are constrained to three channels.
`packages/storage-sqlite/migrations/001-baseline.sql:37` reads:

```sql
stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'system')),
```

In practice only `system` is written, and only from
`transcriptNoteSink()`. A whole run produced sixteen lines, all of the form
`session started`, `tool senawa_complete success`, `session paused`. The agent's
own prose survives in exactly one field: the `prompt` on a question.

### What the SDK offers

With `streaming: true` the session emits a documented event stream. The events
that matter for this pane, and the line kind each would drive:

| Event | Persisted | Renders as |
| --- | --- | --- |
| `assistant.message` | yes | Narration, the agent in its own words |
| `assistant.message_delta` | no | The same text arriving live, for tailing only |
| `assistant.reasoning` | yes | Thinking, folded by default |
| `assistant.intent` | no | A one-line status while a step is in flight |
| `tool.execution_start` | yes | A tool call with its arguments |
| `tool.execution_complete` | yes | Success or the refusal text |
| `permission.requested` | yes | A stop that needs a decision |
| `user_input.requested` | no | The question, which we already capture separately |
| `session.error` | yes | A failure line |
| `session.shutdown` | yes | The end of a session, with code-change totals |

### The decisions this forces

Persisted and ephemeral are not interchangeable. Delta events are explicitly not
replayed when a session resumes, so a record built from deltas would have holes
wherever a worker restarted. The durable transcript must be assembled from the
persisted events, and the deltas used only to make a live view feel live. That
distinction should be visible in the schema rather than discovered later.

Three further points need deciding before any code moves:

1. The current line shape cannot hold prose. Lines are capped at 4096 bytes and
   forbidden from containing newlines, which suits `tool X success` and defeats a
   paragraph. Either lines gain a block form, or assistant messages get their own
   table keyed by `messageId`.
2. Sub-agent output shares the parent stream and is distinguished only by an
   envelope-level `agentId`. We currently set `includeSubAgentStreamingEvents`
   to false. Turning it on changes what a transcript means, so it is a separate
   decision from turning streaming on.
3. Assistant prose is untrusted text that will be rendered in a browser and may
   quote repository contents. The sensitivity classification that already governs
   artifacts has no equivalent for transcript lines.

Until this lands, a terminal-styled pane is a system log in a monospace font,
which is worse than the table it replaces because it implies a conversation that
is not there. The mocks say so, and the invented lines in them are marked.

## G2: tasks are named after the machinery that made them

### Where the name is lost

`packages/configuration/src/compiler.ts:1748` gives every agent phase executor
the same literal key:

```ts
key: "phase-executor",
```

`packages/storage-sqlite/src/index.ts:4888` then derives every display name from
that key:

```ts
return new Map(graph.nodes.map((node) => [node.definition.id, node.definition.key]));
```

So `taskName` is not missing. It is plumbed end to end, through
`PortalAgentSummary.taskName` at `packages/protocol/src/portal-contracts.ts:446`,
through the codec, and into `packages/portal/src/render.ts:1598`. It is simply
fed a structural key instead of a name.

### The name already exists for fan-out members

`.senawa/schemas/task.schema.json` requires a `title` on every planned task, up
to 256 characters. Every fan-out member therefore has a human name sitting in the
plan artifact it was materialised from. It is not projected onto the node.

### The constraint that shapes the fix

The key is identity. It feeds `definition.id`, which feeds digests, which feed
graph revisions and every comparison that detects an added, changed or removed
task across replans. Renaming `phase-executor` to something readable would change
the identity of every node in every existing run.

The fix must therefore add a title beside the key rather than change the key, and
`#nodeNames` must prefer the title and fall back to the key. That leaves two
pieces of work: carry the plan item's existing title onto member nodes, and give
phase executors an authored title in the workflow definition (defaulting to
something derived from the phase, so existing workflows keep working).

This is the highest-value gap for the least risk. Steering is a decision about
one piece of work, and today four members render as four identical rows.

## G3: the graph needs no new data

`PortalGraphEdge` at `packages/protocol/src/portal-contracts.ts:159` already
carries exactly the distinction the graph view is built on:

```ts
export type PortalGraphEdgeKind = "containment" | "dependency" | "supersession";
```

`PortalGraphNode` already carries `runState`, `lifecycle`, `attempt`,
`parentNodeId`, `dispatchId`, `humanNeedCount` and `evidenceCount`. Both
collections are already served and paginated, at
`packages/portal/src/transport.ts:150` and `:162`, two hundred at a time.

The artifact-on-the-edge idea also survives contact: `PortalArtifactMetadata` at
`packages/protocol/src/portal-contracts.ts:375` carries an optional `taskId`, so
an output can be placed on the edge leaving the node that produced it.

What remains is layout and rendering. The mocks measure edges from the laid-out
boxes after render rather than authoring coordinates, which is the approach that
survives wrapping, folding and renaming, and it needs no server support.

One caveat: the mocks derive an edge's carried or uncarried state from whether
the upstream node is closed. That is a rendering rule over data we already have,
not a claim the record makes, and it should stay that way.

## G4: needs mostly know their node already

`PortalHumanNeed` at `packages/protocol/src/portal-contracts.ts:282` carries an
optional `taskId`, and `PortalQuestionSource` carries both `taskId` and
`dispatchId`. Questions can therefore already be rendered on the node that asked.

Allowance escalations are the weaker case. `PortalAllowanceReview` carries
`escalationCommandId`, `operationId`, `unit` and the numbers, but reaches its
task only indirectly, through the need's `sourceId` and optional `taskId`. The
mock puts the escalation on `write the check script` with the spend visible.
Making that reliable means deciding whether `taskId` is guaranteed for the
escalation kind, or whether the review should carry the dispatch itself.

The gap here is not new data. It is a guarantee: which need kinds always name a
node, and what a view is supposed to do with one that does not.

## G5: nothing remembers what the reader opened

This is the gap the mocks exposed by accident, and it is the one most likely to
be underestimated.

`renderPortal` at `packages/portal/src/render.ts:107` ends with:

```ts
root.replaceChildren(shell);
```

Every poll rebuilds the entire tree. The existing code already fights this, with
four hand-written capture and restore pairs around the replacement: focus
identity, transcript scroll, dialog values, and the command narrator. Each is a
piece of view state that a full replacement would otherwise destroy.

The redesign adds more of exactly that kind of state: which phase is folded,
which node is selected, which sub-tab is showing, and which table rows have been
expanded. Adding a fifth and sixth capture pair is not a design, it is a symptom.

Two honest options. Either the portal keeps an explicit view-state record that
rendering reads from and never derives, or rendering becomes incremental so that
untouched subtrees survive a poll. The first is smaller and fits the existing
shape. The second is what the growing list of capture pairs is asking for.

There is a related question the fold rule raises directly. The rule is that a
phase is open while anything in it is running, which is derived and needs no
storage, but an explicit fold by a reader has to outlive the next poll. That is
view state with a lifetime, and today there is nowhere for it to live.

## G6: lazy detail is already possible

Nothing blocks the table-with-lazy-rows pattern. Delivery is paginated at 256
records, transcript is paginated per owner with bounded retention, artifact
content is fetched by offset and length, and records are fetched by digest.
The portal already polls on a ten second interval, with a one second cadence
while a receipt is outstanding, at `packages/portal/src/app.ts:51`.

The current cost is a rendering choice rather than a transport limit: activity
renders every event fully expanded. Moving to a row per event with detail fetched
on open is portal-local work.

## G7: answering and steering already have commands

`POST /api/v1/commands` accepts `answer-question`, `grant-allowance` and
`steer-agent`, and the portal already submits through
`packages/portal/src/transport.ts:293`. The redesign changes where a person types
and what they can see while typing, not what is sent.

The only new requirement comes from G1: the reply box is attached to the bottom
of the transcript, so the transcript has to be worth attaching it to.

## What we already have, and should not rebuild

* Server-sent events exist. `packages/supervisor/src/http-handler.ts:774` sets
  `text/event-stream`, and `packages/portal/src/sse.ts` consumes it with cursor
  based reconnection and a five hundred event buffer. The stream carries run
  lifecycle events, not transcript lines, so G1 has a delivery path waiting for
  it rather than needing a new one.
* Every collection the redesign wants as a table is already paginated.
* The four routes already match the mocks:
  `packages/portal/src/router.ts` lists `workflow`, `record`, `artifacts`,
  `agents`.
* Browser coverage already exercises agent display, steering, need actions,
  transcript following and graph traversal, across six Playwright specs.

## Suggested ordering

G2 first. It is the smallest change with the largest effect on whether any of the
rest is usable, because a surface that cannot name the thing you are about to
redirect is not safe to act on.

G5 next, because both the graph and the tables depend on view state surviving a
poll, and because retrofitting it after two more capture pairs exist is worse.

G3 and G6 follow, in either order. Both are rendering against contracts that
already hold.

G4 alongside them, as a guarantee to tighten rather than a feature to build.

G1 is independent and much larger. It can start at any time and should not block
the others, but no part of the terminal experience should ship before it, because
a pane that promises narration and delivers a tool log is a regression.

G7 lands last, since it is the assembly of the rest.

## Open questions for the plan

1. Do assistant messages become a new stream value on `agent_transcript_lines`,
   or their own table? The newline and length constraints suggest the latter.
2. Do we persist reasoning at all, given it is model-specific, sometimes
   encrypted, and session-bound?
3. Does turning on streaming change worker back-pressure or durability
   guarantees, and what happens when the writer cannot keep up?
4. Do sub-agent events enter the transcript, and if so, how does a reader tell
   whose voice they are reading?
5. Is `taskId` guaranteed on an escalation need, or does the view need a fallback
   for a need with no node?
6. Does view state live in the portal only, or does anything about it need to
   survive a reload?
