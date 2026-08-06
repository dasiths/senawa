# Beads Graph Probe

## Goal

Beads holds durable workflow state, and `@senawa/runtime-beads` is the production
component allowed to run `bd`. That adapter needs a contract it can rely on:
stable JSON, atomic claiming, predictable dependency semantics, fresh reads,
and measured latency. This probe walks the whole surface against throwaway
databases.

## Question and hypothesis

The fresh-read benchmark asks whether successful, uncached
`BeadsRuntimeStateStore.readRuntimeState(runId)` latency is driven by the
selected run graph, the total Beads database size, or both. The implementation
calls `bd list --all --limit 0 --json` before filtering by `run_id`, so the
falsifiable hypothesis is that both sizes matter and total database size is the
larger factor.

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

The original 2026-07-28 contract run showed that `bd` process latency is large
enough to shape the architecture:

| Command             | Best of three |
|---------------------|---------------|
| `bd ready --json`   | 299 ms        |
| `bd show --json`    | 166 to 563 ms |
| `bd list --json`    | 378 to 440 ms |
| one `bd create`     | about 760 ms  |

No hook may touch the graph. The current adapter deliberately performs a fresh
authoritative read, so callers need a measured read budget rather than an
assumption that reads are process-local cache lookups.

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

## Fresh-read method

The benchmark creates one canonical run, phase, and task through the production
store, exports those records with Beads, then imports deterministic clones into
an isolated database for each scenario. Fixture setup is not timed. Every
database has an explicit `BEADS_DIR`, closed stdin, non-interactive mode, a
fixed actor, and a temporary Git repository.

Before warmup, a second Beads client changes the selected phase metadata. The
already-created store must observe that change and its restoration. Every read
must reconstruct revision 1, one phase, and the expected task count. A counting
command runner also requires exactly one complete `bd list` for every measured
read.

| Scenario | Selected issues | Selected tasks | Total issues |
|----------|----------------:|---------------:|-------------:|
| `selected-2-isolated` | 2 | 0 | 2 |
| `selected-32-isolated` | 32 | 30 | 32 |
| `selected-128-isolated` | 128 | 126 | 128 |
| `selected-2-in-1024` | 2 | 0 | 1,024 |
| `selected-32-in-1024` | 32 | 30 | 1,024 |
| `selected-128-in-1024` | 128 | 126 | 1,024 |

The smoke profile runs one warmup and three measured samples against the first
two scenarios. The full profile runs five warmups and 30 measured samples per
scenario. Full samples are serial and interleaved by a fixed seeded shuffle.
Timing uses `process.hrtime.bigint()` around only `readRuntimeState()`.

## Fresh-read evidence

The full profile ran on 2026-08-06 from commit
`7d7188c6a89b31bf1986e8abd7376d74c8084f74` in a dirty worktree. The environment
used Node 22.17.0, pnpm 10.34.5, esbuild 0.25.12, Git 2.50.1, and Beads 1.1.2 at
`20e493e569c9`. Beads used the embedded Dolt backend on overlayfs in a Debian
dev container under WSL2, with 16 logical CPUs and 16 GB memory. One-minute load
was 2.41 at the start and 3.12 at the finish.

The run completed in 178.321 seconds. All 180 measured reads reconstructed the
expected graph, observed the independent freshness mutation, observed its
restoration, and issued exactly one complete list command. No scenario met the
noise rule of coefficient of variation above 0.25 or normalized one-minute load
above 0.5 per logical CPU.

| Scenario | JSON bytes | Database bytes | p50 ms | p90 ms | p95 ms | Mean ms | SD ms | MAD ms | CV |
|----------|-----------:|---------------:|-------:|-------:|-------:|--------:|------:|-------:|---:|
| `selected-2-isolated` | 2,230 | 1,369,076 | 402.669 | 432.867 | 448.561 | 404.375 | 32.299 | 9.185 | 0.080 |
| `selected-32-isolated` | 39,665 | 2,090,066 | 407.688 | 438.729 | 441.969 | 411.945 | 29.396 | 11.991 | 0.071 |
| `selected-128-isolated` | 160,104 | 5,024,014 | 429.363 | 466.647 | 472.285 | 437.266 | 32.909 | 7.574 | 0.075 |
| `selected-2-in-1024` | 1,302,021 | 45,860,489 | 520.894 | 551.506 | 560.038 | 520.304 | 41.525 | 20.858 | 0.080 |
| `selected-32-in-1024` | 1,301,532 | 46,292,128 | 537.292 | 563.040 | 572.594 | 535.985 | 21.074 | 17.687 | 0.039 |
| `selected-128-in-1024` | 1,300,239 | 47,499,522 | 524.356 | 557.583 | 561.029 | 533.878 | 22.984 | 19.148 | 0.043 |

At isolated sizes, increasing the selected run from 2 to 128 issues raised p50
by 6.6%. Placing the two-issue selected run in a 1,024-issue database raised p50
by 29.4% and p95 by 24.9%. This result supports the prediction that the complete
database payload dominates at the measured sizes. It is evidence for this
machine and stack, not a portable latency threshold.

The smoke profile also passed on 2026-08-06 in 30.832 seconds. Its three-sample
p50 values were 396.448 ms for 2 issues and 400.198 ms for 32 issues. Smoke is a
bounded harness and correctness check, not performance evidence.

The JSON output records all raw nanosecond samples, nearest-rank p50, p90, and
p95 values, minimum, maximum, mean, standard deviation, median absolute
deviation, coefficient of variation, ratios, fixture sizes, scenario order,
correctness results, and environment details. Timing is descriptive and never
changes the exit code. Command failures, unsupported Beads, malformed output,
wrong counts, stale reads, and list-command count mismatches fail the run.

## What it does not prove

* Behaviour of `bd init --server`, which would allow genuine multi-writer access
* Whether merge slots serialize integration correctly under real conflicts
* Cold-boot or fully cold filesystem performance
* Concurrent read or read/write performance
* Performance on other hardware, filesystems, Beads versions, or remote Dolt
* A universal service-level objective or safe tool-hook latency
* Event-heavy database scaling

## Layout

| Path | Role |
|------|------|
| `contract.sh` | Ten checks covering JSON shape, metadata, dependencies, gates, batch, and latency |
| `concurrency.sh` | Six concurrent claimants and six concurrent writers against one database |
| `fresh-read-benchmark.ts` | Builds fixtures, enforces correctness, captures samples, and emits JSON and text summaries |
| `fresh-read-benchmark.sh` | Bundles the runner and enforces profile-specific time limits |
| `run.sh` | Runs both contracts and the bounded fresh-read smoke profile |

## Running

```bash
bash experiments/probes/beads-graph/run.sh
```

Run only the bounded benchmark correctness profile:

```bash
bash experiments/probes/beads-graph/fresh-read-benchmark.sh \
  --profile smoke \
  --output /tmp/senawa-beads-fresh-read-smoke.json
```

Reproduce the complete evidence profile:

```bash
bash experiments/probes/beads-graph/fresh-read-benchmark.sh \
  --profile full \
  --output /tmp/senawa-beads-fresh-read-full.json
```

All commands are offline and spend no AI credits. The smoke wrapper has a
120-second limit. The full wrapper has a 30-minute limit and should run manually
or on a dedicated scheduled runner, not as a timing gate in ordinary CI.

## Change log

| Date       | Change                                                                                                                                     |
|------------|-----------------------------------------------------------------------------------------------------------------------------------------------|
| 2026-07-28 | First runs as two probes. Established the envelope requirement, the blocking `bd init` prompt, batch and event-bead limits, and per-command latency. Established atomic claiming and benign write serialization. |
| 2026-08-02 | Merged `02-beads-contract` and `03-beads-concurrency` into one folder, since both describe the same adapter contract. Scripts kept intact as `contract.sh` and `concurrency.sh`. |
| 2026-08-05 | Cleared ambient `BD_JSON_ENVELOPE` before legacy-shape controls so the probe remains independent of the caller environment. Kept unsupported batch metadata diagnostics raw because that error is not a JSON envelope. |
| 2026-08-06 | Added smoke and full fresh-read profiles with isolated canonical fixtures, correctness and freshness guards, complete JSON evidence, environment capture, interleaved raw samples, and non-gating summary statistics. |
