# Worktree mode

`execution.workspaceMode` selects how run work touches the repository. The
default is `repository`. Worktree mode is optional and requires explicit
configuration.

## The default is repository mode

Omitting `execution` entirely, or omitting `workspaceMode` inside it, yields:

```json
{
  "execution": {
    "workspaceMode": "repository",
    "maxWriterConcurrency": 1,
    "failurePolicy": "continue"
  }
}
```

In repository mode, work happens in the repository you point the daemon at.
Exactly one writer is permitted, so `maxWriterConcurrency` above `1` is refused.
No Git worktree is created, no workspace row is recorded, and no integration
branch is needed. Everything in [Getting started](getting-started.md) and
[Workflow authoring](workflow-authoring.md) uses this mode.

## Turning worktree mode on

Worktree mode requires an explicit `workspaceMode` and an explicit
`integrationRef`:

```json
{
  "execution": {
    "workspaceMode": "worktree",
    "maxWriterConcurrency": 4,
    "failurePolicy": "continue",
    "integrationRef": "refs/heads/integration"
  }
}
```

Rules the compiler enforces:

* `integrationRef` must be a full `refs/heads` branch reference. Short names and
  remote references are refused.
* Worktree mode without `integrationRef` reports `missing-field` at
  `/execution/integrationRef`.
* Repository mode with `integrationRef` reports `invalid-field` at the same
  pointer.
* `maxWriterConcurrency` above `1` is valid only in worktree mode.

Validate the change before running anything:

```bash
senawa doctor
```

## What worktree mode changes

* Each writer task runs in its own Git worktree instead of the repository
  checkout, so concurrent writers do not collide in one working tree.
* Task workspaces become durable authority. The portal Workspaces view lists
  each task workspace with its generation, mode, state, completion eligibility,
  and result digest.
* Integration becomes explicit. Completed workspaces integrate onto
  `integrationRef` through recorded integration attempts. The portal shows each
  cohort, attempt, state, member count, sanitized diagnostic, and successor.
* Conflicts and rework become recorded outcomes rather than local surprises. A
  failed integration attempt produces a sanitized diagnostic and, when the
  workflow permits rework, a successor attempt.
* Host writer capacity applies. Active process and workspace capacity cannot
  exceed 32, and `SENAWA_HOST_WRITER_LIMIT` bounds concurrent host writers.

Worktrees are created, locked, unlocked, and removed through the execution host's
Git adapter. Removal is forced and followed by a worktree list check, so a run
does not leave orphaned worktrees behind.

## The testing and example rule

Every worktree example and every worktree test uses a fresh temporary Git
repository. None of them uses the mounted Senawa checkout.

This is not a style preference. Worktree operations create, lock, and forcibly
remove working trees and branches. Pointing them at a repository that holds
uncommitted work risks destroying it. The repository's own worktree tests create
a temporary repository, assert that the Senawa checkout's worktree list is
unchanged, and refuse to operate when the resolved root is inside the Senawa
checkout.

Follow the same rule when you try worktree mode:

```bash
repo="$(mktemp -d)/demo"
git init "$repo"
cd "$repo"
git commit --allow-empty -m "root"
git branch integration
senawa init
```

Then edit `.senawa/workflow.yaml` to set `workspaceMode` and `integrationRef`,
run `senawa doctor`, and point the daemon at that directory with
`SENAWA_REPOSITORY_DIR` when you are ready to dispatch work.

Pointing `SENAWA_REPOSITORY_DIR` at a repository enables the worker host, which
is where model credits start to apply. See
[Operations](operations.md) for the live-worker opt-in and its costs.

## When to leave it off

Repository mode is the right default when:

* One writer at a time is enough.
* You do not want an integration branch or integration accounting.
* You are following a guide, running an example, or exercising the no-credit
  journey.

Worktree mode is worth turning on when a workflow projects many independent
writer tasks and you want them to proceed concurrently with recorded
integration.

## Related reading

* [Workflow authoring](workflow-authoring.md) for the rest of `execution` and
  for the task loops that produce concurrent writers.
* [Portal](portal.md) for the Workspaces view.
* [Architecture](../design/architecture.md) for the execution host boundary that
  owns Git.
