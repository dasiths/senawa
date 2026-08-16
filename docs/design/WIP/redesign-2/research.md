---
title: Senawa v1 redesign research
description: Verified findings on what the current implementation does, what it cannot do, and which parts of it should survive v1
ms.date: 2026-08-16
ms.topic: concept-article
---

This document records what the implementation on `redesign/workflow-state-machine`
actually does, established by reading and running the code rather than its
documentation. It is written against [the v1 brief](brief.md) and is the evidence
base for [the plan](plan.md).

The headline finding is not that the system is wrong. Its parts are unusually
well built, individually tested, and in several cases proven under fault
injection. The finding is that **the parts were never assembled**. Most of what
v1 needs is composition and simplification rather than new foundations.

## How this was verified

Four parallel investigations covered the consumer surface, the deterministic
core, the execution host, and the authority with the portal. Every load-bearing
claim below was then re-checked directly. Where a symbol is described as having
no production caller, that was confirmed by searching all of `apps` and
`packages` excluding `dist`, test files, and the testing package.

## The assembly gap

Five findings together explain why a consumer cannot run a workflow today.

| Symbol | Production callers | Consequence |
|---|---|---|
| `compileWorkflowConfiguration` | none | An authored workflow never becomes a run |
| `registerDispatch` | none | A phase never becomes agent work |
| `evaluateTaskFrontier` | none | Fan-out never happens |
| `createEscalation` | none | A stuck run cannot escalate |
| `measureExecutableSensor` | one, as the git transport | No sensor ever measures anything |

`senawa doctor` appears to contradict the first row, but it calls
`doctorWorkflowConfiguration`, a diagnostics-only variant. The only production
compile path is `compileWorkflowAmendment`, which handles amendments to a run
that already exists. Nothing compiles the document a consumer authors into a run.

The second row was established earlier and is unchanged: `ProductionScheduler`
derives runs from dispatches that already exist, so a run holding no dispatch is
never visited.

These are not five separate defects. They are one missing layer, and it sits
between an authored configuration and the machinery that is already proven.

## What the consumer faces today

The generated `.senawa/workflow.json` carries **14 top-level keys across 853
lines and 18 files, with a worst nesting depth of 7**. Thirteen of the keys are
mandatory. The simplest phase is 91 lines; the `phases` array alone is 476.

The heaviest authoring burden is **data mappings**. Every value crossing a phase
boundary requires a named mapping carrying a tagged source, a source JSON
Pointer, and a destination JSON Pointer, kept manually consistent with a
hand-written JSON Schema, a hand-declared `dependsOn`, and a prompt `inputPaths`
list that the compiler requires to match exactly. The `verify` phase alone spends
four mappings and eight pointers.

The runner-up is budgets: six mandatory units, twelve lines each, repeated for
every phase, with values no consumer chose.

The command surface has 35 forms, of which 27 are operations and recovery.
**Every command the v1 loop needs is absent**: start, run status, approve,
reject, run-gates, schema discovery, output submission, escalate, and steer. All
22 protocol intents exist, but the only route to them is `command submit` with a
hand-computed payload digest, expected graph revision, and exact object digest.

## What is genuinely proven and should survive

This list matters as much as the gap list, because rebuilding any of it would be
waste.

* **The kernel's graph and gate semantics.** Gate evaluation is fail-closed: an
  unreported blocking sensor resolves to `unknown` and rejects. That is the right
  foundation for the anchor invariant v1 needs.
* **Fan-out evaluation on its input side.** `evaluateTaskFrontier` fans out over
  any JSON array reachable by pointer, with schema validation, stable
  NFC-normalised identities, intra-collection dependencies with cycle detection,
  deterministic ordering, and a diff classifier that forces review on any change
  or removal. This generality is real and reusable.
* **The SQLite authority.** Immediate transactions, checksummed forward-only
  migrations, refusal to open a newer schema, monotonic lease fencing, and
  restart resume proven by killing a real spawned process.
* **The context broker's security model.** Per-dispatch `principalId` with a
  capability set, capability-denial, exact binding across repository, run,
  dispatch, context, principal and task, expiring budgeted grant tokens,
  capability-widening refusal, and a secret-leak guard. **This is the model the
  brief's scoped worker credential needs, and it already exists** — on the wrong
  channel.
* **Workspace containment and process execution.** `openat2` with
  `RESOLVE_BENEATH`, `RESOLVE_NO_SYMLINKS`, `RESOLVE_NO_MAGICLINKS` and
  `RESOLVE_NO_XDEV`, a native process supervisor, an allowlisted environment
  built from a null prototype, and git invoked with askpass, system config,
  hooks, and external diff disabled.
* **Portal transport security.** Loopback binding re-asserted after listen, host
  header pinning, timing-safe comparisons, and a content security policy of
  `default-src 'none'`.

## What is missing, and larger than the brief assumed

### Escalation does not exist in production

`createEscalation` has no production caller, and the runtime authority never
passes escalations into the lifecycle projection. The entire `escalated` status
and every escalation human need are unreachable. The runner's `RunnerEscalation`
is a different, effect-level concept. The brief lists escalation under keep; it
belongs under add.

### Runs can strand with no path out

Candidate formation requires every active task to be `completed`, so a single
permanently failing task leaves its phase at `awaiting-completion` with no route
to a gate, closure, or escalation. Two phase-attempt transitions, `refused` and
`fail`, are silent dead ends. This is the concrete mechanism behind the brief's
requirement that a human be able to mark an element done.

### No production code produces a sensor reading

Readings arrive as caller-supplied command payload. The process sensor is
production-proven, but only as the git transport. There is no sensor registry, no
measurement path, and nothing reads the `sensors` section of an authored
workflow. The acceptance test for the template's own `diff-check` sensor
hardcodes its result.

### There is no anchor concept

Nothing in the repository expresses a required deterministic reading. A
`SensorReading` carries no provenance, so the kernel cannot distinguish a
compiler exit code from a model's opinion. A gate with an empty blocking list is
vacuously accepted, so declaring a gate currently guarantees nothing.

### Only one budget unit is enforced

| Unit | State |
|---|---|
| `review-iteration` | Enforced and reached in production |
| `dispatch-failure` | Implemented, but its planner has no production caller |
| `work-attempt` | Never counted |
| `sensor-retry` | Never enforced; nothing to retry |
| `integration-attempt` | Superseded by a hard-coded constant of 2 |
| `rebase-attempt` | Declaration only |

`work-attempt` and `review-iteration` are one counter seen from two sides.
`integration-attempt` and `rebase-attempt` both mean "tries to land the work".
One attempt counter per phase covers everything currently enforced.

### Fan-out cannot nest and cannot continue past failure

Fan-out members materialise as tasks, and a task's only children are criteria, so
a member cannot itself fan out. There is no depth parameter. The `continue`
failure policy cannot be expressed at all, because candidate formation demands
every active task be `completed`, so one failed sibling blocks the phase whatever
the policy says.

### Steering is unreachable through a narrowed port

The SDK supports it: `MessageOptions.mode` accepts `"immediate"`, and the
delivery event names `"steering"` as *injected into the current in-flight run
while the agent was busy*. Senawa cannot express it. Its port types
`sendAndWait(prompt: string, timeoutMs)` as a bare string, so `mode` has nowhere
to go, and the session handle is a local variable inside `run`. Abort-and-retry
is the only one of the three steering forms currently available, and it discards
the session rather than steering it.

### Session continuity is a replay guard, not a persona rule

`decideAgentSessionResume` requires fifteen binding fields to match, including
context, task, task generation, and prompt pack digest. Two different phases
differ in all of those, so resume is **structurally unreachable across phases**.
`putAgentSessionResumeBinding` has no callers at all, including tests. The
brief's declared session scope is therefore new work, not wiring.

### Workers hold no command identity

Workers submit no commands. Their surface is six broker submission types bridged
into commands server-side. On the command channel, `AuthenticatedPrincipal` has
no dispatch, run, scope, or expiry field, authorization is a pure roles-by-intent
lookup, and every local caller collapses into one principal holding both
`operator` and `release-manager` behind a single machine-wide token.

### Three intents are declared but unimplemented

`start-phase-attempt`, `publish-phase-output`, and `create-escalation` fall
through to `unsupported-intent`.

## The agent contract

The eleven tools an agent can call today map one-to-one onto `ContextBrokerClient`,
which is the local API a command line would sit on. It is in-process only: the
daemon's HTTP surface has no worker-facing route, and the commands route is the
human authority path that must remain unreachable from a worker.

Moving to a command line contract preserves roughly 55% of `copilot-worker.ts` —
the submission body, rejection recording, argument bounding, payload
construction, validators, and schema constants are pure functions of their
arguments. The phase output parameter builder already produces exactly the
artifact the brief's schema-discovery step asks for.

One genuine design decision falls out rather than translating. Submission
identity is currently derived from the SDK's `toolCallId`, and idempotency rests
on the SDK reissuing it on replay. A command line has no such identifier, so the
replacement key changes what duplicate means to submission admission.

## The durable mirror

The whole-history blob is confirmed: one row rewritten with the entire serialized
history per command, plus a context row rewritten and ten mirror tables deleted
and reinserted per context write.

It buys a single serialization contract, single-transaction crash safety,
one-integer optimistic concurrency, and a byte-equality invariant across every
derived table. Its cost grows with history depth, which is orthogonal to whether
the v1 loop runs. Replacing it touches backup, restore, repair, integrity, and
remote checkpointing, and introduces a compaction-interruption failure mode that
does not exist today.

The seam for a later change already exists: receipt history and event frames are
already an incrementally written log, and per-run derived records are already
stored separately. **This is a defensible later change, not a v1 prerequisite.**

## The central design proposal

Fan-out members should become **phases rather than tasks**.

Nesting, per-element gates, per-element approval, and per-element human override
are all phase-level concepts already. Making a fanned-out member a phase obtains
all four at once, and collapses the node kinds from four to three. It also
removes the specific mechanism that blocks the `continue` failure policy, because
a phase can close in a disposition other than completed while a task cannot.

### Grouping is already supported, and this was proven

Members must stay visually and semantically grouped, so a workflow can show
"implementation phases" together. The model already allows it:

* `ContainsEdge` admits `{ from: PhaseId, to: PhaseId }`.
* `PhaseDefinitionInput.parentId` accepts `WorkflowId | PhaseId`.

A spike compiled a graph of five phases with three members parented to an
`implement` phase, then rendered it through the portal's real layout. The parent
was marked as a container with its members drawn inside in dependency order,
while `plan`, `implement`, and `verify` kept their top-level sequence. Nine nodes
and twelve edges compiled without a kernel change.

One bound came out of the same spike. `containerAssignment` resolves each node to
its **outermost** phase ancestor, and the layout builds a single member level, so
depth 1 groups correctly today and deeper structure flattens into the top group
rather than failing. That matches the brief's accepted bound of one level, and
makes deeper nesting a contained change in the layout rather than a change to the
graph model.

### What remains unproven

The risk is that tasks carry runner semantics phases do not, particularly task
scopes and the claims the context broker binds against. Whether that coupling is
shallow enough to absorb decides whether the task layer disappears entirely or
survives beneath phases. The plan schedules it as the next spike.

## What a simpler authoring surface must do

The mapping burden is the thing to remove, and it can be **derived rather than
declared**. A phase already states its input schema, and earlier phases already
state their output schemas. Binding a named input property to the most recent
phase output that provides it is a compiler responsibility, not an author's. The
strict internal pointer pairs remain, generated rather than typed by hand.

This is the brief's assumption that the analysis was asked to test. The evidence
supports it: nothing about the mappings requires human authorship, because the
compiler already validates that the declared pointers agree with the schemas and
the prompt input paths. The complexity is redundant rather than load-bearing.

## Consequences for the brief's scope table

| Brief said | Evidence says |
|---|---|
| Keep escalation | Add it; it is unreachable |
| Add sensor execution | Correct, and readings need provenance to support anchors |
| Add scoped worker credentials | Port the broker's existing model onto the command channel rather than inventing one |
| Add fan-out | Input side exists and is general; the output side and failure policy are the work |
| Reconsider the durable mirror | Defer; the seam exists and the cost is orthogonal to v1 |
| Reconsider six budget units | Collapse to one; five are unenforced |
| Sessions durable per persona | New work; today's resume is a strict-equality replay guard |

## Open questions carried into the plan

1. Do fan-out members become phases, and does the task layer survive at all?
2. What replaces `toolCallId` as the submission idempotency key?
3. Is the anchor invariant a compile-time property of a gate, a provenance field
   on a reading, or both?
4. Should the three unimplemented intents be built or removed?
5. Does per-element approval need more than the single authority decision slot a
   phase generation allows today?
