# Orchestration Probe

## Goal

This is the probe closest to the product. It covers both levels of the
orchestration loop: the per-task loop where the harness dispatches a worker,
refuses its work, and hands back findings, and the workflow above it that
compiles phases into durable state and advances them without a human watching.

## What it proves

### The workflow engine, offline

Structural errors are found before anything is dispatched. Against a deliberately
invalid workflow, `doctor` reported ten violations in one pass: a dependency
cycle, a missing gate, an unknown approval value, a non-finite `iteration.max`,
an unknown staleness policy, `reentrant` on an agent phase,
`resumeAcrossIterations` on a task frontier, missing rework and dispatch budgets,
and a `completesWhen` naming a phase that does not exist.

Kickoff is one transaction. `work start` validates the merged input against the
workflow input schema, copies the workflow, sensor and gate configuration, and
schemas into the work directory, records a single content fingerprint, then
creates the epic and five phase beads with their dependency edges. It then
drives, in the foreground, until it needs a human.

Runtime state lives in the graph, not beside it. Phase status, iteration, session
identifier and artifact version are held in bead metadata; transitions go through
`bd set-state`, so a `senawa:awaiting_approval` label answers "what needs a
human" without reading a local file; and waiting for approval is a beads `human`
gate that genuinely blocks the phase. `work.json` holds only run identity, and
the probe deletes `cache.json` mid-run to prove nothing depends on it.

The run follows its frozen snapshot. The probe edits the source workflow
immediately after kickoff; the run completes from the snapshot and reports
`sourceChanged: true` rather than silently adopting the edit.

Phases stop for approval and can be sent back. The probe rejects the plan with a
reason, and the planner's own session resumes to produce v2, which contains the
task the rejection asked for. Artifacts are versioned rather than overwritten, so
v1 remains readable next to v2.

A killed driver is recoverable. The probe kills the process after the worker has
acted but before the outcome is journalled. On resume, reconciliation finds the
intent with no outcome, sees that the turn completed, and gates the work the
worker actually produced rather than dispatching it again.

Iteration is additive. After verification the probe adds a task with
`plan revise`, the implementation frontier re-opens, the new task runs, and the
three already-closed tasks are untouched. Verification runs a second time, and
the run ends only when the human accepts it.

A representative run:

```text
define        approved, iteration 1
research      approved, iteration 1
plan          rejected, then approved at iteration 2 (v2 adds error handling)
implement     driver killed mid-dispatch, reconciled, one refusal, three tasks closed
verify        reached, then superseded by a plan revision
implement     re-opened, add-logging closed
verify        iteration 2, approved
work          accepted
```

Final state: five accepted phases, four closed tasks, plan at v3, verify at
iteration 2, 64 journal events, and every session under the work directory's own
home rather than the user's.

### The principal agent surface, live

`pa-driven.sh` tests the chain the design is actually for: you, a Copilot session
carrying the senawa skill, senawa, then the workers. The agent is given the skill
and a `senawa` on its PATH. Real `bd` is shadowed by a shim that records any
attempt to reach past the seam, because the design admits the agent is contained
by instructions rather than enforcement, and that claim is only worth something
if it is measured.

Across three turns of one resumed session it listed the available workflows,
started a run, read `needs` from the status projection and reported the artifact
path rather than paraphrasing the artifact, then approved the phase and resumed.
The harness recorded one approval, the define phase accepted, and the run moved
on to research. The bd shim was never invoked.

### The per-task loop, live

Capability removal is practical. The worker's environment is constructed rather
than filtered: a directory containing exactly the executables it may reach, with
`bd` deliberately absent. The worker could reach `senawa` and could not reach
`bd`.

The bead status is the proof. Across every run, including failed ones, task
status changed only when the orchestrator changed it, and the worker never
edited the test that judged it.

Instruction-only compliance is unreliable, and it does not matter. In one run the
worker submitted through `senawa task done` as instructed; in another it silently
skipped the call, edited the file, and ended its turn. The outcome was correct
both times because the orchestrator's gate run is authoritative.

Execution hints cannot be forwarded blindly. Passing `--effort` to a model that
does not support it is a hard error that kills the dispatch before the worker
starts, and because the session was never created, the follow-up resume attempts
failed too. One bad flag consumed an entire task budget and reported it as the
worker's fault, which is why dispatch failures need their own event and their own
budget.

### The browser run console, offline

The question is whether a local HTTP application can show an active workflow,
replay and then tail each worker's complete output, and relay human commands
without requiring a terminal attachment or a WebSocket protocol.

`web-console.mjs` starts the five-phase workflow with deterministic child
processes. It captures stdout and stderr separately, assigns a monotonic sequence
to every record, appends the record to a per-phase JSONL file before broadcasting
it, and exposes two Server-Sent Event streams: run changes and selected-phase
output. The browser uses ordinary POST requests for structured commands.

The automated probe established:

* The graph projection contained five phase nodes and four dependency edges.
* Clicking a phase could replay all six existing output records and continue
  with live records from the same stream.
* Disconnecting after output sequence 2 and reconnecting from its cursor resumed
  at sequence 3 with no duplicate or gap.
* Stdout, stderr, and browser control records remained distinguishable, and the
  define and research streams did not leak into one another.
* Browser approval accepted define and started research. Steering was accepted
  only while research was running and was recorded in that phase's stream.
* An arbitrary `shell` command was rejected, as was a command carrying a foreign
  Origin.
* The interface rendered without pane overlap at 1440 pixels and without
  page-level horizontal overflow at 390 pixels. The workflow graph alone scrolls
  horizontally on the narrow layout.

SSE plus command POSTs is sufficient for the first implementation. The data is
one-way except for discrete human commands, SSE already reconnects, and
`Last-Event-ID` maps directly to the durable sequence. A WebSocket adds connection
state and a second command protocol without solving a requirement this probe
found.

The production output source differs by worker topology. Subprocess workers emit
Copilot JSONL on stdout and diagnostics on stderr. SDK-hosted workers expose typed
session events, optional streaming deltas, and an experimental cursor-based event
log with catch-up and long-poll reads. Senawa should normalize both into its own
durable per-session output records rather than expose terminal escape sequences
or make the browser depend on an experimental SDK cursor.

The command handler in this probe is a deterministic stand-in. A production HTTP
adapter must invoke the same authority-checked core operations as the CLI and
driver. If it implements phase transitions itself, it becomes the second control
path the architecture forbids.

The blocking lifecycle determines where the server lives. The driver exits when
a human decision is due, which is exactly when the browser must remain available.
The first production shape should therefore be a separate loopback process,
`senawa web <work>`, rather than a listener owned only by the driver process. It
can start or resume the driver detached, survive its exit, and keep serving the
same run.

| Production concern | Required shape |
|--------------------|----------------|
| Run graph | A JSON projection of phase and task nodes, dependency edges, state, role, session ID, and available human actions |
| Output capture | Drain every process or SDK event source regardless of viewers, normalize records, persist first, then fan out |
| Replay | One monotonic cursor per session output stream; bounded SSE clients reconnect from durable storage |
| Commands | HTTP schema maps to explicit core operations such as approve, reject, steer, pause, abort, and resume; never accept a shell string |
| Driver lifecycle | A web supervisor survives exit 2 and starts or resumes the detached driver after a decision |
| Authority | The same state validation, lease checks, journal events, and approval channel used by CLI calls |
| Security | Loopback binding, one-time capability bootstrap, SameSite cookie, Origin checks, no CORS, output escaping, and no remote mode by default |
| Graph rendering | Use a maintained DAG visualization library for dynamic task frontiers; the hand-built linear graph is POC-only |
| Slow viewers | Never let an HTTP client backpressure worker pipes; cap live queues and make durable replay the recovery path |
| Retention | Rotate or segment large output logs and preserve them with the run report according to the tracking policy |

Raw output is sensitive. It can contain source, prompts, tool arguments, paths,
and imperfectly redacted process diagnostics. Remote binding, shared access, and
TLS are separate decisions rather than flags the local POC should imply are safe.

## What it does not prove

* Real agent phases submitting schema-valid artifacts, since the workflow hosts
  are deterministic fakes
* Parallel task-frontier execution, worktrees, and merge-slot integration
* Inline TTY controls, which the design specifies but this probe replaces with
  separate command invocations
* That a real Copilot session resumes usefully across many phase iterations,
  which is where background compaction eventually bites
* Live Copilot subprocess JSONL or SDK events flowing through the browser stream
* Output replay after the web server itself restarts
* Backpressure and memory behavior under high-volume output or many viewers
* Production authentication, TLS, remote access, and multi-user authorization;
  the probe binds to loopback and uses one capability token
* That the HTTP command adapter calls real Senawa command handlers instead of a
  parallel state transition implementation

## Layout

| Path             | Role                                                                    |
|------------------|--------------------------------------------------------------------------|
| `engine.mjs`     | Validation, kickoff, the blocking driver, approvals, iterations, reconciliation |
| `run.sh`         | The full human journey: approve, reject, crash, resume, revise, accept    |
| `pa-driven.sh`   | The same harness driven by a real Copilot session holding the skill       |
| `skill/senawa/`  | The skill under test, copied into the scratch repository                 |
| `senawa.mjs`     | Throwaway per-task harness: graph, sensors, gate, journal, run report     |
| `end-to-end.sh`  | Live run: constructed worker environment, real dispatch, refusal, rework  |
| `web-console.mjs` | Loopback HTTP server, durable output capture, SSE replay, and command adapter |
| `web-console/`   | Responsive workflow graph, agent output viewer, and contextual controls  |
| `web-console-test.mjs` | Offline replay, reconnect, isolation, authorization, and command assertions |
| `workflows/`     | A valid five-phase workflow and a deliberately invalid one               |
| `schemas/`       | Work request input schema                                                |
| `extra-tasks.json` | The tasks added after verification, to prove revision is additive      |
| `sensors.yaml`   | Gates and sensor declarations used by the engine                         |
| `fixture/`       | The small buggy program the live worker is asked to fix                  |

## Running

```bash
bash poc/orchestration/run.sh          # offline, slow because it uses a real beads database
node poc/orchestration/web-console-test.mjs # offline, no AI credits
node poc/orchestration/web-console.mjs # opens a local run console until interrupted
bash poc/orchestration/pa-driven.sh    # spends AI credits
bash poc/orchestration/end-to-end.sh   # spends AI credits
```

## Change log

| Date       | Change                                                                                                                                            |
|------------|-----------------------------------------------------------------------------------------------------------------------------------------------------|
| 2026-07-28 | End-to-end probe. Established that capability removal works, that only the orchestrator changes bead status, that worker compliance is unreliable but harmless, and that forwarding an unsupported effort hint destroys a task budget. |
| 2026-08-02 | Added the workflow engine: declarative phases, structural validation before dispatch, frozen definition snapshots, plan expansion into dependent beads, and restart-safe bounded ticks. |
| 2026-08-02 | Merged the workflow engine and the end-to-end probe into one folder, since they are the same loop at two levels. Corrected the engine to refresh lifecycle status from beads on every tick rather than trusting its own JSON cache. |
| 2026-08-02 | Replaced the scheduler model with a blocking driver. `work start` now drives to completion and exits 2 when a human is needed; `work resume` reconciles and continues. Added phase approvals, rejection with iterations that resume the phase session, versioned artifacts, additive `plan revise`, human acceptance as the completion condition, and an injected mid-dispatch crash proving intent-before-side-effect journalling is enough to recover. |
| 2026-08-02 | Moved runtime state into beads, where the design always said it belonged. Phase status, iteration, session and version now live in bead metadata, transitions write `senawa:<state>` labels, and approvals are real `human` gates. Two bugs surfaced immediately: `bd list` hides closed issues, so finished tasks vanished from the frontier and `plan revise` would have recreated them, and reopening a phase without resolving its outstanding gate left the phase bead permanently blocked. |
| 2026-08-02 | Added `pa-driven.sh` and the skill it tests. A real Copilot session, given only the skill, listed workflows, started a run, reported what the run needed, approved a phase and resumed, without ever calling `bd`. Also established that repository skills are discovered from `.github/skills/`. |
| 2026-08-04 | Added the offline browser run console. Proved graph observation, durable per-phase stdout/stderr replay followed by live SSE, cursor reconnect without gaps, responsive desktop/mobile layout, browser approval and steering, and rejection of arbitrary or cross-origin commands. Left real Senawa command-handler integration and live Copilot event normalization explicitly unproven. |
