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
* Invoke `senawa work start --detach` when the human asks to begin.
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
| `task next`, `dispatch`, `gate check`, `plan import` | Yes | Debug only | No | No |
| `work start`, `resume`, `pause`, `end` | In-process operation | Yes | No | Relay on request |
| `work budget` | No | Yes | No | No |
| `approve`, `reject`, `plan revise` | No | Yes | No | Relay explicit decision |
| `steer`, `task abort` | No | Yes | No | Draft and relay |
| `task done`, `ask`, `discover`, `note` | No | No | Own task only | No |
| `work show`, `work report`, `workflow info`, `doctor` | Yes | Yes | No | Yes |

The principal agent is the least contained caller because it runs in the human's
session with the human's machine authority. The skill states intended behavior;
it is not a security boundary. Commands carrying judgment therefore require
explicit human intent, and approval records its channel.

Ending a run is one of those judgments. The principal agent may relay
`work end --reason "..."` only after the human explicitly chooses abandonment
and provides or confirms the reason.

## Interaction modes

### Foreground

A human running `senawa work start` directly gets a blocking process, streamed
progress, and inline controls. The process stops at approvals and prompts in the
same terminal.

### Detached

A principal agent uses `--detach`. The driver continues under its lease while the
agent's turn returns immediately. The agent can then answer new questions or
relay steering.

| Caller | Log access | Behavior |
|--------|------------|----------|
| Human | `senawa work log --follow` | Blocks and streams |
| Principal agent | `senawa work log --since <seq>` | Returns only unseen events |

`senawa work wait --timeout <seconds>` provides bounded waiting for requests such
as "tell me when the plan is ready" without polling or holding an unlimited turn.

## Human questions

Workers do not use `ask_user`. A headless worker has no user attached, and a
direct prompt would create a wait the driver cannot observe.

1. The worker calls `senawa ask <task> "<question>"`.
2. Senawa creates a threaded beads message and a human gate blocking that task.
3. The driver surfaces the question while continuing unblocked siblings.
4. The human or principal agent relays `senawa answer <message> "<answer>"`.
5. The driver resumes the same worker session with the answer.

The exchange survives restart and appears in the report.

## Role instructions and briefs

Instructions have two owners:

| Layer | Owner | Contents |
|-------|-------|----------|
| Role profile | Repository | Model, tool surface, durable persona, repository-specific emphasis |
| Brief scaffolding | Senawa | Scope, input references, output contract, rules, iteration context |

`senawa task brief` and `senawa phase brief` compose those layers with current
artifact paths and graph state. They pass paths rather than copying large
artifacts into a prompt.

Instructions do not enforce policy. Capability removal, typed tools, hooks, and
the gate own enforcement. A worker ending its turn without calling
`senawa task done` cannot bypass the driver, because the driver evaluates the
gate after the turn and remains authoritative.

## Session topology

Senawa uses independent sessions for writing work.

The preferred topology hosts sessions through `@github/copilot-sdk`. It provides
per-session model and reasoning effort, typed tools, permission callbacks,
programmatic resume, and user-input interception. The driver implements the
rework loop explicitly because the SDK has no `agentStop` or `subagentStop` hook.

A subprocess topology using `copilot -p` remains the fallback for debugging and
CI. It exposes the same session identity and per-task controls, but policy hooks
run as processes and command hook timeouts fail open.

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
