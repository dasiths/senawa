# Implementation and Operations

## Current status

Senawa now has a production vertical slice across the core, graph, report,
orchestrator, CLI, web, and hook packages. The executable path validates
repository definitions, runs the standard workflow with deterministic workers,
persists versioned artifacts and append-only evidence, accepts CLI and browser
decisions through one command service, streams output over SSE, and renders a
run report.

The production `@senawa/sensors` package evaluates artifact and command sensors
from `.senawa/sensors.yaml`. Core also loads workflows from
`.senawa/workflows/`, artifact contracts from `.senawa/schemas/`, and worker
profiles from `.senawa/agents/`. Command evidence is normalized and capped,
execution errors remain distinct and blocking, and advisory assessment failures
do not block. Worker hosts have no gate-verdict field; the orchestrator invokes
the evaluator and journals `sensor.started`, `sensor.completed`, `sensor.error`,
and `gate.evaluated` evidence before changing phase or task state.

Worker roles are strict repository profiles under `.senawa/agents`. Core loads
and validates their frontmatter and prompts, snapshots exact sources, includes
them in the run fingerprint, and rejects missing workflow or plan roles. Worker
hosts consume only the resolved snapshot profile. The subprocess adapter maps
semantic capability requests through a Senawa-owned phase or task ceiling.
The user-facing skill stays under `.agents/skills/senawa/` only because Copilot
discovers it there; it is not runtime worker configuration.

The graph package currently provides a file-backed runtime store. It enforces
the singleton, leases, immutable identity and snapshot, serialized writes, and
terminal-run archival required by the vertical slice. It is not the intended
beads adapter, which remains pending. The production Copilot subprocess host is
opt-in and has not been exercised during this implementation phase.

The [POC findings](wip/poc-findings.md) distinguish live-model evidence,
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
| `@senawa/core` | Pure schemas, fingerprints, state transitions, event contracts, and brief composition |
| `@senawa/graph` | Runtime store boundary and current file-backed adapter; beads adapter pending |
| `@senawa/sensors` | Gate evaluation and built-in artifact or command execution, normalization, and evidence hygiene; generic extension loading and caching pending |
| `@senawa/report` | Journal writer, report renderer, graph diagrams, and output escaping |
| `@senawa/orchestrator` | Driver loop, session hosting, reconciliation, lease, steering, and TTY controls |
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
one-time bootstrap URL, opens it through the configured system browser, and
prints only the token-free URL after opening. `--no-open` prints the bootstrap
URL for manual or forwarded use. `senawa work web` remains the low-level
supervisor command for automation.

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
