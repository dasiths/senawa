# Senawa v1 redesign research

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

Five findings together explained why a consumer could not run a workflow when
this research was written. The table now carries what has changed, because
planning from the original column would rebuild work that already exists.

| Symbol | Then | Now | Closed by |
|---|---|---|---|
| `compileWorkflowConfiguration` | none | Authored projects compile through `loadAuthoredWorkflow` | Phase 1 |
| `registerDispatch` | none | `dispatch-driver.ts` | Phase 2 |
| `evaluateTaskFrontier` | none | Still none. Fan-out is unlowered | Phase 9 |
| `createEscalation` | none | `authority.ts`, behind the `create-escalation` intent | Phase 8 start |
| `measureExecutableSensor` | one, as the git transport | `sensor-runner.ts` | Phase 4 |

One claim above was wrong when it was written and is corrected here.
`compileWorkflowConfiguration` is a four-line wrapper that calls
`doctorWorkflowConfiguration` and throws when it returns diagnostics instead of a
snapshot. Both produce the same snapshot through the same validation, so doctor
was never a shallower check, and the authored path calling it directly is the
better of the two because it returns diagnostics rather than raising. The real
gap was that nothing called either one on a consumer's document, which is what
Phase 1 closed.

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

Each heading below carries its current state. Resolved means an executable check
now covers it, and the reference names where.

### Escalation does not exist in production

**Resolved.** `createEscalation` had no production caller, and the runtime
authority never passed escalations into the lifecycle projection, so the entire
`escalated` status was unreachable. `create-escalation` is now an implemented
intent that derives the escalation from recorded gate evidence, refuses a passing
gate, a closed phase, a second escalation, and one offering no response. The
finding stands as the reason escalation was new construction rather than wiring.

### Runs can strand with no path out

Candidate formation requires every active task to be `completed`, so a single
permanently failing task leaves its phase at `awaiting-completion` with no route
to a gate, closure, or escalation. Two phase-attempt transitions, `refused` and
`fail`, are silent dead ends. This is the concrete mechanism behind the brief's
requirement that a human be able to mark an element done.

### No production code produces a sensor reading

**Resolved.** Readings arrived as caller-supplied command payload, so a gate
could only agree with whoever submitted it. `runSensors` now executes the
workflow's declared sensors through the proven process sensor and binds each
reading to the argv, working directory, and root that produced it.

### There is no anchor concept

**Resolved at authoring time.** A phase naming a gate whose sensor is not
deterministic is refused with `invalid-gate` when it is written, rather than
passing vacuously at runtime. A gate with an empty blocking list remains a
separate concern for the gate-authoring phase.

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

**Resolved for the channel, open for the protocol.** A worker now holds a
per-dispatch credential delivered as a mode 0600 file, with its own capability
set and expiry, and worker and operator identities are mutually exclusive on the
HTTP surface. What remains is the agent-facing protocol above that channel, which
is the operating contract work.

### Three intents are declared but unimplemented

**Two resolved, one open.** `start-phase-attempt` advances a run and
`create-escalation` records an escalation. `publish-phase-output` remains
unimplemented, and the decision recorded since is to remove it as a public intent
rather than build it, because output publication is a consequence of a granted
completion rather than something an agent coordinates.

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

Four of the five are now answered. The answers are recorded here so the plan does
not reopen them.

1. **Answered.** Fan-out members become phases, and the task layer survives
   beneath them. The compiler already synthesises one reserved task per agent
   phase, so an agent phase is already a phase containing one task.
2. **Answered.** A content digest of the canonical submission, computed by senawa
   and never supplied by the agent.
3. **Answered, as a compile-time property.** A phase naming a gate whose sensor
   is not deterministic is refused when it is written, because a check at
   evaluation time arrives after a run has already spent credits reaching it.
4. **Answered.** `start-phase-attempt` and `create-escalation` were built.
   `publish-phase-output` is removed rather than built.
5. **Still open.** Whether per-element approval needs more than the single
   authority decision slot a phase generation allows today. This is the first
   question the fan-out phase has to settle.
