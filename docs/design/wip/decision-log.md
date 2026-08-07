# Design Decision Log

This is the working entry point for new design ideas. Entries are
non-authoritative until accepted and promoted into a numbered design guide.

Keep entries short. Put executable evidence in `experiments/probes/`, measurements in
[probe-findings.md](probe-findings.md), and durable rejected rationale in
[roads-not-taken.md](roads-not-taken.md).

## Status lifecycle

```text
proposed -> probing -> accepted
                    -> rejected
                    -> superseded
```

| Status | Meaning |
|--------|---------|
| `proposed` | The question and required evidence are defined |
| `probing` | A probe is gathering evidence |
| `accepted` | Evidence supports the decision and the owning guide is updated |
| `rejected` | Evidence or constraints ruled it out; rationale is in Roads Not Taken |
| `superseded` | A later decision replaced it |

## Entry template

Copy this section for each idea and update it in place as the idea matures.

```markdown
### YYYY-MM-DD: Decision title

* Status: `proposed`
* Owner: `docs/design/NN-guide.md`
* Question: One decision the evidence can answer
* Context: Why the decision matters now
* Options: The credible alternatives
* Evidence needed: What would distinguish the options
* Probe: `experiments/probes/<subject>/README.md`, or `not started`
* Outcome: `pending`
* Promotion: Link to the accepted guide section or Roads Not Taken entry
```

## Decisions

### 2026-08-07: Live execution, exact evidence, approval presentation, and tmux

* Status: `probing`
* Owner: `docs/design/01-system-model.md`,
    `docs/design/02-workflows-and-lifecycle.md`,
    `docs/design/03-agents-and-interaction.md`,
    `docs/design/04-sensors-gates-and-enforcement.md`,
    `docs/design/05-runtime-and-state.md`,
    `docs/design/06-provenance-and-observability.md`, and
    `docs/design/07-implementation-and-operations.md`
* Question: Can Senawa make live SDK execution the explicit persisted default,
    bind phase and task outcomes to exact consumed and repository evidence,
    present immutable approval artifacts without transferring human authority,
    and project stable per-turn tmux terminals without entering worker sessions?
* Context: Simulated run `run-7a3b2318-05ad-4431-a827-fc74577fce9e`
    completed the lifecycle without changing repository files. It exposed
    false-success paths but provides no live-model or tmux evidence.
* Options: Retain implicit simulation and aggregate evidence, or require an
    explicit persisted worker host with no live-to-simulation fallback, exact
    evidence manifests and repository deltas, artifact-bound approval
    presentation, and a separately proven terminal substrate
* Evidence needed: For the live default, an authenticated catalog-confirmed SDK
    workflow must persist and resume the selected host, report the invoked
    adapter and resolved model, and stop rather than simulate after live-host
    failure.
* Evidence needed: For exact evidence, phase and task prompts, artifact
    provenance, repository deltas, gates, recovery, and verification must resolve
    the same versioned inputs; required no-op work and failing verification must
    be refused.
* Evidence needed: For approval presentation, CLI and browser projections must
    bind path, version, and digest to a bounded recommendation-free overview and
    complete artifact access, while only an explicit human choice authorizes the
    decision.
* Evidence needed: For tmux, a no-credit deterministic-shell probe must measure
    stable session and pane identity, bounded capture, detach and reconnect,
    exit status, sanitization, and independent browser-terminal projection
    before any separately cost-labeled live run.
* Probe: `experiments/probes/worker-sessions/README.md`, with live workflow,
    evidence, and approval checks planned in the existing orchestration subject
* Outcome: `accepted offline` for canonical host naming and persistence, explicit
    simulation, no-fallback composition, exact input manifests, trusted
    repository deltas, schema-aware verification, artifact-bound presentation,
    version-bound decisions, and report classification. Production adapters and
    application paths passed offline tests, including a measured temporary Git
    repository. These results do not establish authenticated model availability
    or live execution quality.
* Outcome: `accepted offline` for the bounded, sanitized, independently keyed
    per-turn browser projection fixture. Two no-credit tests passed on
    2026-08-07. This does not establish production browser integration with
    tmux-hosted workers.
* Outcome: `documentation-only skip` for tmux in the recorded Debian 12
    environment because tmux was unavailable. Session and pane identity,
    capture, detach and reconnect, exit status, disappearance, and cleanup remain
    unmeasured.
* Outcome: `measured` for authenticated Sonnet 5 and Opus 5 catalog availability
    on 2026-08-07. `senawa doctor --live` resolved every configured role to its
    exact requested model and the implementor's preferred `high` effort without
    invoking a model. A complete live SDK workflow, live model quality and
    telemetry, and tmux substrate behavior remain pending. The overall decision
    and tmux production design remain `probing`.
* Promotion: Offline contracts are promoted to the owning numbered guides and
    linked to [Live default and evidence contracts](probe-findings.md#live-default-and-evidence-contracts).
    Live-model and tmux claims remain unpromoted.

### 2026-08-06: Durable browser command receipts

* Status: `accepted`
* Owner: `docs/design/03-agents-and-interaction.md`
* Question: Can the browser acknowledge a command after durable submission,
    execute it independently of the initiating HTTP connection, recover it after
    supervisor restart, and still leave every workflow transition under the
    shared application command service and driver?
* Context: Live portal approvals and rejections currently hold the HTTP request
    open through Beads writes, worker execution, sensors, and the next decision
    boundary. Browser reload or supervisor restart can lose command progress even
    though the underlying workflow remains recoverable.
* Options: Keep synchronous POSTs, use the orchestration journal as a queue, or
    add a separate run-scoped durable command receipt queue with its own replay
    cursor and SSE projection
* Evidence obtained: Idempotent submission, changed-payload refusal, single-command
    claiming, completion and refusal receipts, browser reload projection, and
    supervisor restart recovery passed in the production HTTP path with file
    runtime composition. A real-Beads contract separately proved cross-process
    runtime freshness for a long-lived reader.
* Evidence obtained: A no-credit production-composition contract durably queued
    a receipt, killed the Beads-backed supervisor with `SIGKILL`, waited for its
    persisted lease to expire, and completed the same receipt through a fresh
    composition without duplicate approval or resume events. Receipt SSE replay,
    live terminal updates, Last-Event-ID reconnect, independent-writer polling,
    authentication, and backpressure passed focused tests.
* Probe: `experiments/probes/orchestration/README.md#durable-browser-command-receipts`
* Outcome: Browser commands use a separate run-scoped receipt queue. HTTP returns
    after durable submission, the fenced web supervisor owns execution and
    recovery, and receipt-local SSE projects progress without becoming workflow
    authority.
* Promotion: `docs/design/03-agents-and-interaction.md#browser-command-receipts`

### 2026-08-06: Browser controls for worker questions

* Status: `accepted`
* Owner: `docs/design/03-agents-and-interaction.md`
* Question: Can the portal project unanswered worker questions and submit a
    correlated human answer without routing that answer through the single active
    browser command receipt or granting the worker transition authority?
* Context: Active SDK questions now block inside the original typed tool call,
    but the human must leave the portal and use the CLI to answer. Sending the
    answer through the receipt queue would deadlock when the receipt itself owns
    the active worker turn.
* Options: Keep CLI-only answers, route answers through command receipts, or add
    a separate authenticated answer endpoint over durable journal questions
* Evidence obtained: Unanswered and stale question projection, idempotent answer
    submission, reload behavior, strict Origin and schema enforcement, DOM-safe
    rendering, answer controls during an active command receipt, and delivery
    through the original active SDK tool call passed application, binding, and
    production browser tests.
* Probe: `experiments/probes/orchestration/README.md#browser-worker-question-controls`
* Outcome: The portal projects durable worker questions and uses a separate
    authenticated answer endpoint. Active questions are answerable, stale ones
    remain visible and disabled, and answers never enter the command receipt
    queue or advance workflow state.
* Promotion: `docs/design/03-agents-and-interaction.md#human-questions`

### 2026-08-05: Port-first production architecture migration

* Status: `probing`
* Owner: `docs/design/07-implementation-and-operations.md`
* Question: Can Senawa migrate from the vertical-slice package graph to
    application-owned ports, Beads runtime authority, and explicit worker
    session lifecycles while the built CLI, browser, and one no-credit workflow
    remain executable after every migration phase?
* Context: The deterministic slice proves adapter plumbing, but current packages
    mix domain rules, configuration loading, application control, persistence,
    worker hosting, and presentation. The live worker path also has unresolved
    first-turn, lease, recovery, enforcement, and gate-feedback defects.
* Options: Mechanically move existing packages, rewrite the repository at once,
    or migrate one working path at a time through domain and application ports
* Evidence needed: Shared adapter contract suites, crash and lease fault
    injection, CLI and HTTP command parity, browser replay across processes and
    restart, deterministic Beads execution, and one bounded live create-resume
    worker run after offline containment checks pass
* Probe: Planned under `experiments/probes/runtime-ports/`,
    `experiments/probes/worker-sessions/`, and
    `experiments/probes/browser-replay/`
* Outcome: Phase 4 established `@senawa/application`, domain-only production
    imports, application fakes, revision-checked operation commits, and shared
    CLI/browser commands and projections. Phase 5 split explicit file runtime,
    immutable documents, journal and output, leases, active-run ownership, and
    notification hints behind application ports. Shared contracts prove reopen,
    idempotency, fencing, mid-commit crash recovery, dispatch projection,
    independent-process SSE writes, and supervisor restart replay. The graph package is now a thin facade, and
    executable file composition is explicit in the app. Phase 6 moved worker
    lifecycle, authorization, capability negotiation, normalized events, and
    typed binding fixtures to `@senawa/workers`; made sensors implement the
    application gate port with cost ordering, blocking short-circuit, cache,
    and evidence spill seams; and moved HTTP and report ownership to
    `@senawa/browser` and `@senawa/reporting`. Offline conformance includes a
    recording fake subprocess, browser replay across process and restart, and
    hostile report rendering. Phase 7 added `@senawa/runtime-beads` over real
    `bd 1.1.2`, semantic atomic claims, graph and gate reconstruction,
    pending-operation convergence, stable receipts, and an explicit no-credit
    Beads CLI/browser composition. On 2026-08-05, the final suite passed 87
    tests in 228.67 seconds, the real-Beads contract file took 227.45 seconds,
    all four injected split-write points recovered, and
    `pnpm demo:beads` completed with eight authoritative graph nodes and no
    mutable runtime JSON blob. Phase 8 made Beads the omitted-option production
    composition, required explicit `--runtime file` for development and tests,
    persisted backend identity in immutable identity and the active pointer,
    exposed it in status and reports, and rejected mismatched reopen attempts.
    Focused tests proved a missing Beads executable never creates file runtime
    state. The final suite passed 91 tests in 219.98 seconds, the explicit-file
    demo passed, and the default-Beads CLI/browser demo completed with eight
    authoritative graph nodes. No-credit validation covered the implemented
    command grammar; unsafe or unsupported `init`, `sensor run`, `task done`,
    and `task abort` commands remain omitted. Phase 9 added durable normalized
    worker events, transcripts, task diffs, sensor evidence, complete process
    reports, and fenced forced-end recovery. Phase 10 added the pinned Copilot
    SDK 1.0.7 adapter, native typed tools, canonical permission callbacks,
    model negotiation, trace injection, explicit abort, offline conformance,
    direct `--worker-host sdk` composition, final package-boundary enforcement,
    and removal of the `core`, `graph`, `orchestrator`, `report`, and `web`
    compatibility packages. The final offline suite and both file and Beads
    CLI/browser demos pass. Live subprocess and SDK create-resume evidence is
    still pending explicit approval, so this decision remains probing.
* Promotion: `pending`

### 2026-08-04: Sensor policy location

* Status: `accepted`
* Owner: `docs/design/04-sensors-gates-and-enforcement.md`
* Question: Should repository-specific sensor and gate policy live at the
    repository root or inside the `.senawa` configuration namespace?
* Context: Workflows, schemas, and worker profiles already live under
    `.senawa`; root `sensors.yaml` was the only Senawa configuration exception.
* Evidence obtained: Definition loading, frozen-path enforcement, bundle checks,
    all 31 tests, and the complete offline browser demo pass after moving the
    production file to `.senawa/sensors.yaml`.
* Outcome: Repository sensor extensions, instances, gates, and frozen paths live
    in `.senawa/sensors.yaml`. probe-local sensor manifests remain local fixtures.
* Promotion: [Sensors, Gates, and Enforcement](../04-sensors-gates-and-enforcement.md#sensor-configuration)

### 2026-08-04: Worker profile ownership

* Status: `accepted`
* Owner: `docs/design/02-workflows-and-lifecycle.md`
* Question: Are worker roles embedded Senawa behavior or repository-owned
    workflow configuration?
* Context: Workflows name roles, but the first implementation embedded their
    prompts, model, and tools in the orchestrator after rejecting `.github`
    repository conventions.
* Options: Embedded Senawa roles, prompt-only files, or repository-owned strict
    worker profiles under `.senawa/agents`
* Evidence obtained: The implementation already snapshots workflows and schemas;
    excluding role content allowed runtime upgrades to change a resumed run's
    instructions without changing its fingerprint. A strict profile can request
    capabilities without granting them. Focused production tests now prove
    strict parsing, exact-source fingerprint drift, snapshot-based dispatch,
    missing-role rejection, host ceiling intersection, frozen profile writes,
    and independence from repository Copilot hook files.
* Outcome: Repositories define `.senawa/agents/<role>.senawa.md` profiles that
    combine model hints, requested capabilities, and prompt content. Senawa owns
    profile schemas, brief scaffolding, typed worker tools, capability mapping,
    permission ceilings, isolation, hooks, gates, and audit. Effective authority
    is profile request intersected with task scope, host support, and Senawa's
    security ceiling. Hooks remain embedded Senawa enforcement.
* Promotion: `docs/design/02-workflows-and-lifecycle.md#worker-profiles`, with
    enforcement, provenance, and operations reflected in guides 03, 04, 06,
    and 07

### 2026-08-04: Single active run and worker

* Status: `accepted`
* Owner: `docs/design/05-runtime-and-state.md`
* Question: Can v1 enforce one unfinished run per repository and one active
    Senawa-created worker turn within that run?
* Context: Multiple runs and workers require worktree isolation, integration
    policy, cross-run selection, and more complex browser supervision that v1
    does not need.
* Options: Repository singleton, per-run singleton only, or unrestricted runs
* Evidence obtained: A competing work start and second web supervisor were
    refused, peak in-flight worker turns was one, graceful end reached durable
    terminal state and released the pointer, and a replacement run started in
    the same beads repository.
* Evidence still needed: Forced takeover of an unresponsive driver requires the
    production driver lease and remains a separate edge to probe.
* Probe: `experiments/probes/orchestration/README.md#single-active-run-and-graceful-end-offline`
* Outcome: Version 1 supports one unfinished run per repository, one driver and
    web supervisor for that run, and one active worker turn. Retained sessions
    are inactive context. Normal end is durable and auditable; raw lock deletion
    is unsupported.
* Promotion: `docs/design/05-runtime-and-state.md#version-1-singleton` and
    `docs/design/02-workflows-and-lifecycle.md#ending-a-run`

### 2026-08-04: Browser run console

* Status: `probing`
* Owner: `docs/design/03-agents-and-interaction.md`
* Question: Can a local HTTP application reconstruct and stream an active run,
    show per-agent output history, and dispatch authority-checked human commands
    without becoming a second orchestration control path?
* Context: Browser interaction would make workflow observation, approvals,
    rejection, and steering available without attaching to the driver's terminal.
* Options: Server-Sent Events plus command POSTs, WebSockets, or periodic polling
* Evidence obtained: The offline probe rendered five graph nodes, replayed and
    tailed isolated stdout/stderr streams, resumed from sequence 3 without gaps,
    accepted browser approval and steering, and refused arbitrary and
    cross-origin commands. Desktop and mobile browser layouts were exercised.
    The production vertical slice routes strict HTTP commands through the same
    command service as the CLI, enforces a supervisor lease and
    supervisor-lifetime path bootstrap, and integration-tests replay, rejection,
    approval, and finish.
* Evidence needed: Test supervisor restart and sustained output load, then
    normalize one live subprocess and one SDK session.
* Probe: `experiments/probes/orchestration/README.md#the-browser-run-console-offline`
* Outcome: HTTP is feasible. Use SSE for run and output streams plus structured
    command POSTs for the first implementation; no current requirement needs a
    WebSocket. Because the driver exits when human input is due, a separate
    loopback `senawa work web <run>` supervisor must survive that exit and resume
    the detached driver after decisions. The production supervisor now uses the
    shared control path; keep the decision probing until restart, load, and live
    worker evidence close the remaining questions.
* Promotion: `pending`

### 2026-08-05: Reusable browser bootstrap capability

* Status: `accepted`
* Owner: `docs/design/07-implementation-and-operations.md`
* Question: Can the high-entropy browser bootstrap capability remain reusable
    for the supervisor lifetime without weakening cookie, Host, Origin, or
    loopback enforcement?
* Context: A single-use bootstrap fails when a link preview, browser retry, or
    prior navigation consumes it before the intended browser retains the cookie.
    VS Code remote-port forwarding also rewrites a query capability delimiter,
    so the server cannot recognize the printed URL and returns `Unauthorized`.
* Options: Remove browser authentication, retain a single-use bootstrap, or
    retain authentication with a supervisor-lifetime bootstrap capability
* Evidence obtained: Repeated valid bootstrap requests mint the same scoped
    session, an incorrect capability remains unauthorized, and command POSTs
    continue to require the expected Origin. A path capability survives VS Code
    remote-port forwarding without delimiter rewriting. The focused production
    supervisor and CLI tests pass with this behavior.
* Probe: `experiments/probes/orchestration/README.md#the-browser-run-console-offline`
* Outcome: Retain browser authentication. Make the random bootstrap capability
    a path segment reusable only while its loopback supervisor lives, and print
    it after launch so the human can recover from previews, retries, forwarding,
    and opener failures.
* Promotion: `docs/design/07-implementation-and-operations.md#cli-groups`

### 2026-08-04: Worker autopilot completion

* Status: `proposed`
* Owner: `docs/design/03-agents-and-interaction.md`
* Question: Can worker autopilot trigger the gate without treating
    `task_complete` as proof of completion?
* Evidence needed: A live worker run where the harness remains authoritative
    across success, refusal, and exhausted continuation paths
* Probe: `experiments/probes/orchestration/README.md`
* Outcome: `pending`
* Promotion: `pending`

### 2026-08-04: Verification representation

* Status: `proposed`
* Owner: `docs/design/02-workflows-and-lifecycle.md`
* Question: Should verification be a sensor, a phase node, or both?
* Evidence needed: Compare graph clarity, iteration behavior, report provenance,
    and cost for each representation
* Probe: `not started`
* Outcome: `pending`
* Promotion: `pending`

### 2026-08-04: Non-additive plan revision

* Status: `proposed`
* Owner: `docs/design/02-workflows-and-lifecycle.md`
* Question: Should plan revision retract work as well as append it?
* Evidence needed: A case where task abort plus additive revision cannot express
    the intended correction cleanly
* Probe: `experiments/probes/orchestration/README.md`
* Outcome: `pending`
* Promotion: `pending`

### 2026-08-04: Run-wide spend limits

* Status: `proposed`
* Owner: `docs/design/07-implementation-and-operations.md`
* Question: Should a run-wide AIU ceiling supplement task and phase limits?
* Evidence needed: Cost traces from representative runs showing whether local
    limits bound total spend predictably
* Probe: `not started`
* Outcome: `pending`
* Promotion: `pending`

### 2026-08-04: Tracking directory retention

* Status: `proposed`
* Owner: `docs/design/06-provenance-and-observability.md`
* Question: Should the tracking directory be committed to the main branch or an
    archive branch?
* Evidence needed: Review one real run through both storage models and compare
    discoverability, repository noise, and retention
* Probe: `not started`
* Outcome: `pending`
* Promotion: `pending`

### 2026-08-04: Journal segmentation

* Status: `proposed`
* Owner: `docs/design/06-provenance-and-observability.md`
* Question: Do long runs require segmented journals while preserving append-only
    order?
* Evidence needed: Journal size, render latency, and recovery behavior from a
    multi-day or high-event run
* Probe: `not started`
* Outcome: `pending`
* Promotion: `pending`

### 2026-08-04: Human review cadence

* Status: `proposed`
* Owner: `docs/design/01-system-model.md`
* Question: Which checkpoint cadence prevents comprehension debt on large task
    frontiers?
* Evidence needed: Human review experience at task-count, merge-slot, and spend
    thresholds on a representative run
* Probe: `not started`
* Outcome: `pending`
* Promotion: `pending`

### 2026-08-04: Counter-metric selection

* Status: `proposed`
* Owner: `docs/design/04-sensors-gates-and-enforcement.md`
* Question: Which counter-metrics remain cheap, stable, and independent of their
    primary gates?
* Evidence needed: Repeated cost, stability, and correlation measurements for
    coverage, public API surface, and candidate structural counts
* Probe: `experiments/probes/sensors/README.md`
* Outcome: `pending`
* Promotion: `pending`
