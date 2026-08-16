# Repository Guidance

These instructions apply to the entire repository.

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