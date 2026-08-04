<!-- markdownlint-disable-file -->
# Production Demo Research

## Scope

Implement the first production Senawa vertical slice and make it runnable as an
end-to-end browser demo. Version 1 supports one unfinished run per repository,
one active worker turn, local single-user browser access, deterministic workers
by default, and opt-in billable Copilot workers.

## Success criteria

* Root TypeScript workspace builds reproducibly.
* `senawa doctor` validates repository definitions before dispatch.
* CLI and HTTP invoke one shared command/query service.
* A deterministic standard-delivery run can start, stream output, accept browser
  decisions, finish or end gracefully, and render a report.
* A competing run, driver, or web supervisor is refused.
* Output is durable before SSE fan-out and reconnects by cursor.
* An opt-in Copilot subprocess adapter is present and isolated, without being
  called by default tests.
* Offline tests and an automated end-to-end demo pass.

## Evidence log

* `poc/orchestration/engine.mjs` proves workflow iteration, graph-backed state,
  crash reconciliation, singleton release ordering, graceful end, and additive
  revision.
* `poc/orchestration/web-console.mjs` proves SSE replay, browser commands,
  responsive UI, and supervisor singleton behavior, but has a fake control path.
* `poc/orchestration/end-to-end.sh` proves isolated Copilot subprocess dispatch,
  same-session rework, and harness-owned completion.
* `poc/sdk-surface` proves typed tools and session events on SDK 1.0.7, but the
  first production demo can use the subprocess fallback.
* Current environment: Node 22.17.0, pnpm 10.34.5, TypeScript 5.8.3, beads 1.1.2,
  Copilot CLI 1.0.75.

## Alternatives

### Promote the orchestration POC directly

Rejected. It combines graph, driver, fake sessions, CLI parsing, and HTTP state
mutation. It is evidence, not a maintainable production boundary.

### Implement every design package completely

Rejected for this slice. Full extension loading, inferential reviewers, OTel,
parallel worktrees, and remote web access are not required for a credible first
demo and would delay executable feedback.

### Shared services with production adapters

Selected. `@senawa/orchestrator` owns commands and queries. CLI and web are thin
adapters. A file-backed runtime store provides the first demo while preserving an
interface for the beads adapter. Deterministic and Copilot worker hosts share one
output contract.

## Key decisions

* Browser demo is in scope because it is part of the requested human workflow.
* SSE plus strict command POSTs remains the selected local transport.
* Browser routes are run-scoped even though version 1 has one active run.
* The browser never accepts arbitrary commands, paths, executable names, or
  actor identity.
* Deterministic demo mode is the default. Copilot mode is explicit and billable.
* The production vertical slice may use a file runtime store first, but the graph
  package boundary must exist and all runtime access must pass through it.
* The current POC and design documents remain evidence; production code lives in
  `packages/` and repository definitions in `.senawa/`.

## Research sources

* `.copilot-tracking/research/subagents/2026-08-04/senawa-production-demo-scope.md`
* `.copilot-tracking/research/subagents/2026-08-04/copilot-sdk-orchestrator.md`
* `.copilot-tracking/research/subagents/2026-08-04/browser-supervisor.md`
* `docs/design/01-system-model.md` through `07-implementation-and-operations.md`
* `poc/orchestration/`

## Actionable next steps

1. Bootstrap the workspace and package boundaries.
2. Implement contracts, persistence, journals, output, gates, and shared services.
3. Add deterministic and Copilot subprocess worker hosts.
4. Add CLI and browser adapters over the services.
5. Add standard definitions, a demo fixture, offline tests, and a demo script.
6. Validate the browser and update current status documentation.
