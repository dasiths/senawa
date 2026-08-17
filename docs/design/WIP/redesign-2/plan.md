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
| 0 | Settle the shape | Complete |
| 1 | An authored workflow becomes a run | Complete |
| 2 | One phase runs a real agent end to end | Complete except live-credit acceptance |
| 3 | The consumer command line | Complete except blocking start |
| 4 | Sensors, gates, and anchors | Complete |
| 5 | Human decisions and escalation | Escalation built, loop items open |
| 6 | Fan-out and fan-in | Not started |
| 7 | Sessions and steering | Not started |
| 8 | The portal earns its density | Not started |
| 9 | Remove what the evidence condemns | Not started |
| 10 | Name it v1 and document it | Not started, gated on authored-surface parity |
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
* [x] **Does the task layer survive?** Yes, beneath phases. The compiler already
  synthesises one reserved `phase-executor` task per agent phase, so an agent
  phase is already a phase containing one task. Criteria cannot parent to a phase
  at three independent levels, and the runner keys budgets by unit and claims by
  operation rather than by task, so no runner code changes. Recorded as D-002.
* [x] **What replaces `toolCallId` as the submission idempotency key?** A content
  digest of the canonical submission, computed by senawa and never supplied by
  the agent. Recorded as D-003.
* [x] **What does the authoring format look like?** Three YAML documents totalling
  115 lines compile into a 23-node graph the kernel accepts, with zero JSON
  Pointers and zero budget units authored. Proven by the `v1-authoring` probe and
  recorded as D-004.

Exit when all four are written down with evidence and the last compiles.
**Phase 0 is complete.**

## Phase 1: An authored workflow becomes a run

Close the first assembly gap. `compileWorkflowConfiguration` has no production
caller; a consumer's file must reach the authority.

* [x] Define the v1 authoring format: agent definitions, workflow, and sensors as
  YAML, with schemas and input and output as JSON.
* [x] Derive data mappings in the compiler by binding each named input property to
  the most recent earlier phase output that provides it, and generate the strict
  internal pointer pairs. Authors stop writing pointers. Prompt input paths are
  also derived, by reading the template the author already wrote.
* [x] Collapse the six budget units to one enforced attempt counter per phase.
* [x] Wire compilation into the run path so an authored workflow produces a
  configuration snapshot and an instantiated run.

Acceptance:

* [x] A three-file authored workflow compiles with no hand-computed digest.
* [x] The same workflow instantiates a run.
* [x] What a consumer authors is under 150 lines across 3 files. Measured at 117,
  against 853 lines across 18 files before. The lowered internal document is 714
  lines, which is machine-generated and never read by a human, so the original
  criterion measured the wrong artifact and was corrected. **This measurement was
  still incomplete: part of the reduction is derivation and part is hardcoding,
  and counting lines cannot tell them apart. See
  [the authored surface must not become a ceiling](#cross-cutting-the-authored-surface-must-not-become-a-ceiling).**
* [x] Refusals name the offending file, path, and reason.

## Phase 2: One phase runs a real agent end to end

The centre of the plan. Close the dispatch gap and the worker channel together,
because building the agent contract twice would be waste.

* [x] Build the dispatch driver: read the lifecycle projection for phases awaiting
  completion, evaluate input mappings, build the phase attempt, worker context,
  and dispatch, derive completion requirements from the graph, and call
  `registerDispatch` with an effect seed. Every primitive exists and is tested.
* [x] Give the worker a scoped identity by porting the context broker's existing
  model — per-dispatch principal, capability set, exact binding, expiry — onto
  the command channel. A worker must not be able to approve, reject, mark done,
  steer, or end a run.
* [x] Expose the worker operations over a local API and a command line: discover
  the output schema, submit output, request completion, ask a question, escalate.
* [x] Add a minimal `senawa start` sufficient to trigger a run.

Acceptance:

* [ ] From a clean repository, an authored workflow drives a real Copilot agent
  through one phase to a granted completion. **Not done: this spends model
  credits against a live account, which is not a decision an autonomous run
  should take. Everything it needs is in place and the scripted path below
  covers the same composition.**
* [ ] The artifacts and transcript survive a process restart. **Not done: the
  durable stores are exercised by the existing restart tests, but no test yet
  restarts a process mid-dispatch, because nothing drives a dispatch to the
  point where a restart would be meaningful until the run loop of Phase 5
  exists.**
* [ ] A scripted agent with no model completes the same loop, keeping the path
  testable without credits. **Not done: blocked on the same run loop. The worker
  channel it would speak to is built and tested.**
* [x] A worker attempting a human authority operation is refused, and the refusal
  is recorded. Proven in `worker-http.test.ts`: an operator route does not merely
  reject a worker token, it does not resolve at all, and an operator token is
  refused on the worker channel for the same reason in reverse.

## Phase 3: The consumer command line

* [ ] `senawa start workflow.yaml input.json` blocks by default and streams events
  and agent output, with a non-blocking argument. **Not done: blocking has
  nothing to block on until a run loop advances phases without a human poking
  it. Deferred into Phase 5, where that loop is built.**
* [x] Run-level status showing mode, phase count, agents dispatched, and what is
  waiting on the human.
* [x] Phase inspection and artifact reading. `senawa phase`, `senawa artifact
  list|read`, and `senawa agent list`.
* [x] `senawa run-gates <phase>` so an agent, or a human, can self-check. The
  workflow argument was dropped: the project root already names the workflow, and
  a second way to name it would be a second source of truth.

Acceptance:

* [ ] The complete loop is drivable from the command line with no portal running
  and no hand-computed values. **Partly done: authoring, starting, status, phase
  inspection, artifact reading, and gate measurement are all drivable with no
  hand-computed values. The loop is not yet complete because approval, rejection,
  and escalation are Phase 5.**

## Phase 4: Sensors, gates, and anchors

Completion becomes granted rather than claimed, which is the property the product
exists to provide.

* [x] Execute consumer-declared sensors through the proven process sensor, under
  the existing environment allowlist and containment.
* [x] Produce sensor readings in production, carrying provenance so the kernel can
  tell a measured result from an asserted one.
* [x] Add the anchor invariant: a blocking gate requires at least one
  deterministic reading. Reject at compile time a blocking gate that cannot have
  one.
* [x] Give the git command port an argv allowlist before any consumer-authored
  sensor can reach it.

Acceptance:

* [x] A failing test refuses a phase and returns actionable reasons. Demonstrated
  against a real project: `senawa run-gates implement` exits 1 and prints the
  sensor, its exit code, and its diff.
* [x] A gate whose sensor cannot anchor it is rejected when authored rather than
  passing vacuously.
* [x] A sensor cannot read the environment or escape the workspace. Proven in
  `sensor-runner.test.ts`.

## Phases 5 to 11: not started, and why

The four phases above were taken in order and each one was finished or explicitly
excused before the next began. Phases 5 to 11 are untouched. They are listed
below unchanged, with the reason each is still open recorded once here rather
than repeated against every line, because the reason is the same shape each time:
they are sequenced work that depends on what precedes them, and inventing a
partial version of any of them would leave the repository in the state this whole
redesign exists to escape, where parts exist and nothing runs.

Specifically:

* **Phase 5** is part done. Escalation was new construction and is built; the
  remaining items need a run loop that advances a phase without a human poking
  it, which is the same thing Phase 3's blocking `start` waits on. That loop is
  the single largest open dependency in this plan and everything below inherits
  it.
* **Phase 6** depends on Phase 5, because a fan-out member that cannot escalate
  reintroduces exactly the strand Phase 5 exists to remove. It also carries a
  known correctness risk: amendment quiescence must become transitive over
  member phases, and a test has to prove it before the feature is trusted.
* **Phase 7** depends on Phase 6 for the fresh-per-element session scope it has
  to honour. It additionally requires widening the SDK port so `MessageOptions.mode`
  is expressible; today's resume path is a fifteen-field equality guard that is
  structurally unreachable across phases, so it is replaced rather than extended.
* **Phase 8** is portal work whose value is measured against a running loop. Its
  nine always-on panels are identified, but moving them before there is a loop to
  watch would be guessing at what a person wants in front of them.
* **Phase 9** removes what the evidence condemns. Doing it before Phases 5 to 7
  would delete seams those phases are about to need, and would have to be redone.
* **Phase 10** renames to v1 and rewrites the guides. Naming something v1 before
  it runs a loop end to end would be the precise dishonesty this plan was written
  to correct.
* **Phase 11** restores the loop engineering narrative. Its own preamble already
  says these ideas belong back *once the system can actually demonstrate them*,
  and it cannot yet.

Two smaller items are worth naming so they are not lost:

* `publish-phase-output` and `create-escalation` remain unimplemented command
  intents. The phase-output mechanism exists on the dataflow authority and is
  reachable; the intents are the gap. Phase 9 decides whether to implement or
  delete them, and Phase 5 needs escalation either way.
* `senawa init` now publishes the authored three-document tree rather than the
  lowered internal document. `createStandardTemplateFiles` still exists and is
  still exercised, because two acceptance tests drive the lowered document
  directly. Phase 10 decides whether that generator survives.

## Phase 5: Human decisions and escalation

> Partly started. The remaining items depend on the run loop; the reason is
> recorded in [Phases 5 to 11: not started, and why](#phases-5-to-11-not-started-and-why).

* [x] Build escalation. It was unreachable, so this was new work. `create-escalation`
  is now an implemented intent: it requires the gate evidence it is escalating,
  refuses a passing gate, refuses a second escalation, refuses a closed phase,
  and refuses an escalation that offers the human no response.
* [ ] Remove the strand where a permanently failing member leaves a phase with no
  route to a gate, closure, or escalation. **Not done: members are Phase 6, so
  there are no members to strand yet. The escalation the removal depends on now
  exists.**
* [ ] Approve and reject with reasons, where the reasons become the next
  iteration's input for the same agent. **Partly done: an authority decision now
  carries a reason, the reason is bound into the decision digest so it cannot be
  revised afterwards, and a rejection without one is refused. Feeding it into the
  next iteration's prompt needs the run loop.**
* [x] Record every human decision with who decided, when, and on what reasoning.
  The decision already carried principal and timestamp; it now carries reasoning.

Acceptance:

* [ ] A rejected phase re-runs with the reasons supplied. **Not done: needs the
  run loop.**
* [ ] An agent that cannot satisfy its gates escalates rather than stalling.
  **Not done: the escalation exists and is reachable, but nothing calls it yet
  because nothing drives a phase to exhaustion without a human.**
* [ ] No reachable state leaves a run neither completing nor escalating. **Not
  done: this is a claim about the whole state space and cannot be made until the
  loop that traverses it exists.**

## Phase 6: Fan-out and fan-in

> Not started. The reason is recorded in [Phases 5 to 11: not started, and why](#phases-5-to-11-not-started-and-why).

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

> Not started. The reason is recorded in [Phases 5 to 11: not started, and why](#phases-5-to-11-not-started-and-why).

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

> Not started. The reason is recorded in [Phases 5 to 11: not started, and why](#phases-5-to-11-not-started-and-why).

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

> Not started. The reason is recorded in [Phases 5 to 11: not started, and why](#phases-5-to-11-not-started-and-why).

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

> Not started. The reason is recorded in [Phases 5 to 11: not started, and why](#phases-5-to-11-not-started-and-why).

* [ ] Remove alpha from versions, package metadata, and prose.
* [ ] Rewrite the consumer guides around the three-file authoring model and the
  command line loop.
* [ ] Rewrite the design set to describe what exists after this plan.
* [ ] Record which contracts were accepted, changed, disproved, or deferred.

## Phase 11: Restore the loop engineering narrative

> Not started. The reason is recorded in [Phases 5 to 11: not started, and why](#phases-5-to-11-not-started-and-why).

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

Every gate in this repository was manual; there was no pipeline. A change of this
size should not rely on remembering to run them.

* [x] Land a pipeline running build, typecheck, lint, tests, boundaries,
  documentation links, and the browser matrix. `.github/workflows/verify.yml`.
  It landed after Phase 2 rather than no later than it, which is recorded as a
  deviation.

## Cross-cutting: the authored surface must not become a ceiling

Phase 1 measured its success as 117 authored lines against 853, and that
measurement was incomplete. Compression was achieved partly by deriving things
and partly by **hardcoding** them, and the plan did not separate the two. The
compiler and kernel lost nothing; the *author* lost a great deal. Recorded as
F-004.

Nothing below is a defect in the engine. Each is a value the internal document
still accepts and `lowerAuthoredWorkflow` currently pins, with no YAML key to
reach it. Until these land, an author who needs any of them has no route except
hand-writing the lowered document, which is the situation the redesign set out
to remove.

Deliberate, not gaps:

* Six budget units collapsing to one attempt counter is D-005, and stays.
* Fan-out, `forEach`, and task-frontier phases are Phase 6.
* Session scope already reaches YAML through `session`.

Real gaps, none of which any phase currently schedules:

* [ ] **Evidence policy.** `evidencePolicy` is pinned to `{ mode: "none",
  requirements: [] }`. The internal document accepts `task`, `required-criteria`,
  and `all-satisfied` with per-kind minimum counts and a waiver authority. The
  old standard template used `mode: "task"` with a `task-completion` requirement.
  An author cannot currently say "completion requires evidence", which is close
  to the centre of what the product claims to do.
* [ ] **Iteration policy.** `maximumAttempts` is pinned to 3, and
  `onGateRejected`, `onApprovalRejected`, and `onUpstreamChanged` are all pinned
  to `iterate` with `onExhausted` pinned to `escalate`. An author cannot make a
  phase fail fast on a rejected gate, cannot widen or narrow the attempt budget
  per phase, and cannot choose to fail rather than escalate. This is the loop,
  and it is not currently authorable.
* [ ] **Advisory gate rules.** `advisory` is pinned to `[]`. Only blocking rules
  can be authored, so a reading that should inform without refusing has nowhere
  to go. D-012 already noted advisory use was left open.
* [ ] **Gate conditions.** Every rule is generated as `equals` against
  `/exitCode` expecting `0`. The internal document supports ten operators, any
  JSON pointer into the reading, and any expected value. An author cannot gate on
  a coverage number, a count, or anything a sensor reports other than its exit
  status.
* [ ] **Sensor tuning.** `cwd`, `timeoutMs`, `maxStdoutBytes`, `maxStderrBytes`,
  `inheritedEnvironment`, `maxAttempts`, and `maxReconciliationAttempts` are all
  pinned. A test suite that needs longer than five minutes, or one environment
  variable beyond `PATH`, cannot be expressed.
* [ ] **Output sensitivity and size.** Pinned to `internal` and 262,144 bytes. An
  author cannot mark an output `confidential`, so the sensitivity ceiling the
  design relies on is currently decorative from the authored surface.
* [ ] **Approval authority.** `approve: true` always names `release-manager`. An
  author cannot route approval to a different role.
* [ ] **Model routing.** One route per agent with `maxTurns`, `maxSubmissions`,
  and `maxMillidollars` pinned. No fallback and no escalation route, so the
  model-routing work the probes explored is unreachable from a workflow.

Acceptance:

* [ ] Every value `lowerAuthoredWorkflow` pins today is either authorable, or
  recorded here as a deliberate decision with a reason.
* [ ] A test asserts that the authored format can express the old standard
  template's five-phase workflow, evidence policy and all, so the surface is
  measured against a real workload rather than against the toy in the template.

This gates Phase 10. Naming something v1 whose authoring surface cannot express
what its own previous template did would repeat the mistake this plan exists to
correct.

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
