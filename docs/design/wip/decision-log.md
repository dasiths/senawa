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
    mutable runtime JSON blob. The ordinary CLI still defaults to file until
    Phase 8; backend identity, the production-default switch, live subprocess
    evidence, and SDK transport remain pending.
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
