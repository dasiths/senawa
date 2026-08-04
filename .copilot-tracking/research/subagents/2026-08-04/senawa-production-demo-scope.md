# Senawa Production Demo Scope Research

## Research questions

* What is the smallest production implementation that satisfies the current Senawa design and supports an end-to-end demo?
* Which repository tooling and configuration already exist?
* Which orchestration POC modules can be reused or promoted?
* Which production packages and files must be created?
* What exact demo flow should serve as acceptance criteria?
* Which steps require live GitHub Copilot, and which can use deterministic workers?
* What major risks, blockers, and ambiguities remain?

## Current repository tooling and configuration

The repository has no root `package.json`, workspace manifest, TypeScript
configuration, test configuration, linter configuration, build script, or
production source directory. Production implementation has not started.

The devcontainer already provisions the intended development substrate:

* Node.js 22 on Debian 12
* pnpm 10.34.5 through the post-create script
* GitHub Copilot CLI and beads as global packages
* Biome, Vitest, YAML, Markdown, Docker, and GitHub VS Code extensions
* A public npm registry by default, with proxy support through
  `.devcontainer/.env`

Each POC is an independent npm package with its own `package-lock.json`.
Relevant proven dependencies are Ajv 8.17.1, `ajv-formats` 3.0.1, YAML 2.8.1,
Copilot SDK 1.0.7, Zod 4.4.3, Commander 14.0.2, execa 9.6.0, esbuild 0.25.12,
TypeScript 5.8.3, and ESLint 9.30.1. The current design instead calls for a
pnpm workspace using TypeScript, Vitest, Zod, execa, esbuild, and Biome. Ajv or
another JSON Schema evaluator is additionally required because Senawa accepts
repository-owned JSON Schema documents; Zod alone cannot evaluate those files.

The repository deliberately commits tracking data except regenerated sensor
runs. Production outputs should continue to use `.agents/.copilot-tracking/`.

## Reusable POC code

Promote behavior, tests, and fixtures rather than copying the monolithic POC
files unchanged.

| POC source | Reusable production behavior |
|------------|------------------------------|
| `poc/orchestration/engine.mjs` | Definition validation, fingerprints and snapshots, graph-backed phase/task state, deterministic transition selection, plan import, approval and rejection, additive revision, status projection, intent/outcome reconciliation, singleton release ordering, and graceful end |
| `poc/orchestration/senawa.mjs` | Capability-restricted task contract, authoritative post-turn gate, actionable refusal shape, append-only journal, and report outline |
| `poc/orchestration/end-to-end.sh` | Live subprocess dispatch, isolated session identity, constructed worker `PATH`, model/effort capability mapping, same-session rework, and harness-only closure acceptance |
| `poc/orchestration/run.sh` | Full deterministic acceptance narrative and assertions |
| `poc/orchestration/pa-driven.sh` | Principal-agent skill discovery and relay acceptance test |
| `poc/orchestration/skill/senawa/SKILL.md` | Initial principal-agent command vocabulary and authority rules |
| `poc/sensors/cli.mjs` | Explicit extension registry and four schema-validation boundaries |
| `poc/sensors/hygiene.mjs` | Cost ordering, short-circuiting, fingerprint cache, and hostile-output regression behavior |
| `poc/sensors/normalizers.mjs` | Common finding envelope and parsers for raw, Node, Python, ESLint, and TypeScript output |
| `poc/worker-sessions/isolation.mjs` | SDK `baseDirectory`, subprocess `COPILOT_HOME`, and post-archive session deletion |
| `poc/sdk-surface/probe.mjs` | Typed worker tool, permission feedback, and programmatic session resume |

Do not promote the fake implementations in `runAgentPhase`, `evaluateGate`, or
the browser command handler. They exist to test orchestration semantics. The
browser server also owns an in-memory transition system, which production must
not retain.

## Proposed implementation scope

Implement one vertical CLI slice that preserves the documented package
boundaries and can run the standard-delivery workflow with one active run and
one active worker turn.

The minimum includes:

1. A pnpm TypeScript workspace and two esbuild bundles, `senawa` and
   `senawa-hook`.
2. JSON Schema-backed contracts for workflows, work requests, phase artifacts,
   plans, sensor manifests, assessments, journal events, and status output.
3. Definition loading, full pre-dispatch validation, content fingerprinting,
   and a frozen per-run snapshot.
4. A beads adapter that always sets `BD_JSON_ENVELOPE=1`, initializes once with
   non-interactive flags, claims atomically, reads with `--all` when rebuilding,
   serializes writes, and invalidates its read cache.
5. Explicit command-sensor loading, normalized and sanitized findings,
   deterministic-first evaluation, reading fingerprints, and gate evaluation.
   Inferential sensors may remain advisory or use a deterministic test host for
   the first demo.
6. Append-only journal events, durable intent/outcome pairs, versioned
   artifacts, status projection, report rendering, and output escaping.
7. The foreground deterministic driver with a real lease, startup singleton,
   resume reconciliation, approval/rejection, additive plan revision, graceful
   end, separate dispatch and rework budgets, and release-last terminalization.
8. One worker-host interface with a deterministic implementation for free
   acceptance tests and a Copilot subprocess implementation for the live demo.
   Subprocess sessions use isolated `COPILOT_HOME`, caller-chosen stable IDs,
   JSONL output capture, restricted capabilities, and same-session resume.
9. A principal-agent skill that uses only bounded Senawa commands and requires
   explicit human intent for decisions.
10. Fast frozen-file and command policy enforcement through `senawa-hook`.
    Hooks return an empty object or a denial, never `allow`.

Defer the hosted SDK driver, browser console, inferential sensor audits, cost
dashboard, multiple runs, parallel workers, worktrees, merge slots, remote web
access, and journal segmentation. The subprocess host is an accepted fallback
and is the smallest inspectable path to a live demo. The browser console remains
a follow-up until HTTP calls the same production operations as the CLI and
survives real driver restarts.

## Files and modules to create

The following is the smallest production-oriented file map. Each package also
needs a `package.json`, `tsconfig.json`, `src/index.ts`, and focused tests.

### Workspace

* `package.json`: package manager pin and root scripts
* `pnpm-workspace.yaml`: `packages/*`
* `pnpm-lock.yaml`: generated frozen dependency graph
* `tsconfig.base.json`: strict ESM Node.js configuration
* `biome.json`: formatting and lint rules
* `vitest.config.ts`: unit and integration test projects
* `scripts/build.mjs`: both esbuild bundles with the `createRequire` banner
* `scripts/check-bundles.mjs`: imports both built bundles and measures startup

### `packages/core`

* `src/contracts/workflow.ts`
* `src/contracts/artifacts.ts`
* `src/contracts/sensors.ts`
* `src/contracts/events.ts`
* `src/definitions/load.ts`
* `src/definitions/validate.ts`
* `src/definitions/fingerprint.ts`
* `src/definitions/snapshot.ts`
* `src/gates/evaluate.ts`
* `src/state/transition.ts`
* `src/briefs/compose.ts`

### `packages/graph`

* `src/beads-client.ts`: envelope validation and subprocess boundary
* `src/store.ts`: graph operations and metadata mapping
* `src/cache.ts`: read-through cache with write invalidation
* `src/plan-import.ts`: stable-key validation, dependencies, and idempotency

### `packages/sensors`

* `src/registry.ts`: explicit package/path extension loading
* `src/runner.ts`: input/output validation and execution ordering
* `src/cache.ts`: reading fingerprints
* `src/hygiene.ts`: caps, sanitization, and evidence persistence
* `src/normalizers.ts`: common finding envelope and proven parsers
* `src/extensions/command.ts`: built-in deterministic command sensor

The agent-review extension can be added after one live structured-submission
integration test. It is not needed to block the first demo.

### `packages/report`

* `src/journal.ts`: single-writer append and monotonic sequence recovery
* `src/render.ts`: report sections from graph, journal, and usage records
* `src/diagram.ts`: decomposition graph from parent-child and dependency edges
* `src/escape.ts`: untrusted text handling for Markdown output

### `packages/orchestrator`

* `src/operations.ts`: the sole authority-checked application operations used
  by CLI, driver, worker tools, and future HTTP adapters
* `src/driver.ts`: deterministic transition loop
* `src/reconcile.ts`: unmatched intent recovery
* `src/lease.ts`: driver heartbeat and stale-owner checks
* `src/work-directory.ts`: identity, snapshot, artifacts, and projection paths
* `src/projection.ts`: bounded `work show` response
* `src/model-capabilities.ts`: requested-to-resolved model and effort mapping
* `src/session-host.ts`: worker-host interface
* `src/hosts/deterministic.ts`: test and offline demo host
* `src/hosts/copilot-subprocess.ts`: isolated live worker and JSONL capture
* `src/output-log.ts`: durable normalized session output and usage checkpoints

### `packages/cli` and `packages/hook`

* `packages/cli/src/main.ts`: Commander entry point
* `packages/cli/src/commands/doctor.ts`
* `packages/cli/src/commands/work.ts`
* `packages/cli/src/commands/workflow.ts`
* `packages/cli/src/commands/phase.ts`
* `packages/cli/src/commands/task.ts`
* `packages/cli/src/commands/decision.ts`
* `packages/cli/src/commands/sensor.ts`
* `packages/hook/src/main.ts`: stdin/stdout hook adapter only
* `packages/hook/src/policy.ts`: frozen path and dangerous command decisions

### Repository definitions and demo acceptance

* `.senawa/workflows/standard-delivery.yaml`
* `.senawa/schemas/work-request.schema.json`
* `.senawa/schemas/definition.schema.json`
* `.senawa/schemas/research.schema.json`
* `.senawa/schemas/plan.schema.json`
* `.senawa/schemas/verification.schema.json`
* `sensors.yaml`
* `.github/agents/definer.agent.md`
* `.github/agents/researcher.agent.md`
* `.github/agents/planner.agent.md`
* `.github/agents/implementor.agent.md`
* `.github/agents/verifier.agent.md`
* `.github/hooks/senawa.json`
* `.agents/skills/senawa/SKILL.md`
* `test/e2e/offline-workflow.test.ts`
* `test/e2e/live-worker.sh`
* `test/e2e/principal-agent.sh`
* `test/fixtures/demo-repository/`

Do not create a web package in this slice. If promoted later, its HTTP handlers
must import `packages/orchestrator/src/operations.ts` and contain no transition
logic.

## Demo acceptance flow

The deterministic acceptance flow should reproduce the proven POC narrative:

1. `doctor` rejects invalid definitions before starting a model.
2. `work start` snapshots definitions, creates the beads graph, and exits 2 at
   define approval.
3. A competing start is refused while the active run is unfinished.
4. Define and research are approved.
5. Plan v1 is rejected with a reason; resume reuses the planner session and
   produces a versioned v2 that addresses the reason.
6. Plan approval imports stable tasks and dependencies.
7. The driver is killed after `task.dispatching` and before its outcome; resume
   adopts a completed turn without duplicate dispatch.
8. The first implementation attempt is refused by a deterministic gate and the
   same worker session is resumed with findings. Only the harness closes the
   task after a green gate.
9. Deleting `cache.json` does not alter the reconstructed status.
10. At verify, additive plan revision adds one task without reopening completed
    tasks, then verification runs again.
11. Human approval of verification closes the epic, releases the active-run
    pointer, and renders a report from graph, journal, artifacts, and usage.
12. A separate graceful-end case proves terminal state is durable before a
    replacement run can start.

The live demo should replace only the implementation worker host in steps 7 and
8, then optionally have a live principal-agent session relay start, show, and
one explicit approval. This provides real model behavior where policy and
backpressure matter while retaining a reproducible no-credit path.

## Validation commands

These commands are proposed root scripts and should be made executable by the
workspace bootstrap:

```bash
pnpm install --frozen-lockfile
pnpm biome check .
pnpm typecheck
pnpm test
pnpm build
pnpm test:bundles
pnpm test:e2e:offline
pnpm exec senawa doctor
pnpm demo:offline
```

The live checks require authenticated Copilot and spend credits:

```bash
pnpm test:e2e:live-worker
pnpm test:e2e:principal-agent
pnpm demo:live
```

The CI acceptance matrix should run Node.js 22, import both bundles after build,
assert `senawa-hook` startup remains near its measured 40 ms budget, run the
hostile-output fixture, and run the offline beads workflow. Live checks should
be explicit opt-in jobs because they are non-deterministic and billable.

## Live Copilot and deterministic mode boundary

Use live Copilot for claims about agent behavior:

* A worker can edit the demo fixture under restricted capabilities.
* A refused worker can use findings and resume the same session successfully.
* Worker sessions remain outside the human session store.
* The principal agent discovers the skill, uses only Senawa, treats exit 2 as a
  normal decision point, and relays only explicit human decisions.
* Live phase agents submit schema-valid artifacts, but only after the submission
  transport has its missing integration test.

Use deterministic hosts for claims about orchestration:

* Workflow validation, graph compilation, frozen snapshots, state transitions,
  approval and rejection, iteration limits, additive revision, gate policy,
  singleton rules, crash reconciliation, cache reconstruction, graceful end,
  and report rendering
* Inferential sensor stand-ins and seeded first-attempt failure
* Every default test and demo command that must avoid AI credits

Do not present a fully deterministic run as proof that Copilot can produce
phase artifacts. Do not make the standard CI pipeline depend on a live model.

## Major risks, blockers, and ambiguities

1. Live phase artifact submission is the largest demo blocker. The five-phase
   POC uses fake hosts, while the SDK probe proves only an isolated typed tool.
   The production host still needs one test joining role brief, schema-backed
   submit tool, output validation, persistence, and resume.
2. The installed SDK evidence is for 1.0.7 while design references 1.0.8. Pin a
   verified version and repeat permission, resume, tool, and isolation tests
   before relying on it.
3. The browser decision is still `probing`. Its fake command handler cannot be
   promoted, live output normalization and restart replay are untested, and a
   web supervisor introduces a second lease. It is not part of the minimum.
4. Forced takeover of an unresponsive driver is unproven. The first demo can
   support foreground interruption and normal resume/end, but `work end
   --force` must not ship as a raw lock deletion.
5. Verification representation remains undecided: sensor, phase, or both. The
   current workflow uses a verifier phase with deterministic artifact and work
   gates; preserve that for the demo without claiming the decision is settled.
6. Run-wide AIU budget and tracking-directory retention are open decisions.
   Local task/phase limits and usage recording are required; global spend policy
   and archival placement can remain deferred.
7. Principal-agent containment is instruction-only. Every judgment command must
   validate current state and preserve the explicit human channel; the skill is
   usability guidance, not authorization.
8. The POC workflow omits output-schema references even though the authoritative
   design requires schema-constrained artifacts. Production definitions must add
   those schemas rather than copy the fixture unchanged.
9. The design tooling list omits a runtime JSON Schema library. Ajv is already
   proven in the POCs and should be made an explicit dependency unless another
   evaluator is selected.
10. Beads calls cost hundreds of milliseconds and its JSON shapes are uneven.
    Envelope validation, read caching, serialized writes, `--all` reconstruction,
    and integration tests against the pinned `bd` version are mandatory.
11. Subprocess output may contain source, prompts, tool arguments, paths, and
    usage data. Persist-first capture requires size caps, sanitization, and a
    retention policy even without a browser.

## References and evidence

* AGENTS.md
* README.md
* docs/design/README.md
* docs/design/01-system-model.md
* docs/design/02-workflows-and-lifecycle.md
* docs/design/03-agents-and-interaction.md
* docs/design/04-sensors-gates-and-enforcement.md
* docs/design/05-runtime-and-state.md
* docs/design/06-provenance-and-observability.md
* docs/design/07-implementation-and-operations.md
* docs/design/wip/decision-log.md
* docs/design/wip/poc-findings.md
* poc/orchestration/README.md
* poc/orchestration/engine.mjs
* poc/orchestration/run.sh
* poc/orchestration/senawa.mjs
* poc/orchestration/end-to-end.sh
* poc/orchestration/pa-driven.sh
* poc/orchestration/web-console.mjs
* poc/orchestration/workflows/standard-delivery.yaml
* poc/orchestration/sensors.yaml
* poc/sensors/cli.mjs
* poc/sensors/hygiene.mjs
* poc/sensors/normalizers.mjs
* poc/worker-sessions/isolation.mjs
* poc/sdk-surface/probe.mjs
* .devcontainer/devcontainer.json
* .devcontainer/post-create.sh
* .gitignore

## Follow-on questions

* Which concrete phase submission transport should the subprocess fallback use
  while preserving the schema-backed submission rule?
* Should the first live demo use the subprocess host only, or include one SDK
  phase-agent integration after the core CLI flow is stable?

## Clarifying questions

* Does "end-to-end demo" require the browser console, or is the documented
  principal-agent and CLI journey the acceptance surface? Current architecture
  supports the latter; the browser remains a probing decision.
* Must all five roles use live Copilot in the first demo? Existing evidence
  supports a live principal agent and live implementor, but not yet live
  schema-constrained define, research, plan, and verify phases.