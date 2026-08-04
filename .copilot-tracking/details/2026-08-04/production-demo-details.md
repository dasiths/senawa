<!-- markdownlint-disable-file -->
# Production Demo Implementation Details

## References

* Plan: `.copilot-tracking/plans/2026-08-04/production-demo-plan.instructions.md`
* Research: `.copilot-tracking/research/2026-08-04/production-demo-research.md`
* Guidance: `AGENTS.md`

## Phase 1 details

Create one pnpm workspace with source imports between packages and esbuild entry
points for `senawa` and `senawa-hook`. Contracts use Zod for Senawa-owned wire
formats and Ajv for repository JSON Schema artifacts. Repository definitions are
real demo inputs, not copied POC files.

Success: package installation, typecheck of empty boundaries, and definition
parsing.

## Phase 2 details

The runtime store is an interface owned by `@senawa/graph`. Its first production
implementation persists JSON under `.agents/.copilot-tracking/<work>/runtime.json`
and serializes writes. This keeps the vertical slice small while preventing CLI,
HTTP, or workers from mutating files directly. A future beads implementation can
replace it without changing services.

`RunCommandService` owns all legal-state checks and mutations. Driver progress is
one transition at a time and can be called from start, resume, or browser action.
Every output record and journal event is appended before publication.

Success: complete deterministic lifecycle with one worker turn, versioned
artifacts, gate refusal, approval/rejection, finish/end, and replacement start.

## Phase 3 details

CLI and HTTP parse input only, derive actor channels, and call shared services.
The web supervisor keeps no authoritative run state. Endpoints use run IDs and
strict schemas. SSE reads persisted records first and tails an in-process
notifier. Browser output uses text nodes only.

Success: parity tests show the same command produces the same journal and
projection effect through CLI and HTTP.

## Phase 4 details

`pnpm demo` creates a temporary repository, installs/copies definitions, starts a
run and web supervisor, drives browser-equivalent HTTP decisions, waits for
finish, and prints the URL and report. The command must not call Copilot.

`pnpm demo:live` is separate, prints a cost warning, and uses the global Copilot
CLI subprocess adapter for implementation tasks only.

Success: all checks pass and Playwright validates desktop/mobile browser layout.

## Discrepancies to track

* The current design prefers beads runtime truth. The first vertical slice uses a
  production graph interface with a file store to deliver the demo without
  promoting POC internals. Beads integration remains the next store adapter.
* The browser decision remains probing until it uses the shared command service;
  this implementation is intended to close that gap.
* Forced end takeover is not implemented until a real driver lease process is
  running; normal graceful end is required now.
