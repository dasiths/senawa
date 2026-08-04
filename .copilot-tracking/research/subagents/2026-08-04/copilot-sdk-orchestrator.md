# Copilot SDK Orchestrator Research

Status: Complete on 2026-08-04. No model sessions or credit-spending probes were
run during this research.

## Research questions

* How should a production Senawa orchestrator create and resume isolated SDK sessions?
* Which streaming events and exact APIs should it subscribe to?
* How should it expose typed submission tools, control permissions, and collect output?
* What package, version, installation, and live end-to-end constraints apply?
* Where should the SDK adapter boundary sit?

## Findings

### Package and runtime inventory

* The only currently installed SDK copy is
  `poc/sdk-surface/node_modules/@github/copilot-sdk`, version `1.0.7`.
* `poc/worker-sessions/package.json` and its lockfile also pin `1.0.7`, but that
  directory currently has an unmet dependency. Its run script would install it.
* The installed SDK resolves `@github/copilot` and
  `@github/copilot-linux-x64` at `1.0.73`. The separately installed global CLI
  is `1.0.75`.
* The SDK package requires Node `^20.19.0 || >=22.12.0`; the container has
  Node `22.17.0`.
* The SDK declares protocol version `3`. Client startup negotiates the protocol
  with the runtime.
* Installation is `npm install @github/copilot-sdk`. A direct Zod dependency is
  needed when Senawa authors Zod schemas. The surface probe has Zod `4.4.3`,
  while the SDK itself depends on Zod `^4.3.6`.
* The container mirror served `1.0.7` as latest when the probe was created,
  although a working design note mentions `1.0.8`. All behavior below is
  version-specific and must be rechecked when the mirror advances.

The default connection is a bundled runtime child process over stdio. Prefer
that for version 1. `RuntimeConnection.forStdio({ path?, args?, env? })` can
select another runtime. `forTcp`, `forUri`, and experimental `forInProcess`
also exist. `baseDirectory` is ignored for `forUri`; the in-process transport
does not honor per-client `env`, `telemetry`, `gitHubToken`, or `baseDirectory`.
Those two transports complicate isolation and should not be the production
default.

### Session creation and resumption

Use one long-lived client per active Senawa run and one caller-chosen session ID
per phase or task:

```ts
const client = new CopilotClient({
  mode: "empty",
  baseDirectory: `${workDir}/.copilot-home`,
  connection: RuntimeConnection.forStdio({ env: workerEnvironment }),
  logLevel: "warning",
});

await client.start();

const session = await client.createSession({
  sessionId,
  model: resolvedModel,
  reasoningEffort: resolvedEffort,
  workingDirectory,
  streaming: true,
  availableTools,
  tools: submissionTools,
  onPermissionRequest: permissionHandler,
  hooks,
  onEvent: captureEarlyEvent,
});
```

The exact public declarations in `1.0.7` are:

* `new CopilotClient(options?: CopilotClientOptions)`
* `client.start(): Promise<void>`; start is also automatic on first create or
  resume
* `client.createSession(config: SessionConfig): Promise<CopilotSession>`
* `client.resumeSession(sessionId: string, config: ResumeSessionConfig):
  Promise<CopilotSession>`
* `session.disconnect(): Promise<void>` preserves disk state
* `client.deleteSession(sessionId: string): Promise<void>` irreversibly removes
  disk state
* `client.listSessions(filter?): Promise<SessionMetadata[]>` and
  `client.getSessionMetadata(sessionId)` support reconciliation
* `client.stop(): Promise<Error[]>` performs graceful cleanup;
  `forceStop(): Promise<void>` is the bounded-shutdown fallback

The bundled README says create and resume config are optional, but the shipped
declarations require both. Production code should follow the declarations.

Resume with the same working directory, tool declarations, permission handler,
hooks, and output callback. These handlers are connection-local and are cleared
by disconnect. Leave `continuePendingWork` false for deterministic crash
reconciliation; when true, pending permissions are re-emitted and pending
external tools require low-level completion. Use `suppressResumeEvent` only for
an internal reconnect that must not trigger resume side effects.

`mode: "empty"` is required for a server-style orchestrator. It requires an
explicit `baseDirectory` or `sessionFs` and an explicit `availableTools` on every
session. It disables ambient CLI features and changes tool filtering to
deny-wins. The isolation probe measured that a session under `baseDirectory`
was invisible to a default client and that `deleteSession` removed it.

Do not forward `reasoningEffort` blindly. Its exact union is `"low" |
"medium" | "high" | "xhigh"`; query `client.listModels()` and check
`ModelInfo.supportedReasoningEfforts` or capability support before including it.

### Streaming events and output collection

Register `SessionConfigBase.onEvent` during create or resume. It is installed
before the RPC and therefore captures early events such as `session.start` that
could be missed by calling `session.on(...)` afterward. Add typed subscriptions
with either overload:

* `session.on<K extends SessionEventType>(eventType, handler): () => void`
* `session.on(handler: SessionEventHandler): () => void`

Set `streaming: true` to receive ephemeral message and reasoning deltas. The
minimum production normalization set is:

* Turn output: `assistant.message_start`, `assistant.message_delta`,
  `assistant.message`, `assistant.turn_start`, `assistant.turn_end`
* Optional reasoning display: `assistant.reasoning_delta` and
  `assistant.reasoning`; reasoning content is sensitive
* Tool activity: `tool.execution_start`, `tool.execution_partial_result`,
  `tool.execution_progress`, `tool.execution_complete`
* Session state: `session.error`, `session.idle`, `session.task_complete`,
  `session.usage_checkpoint`
* Usage: `assistant.usage` and durable `session.usage_checkpoint`
* Nested activity when enabled: `subagent.started`, `subagent.completed`, and
  `subagent.failed`; streaming deltas carry `agentId`
* Permissions for audit: `permission.requested` and `permission.completed`

`assistant.message_delta.data` is `{ messageId, deltaContent,
parentToolCallId? }`. `assistant.message.data.content` is the final text.
`tool.execution_start.data` carries `toolCallId`, `toolName`, and arguments;
`tool.execution_complete.data` carries the same call ID, `success`, optional
`result`, and optional `error`. Every session event also carries `id`,
`parentId`, `timestamp`, optional `agentId`, and optional `ephemeral`.

Use `session.send(options): Promise<string>` for asynchronous dispatch and
consume events until `session.idle`. `MessageOptions.mode` is `"enqueue" |
"immediate"`; `session.abort()` cancels current processing. The convenience
`session.sendAndWait(options, timeout?): Promise<AssistantMessageEvent |
undefined>` waits for `session.idle` and returns the final assistant message,
but its default 60-second timeout does not abort in-flight work. It is not an
output collector by itself.

`session.getEvents(): Promise<SessionEvent[]>` retrieves persisted history.
The low-level `session.rpc.eventLog.read({ cursor?, max?, waitMs?, types?,
agentScope? })`, `tail()`, `registerInterest()`, and `releaseInterest()` APIs are
experimental. Their cursor can expire after truncation or compaction, and
ephemeral events observed during long-polling are not replayable. Senawa should
therefore normalize live callbacks into its own records, assign a per-session
monotonic sequence, persist each record before fan-out, and use its own cursor
for SSE replay. Preserve unknown SDK event types in a raw envelope so a minor SDK
upgrade does not silently discard evidence.

Client lifecycle subscriptions are different from session output:
`client.onLifecycle(...)` reports only `session.created`, `session.deleted`,
`session.updated`, `session.foreground`, and `session.background`.

### Typed submission tools

The exact helper is:

```ts
defineTool<T>(name: string, config: {
  description?: string;
  parameters?: ZodSchema<T> | Record<string, unknown>;
  handler?: ToolHandler<T>;
  overridesBuiltInTool?: boolean;
  skipPermission?: boolean;
  defer?: "auto" | "never";
  metadata?: Record<string, unknown>;
}): Tool<T>
```

`ToolHandler<T>` receives `(args, invocation)`; the invocation contains
`sessionId`, `toolCallId`, `toolName`, raw `arguments`, and trace context. Use
one non-deferred, `skipPermission: true` custom tool per submission contract,
for example `senawa_task_done`, `senawa_plan_submit`, or
`senawa_review_submit`. Its Zod input must include the scoped task or artifact
payload. The closure, not model-supplied IDs, pins the operation to the worker's
assigned graph node.

The handler invokes the same authority-checked Senawa core operation as the CLI.
It may evaluate and return a gate result, but a worker submission never closes
the task. Return either a string or an explicit `ToolResultObject` with
`textResultForLlm`, `resultType`, optional `error`, and optional `sessionLog`.
For a refusal, use `resultType: "rejected"` or `"failure"` consistently and put
actionable Senawa findings in `textResultForLlm`.

`defineTool` infers and validates input parameters only. The handler return type
is `unknown`; there is no declared output schema. Senawa must validate its own
domain result before returning it and before recording it.

### Permissions and tool containment

Use three layers:

1. Construct the spawned runtime environment without forbidden executables such
   as `bd`.
2. Set `availableTools` with `ToolSet.addBuiltIn`, `addMcp`, and `addCustom`.
   A bare `"*"` is invalid; wildcards must be source-qualified.
3. Supply `onPermissionRequest(request, { sessionId })` and switch on the
   generated `PermissionRequest.kind` union: `shell`, `write`, `read`, `mcp`,
   `url`, `memory`, `custom-tool`, `hook`, and extension variants.

The ordinary decisions needed by Senawa are `{ kind: "approved" }`,
`{ kind: "reject", feedback }`, and `{ kind: "user-not-available" }`.
Rejection feedback reaches the model. Prefix it with explicit Senawa ownership
to prevent the model inventing another denial source.

Never use `approveAll` in production. When `onPermissionRequest` is omitted,
permission requests become events and remain pending for low-level resolution.

The measured composition rule is strict: an `onPreToolUse` hook that returns
`{ permissionDecision: "allow" }` suppresses `onPermissionRequest` and lets the
tool run. Senawa hooks must return `{}` or `void` when observing, or an explicit
denial when blocking. They must never return `allow`.

`BuiltInTools.Isolated` in `1.0.7` contains `ask_user`, `task_complete`,
`exit_plan_mode`, `task`, `read_agent`, `write_agent`, `list_agents`,
`send_inbox`, `context_board`, and `skill`. It does not provide the filesystem
coding surface an implementor needs. Each role therefore needs an explicit,
version-tested built-in allowlist; the curated preset is not sufficient.

The SDK hook surface is `onPreToolUse`, `onPreMcpToolCall`, `onPostToolUse`,
`onPostToolUseFailure`, `onUserPromptSubmitted`, `onSessionStart`,
`onSessionEnd`, and `onErrorOccurred`. There is no `onSubagentStart`,
`onSubagentStop`, `onAgentStop`, `onPreCompact`, or `onNotification`. The driver
must own the bounded rework loop after a turn becomes idle.

### Live end-to-end feasibility

The SDK can host a live Senawa worker. Historical live probe evidence already
shows create, typed tool invocation, permission rejection with model-visible
feedback, disconnect, and resume on `1.0.7`. No such probe was rerun for this
research because every live path spends AI credits.

The current orchestration demo cannot switch to the SDK without a code and
installation change:

* `poc/orchestration/package.json` contains only Ajv and YAML.
* `poc/orchestration/end-to-end.sh` dispatches the global `copilot` CLI and
  resumes with `--resume`.
* Node module resolution from `poc/orchestration` cannot use the sibling
  `poc/sdk-surface/node_modules` installation as a normal package dependency.
* The offline browser probe explicitly leaves live SDK event normalization
  unproved.

A live SDK end-to-end demo is therefore feasible after adding an exact SDK
dependency and a worker adapter, but it does not exist today. It would spend AI
credits and should first replace one deterministic agent executor or one
subprocess worker, while leaving the graph, gate, journal, and browser adapters
unchanged.

## Evidence

### Declared API evidence

* `poc/sdk-surface/node_modules/@github/copilot-sdk/package.json`
* `poc/sdk-surface/node_modules/@github/copilot-sdk/dist/client.d.ts`
* `poc/sdk-surface/node_modules/@github/copilot-sdk/dist/session.d.ts`
* `poc/sdk-surface/node_modules/@github/copilot-sdk/dist/types.d.ts`
* `poc/sdk-surface/node_modules/@github/copilot-sdk/dist/toolSet.d.ts`
* `poc/sdk-surface/node_modules/@github/copilot-sdk/dist/sdkProtocolVersion.d.ts`
* `poc/sdk-surface/node_modules/@github/copilot-sdk/dist/generated/session-events.d.ts`
* `poc/sdk-surface/node_modules/@github/copilot-sdk/dist/generated/rpc.d.ts`

### Measured probe evidence

* `poc/sdk-surface/probe.mjs` and `poc/sdk-surface/README.md`: live custom tool,
  permission feedback, resume, and declaration scan
* `poc/sdk-surface/precedence.mjs`: live hook/permission short-circuit behavior
* `poc/worker-sessions/isolation.mjs` and `poc/worker-sessions/README.md`: live
  `baseDirectory`, `listSessions`, `deleteSession`, and subprocess isolation
* `poc/worker-sessions/resume.sh`: live CLI resume and JSONL event observations
* `docs/design/wip/poc-findings.md`: authoritative environment and measured
  findings record

### Current orchestration evidence

* `poc/orchestration/package.json`: no SDK dependency
* `poc/orchestration/end-to-end.sh`: live subprocess dispatch path
* `poc/orchestration/engine.mjs`: deterministic fake session host
* `poc/orchestration/README.md`: live SDK output normalization remains unproved
* `docs/design/03-agents-and-interaction.md`: intended hosted-session topology
* `docs/design/05-runtime-and-state.md`: session identity and reconciliation
* `docs/design/07-implementation-and-operations.md`: package ownership and
  hosted-driver implementation slice

## Recommended adapter boundary

Put the only direct SDK dependency in `@senawa/orchestrator`, behind a
`WorkerSessionAdapter`. Do not leak `CopilotSession`, generated event unions, or
permission variants into `@senawa/core`, graph state, HTTP handlers, or reports.

The adapter should own:

* One run-scoped `CopilotClient` and its isolated home
* Create/resume/disconnect/delete and runtime version negotiation
* Mapping resolved role configuration to model, effort, tools, hooks, and
  permissions
* Registration of typed submission tools that call injected core operations
* Live event normalization and durable output-store writes
* Send, enqueue/immediate steering, abort, timeout, and graceful shutdown
* Session existence and turn-completion observations used by reconciliation

The injected core boundary should expose domain operations such as
`submitTask`, `submitArtifact`, `ask`, and `recordNote`. Those operations own
authority checks, gate evaluation, journal events, and graph transitions. The
SDK tool handler, CLI command, and future HTTP command adapter all call the same
operations.

Normalize SDK output into a Senawa-owned envelope such as `{ seq, sessionId,
at, source, kind, agentId?, ephemeral, payload, sdkEventId? }`. Persist before
broadcast. This keeps the browser on Senawa cursors and permits a subprocess
adapter to emit the same domain shape from CLI JSONL and stderr.

## Limitations

* All live SDK findings are from `1.0.7`; behavior at `1.0.8+` is unvalidated.
* No live SDK call was made during this research, so current credentials and
  model availability were not retested.
* The current orchestration and browser probes do not ingest live SDK events.
* A real inferential reviewer has not yet been shown to submit schema-valid
  output through the SDK tool.
* Real phase agents have not yet resumed across several iterations or
  compactions.
* Cross-session trace joining is declared by `onGetTraceContext` but has not
  been measured with a collector.
* `sendAndWait` timeout is not cancellation, and experimental event-log cursors
  cannot be the durable output contract.
* Exact implementor filesystem tool wire names are not declared as a curated
  SDK set. They need a version-pinned no-credit catalog check or a tightly
  scoped live probe before production configuration is frozen.

## Clarifying questions

None. The remaining questions require implementation probes rather than product
clarification.