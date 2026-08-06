# Agents and Interaction

## Purpose

Senawa uses Copilot sessions in two distinct roles. The principal agent belongs
to the human and provides a conversational interface. Worker sessions belong to
the run and perform bounded work. Treating both as generic agents obscures their
different authority, lifetime, visibility, and trust.

## Principal agent

The principal agent is an ordinary Copilot session carrying the Senawa skill. It
is not a dedicated runtime component and does not require a
`principal.agent.md` profile.

It performs the conversational work a human would otherwise do manually:

* Convert a goal into a valid workflow request.
* Invoke `senawa work start` when the human asks to begin.
* Read bounded status and incremental logs.
* Present artifact paths when a decision is due.
* Quote the sensor and finding behind a refusal.
* Draft a rejection reason or steer for human confirmation.
* Relay an explicit approval, rejection, answer, pause, abort, or steer.

It never decides what runs next. It does not inspect beads, read the journal
file, enter worker sessions, alter budgets, or approve unasked.

`senawa` is its entire system view. Task and phase identifiers are opaque handles.
This keeps a future graph implementation change out of the skill.

## Worker sessions

A worker is a role-scoped Copilot session dispatched for one phase or task. Each
session has its own model, reasoning effort, tools, working directory, and stable
identifier.

| Role | Produces | Typical access |
|------|----------|----------------|
| Definer | A bounded problem definition | Read-only repository access |
| Researcher | Evidence and constraints | Read-only repository and documentation access |
| Planner | A schema-valid implementation plan | Read-only access plus plan submission |
| Implementor | Code for one claimed task | Declared write paths and worker Senawa tools |
| Verifier | Verification artifact or inferential assessment | Read-only change and evidence access |

Workers cannot call `bd`. They cannot close tasks directly. Their Senawa wrapper
is pinned to their own task, so a completion request cannot target another task.

## Command authority

| Command group | Driver | Human | Worker | Principal agent |
|---------------|--------|-------|--------|-----------------|
| `gate check` | Yes | Debug only | No | No |
| `work start`, `resume`, `pause`, `end` | In-process operation | Yes | No | Relay on request |
| `approve`, `reject`, `plan revise` | No | Yes | No | Relay explicit decision |
| `steer`, `answer` | No | Yes | No | Draft and relay |
| `ask`, `discover` | No | Yes | Recognized v1 capability keywords | Relay on request |
| `note` | No | Yes | Future binding | Relay on request |
| `work show`, `work report`, `workflow info`, `doctor` | Yes | Yes | No | Yes |

The principal agent is the least contained caller because it runs in the human's
session with the human's machine authority. The skill states intended behavior;
it is not a security boundary. Commands carrying judgment therefore require
explicit human intent, and approval records its channel.

Ending a run is one of those judgments. The principal agent may relay
`work end --reason "..."` only after the human explicitly chooses abandonment
and provides or confirms the reason. When a worker is active, the human must
also choose `--force`. The forced path performs cancellation, bounded grace,
fenced takeover, dispatch reconciliation, and terminal persistence rather than
deleting a lock.

## Interaction modes

### Foreground

A human running `senawa work start` directly gets a blocking process, streamed
progress, and inline controls. The process stops at approvals and prompts in the
same terminal.

Detached start and resume are not available. A real background driver needs a
bounded process lifecycle, durable ownership, and shutdown semantics before the
CLI can return while work continues.

`senawa work wait --timeout <seconds>` provides bounded waiting for requests such
as "tell me when the plan is ready" without polling or holding an unlimited turn.

## Human questions

Workers do not use `ask_user`. A headless worker has no user attached, and a
direct prompt would create a wait the driver cannot observe.

`senawa ask "<question>"` records a durable question ID in the run journal.
The human or principal agent relays
`senawa answer <question-id> "<answer>"`. The current operation records the
exchange across restart but does not yet create a blocking Beads gate or resume
a worker session automatically.

## Role instructions and briefs

Instructions have two owners:

| Layer | Owner | Contents |
|-------|-------|----------|
| Worker profile | Repository | Model and effort defaults, requested semantic capabilities, and durable role instructions |
| Brief scaffolding | Senawa | Scope, input references, output contract, rules, iteration context |
| Enforcement | Senawa | Host capability ceiling, typed tools, permission callbacks, isolation, hooks, gates, and audit |

`senawa phase brief` composes those layers with current
artifact paths and graph state. They pass paths rather than copying large
artifacts into a prompt.

The [worker profile contract](02-workflows-and-lifecycle.md#worker-profiles)
defines what a repository may request. Effective authority is always the
intersection:

```text
profile request ∩ task scope ∩ host support ∩ Senawa security ceiling
```

Each term can remove authority; none can add authority excluded by another.
Task paths constrain repository writes, host support removes unavailable
operations, and Senawa's ceiling keeps graph mutation, policy mutation, nested
agents, and unmediated completion unavailable even when a profile requests a
broader semantic capability.

Instructions do not enforce policy. Capability removal, typed tools, hooks, and
the gate own enforcement. A worker ending its turn without submitting the typed
completion request cannot bypass the driver, because the driver evaluates the
gate after the turn and remains authoritative. A public `task done` CLI command
remains deferred until it can authenticate and bind the worker turn.

The deterministic binding registry proves owner-bound task completion offline,
but the subprocess adapter has no authenticated command bridge. Public
`task done` therefore remains omitted. Public `task abort` also remains omitted
because cancelling one task must coordinate with the live driver without
terminalizing the run; forced whole-run end does not establish that contract.

## Session topology

Senawa uses independent sessions for writing work.

The production SDK adapter hosts sessions through `@github/copilot-sdk` 1.0.7.
Offline fake-client conformance proves caller-chosen create and resume,
pre-send event subscription, native typed Senawa tools, canonical permission
callbacks, model and effort negotiation, W3C trace injection, explicit abort,
and retain or archive-delete release against the shipped declarations. The
driver implements the rework loop explicitly because the SDK has no `agentStop`
or `subagentStop` hook. Senawa applies the snapshotted repository profile and
its embedded session policy when it creates each hosted session. Profile
instructions use system-message append mode so SDK guardrails remain active.
SDK sessions disable repository hook discovery and do not depend on repository
Copilot agent files.

The adapter reports inspection as session-only and replay as unavailable. SDK
session history cannot prove a Senawa turn outcome after process loss, and the
experimental SDK cursor never crosses the application port. The application
persists normalized lifecycle, text, tool, model, usage, and artifact events
under Senawa-owned durable identifiers before browser fan-out. Live SDK session
execution, model behavior, and multi-turn retention remain unvalidated and need
an explicitly approved paid probe.

A subprocess topology using `copilot -p` remains the fallback for debugging and
CI. Senawa passes the resolved profile instructions and model directly to the
subprocess, then maps the effective semantic capabilities through a
Senawa-owned allowlist. Profile strings never become command options directly.
The subprocess exposes the same session identity and per-task controls without
repository Copilot agent or hook files.

In-process `task`-tool subagents are reserved for cheap read-only exploration.
They do not provide the independent model, effort, permissions, lifetime, or
resume identity required for implementation work.

## Session isolation

No worker session may appear in the human's Copilot session picker. Hosted
workers use an isolated home:

```ts
const client = new CopilotClient({
  mode: "empty",
  baseDirectory: `${workDir}/.copilot-home`,
});
```

Subprocess workers set `COPILOT_HOME` to the same per-run directory.

| Session | Retained until |
|---------|----------------|
| Task worker | Task closes and transcript is archived |
| Phase agent | Phase is accepted, allowing iteration resume |
| Any remaining worker | `senawa work finish` |

Isolation does not remove correlation. Session identifiers appear in the journal
and telemetry regardless of where the session store lives.

## Tool containment

Containment is layered from strongest to weakest:

1. Build the worker environment without capabilities such as `bd`.
2. Remove unavailable tools from the model's tool list.
3. Enforce path and command policy in an in-process permission callback or hook.
4. Use an OS sandbox for unattended work.
5. Keep exact deny rules as a final convenience, not as the boundary.

A shell deny pattern can be wrapped or invoked indirectly. Capability removal
cannot.

## Next reading

Continue with [Sensors, Gates, and Enforcement](04-sensors-gates-and-enforcement.md)
to see how completion requests become evidence-backed decisions.
