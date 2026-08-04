# Browser Supervisor Research

## Research Scope

Investigate the current web-console proof of concept and Senawa design to answer:

* What architecture can turn the POC into a production browser supervisor while preserving the Senawa core command path?
* Which APIs and persistence formats are required?
* Which singleton or lease semantics are required?
* Which security requirements apply?
* Which existing modules are reusable?
* What practical end-to-end demonstration should prove the production shape?
* Which module boundaries, endpoint schemas, and validation tests should be used?

## Current Architecture

The POC is a separate loopback HTTP process over a deterministic in-memory run.
It reads the standard workflow, starts one child process per ready phase, captures
stdout and stderr by line, persists each record to a phase JSONL file, and only
then fans the record out to SSE subscribers. Run events use a separate JSONL
stream. The browser loads a status projection, subscribes to run changes and one
selected phase output stream, and sends typed commands with ordinary POSTs.

The transport shape is validated, but the control path is not. The POC's HTTP
handler directly changes phase status and starts child processes. Production
must call the same authority-checked command service used by the CLI and driver.
Otherwise the browser becomes a second state machine with different validation,
journalling, lease, and recovery behavior.

Evidence:

* `poc/orchestration/web-console.mjs`, especially `emitRun`, `appendOutput`,
  `beginSse`, and the `/api/commands` handler
* `poc/orchestration/web-console/app.js`, especially `api`, `connectOutput`,
  `refreshSnapshot`, and `sendCommand`
* `poc/orchestration/web-console-test.mjs`
* `poc/orchestration/README.md`, "The browser run console, offline"
* `docs/design/wip/poc-findings.md`, "Browser run console"

## Production Module Boundaries

The browser decision remains `probing`, so these are recommended production
boundaries over the accepted package design rather than promoted architecture.

| Module | Owns | Must not own |
|--------|------|--------------|
| `@senawa/core` | Zod schemas for projections, normalized output records, commands, results, errors, actor channels, and legal state preconditions | Files, HTTP, beads, processes, or stateful command execution |
| `@senawa/graph` | All beads reads and serialized graph writes, human gates, graph revisions, and projection inputs | HTTP concepts, cookies, SSE, or browser sessions |
| `@senawa/report` | Single-writer journal API, normalized output persistence, escaping and redaction, replay readers, and final report rendering | Run transitions or HTTP authorization |
| `@senawa/orchestrator` | `RunCommandService`, `RunQueryService`, driver lifecycle, leases, durable control inbox, session output normalization, reconciliation, and detached start or resume | Route parsing, cookies, static assets, or UI state |
| `@senawa/web` | Loopback server, web-supervisor lease, bootstrap authentication, HTTP-to-core schema mapping, SSE fan-out, bounded client queues, static UI, and artifact read adapter | Direct beads calls, direct journal appends, transition logic, worker spawning, or shell command execution |
| `senawa` | CLI parsing that calls the same `RunCommandService` and `RunQueryService`; `senawa web <work>` starts `@senawa/web` | A second set of command implementations |

The load-bearing interface is an in-process service, not subprocess recursion:

```ts
interface RunCommandService {
  execute(command: RunCommand, context: ActorContext): Promise<CommandResult>;
}

interface RunQueryService {
  snapshot(work: string): Promise<RunSnapshot>;
  readJournal(work: string, after: number, limit: number): Promise<RunEvent[]>;
  readOutput(work: string, stream: string, after: number, limit: number): Promise<OutputRecord[]>;
}
```

The CLI constructs `ActorContext` from the invoking terminal or principal-agent
relay. The web adapter constructs it from the authenticated browser session.
Clients never supply their own actor or channel.

`RunCommandService` owns command authority and legal-state checks. It routes
steering and pause requests through the durable control mechanism, performs
human decisions through the graph and journal path, and asks the orchestrator to
start or resume a detached driver when the command requires progress. The web
server only maps status and typed errors to HTTP.

## API And Endpoint Schemas

Use versioned, run-scoped routes even while version 1 allows one active run. This
avoids an incompatible route redesign when multiple runs eventually arrive and
prevents a browser tab from silently acting on a replacement run.

| Method and route | Contract |
|------------------|----------|
| `GET /api/v1/runs/{work}/snapshot` | Bounded graph and action projection reconstructed from authoritative state |
| `GET /api/v1/runs/{work}/events?after={seq}&limit={n}` | Bounded journal replay for catch-up and diagnostics |
| `GET /api/v1/runs/{work}/events/stream?after={seq}` | Journal-backed SSE; `Last-Event-ID` is also accepted |
| `GET /api/v1/runs/{work}/streams/{stream}/records?after={seq}&limit={n}` | Bounded normalized output history |
| `GET /api/v1/runs/{work}/streams/{stream}/events?after={seq}` | Persisted output replay followed by SSE tail |
| `GET /api/v1/runs/{work}/phases/{phase}/artifacts/{version}` | Schema-valid artifact selected from graph metadata, never an arbitrary path |
| `POST /api/v1/runs/{work}/commands` | One strict discriminated command union mapped to `RunCommandService.execute` |

The snapshot should expose opaque stream identifiers and actions computed by the
core rather than guessed by the UI:

```ts
type RunSnapshot = {
  schema: "senawa.dev/run-snapshot/v1";
  work: string;
  workflow: string;
  status: "running" | "awaiting_approval" | "paused" | "ended" | "finished" | "stopped";
  revision: number;
  journalCursor: number;
  needs: null | {
    action: "approve" | "answer" | "intervene";
    nodeId: string;
    artifact?: { phase: string; version: number; sha256: string };
  };
  nodes: Array<{
    id: string;
    kind: "phase" | "task";
    title: string;
    role?: string;
    status: string;
    iteration?: number;
    attempt?: number;
    stale?: boolean;
    stream?: string;
    actions: string[];
  }>;
  edges: Array<{ from: string; to: string; kind: "blocks" | "parent" }>;
  progress: { phases: string; tasks: string };
  budget?: { aiuSpent: number; aiuCap: number };
  sourceChanged: boolean;
};
```

The command schema needs a client-generated idempotency key and an optimistic
state precondition. The server derives actor identity and channel:

```ts
type CommandBase = {
  schema: "senawa.dev/run-command/v1";
  requestId: string; // UUID, retained for bounded deduplication
  expected: { revision: number };
};

type RunCommand = CommandBase & (
  | { command: "approve"; phase: string; expectedArtifactVersion: number; note?: string }
  | { command: "reject"; phase: string; expectedArtifactVersion: number; reason: string }
  | { command: "steer"; target: { kind: "phase" | "task"; id: string }; instruction: string; mode: "next" | "now" }
  | { command: "answer"; message: string; answer: string }
  | { command: "pause" }
  | { command: "resume" }
  | { command: "abort-task"; task: string; reason: string }
  | { command: "end"; reason: string }
);
```

Do not expose `force end`, worker commands, driver internals, graph operations,
arbitrary paths, executable names, or shell strings through the first browser
API. Emergency takeover remains a local CLI operation until its lease and
reconciliation probe is complete.

Successful mutation response:

```json
{
  "schema": "senawa.dev/command-result/v1",
  "requestId": "f1206c9c-3f5a-4721-84a2-52c0379fc866",
  "accepted": true,
  "journalSeq": 129,
  "driver": "resume-requested",
  "snapshot": {}
}
```

Error response:

```json
{
  "error": {
    "code": "state_conflict",
    "message": "plan v2 is no longer awaiting approval",
    "retryable": false,
    "currentRevision": 42
  }
}
```

Use `400` for schema failures, `401` for no browser session, `403` for authority,
Origin, or channel refusal, `404` for unknown run or opaque resource, `409` for
state or lease conflict, `413` for request limits, and `503` when the driver
cannot be started. A duplicate `requestId` returns its original result.

## Persistence And Recovery

Authoritative production persistence follows the current design:

* Beads stores epics, phases, tasks, dependencies, gates, status, and structured
  runtime metadata.
* `work.json` is immutable run identity only.
* `journal.jsonl` is append-only ordered history with one writer and a monotonic
  sequence.
* `cache.json` is a bounded derived projection and is safe to delete.
* `snapshot/` contains frozen definitions bound by a content fingerprint.
* `artifacts/` stores schema-valid versioned artifacts without overwriting prior
  versions.
* `steering.jsonl` or its production successor is a durable inbox consumed at a
  safe transition boundary.
* `driver.lock` is transient lease state, not run truth.

Add one Senawa-owned output stream per worker or phase session. The browser must
not depend on Copilot subprocess JSONL fields or the SDK's experimental cursor:

```text
streams/
  <opaque-stream-id>/
    stream.json
    records.jsonl
    index.json
```

`stream.json` is immutable identity and source metadata. `records.jsonl` is the
append-only source. `index.json` is a derived cursor or segment index and must be
rebuildable. Long-run segmentation needs load evidence before it becomes a
journal-wide contract, but output storage should hide file layout behind the
replay reader from the start.

```ts
type OutputRecord = {
  schema: "senawa.dev/output-record/v1";
  seq: number; // Monotonic within this stream
  ts: string;
  work: string;
  stream: string;
  owner: { kind: "phase" | "task"; id: string };
  sessionId?: string;
  source: "copilot-subprocess" | "copilot-sdk" | "senawa";
  kind: "text" | "message" | "tool" | "control" | "diagnostic" | "usage";
  channel: "stdout" | "stderr" | "assistant" | "tool" | "control" | "system";
  text?: string;
  data?: Record<string, unknown>; // Schema-limited and sanitized per kind
};
```

Every source adapter normalizes, strips unsafe control sequences, applies size
limits, appends durably, and only then publishes. Slow SSE clients receive a
bounded in-memory queue and reconnect to durable replay after overflow; they
never backpressure a worker pipe or SDK event handler.

On web-supervisor restart, snapshot data is reconstructed from beads plus the
work directory, stream cursors are reconstructed from persisted records, and
SSE resumes from each client's cursor. No browser connection is recovery state.

## Singleton And Lease Requirements

Four independent guards must remain separate:

| Guard | Required behavior |
|-------|-------------------|
| Repository active-run pointer | Refuse a second unfinished run; release only after terminal graph state, journal event, and projection are durable |
| Driver lease | One transition owner and journal writer for a run; heartbeat; stale takeover only after reconciliation |
| Web-supervisor lease | One HTTP supervisor for the selected run; does not imply ownership of the driver lease |
| Dispatch limit or atomic claim | One active Senawa-created worker turn in version 1; retained sessions are inactive |

The production web lease should be atomically created with mode `0600` and carry
`schema`, `work`, `instanceId`, `pid`, `host`, `startedAt`, and `heartbeatAt`.
Heartbeat replacement must be atomic. Release checks `instanceId`, not only PID,
to prevent a restarted process from deleting a successor's lease. A contender
may remove a local stale lease only after process death is confirmed; remote
hosts are out of scope because the server is loopback-only.

The supervisor never deletes `driver.lock` or the active-run pointer. Commands
enter through `RunCommandService`, which applies the same lease, inbox, graph,
journal, and legal-state rules as the CLI. After an approval or rejection is
durable, the supervisor requests a detached `work resume`; the driver lease
decides whether that request starts a process or observes one already running.

Normal `end` asks a live driver to stop, waits for the configured grace period,
reconciles in-flight intent, writes terminal state, and releases the active-run
pointer last. Forced takeover remains unproven and must not be approximated by
lock-file removal.

## Security Requirements

The first production mode is local and single-user:

* Bind only to an explicit loopback address and random port. Remote binding,
  shared access, TLS termination, and multi-user authorization are separate
  designs, not flags.
* Generate at least 256 bits of capability entropy. Exchange a one-time URL
  bootstrap token for an `HttpOnly`, `SameSite=Strict`, path-scoped session
  cookie, redirect to a token-free URL, and invalidate the bootstrap token.
* Validate `Host` against the actual listener address and validate state-changing
  request `Origin` against a fixed allowlist. Do not derive the trusted Origin
  from the request's Host header. Send no CORS headers.
* Require JSON, strict schemas with unknown fields rejected, an 8 KiB command
  body cap, per-field limits, and bounded request timeouts.
* Enforce the command authority matrix in the core. Browser sessions are human
  command channels, never worker or driver channels. A phase requiring
  `human-direct` must refuse browser approval because current design defines that
  channel as the driver's own terminal.
* Serve artifacts only through graph-owned phase and version references. Resolve
  canonical paths under the run's artifact root and reject traversal, absolute
  paths, and symlink escape.
* Render every dynamic value with text nodes or equivalent escaping. The POC
  safely uses `textContent` for output but interpolates phase and role strings
  into `innerHTML`; production must remove that remaining injection surface.
* Strip terminal control characters and ANSI sequences, reject raw HTML, cap
  output fields, and do not treat model, source, tool, or diagnostic text as
  Markdown instructions.
* Treat raw output as sensitive source and prompt material. Use private work
  directory permissions, `Cache-Control: no-store`, no access logging of tokens
  or command bodies, and explicit retention or deletion policy.
* Send CSP with external same-origin assets only, `frame-ancestors 'none'`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy: same-origin`, and a restrictive
  `Permissions-Policy`.
* Rate-limit authentication failures, command submissions, and concurrent SSE
  clients. Bound per-client queues and close lagging clients without dropping
  durable records.

## Reusable Code

Reusable as behavior or focused implementation:

* JSONL record shapes and persist-before-fanout ordering from
  `poc/orchestration/web-console.mjs`
* SSE framing, replay by cursor, heartbeat, and per-phase subscriber isolation
  from `poc/orchestration/web-console.mjs`
* Loopback binding, capability-token bootstrap, strict cookie, Origin check,
  security headers, body cap, and browser command allowlist from the POC server
* Browser projection rendering, selected-phase output replay, contextual
  controls, and reconnect behavior from `poc/orchestration/web-console/app.js`
* Replay, authorization, command refusal, singleton, and terminal-state test
  helpers from `poc/orchestration/web-console-test.mjs`
* Definition validation, immutable run identity, frozen snapshots, graph-backed
  phase and task state, intent-outcome reconciliation, projections, and command
  preconditions from `poc/orchestration/engine.mjs`

Do not reuse the POC's in-memory `phases`, `children`, `runStatus`, or transition
functions as production authority. Do not reuse the hand-built linear graph for
dynamic task frontiers.

## End-To-End Demo Workflow

Build one offline, credit-free acceptance demo around the existing
`standard-delivery` workflow. Keep live Copilot normalization in a clearly named
credit-spending companion script.

1. Create a scratch repository, initialize beads once, install the standard
  workflow, and start work through the production `RunCommandService` using the
  CLI adapter with `--detach`.
2. Start `senawa web <work>`, capture the token-free redirected browser session,
  and prove a second supervisor is refused.
3. Observe define through the run snapshot and output SSE. Disconnect after
  record 2, reconnect from the cursor, and prove contiguous replay.
4. Approve define through HTTP. Assert the core resolves the human gate,
  journals actor channel `browser`, and starts detached resume. Do not let the
  HTTP module write any of those stores directly.
5. Run the same approval from an equivalent fixture through the CLI adapter.
  Normalize request ID, timestamp, and channel, then compare graph state,
  artifact pointer, legal next transition, and journal event shape.
6. Reject plan v1 through HTTP with a reason. Prove the planner iteration resumes,
  v1 remains, v2 includes the rejection context, and a stale retry against v1 is
  refused.
7. Steer the running implementation task. Prove the durable inbox receives it,
  the driver consumes it at a safe boundary, and the journal and selected
  output stream record the event without cross-stream leakage.
8. Kill the driver after dispatch intent and before outcome. Keep the browser
  serving, invoke resume through HTTP, and prove reconciliation adopts or
  redispatches exactly once.
9. Restart the web supervisor and prove snapshot reconstruction plus output and
  journal replay from persisted cursors.
10. End an unfinished run with a reason, prove every unfinished node is terminal
   and the active-run pointer releases last, then start a replacement run.

The live companion should feed one `copilot -p --output-format json` session and
one SDK-hosted session through the same `OutputRecord` store. It proves adapter
normalization only; the offline demo remains the repeatable authority and
recovery acceptance test.

## Validation Tests

Minimum production validation matrix:

* Command parity: execute every browser-exposed command through CLI and HTTP
  adapters against equivalent fixtures; compare graph, journal, inbox, artifact,
  and resume effects after normalizing actor channel and request metadata.
* Authority: refuse arbitrary commands, worker and driver commands, browser
  approval of `human-direct`, missing explicit reasons, stale artifact versions,
  wrong node state, terminal runs, and actor fields supplied by clients.
* Idempotency and races: duplicate `requestId` returns one result; concurrent
  approve and reject yield one winner; stale `revision` returns `409`; detached
  resume cannot create two drivers.
* Lease lifecycle: second supervisor refusal, heartbeat, PID reuse protection,
  stale local takeover, crash during lease creation, and release that checks
  `instanceId`.
* Recovery: delete `cache.json`, restart the supervisor, kill the driver at each
  intent-outcome boundary, and verify reconstruction without duplicate work.
* Persistence: corrupt or truncate the final output record, rebuild derived
  indexes, preserve monotonic sequence, and reject corruption before replaying
  untrusted data.
* Output adapters: golden fixtures for subprocess JSONL, subprocess stderr, SDK
  typed events, streaming deltas, usage, malformed records, ANSI, NUL, huge
  fields, and split UTF-8 or line chunks.
* SSE: replay then tail without a gap, `Last-Event-ID`, duplicate suppression,
  independent stream cursors, heartbeats, bounded queues, slow and disconnected
  viewers, server restart, and multiple viewers.
* Security: no-auth reads, token replay after bootstrap, foreign and missing
  Origin, forged Host and DNS rebinding shape, no CORS, cookie attributes,
  security headers, request and field caps, path traversal, symlink escape,
  HTML and script strings in roles or output, and secret-bearing diagnostics.
* Lifecycle: approval, rejection, steering, answer, pause, resume, abort, normal
  end, replacement start, and refusal after `ended` or `finished`.
* UI: Playwright at desktop and mobile sizes, keyboard navigation, graph-only
  horizontal overflow, artifact review before approval, reconnect indication,
  contextual action visibility, and no dynamic `innerHTML` injection.

Keep the existing `poc/orchestration/web-console-test.mjs` as the transport
regression seed, but replace its fake in-memory command assertions with parity
assertions over the real service before promoting the browser decision.

## Evidence And References

Primary POC evidence:

* `poc/orchestration/web-console.mjs`
* `poc/orchestration/web-console/app.js`
* `poc/orchestration/web-console-test.mjs`
* `poc/orchestration/engine.mjs`
* `poc/orchestration/README.md`

Current design evidence under review:

* `docs/design/01-system-model.md`
* `docs/design/02-workflows-and-lifecycle.md`
* `docs/design/03-agents-and-interaction.md`
* `docs/design/05-runtime-and-state.md`
* `docs/design/06-provenance-and-observability.md`
* `docs/design/07-implementation-and-operations.md`
* `docs/design/wip/decision-log.md`
* `docs/design/wip/poc-findings.md`

## Follow-On Questions

* What output retention and segmentation thresholds are justified by measured
  long-run volume and replay latency?
* Should browser artifact viewing support only structured JSON in version 1, or
  also bounded text and diff media types?
* Which browser action, if any, should be allowed to request `steer --now` while
  preserving the driver's single-writer and SDK interruption guarantees?
* Does remote access warrant a separate authenticated gateway rather than any
  non-loopback mode in `senawa web`?

## Clarifying Questions

No clarification is required for the local version 1 recommendation. Remote,
shared, or multi-run browser supervision would change the authentication,
authorization, routing, and lease model and needs a separate scope decision.