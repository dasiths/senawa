<!-- markdownlint-disable-file -->
# Production Demo Implementation Plan

## User requests

* Implement the Senawa design.
* Make the repository ready for an end-to-end demo.
* Preserve the browser workflow for observing graph state, streaming worker
  output, and issuing human commands.
* Support one active run and one active worker turn in version 1.
* Provide graceful end so a stuck run cannot block replacement work.
* Keep Senawa hook policy embedded. Define worker profiles as strict
  repository-owned `.senawa/agents/<role>.senawa.md` configuration; do not use
  `.github/agents` or `.github/hooks` conventions.
* Keep every repository-owned Senawa configuration asset under `.senawa`,
  including sensor and gate policy at `.senawa/sensors.yaml`.

## Objectives

Build a production-oriented vertical slice that demonstrates the complete human
journey without AI credits by default and supports an explicit live Copilot
worker mode. The implementation must preserve a single control path shared by CLI
and HTTP.

## Context summary

Repository guidance: `AGENTS.md`. Current architecture:
`docs/design/01-system-model.md` through
`docs/design/07-implementation-and-operations.md`. Research:
`.copilot-tracking/research/2026-08-04/production-demo-research.md` and the three
subagent reports under `.copilot-tracking/research/subagents/2026-08-04/`.

Relevant skills: none required at runtime. The repository Senawa skill is a
production artifact, not an implementation dependency.

## Implementation checklist

### Phase 1: Workspace and contracts
<!-- parallelizable: false -->

- [x] Create pnpm workspace, strict TypeScript config, Biome, Vitest, and esbuild.
- [x] Create package manifests and exports for core, graph, report, orchestrator,
      CLI, web, and hook.
- [x] Define workflow, run snapshot, command, event, output, sensor, and artifact
      contracts.
- [x] Add repository workflow, artifact schemas, sensors, and skill.

### Phase 1.5: Runtime asset ownership
<!-- parallelizable: false -->

- [x] Embed hook policy in Senawa-owned source and remove repository
  `.github/agents` and `.github/hooks` conventions.
- [x] Define strict worker-profile frontmatter and prompt parsing under
  `.senawa/agents/<role>.senawa.md`.
- [x] Include referenced worker profiles in definition validation, snapshots,
  fingerprints, and frozen paths.
- [x] Make deterministic, subprocess, and future SDK hosts resolve snapshotted
  profiles and intersect requested capabilities with Senawa policy.
- [x] Remove the temporary embedded worker-role registry.

### Phase 1.6: Configuration namespace
<!-- parallelizable: false -->

- [x] Move production `sensors.yaml` to `.senawa/sensors.yaml`.
- [x] Update definition loading, demo copying, frozen paths, tests, and bundles.
- [x] Validate the full offline browser demo from the namespaced configuration.
- [x] Create a separate plan for the broad documentation consistency update.

### Phase 2: Runtime services
<!-- parallelizable: false -->

- [x] Implement file-backed runtime store behind the graph package boundary.
- [x] Implement immutable run identity, definitions snapshot, active-run pointer,
      driver lease, web lease, and archival.
- [x] Implement append-only journal and per-owner output streams.
- [x] Implement deterministic gate behavior, phase artifacts, task imports,
      iteration, graceful end, and bounded status projection.
- [x] Implement deterministic worker and opt-in isolated Copilot subprocess host.
- [x] Move gate authority out of worker hosts into an injected production
  evaluator backed by snapshotted repository sensor policy.
- [x] Add built-in artifact and command sensors with bounded execution,
  expectation operators, advisory behavior, sanitized evidence, and journal
  events.

### Phase 3: CLI and browser
<!-- parallelizable: false -->

- [x] Implement one `RunCommandService` and `RunQueryService`.
- [x] Implement CLI commands for doctor, workflow, start/resume/show/wait/end,
      approve/reject/steer, report, and web.
- [x] Implement loopback web supervisor, versioned routes, capability bootstrap,
      SSE replay, strict command schemas, and static browser UI.
- [x] Ensure HTTP and CLI mutations have identical service effects.

### Phase 4: Demo and validation
<!-- parallelizable: false -->

- [x] Add unit and integration tests for contracts, command parity, singleton,
      output replay, approval/rejection, graceful end, and report rendering.
- [x] Add a no-credit demo script and fixture.
- [x] Make the demo command gate fail task attempt 1 and pass attempt 2 without
  AI credits.
- [x] Add an explicit billable live-worker demo command.
- [x] Build bundles and validate startup/import.
- [x] Run typecheck, lint/format, tests, build, bundle checks, offline demo, and
  diff hygiene.
- [x] Run production browser screenshots at desktop and mobile sizes and validate
  documentation links.
- [x] Update README and implementation status without altering measured claims.

## Dependencies

* Node.js 22+
* pnpm 10+
* TypeScript, Vitest, Biome, esbuild
* Zod, Ajv, YAML, Commander, execa
* `bd` for later beads-store integration; first demo uses the graph interface's
  file store to avoid duplicating the proven POC adapter during vertical slicing
* GitHub Copilot CLI only for explicit live mode

## Success criteria

* `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build`
  pass.
* `pnpm demo` completes an offline browser-backed workflow.
* `senawa doctor` validates the repository.
* CLI and HTTP parity tests compare journal and snapshot effects.
* Browser reconnect replays output without gaps.
* A competing run and supervisor are refused.
* `work end` permits a replacement run while preserving evidence.
* No default command spends AI credits.
