# Documentation Consistency Demo

This opt-in demo creates a Git branch in the current Senawa checkout and runs
the production `standard-delivery` workflow there. It uses Beads as the runtime
authority, executes every agent through the authenticated Copilot SDK adapter,
and stops for your explicit decision at each human gate.

The launcher never approves, rejects, or ends work on your behalf. After the
final approval, it checks the run state, task closure, branch identity, changed
paths, documentation links, lint, types, tests, build, package boundaries,
bundles, sensor evidence, and the complete provenance report.

> [!WARNING]
> The full demo spends GitHub Copilot AI credits and changes the current Git
> branch. The branch and runtime state remain in the repository after success,
> failure, or interruption so you can inspect and resume the work.

## Prerequisites

Run the demo from the root of a clean, committed Senawa checkout with no active
Senawa run and these commands on `PATH`:

* Node.js 22 or later
* pnpm
* Git
* Beads (`bd`)
* An authenticated Copilot CLI (`copilot`)

The launcher refuses to stash, discard, or carry uncommitted changes. It also
refuses an existing branch name or active Senawa run because Git branches do not
isolate Beads or `.agents/.copilot-tracking` runtime state.

## Run the workflow

From the repository root:

```bash
pnpm demo:docs -- --confirm-cost
```

The launcher creates and checks out a generated
`demo/documentation-consistency-*` branch in place. Each phase artifact is
printed in full before the launcher asks you to approve, reject, or end the
run. Rejection requires a reason and resumes the same bounded workflow after
Senawa records your decision.

Use an explicit branch name when a stable name is useful:

```bash
pnpm demo:docs -- --confirm-cost --branch demo/documentation-consistency
```

## Prepare without spending credits

Preparation checks the clean worktree and runtime state, installs locked
dependencies, builds Senawa, validates repository definitions, and creates the
branch in place. It does not start an SDK session:

```bash
pnpm demo:docs -- prepare --branch demo/documentation-consistency
```

Inspect the prepared branch, then start its live workflow:

```bash
pnpm demo:docs -- start --confirm-cost
```

## Resume an interruption

Start and resume are foreground operations. If the process is interrupted,
remain on the prepared branch and run:

```bash
pnpm demo:docs -- resume --confirm-cost
```

The resume path reads the durable active run, shows any pending artifact or
dispatch reconciliation, and asks for the next human decision. It does not
create another run.

## Repeat verification

Verification does not invoke a model or spend AI credits:

```bash
pnpm demo:docs -- verify
```

It fails unless all of these conditions hold:

* The production backend is Beads and the run is `finished`
* Every workflow phase is `accepted`
* At least one implementation task exists and every task is `closed`
* No human decision or worker dispatch remains unsettled
* The prepared Git branch is still checked out
* The workflow changed `README.md` or files under `docs/`, and no other authored
  paths
* Repository and documentation validation commands pass

Runtime evidence under `.agents/.copilot-tracking/` and Beads state are excluded
from the documentation-only changed-path assertion but remain available for
inspection.