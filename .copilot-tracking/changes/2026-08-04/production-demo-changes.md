# Production Demo Changes

## Scope

Phase 4 adds production demo and validation artifacts for the completed
workspace, runtime, CLI, and browser vertical slice. No billable live-worker
command was executed.

## Implementation progress

* Added `pnpm demo`, `pnpm demo:live`, and `pnpm bundle:check`
* Added explicit `--worker-host deterministic|copilot` selection
* Kept deterministic execution as the default
* Routed opt-in Copilot execution to implementation tasks only
* Added an isolated temporary-repository demo driver
* Exercised doctor, deterministic start, production web supervision, HTTP
  rejection and approvals, SSE replay and task streaming, finish, report
  rendering, server termination, and temporary-directory cleanup
* Added `--keep-server` as the only mode that retains the browser supervisor and
  temporary repository
* Added bundle executable-banner and startup checks for the CLI and hook
* Added a browser-backed end-to-end lifecycle test
* Updated public and implementation status for the file-backed vertical slice
* Kept the beads adapter and production live-worker validation explicitly pending
* Added the production `@senawa/sensors` package and shared reading contracts
* Removed gate verdicts from deterministic and Copilot worker results
* Made `RunCommandService` evaluate snapshotted policy after every worker turn
* Added built-in candidate-artifact and bounded repository-command evaluation
* Added closed expectation operators, advisory semantics, execution-error
  blocking, capped evidence, and sensor or gate journal events
* Added focused tests proving worker claims cannot close red gates
* Changed the offline demo fixture so command tests fail attempt 1 and pass
  attempt 2, producing two deterministic rework events without Copilot
* Moved repository sensor and gate policy from root `sensors.yaml` to
  `.senawa/sensors.yaml`, including loading, demo copying, frozen paths, and
  test fixtures

## Validation progress

* Focused CLI tests passed: 2 tests
* CLI and hook bundle build and startup checks passed
* Initial offline demo passed with 51 journal events before the sensor authority
  repair
* Focused web tests passed: 4 tests, including the full HTTP lifecycle
* Workspace typecheck passed
* Workspace lint and formatting checks passed across 67 files
* Full Vitest suite passed: 20 tests in eight files
* Production build and bundle startup checks passed after the full test run
* Final offline demo passed and removed its temporary repository and supervisor
* Explicit `--keep-server` mode retained and printed the browser URL, supervisor
  PID, and temporary repository; the validation process and repository were then
  terminated and removed
* The unconfirmed live launcher printed its AI-credit warning and stopped with
  the expected decision exit code `2`; Copilot was not invoked
* Sensor and orchestrator focused suites passed: 11 tests
* Workspace typecheck passed with the production sensor package included
* Workspace lint passed across 74 files
* Full Vitest suite passed: 31 tests in nine files
* Production build and bundle startup checks passed
* Final offline demo passed with 77 journal events, 27 output records, five
  artifacts, two task rework events, and both tasks closed on attempt 2
* Final CLI-only acceptance passed in a clean temporary repository: doctor,
  start, define rejection and iteration, every phase approval, sensor-driven
  task rework, finish, show, and report all used the bundled CLI surface
* Production browser UI validated at 1440x900 and 390x844: no pane overlap or
  page-level horizontal overflow, graph-only horizontal scrolling on mobile,
  replayed output visible, and terminal controls hidden
* Subprocess profile mapping now removes tools outside the resolved capability
  ceiling and always excludes nested-agent controls

## Deviations and limits

* The demo creates its fixture dynamically by copying repository definitions
  into an isolated temporary repository instead of maintaining a duplicate
  fixture tree
* The live-worker launcher is guarded and wired but was not executed because it
  can consume AI credits; it starts the live workflow but does not yet automate
  the entire approval-to-finish journey
* The browser decision remains probing because restart, sustained output load,
  and normalized live subprocess and SDK sessions remain unvalidated
* The current runtime store is file-backed behind `@senawa/graph`; the beads
  adapter remains pending