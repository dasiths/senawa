---
title: Senawa v1 redesign plan
description: Sequenced plan to make an authored workflow drive real agents to completion, with a simpler authoring surface and a progressive portal
ms.date: 2026-08-16
ms.topic: concept-article
---

This plan turns [the brief](brief.md) into sequenced work, using the evidence in
[the research](research.md). It replaces the redesign-1 plan as the active
implementation source.

## Governing principle

The failure of the previous cycle was that every part was built and tested while
nothing ran. The parts were sound; the assembly was absent. This plan therefore
inverts the order: **get a real agent completing a real phase from an authored
file as early as possible, then deepen.**

Concretely, Phase 2 must end with a demonstration, not a test suite. Every phase
after it keeps that demonstration working.

A second principle follows from the ordering defects found in the portal: **a
fixture whose shape agrees with the implementation proves nothing.** Where a
phase adds behaviour, its tests must be built from a compiled real workflow
wherever that is possible.

## Progress

| Phase | Title | State |
|---|---|---|
| 0 | Settle the shape | In progress |
| 1 | An authored workflow becomes a run | Not started |
| 2 | One phase runs a real agent end to end | Not started |
| 3 | The consumer command line | Not started |
| 4 | Sensors, gates, and anchors | Not started |
| 5 | Human decisions and escalation | Not started |
| 6 | Fan-out and fan-in | Not started |
| 7 | Sessions and steering | Not started |
| 8 | The portal earns its density | Not started |
| 9 | Remove what the evidence condemns | Not started |
| 10 | Name it v1 and document it | Not started |
| 11 | Restore the loop engineering narrative | Not started |

## Phase 0: Settle the shape

Three decisions change the structure of everything after them, and each is
answerable with a spike rather than an opinion.

* [x] **Can fan-out members be phases, and can they stay grouped?** Proven by
  spike. `contains` already admits a phase inside a phase and `parentId` already
  accepts a phase, so a compiled graph of five phases with three members under
  `implement` renders the parent as a container with its members inside, in
  dependency order. `containerAssignment` resolves to the outermost phase
  ancestor and the layout builds one member level, so depth 1 groups today and
  deeper structure flattens rather than breaking.
* [ ] **Does the task layer survive?** Determine how deeply tasks are coupled to
  runner semantics, particularly task scopes and the claims the context broker
  binds against. Produce a written answer with references, and a recommendation.
* [ ] **What replaces `toolCallId` as the submission idempotency key?** Evaluate a
  client nonce, a senawa-issued attempt ordinal, and a content digest against
  replay, crash, and duplicate-delivery cases.
* [ ] **What does the authoring format look like?** Draft the three YAML documents
  for the standard delivery workflow and show, by compiling them, that they
  produce a graph the kernel accepts.

Exit when all four are written down with evidence and the last compiles.

## Phase 1: An authored workflow becomes a run

Close the first assembly gap. `compileWorkflowConfiguration` has no production
caller; a consumer's file must reach the authority.

* [ ] Define the v1 authoring format: agent definitions, workflow, and sensors as
  YAML, with schemas and input and output as JSON.
* [ ] Derive data mappings in the compiler by binding each named input property to
  the most recent earlier phase output that provides it, and generate the strict
  internal pointer pairs. Authors stop writing pointers.
* [ ] Collapse the six budget units to one enforced attempt counter per phase.
* [ ] Wire compilation into the run path so an authored workflow produces a
  configuration snapshot and an instantiated run.

Acceptance:

* [ ] A three-file authored workflow compiles and instantiates with no
  hand-computed digest.
* [ ] The generated document is under 150 lines with nesting depth no greater
  than 3.
* [ ] Refusals name the offending file, path, and reason.

## Phase 2: One phase runs a real agent end to end

The centre of the plan. Close the dispatch gap and the worker channel together,
because building the agent contract twice would be waste.

* [ ] Build the dispatch driver: read the lifecycle projection for phases awaiting
  completion, evaluate input mappings, build the phase attempt, worker context,
  and dispatch, derive completion requirements from the graph, and call
  `registerDispatch` with an effect seed. Every primitive exists and is tested.
* [ ] Give the worker a scoped identity by porting the context broker's existing
  model — per-dispatch principal, capability set, exact binding, expiry — onto
  the command channel. A worker must not be able to approve, reject, mark done,
  steer, or end a run.
* [ ] Expose the worker operations over a local API and a command line: discover
  the output schema, submit output, request completion, ask a question, escalate.
* [ ] Add a minimal `senawa start` sufficient to trigger a run.

Acceptance:

* [ ] From a clean repository, an authored workflow drives a real Copilot agent
  through one phase to a granted completion.
* [ ] The artifacts and transcript survive a process restart.
* [ ] A scripted agent with no model completes the same loop, keeping the path
  testable without credits.
* [ ] A worker attempting a human authority operation is refused, and the refusal
  is recorded.

## Phase 3: The consumer command line

* [ ] `senawa start workflow.yaml input.json` blocks by default and streams events
  and agent output, with a non-blocking argument.
* [ ] Run-level status, phase inspection, and artifact reading.
* [ ] `senawa run-gates <workflow> <phase>` so an agent, or a human, can
  self-check.

Acceptance:

* [ ] The complete loop is drivable from the command line with no portal running
  and no hand-computed values.

## Phase 4: Sensors, gates, and anchors

Completion becomes granted rather than claimed, which is the property the product
exists to provide.

* [ ] Execute consumer-declared sensors through the proven process sensor, under
  the existing environment allowlist and containment.
* [ ] Produce sensor readings in production, carrying provenance so the kernel can
  tell a measured result from an asserted one.
* [ ] Add the anchor invariant: a blocking gate requires at least one
  deterministic reading. Reject at compile time a blocking gate that cannot have
  one.
* [ ] Give the git command port an argv allowlist before any consumer-authored
  sensor can reach it.

Acceptance:

* [ ] A failing test refuses a phase and returns actionable reasons.
* [ ] A gate declaring no blocking sensor is rejected when authored rather than
  passing vacuously.
* [ ] A sensor cannot read the environment or escape the workspace.

## Phase 5: Human decisions and escalation

* [ ] Build escalation. It is currently unreachable, so this is new work, and it
  must remove the strand where a permanently failing member leaves a phase with no
  route to a gate, closure, or escalation.
* [ ] Approve and reject with reasons, where the reasons become the next
  iteration's input for the same agent.
* [ ] Record every human decision with who decided, when, and on what reasoning.

Acceptance:

* [ ] A rejected phase re-runs with the reasons supplied.
* [ ] An agent that cannot satisfy its gates escalates rather than stalling.
* [ ] No reachable state leaves a run neither completing nor escalating.

## Phase 6: Fan-out and fan-in

* [ ] Generalise the output side of fan-out along the Phase 0 decision, so a
  member can nest to a bounded depth and carry its own gates and approval.
* [ ] Honour a per-phase failure policy, including proceeding with the members
  that passed.
* [ ] Let a human mark a member done over red gates, recorded as an explicit
  authority decision that stays visible in history and reports.
* [ ] Let a human supply steering or instructions to a stuck member.

Acceptance:

* [ ] A plan phase computes a collection and later members run their own loops
  sequentially, grouped under their parent phase in the portal.
* [ ] Three failing members do not block the remaining seven under a continue
  policy.
* [ ] A human override is visible in the report.

## Phase 7: Sessions and steering

* [ ] Make session scope a declared property of an agent, defaulting to durable
  across phases and fresh per fan-out element. Today's resume is a
  strict-equality replay guard that cannot span phases, so this replaces it.
* [ ] Widen the SDK port so `MessageOptions.mode` is expressible, and hold the
  live session handle where steering can reach it.
* [ ] Deliver steering from the portal and the command line, scoped to a running
  agent instance, recorded durably before delivery.
* [ ] Record session identity and turn position on dispatch records, and treat
  session loss as an explicit degrading event rather than a silent restart.
* [ ] Bound context growth by retention or compaction, as authority-visible
  policy.

Acceptance:

* [ ] A human steers a running agent mid-turn and the run history explains why
  the agent changed course.
* [ ] A long run does not grow its context without bound.

## Phase 8: The portal earns its density

* [ ] Keep the graph, the terminal, the question banner, and the review dialog as
  the primary surface.
* [ ] Move behind progressive disclosure: the authority sync vector, raw event and
  receipt trees, whole-record amendment dumps, delivery and workspace tabs,
  effect counters, full digests, and the pending receipts rail.
* [ ] Stop fetching needs, events, and receipts on every route change.
* [ ] Add an agent-pool view so a human can watch the team work, not only the
  graph.
* [ ] Let approval, rejection, and steering be driven by pointing and clicking.

Acceptance:

* [ ] The default view shows the workflow and the working agent.
* [ ] Evidence, assets, and sensor readings are reachable in one action and absent
  until asked for.

## Phase 9: Remove what the evidence condemns

* [ ] Delete or implement the three unimplemented intents.
* [ ] Remove the unenforced budget units and the code that pretends to plan
  against them.
* [ ] Remove unreachable paths the research identified, including the dead resume
  binding.
* [ ] Compile out the workspace fault-injection path from production builds.

Acceptance:

* [ ] No exported symbol in production packages lacks a production caller unless
  it is a documented extension seam.
* [ ] Boundary and dependency checks still pass.

## Phase 10: Name it v1 and document it

* [ ] Remove alpha from versions, package metadata, and prose.
* [ ] Rewrite the consumer guides around the three-file authoring model and the
  command line loop.
* [ ] Rewrite the design set to describe what exists after this plan.
* [ ] Record which contracts were accepted, changed, disproved, or deferred.

## Phase 11: Restore the loop engineering narrative

The README on `main` carries the ideas that explain why the product is shaped the
way it is, and the redesign dropped them. They belong back once the system can
actually demonstrate them.

* [ ] Restore the three nested loops, naming who runs each, over what period, and
  where the human sits.
* [ ] Restore the vocabulary the design depends on: sensor, gate, anchor, and
  frozen set, each defined where a reader first meets it.
* [ ] Restore backpressure as the organising idea, with completion granted rather
  than claimed shown against the implementation that now does it.
* [ ] Restore the loop engineering and graph-of-loops references, and state plainly
  what keeps the system honest: deterministic sensors that execute real code, a
  journal no agent can write, a frozen set the optimizer cannot weaken, and a
  human who decides what better means.
* [ ] Sweep every document for claims the implementation no longer supports, and
  for capabilities it gained that nothing describes.
* [ ] Record which of the original design's promises v1 keeps, changes, or drops.

Acceptance:

* [ ] A reader who has never seen the project understands the three loops and the
  backpressure model from the README alone.
* [ ] Every vocabulary term used in the design set is defined once and used
  consistently.
* [ ] No document describes behaviour the code does not have, verified by
  checking each testable claim.

## Cross-cutting: continuous integration

Every gate in this repository is currently manual; there is no pipeline. A change
of this size should not rely on remembering to run them.

* [ ] Land a pipeline running build, typecheck, lint, tests, boundaries,
  documentation links, and the browser matrix, no later than Phase 2, when the
  first end-to-end path exists to protect.

## Deferred with reasons

| Item | Reason |
|---|---|
| Replacing the whole-history durable mirror | Cost grows with history depth, which is orthogonal to whether the loop runs. The incremental seam already exists |
| Parallel agents and worktree isolation | The brief chooses sequential execution for v1. Keep the worktree seam, build nothing on it |
| A local MCP server | Worth offering over the same command surface later. It must never become a second authority path |
| Fan-out nesting beyond the configured bound | Depth stays a bounded parameter so the limit is configuration rather than an assumption |

## What done looks like

A consumer authors three YAML files and a JSON input, runs one command, and
watches an agent pool drive a multi-phase workflow to completion. Gates refuse
work that does not measure up. Agents escalate rather than stalling. A phase fans
out over a computed collection. The human approves only where declared, steers
when they want to, and can unstick a member without hiding that they did. The
same run is observable and approvable in the portal. None of it requires a
fourteen-key configuration file or a line of TypeScript.
