# Implementation and Operations

## Current status

Senawa now has a production vertical slice across the domain, configuration,
application, file runtime, artifact, observability, workers, sensors, browser,
reporting, CLI, and hook packages. The executable path validates repository definitions,
runs the standard workflow with deterministic workers, persists versioned
artifacts and append-only evidence, accepts CLI and browser decisions through
the same application commands and queries, streams output over SSE, and renders
a run report.

The production `@senawa/sensors` package evaluates artifact and command sensors
from `.senawa/sensors.yaml`. Configuration loads workflows from
`.senawa/workflows/`, artifact contracts from `.senawa/schemas/`, and worker
profiles from `.senawa/agents/`. Command evidence is normalized and capped,
execution errors remain distinct and blocking, and advisory assessment failures
do not block. Deterministic checks run from cheap to expensive; a deterministic
failure skips later blocking expensive checks while advisory checks still run.
The evaluator exposes cache identity and evidence-spill ports and neutralizes
instruction-like tags before evidence reaches prompts or reports. Worker hosts
have no gate-verdict field; the application driver
invokes the evaluator and journals `sensor.started`, `sensor.completed`,
`sensor.error`, and `gate.evaluated` evidence before changing phase or task
state.

Worker roles are strict repository profiles under `.senawa/agents`.
Configuration loads and validates their frontmatter and prompts, snapshots exact
sources, includes them in the run fingerprint, and rejects missing workflow or
plan roles. Worker hosts consume only the resolved snapshot profile. The
subprocess adapter maps semantic capability requests through a Senawa-owned
phase or task ceiling.
The user-facing skill stays under `.agents/skills/senawa/` only because Copilot
discovers it there; it is not runtime worker configuration.

`@senawa/workers` owns deterministic, recording, and subprocess adapters behind
an application lifecycle port. The port separates create, resume, inspect,
cancel, release, negotiation, normalized events, and typed binding contracts.
Offline conformance covers deterministic lifecycle behavior and a recording
fake subprocess executable. The subprocess adapter reports absent typed-tool
transport, buffered output, process-local inspection limits, and absent path
containment honestly. No live Copilot subprocess or SDK transport was exercised.

The `senawa` app explicitly composes the file and presentation adapters.
`@senawa/runtime-file`
owns mutable runtime state, repository singleton ownership, fenced leases, and
write-ahead recovery. `@senawa/artifact-store` owns create-only identity,
snapshot, and versioned artifact documents with digest conflict checks.
`@senawa/observability` owns idempotent journal JSONL and session/turn output
streams with stable owner projections, storage-assigned cursors, and
process-local notification hints. Interrupted aggregate
application commits converge from one pending transaction on reopen, while each
fact has one durable authority after convergence. This is not the intended
Beads adapter, which remains pending. The production Copilot subprocess host is
opt-in and has not been exercised during this implementation phase.

The application package owns commands, queries, driver transitions, prompt
construction, status projections, and ports for runtime state, active-run
ownership, immutable documents, journal and output reads, leases, worker
sessions, gates, reporting, clocks, scheduling, notifications, and telemetry.
Runtime mutations use operation IDs and compare-and-swap revisions. The graph
package is now a thin compatibility re-export facade with no adapter factory or
runtime selection. Shared contracts under `@senawa/testing` and
`tests/contract/` cover runtime restart, immutable documents, journal and output
idempotency, lease fencing, mid-commit crash recovery, dispatch reconstruction,
and status projections.
Browser SSE rereads durable cursors on bounded polling; notifications only wake
same-process readers sooner. `@senawa/browser` owns authenticated HTTP routes,
strict command schemas, graph assets, and durable replay. `@senawa/reporting`
reads an application-owned evidence projection and escapes untrusted Markdown,
HTML, control characters, and instruction-like tags. `@senawa/web` and
`@senawa/report` are thin re-export facades.

The [POC findings](wip/probe-findings.md) distinguish live-model evidence,
offline deterministic simulation, and documentation-only claims.

## Technology choice

Implement the core in TypeScript on Node.js 22 or later.

The choice is based on one toolchain across the CLI, orchestrator, graph adapter,
sensor schemas, and report renderer; acceptable bundled hook startup; and rapid
iteration on schema-heavy contracts that are still changing.

Go remains the strongest alternative for a future hook shim or stable rewrite.
Beads being written in Go does not justify linking its internals. Senawa consumes
the documented `bd --json` contract with `BD_JSON_ENVELOPE=1`.

## Package boundaries

| Package | Responsibility |
|---------|----------------|
| `@senawa/domain` | Pure schemas, identifiers, snapshots, state contracts, events, and transition invariants |
| `@senawa/configuration` | Repository discovery, YAML and JSON loading, schema compilation, profiles, workflow catalog, doctor preflight, snapshots, and fingerprints |
| `@senawa/core` | Temporary source-level compatibility facade over domain and configuration exports |
| `@senawa/application` | Commands, queries, driver, prompts, projections, and application-owned ports; imports domain only |
| `@senawa/runtime-file` | Explicit development and test runtime state, active-run registry, fenced leases, and split-store recovery |
| `@senawa/artifact-store` | Immutable run identity, snapshot, and versioned artifact documents |
| `@senawa/observability` | Append-only journal and output JSONL, stable cursors, notification hints, and future telemetry seams |
| `@senawa/testing` | Shared adapter contracts and deterministic fixtures; production packages do not import it |
| `@senawa/graph` | Thin compatibility re-export facade with no adapter selection |
| `@senawa/workers` | Deterministic, recording, and subprocess lifecycle adapters, capability negotiation, authorization, normalized events, and typed binding fixtures |
| `@senawa/sensors` | Application gate port implementation, ordered built-in artifact or command execution, normalization, cache identity, and evidence spill seams; generic extension loading pending |
| `@senawa/browser` | Authenticated loopback HTTP routes, strict command schemas, durable SSE replay, static graph assets, and application command/query consumption |
| `@senawa/reporting` | Report renderer and untrusted Markdown hygiene over application evidence projections |
| `@senawa/web` | Thin compatibility re-export facade for `@senawa/browser` |
| `@senawa/report` | Thin compatibility re-export facade for `@senawa/reporting` |
| `@senawa/orchestrator` | Temporary application compatibility package for remaining non-production importers |
| `senawa` | Full command-line interface |
| `senawa-hook` | Minimal hook entry point with no graph or heavy dependencies |

The sensor executable boundary remains language-agnostic. Project-specific checks
may be shell, Python, Go, or any executable that implements the declared JSON
contract.

## Repository initialization

The current vertical slice validates existing repository definitions but does
not yet implement `senawa init`. A consumer repository must provide
`.senawa/sensors.yaml`, at least one workflow under `.senawa/workflows/`, its
referenced schemas under `.senawa/schemas/`, every referenced worker role under
`.senawa/agents/`, and the Copilot-facing skill at
`.agents/skills/senawa/SKILL.md` before running `senawa doctor`.

Initialization will scaffold those repository inputs. It will not emit
`.github/agents` or `.github/hooks`: worker authority, hook policy, isolation,
gate evaluation, and audit remain implemented and versioned in Senawa packages.

## Build and tooling

Use a pnpm workspace with Vitest, Zod, execa, esbuild, and Biome.

Build two bundles:

| Bundle | Budget | Contents |
|--------|--------|----------|
| `senawa-hook` | Approximately 40 ms startup | Hook payload parsing and local policy decision |
| `senawa` | Approximately 70 ms startup | Full CLI and orchestration dependencies |

ESM bundles that include CommonJS dependencies require the esbuild
`createRequire` banner. CI must import both built bundles so runtime-only dynamic
require failures do not escape the build.

The current workspace exposes `pnpm bundle:check` for CLI and hook startup,
`pnpm demo` for the isolated no-credit browser workflow, and `pnpm demo:live`
for the guarded Copilot implementation-worker path. The offline demo terminates
its supervisor by default; `pnpm demo -- --keep-server` is the explicit
inspection mode. Its temporary repository runs real command sensors: typecheck
passes, while tests fail on attempt 1 and pass on attempt 2 to prove deterministic
rework without AI credits.

If hook startup later becomes material, keep the orchestrator warm behind a Unix
socket and replace the shell hook with a small compiled client. Do not rewrite
the orchestration system to solve a measured hot-path problem.

## CLI groups

The command surface is grouped by responsibility:

| Group | Representative commands | Primary caller |
|-------|-------------------------|----------------|
| Run lifecycle | `work start`, `resume`, `show`, `log`, `wait`, `pause`, `end`, `finish`, `browser` | Human or principal agent |
| Human decisions | `approve`, `reject`, `answer`, `steer`, `task abort`, `work budget` | Human, sometimes relayed |
| Phase inspection | `phase show`, `phase brief` | Human, principal agent, driver |
| Worker contract | `task done`, `ask`, `discover`, `note` | Worker wrapper |
| Driver internals | `task next`, `dispatch`, `gate check`, `plan import` | Driver or debugging |
| Sensor management | `sensor list`, `info`, `run`, `audit` | Human, CI, driver |
| Workflow management | `workflow list`, `info`, `validate`, `render` | Human or principal agent |
| Diagnostics | `doctor`, `prime`, `work report` | All trusted operational callers |

`senawa browser [<run>]` is the user-facing console command. It creates a fresh
high-entropy bootstrap capability, opens it through the configured system
browser, and prints it as a recoverable URL. The capability may mint the same
HttpOnly session cookie repeatedly while that supervisor lives, so link previews
and browser retries cannot consume the only entry path. It is carried in a path
segment because VS Code remote-port forwarding rewrites query delimiters.
`--no-open` suppresses the local launch for manual or forwarded use. `senawa work
web` remains the low-level supervisor command for automation.

The complete argument grammar belongs in generated CLI reference once the
implementation begins. Design documents define authority and behavior, not a
second parser specification.

## Build order

### Slice 0: workspace and contracts

Create the pnpm workspace, pure schemas, tests, and two bundles. Add startup and
hostile-output regression tests immediately.

### Slice 1: quality seam

Implement `init`, sensor discovery, `sensor run`, `gate check`, and `doctor`.
This yields one command that answers whether work satisfies declared policy,
without any agents.

### Slice 2: enforcement

Add fast post-edit feedback and pre-tool policy interception. Verify that hooks
return an empty response or denial, never `allow`, and measure timeout behavior.

### Slice 3: graph and journal

Add the beads adapter, work creation, atomic claim, completion requests, bounded
status, and append-only events. Drive one task manually and prove it cannot close
while its gate is red.

### Slice 4: phases and subprocess workers

Add strict repository worker profiles, versioned phase artifacts, plan import
and validation, approval, rejection, and session resume. Use the subprocess
topology first because exact commands and transcripts are easy to inspect.
Resolve roles from the immutable run snapshot, fail closed, and intersect their
requested capabilities with Senawa policy when each worker is created.

### Slice 5: hosted driver

Move workers to SDK-hosted independent sessions. Add the lease, intent-outcome
reconciliation, human question relay, steering inbox, and inline terminal
controls. Enforce one active run and one active worker turn. Add graceful end
before any background execution so a stranded run can never permanently block
the repository.

### Slice 6: conversational surface and scale

Expand the Senawa skill, additive planning, cost dashboards, and reusable
workflow formulas. Keep worktrees, parallel workers, and multiple active runs
deferred until separate probes establish isolation and integration policy.

### Slice 7: control quality

Add sensor stability audits, counter-metrics, review cadence, and operational
alerts for hook latency and sensor drift.

## Required validations

Each implementation slice should preserve these executable properties:

* Invalid configuration fails before any model dispatch.
* A worker cannot resolve `bd` or mutate graph state directly.
* A red gate prevents task closure and returns actionable findings.
* Deleting the projection cache does not change resumed state.
* A crash between intent and outcome reconciles without duplicate work.
* Closed tasks survive additive plan revision.
* Worker sessions never appear in the human session store.
* A principal agent uses only Senawa and never chooses a transition.
* Every run can be reconstructed from graph state, journal, and artifacts.

## Known substrate constraints

| Constraint | Design response |
|------------|-----------------|
| Command hook timeout fails open | Keep policy hooks fast and instrument latency |
| SDK has no stop hooks | Driver owns the explicit retry loop |
| Model `Auto` overrides profile model | Pin a model for every dispatched session |
| Some models reject reasoning effort | Resolve hints through a capability table |
| Beads reads take hundreds of milliseconds | Cache reads and never call beads from hooks |
| `bd list` hides closed work by default | Reconstruct with `--all` and filter events |
| `bd batch` cannot write metadata | Keep metadata updates as explicit calls |
| Worktrees share one beads database | Serialize graph writes through Senawa |
| Session picker has no hidden-session flag | Use isolated `COPILOT_HOME` or `baseDirectory` |
| Inferential output can vary | Start advisory and promote only for measured scopes |

## Open decisions

Questions that still need evidence are tracked in the working
[Decision Log](wip/decision-log.md). This guide changes only after a decision is
accepted and promoted.

Decisions removed from the current architecture remain in
[Roads Not Taken](wip/roads-not-taken.md). They should return to current guidance
only when new evidence changes their constraints.

## Evidence and history

The [design working record](wip/README.md) holds proposed decisions, probe
findings, discarded approaches, and the historical monolith. Use it to mature or
audit a decision. Use the numbered guides for the design currently intended for
implementation.
