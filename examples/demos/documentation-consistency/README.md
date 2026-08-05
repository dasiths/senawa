# Documentation Consistency Demo

This opt-in demo runs the production `standard-delivery` workflow against a
fresh, persistent clone of the Senawa repository. It creates a real Git branch,
uses Beads as the runtime authority, executes every agent through the
authenticated Copilot SDK adapter, and stops for your explicit decision at each
human gate.

The launcher never approves, rejects, or ends work on your behalf. After the
final approval, it checks the run state, task closure, branch identity, changed
paths, documentation links, lint, types, tests, build, package boundaries,
bundles, sensor evidence, and the complete provenance report.

> [!WARNING]
> The full demo spends GitHub Copilot AI credits. The prepared clone is retained
> after success, failure, or interruption so you can inspect and resume it.

## Prerequisites

Run the demo from a clean, committed Senawa checkout with these commands on
`PATH`:

* Node.js 22 or later
* pnpm
* Git
* Beads (`bd`)
* An authenticated Copilot CLI (`copilot`)

Uncommitted source changes are intentionally excluded because the launcher
clones the current committed branch.

## Run the workflow

From the repository root:

```bash
pnpm demo:docs -- --confirm-cost
```

The launcher prints the clone path and generated
`demo/documentation-consistency-*` branch. Each phase artifact is printed in
full before the launcher asks you to approve, reject, or end the run. Rejection
requires a reason and resumes the same bounded workflow after Senawa records
your decision.

Use explicit paths and branch names when a stable location is useful:

```bash
pnpm demo:docs -- --confirm-cost \
  --workspace ../senawa-docs-demo \
  --branch demo/documentation-consistency
```

## Prepare without spending credits

Preparation performs the real clone, branch, dependency installation, build,
repository preflight, and workflow validation. It does not start an SDK
session:

```bash
pnpm demo:docs -- prepare --workspace ../senawa-docs-demo
```

Inspect the prepared branch, then start its live workflow:

```bash
pnpm demo:docs -- start --confirm-cost --workspace ../senawa-docs-demo
```

## Resume an interruption

Start and resume are foreground operations. If the process is interrupted, use
the retained workspace reported by the launcher:

```bash
pnpm demo:docs -- resume --confirm-cost --workspace ../senawa-docs-demo
```

The resume path reads the durable active run, shows any pending artifact or
dispatch reconciliation, and asks for the next human decision. It does not
create another run.

## Repeat verification

Verification does not invoke a model or spend AI credits:

```bash
pnpm demo:docs -- verify --workspace ../senawa-docs-demo
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