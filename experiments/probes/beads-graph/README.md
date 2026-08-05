# Beads Graph Probe

## Goal

Beads holds durable workflow state, and `@senawa/graph` is the only component
allowed to run `bd`. That adapter needs a contract it can rely on: stable JSON,
atomic claiming, predictable dependency semantics, and known latency. This probe
walks the whole surface against a throwaway database.

## What it proves

The JSON envelope is mandatory rather than advisable. Without
`BD_JSON_ENVELOPE=1`, `bd ready` returns a bare array and `bd show` returns a
single-element array with no `schema_version` at all, so a version guard built on
the legacy shape protects nothing.

`bd init` blocks forever on an interactive prompt. It asks whether you are
contributing to someone else's repository even with `--quiet` and even with stdin
closed, so automation must pass `--non-interactive` and `--role`.

Claiming is atomic. Six concurrent `bd ready --claim` calls returned six distinct
issue identifiers with no duplicates, which is what makes a parallel frontier
safe and why selecting and owning a task must stay one call.

Concurrent writers serialize rather than fail. Six concurrent creates took
4564 ms against a sequential baseline of 4725 ms, with nothing lost and no error
raised. Funnelling writes through `senawa` is therefore justified by policy and
accounting, not by data safety.

`bd` is slow enough to shape the architecture:

| Command             | Best of three |
|---------------------|---------------|
| `bd ready --json`   | 299 ms        |
| `bd show --json`    | 166 to 563 ms |
| `bd list --json`    | 378 to 440 ms |
| one `bd create`     | about 760 ms  |

No hook may touch the graph, and the adapter needs a read cache with explicit
invalidation on write.

Four smaller contract facts also hold. Nested metadata round-trips with numbers
intact and is filterable. `bd dep add <dependent> <blocker>` blocks in the
expected direction. Human gates open and resolve cleanly. `bd swarm validate`
reports ready waves and maximum parallelism, which is the plan-lint sensor.

Three behaviours need workarounds. `bd set-state` writes an event bead that
`bd list --type event` cannot see, so the journal reader needs `bd list --all`.
`bd batch` accepts only `status`, `priority`, `title`, and `assignee`, so
metadata writes stay separate calls. `bd dep tree --format=mermaid` follows
dependency edges only and renders an epic with children as a single node, so the
run report must build its own diagram.

## What it does not prove

* Behaviour of `bd init --server`, which would allow genuine multi-writer access
* Whether merge slots serialize integration correctly under real conflicts

## Layout

| Path             | Role                                                              |
|------------------|--------------------------------------------------------------------|
| `contract.sh`    | Ten checks covering JSON shape, metadata, dependencies, gates, batch, latency |
| `concurrency.sh` | Six concurrent claimants and six concurrent writers against one database |
| `run.sh`         | Runs both in order                                                |

## Running

```bash
bash experiments/probes/beads-graph/run.sh   # offline, slow because bd init is slow
```

## Change log

| Date       | Change                                                                                                                                     |
|------------|-----------------------------------------------------------------------------------------------------------------------------------------------|
| 2026-07-28 | First runs as two probes. Established the envelope requirement, the blocking `bd init` prompt, batch and event-bead limits, and per-command latency. Established atomic claiming and benign write serialization. |
| 2026-08-02 | Merged `02-beads-contract` and `03-beads-concurrency` into one folder, since both describe the same adapter contract. Scripts kept intact as `contract.sh` and `concurrency.sh`. |
| 2026-08-05 | Cleared ambient `BD_JSON_ENVELOPE` before legacy-shape controls so the probe remains independent of the caller environment. Kept unsupported batch metadata diagnostics raw because that error is not a JSON envelope. |
