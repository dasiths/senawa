<!-- markdownlint-disable-file -->
# Production Demo Plan Review

## Metadata

* Plan: `.copilot-tracking/plans/2026-08-04/production-demo-plan.instructions.md`
* Reviewer: RPI Agent direct review
* Date: 2026-08-04
* Iterations: three implementation corrections after initial vertical slice

## User request fulfillment

| Request | Status | Evidence |
|---------|--------|----------|
| Implement Senawa for an end-to-end demo | Complete for deterministic vertical slice | `pnpm demo` completes browser-backed standard-delivery run and report |
| Browser observation, output replay, and decisions | Complete | Production HTTP and CLI share services; SSE and browser tests pass |
| One active run and worker with graceful end | Complete | Runtime store singleton, leases, active-turn invariant, end/replacement tests |
| Senawa-owned enforcement rather than `.github` files | Complete | Hook/session policy lives in `packages/hook`; no production `.github/agents` or `.github/hooks` |
| Consumer-defined worker prompts and profiles | Complete | Strict `.senawa/agents/*.senawa.md`, snapshotted and fingerprinted |
| Repository sensor policy under `.senawa` | Complete | `.senawa/sensors.yaml` loads, freezes, builds, tests, and demos successfully |
| Create a separate plan to update all docs | Complete | `.copilot-tracking/plans/2026-08-04/senawa-configuration-docs-plan.instructions.md` |

## Placement and quality findings

* CLI and HTTP adapters invoke one `RunCommandService` and `RunQueryService`.
* Worker hosts return output and candidate artifacts only. `@senawa/sensors`
  evaluates snapshotted policy and owns completion verdicts.
* Worker profiles request semantic capabilities. The subprocess mapper intersects
  them with owner-type ceilings, hides unavailable tools, and excludes nested
  agent controls.
* Repository configuration is now consistently namespaced under `.senawa` in
  production source. Broad prose alignment is intentionally planned separately.
* Browser dynamic values use DOM text nodes. Loopback bootstrap, HttpOnly
  SameSite cookie, fixed Host/Origin checks, CSP, no CORS, body limits, and strict
  command schemas are present.
* File-backed `RuntimeStore` is a documented vertical-slice deviation. The beads
  adapter remains unimplemented.
* The live Copilot launcher is guarded and selects the Copilot task host, but a
  complete approval-to-finish live journey has not been executed or automated.

## Validation

* `pnpm typecheck`: passed
* `pnpm lint`: passed, 74 files
* `pnpm test`: passed, 31 tests in 9 files
* `pnpm build`: passed
* `pnpm bundle:check`: passed
* `pnpm demo`: passed, 77 journal events, 27 output records, 5 artifacts, 2
  sensor-driven rework events, 2 tasks closed on attempt 2
* Bundled CLI-only acceptance: passed in a clean repository, including doctor,
  phase rejection, all approvals, two task reworks, finished projection, and
  report rendering at journal cursor 77
* `pnpm demo:live` without confirmation: stopped before Copilot with exit 2
* Production browser: validated at 1440x900 and 390x844; no page overflow or
  pane overlap, graph-only horizontal scrolling, replay visible, terminal actions
  hidden
* Markdown links and anchors: 41 files passed
* Editor diagnostics: no errors
* `git diff --check`: passed

## Remaining work

* Execute the configuration documentation plan.
* Implement a beads-backed `RuntimeStore` and parity tests.
* Turn `demo:live` into a complete fixture-backed journey and run it with explicit
  credit approval.
* Add SDK-hosted workers after version revalidation.
* Probe forced stale-lease termination and high-volume SSE replay.

## Overall status

Complete for the deterministic production vertical slice and requested demo
readiness. Residual architecture and live-model work is explicit and does not
invalidate the no-credit end-to-end demo.
