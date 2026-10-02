# Repository Guidance

These instructions apply to the entire repository.

## Prime directive: keep working

Given a plan or a multi-phase task, continue until everything is done. Do not
stop after each phase for an update.

* Do not end a turn with a status report. A summary that ends the turn hands
  control back, which is the same failure as asking permission.
* Do not ask whether to continue. The next planned step is already approved.
* Chain phases in one turn: implement, validate, commit, push, next phase.
* Put findings, deviations, and judgement calls in the implementation log. The
  log is the reporting channel, not the chat turn.
* Stop only for a product decision that cannot be inferred, an irreversible or
  shared action, or a real blocker.
* Summarise only when the whole task is finished.

### Ending a turn

* End with at most two short sentences.
* No bullet lists, tables, headings, or done/remaining inventories.
* Never end a turn straight after a commit and push. A push is a checkpoint,
  not a finish line; start the next item in the same turn.
* Finishing one plan item is not a reason to stop. Move to the next.

## Architecture boundaries

* Keep the kernel deterministic and free of filesystem, process, network,
  database, Git, clock, random, worker, sensor, and UI dependencies.
* Keep protocol contracts browser-safe and behavior-free.
* Define adapter ports above concrete adapters; never import apps from packages.
* Do not add legacy compatibility, Beads, or the former file runtime.
* Do not create empty packages for future phases.

## Implementation workflow

* Implement one comprehensive-plan phase at a time.
* Run a focused executable check after the first substantive edit.
* Record major decisions and deviations in the implementation log.
* Finish each phase with validation, independent review, a commit, and a push
  attempt.
* Preserve probe-local historical fixture names unless a new probe supersedes
  them explicitly.

## Before finishing a phase

Run build, typecheck, lint, tests, dependency boundaries, documentation links,
and `git diff --check`, plus any phase-specific validation.