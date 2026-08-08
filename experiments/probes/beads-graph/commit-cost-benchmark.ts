// Reproducible, no-credit measurement of Beads commit cost per changed node.
//
// Commits are the dominant Senawa transition cost because every commit used to
// rewrite every phase and task. This benchmark measures a converging commit
// against an unchanged re-commit, so the skip behaviour is verifiable rather
// than recorded.
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { StoredRuntimeState } from "@senawa/application";
import type { RuntimeTask } from "@senawa/domain";
import { BeadsClient, BeadsRuntimeStateStore } from "@senawa/runtime-beads";
import { createRuntimeFixture } from "@senawa/testing";

const execute = promisify(execFile);

interface Sample {
  readonly label: string;
  readonly durationMs: number;
  readonly commands: number;
  readonly byVerb: Record<string, number>;
}

function parseArguments(argv: readonly string[]): { tasks: number; output: string } {
  let tasks = 10;
  let output = join(tmpdir(), "senawa-beads-commit-cost.json");
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${String(flag)}`);
    if (flag === "--tasks") tasks = Number.parseInt(value, 10);
    else if (flag === "--output") output = value;
    else throw new Error(`Unknown argument: ${String(flag)}`);
  }
  if (!Number.isSafeInteger(tasks) || tasks < 1) {
    throw new Error("--tasks must be a positive integer");
  }
  return { tasks, output };
}

async function createGitRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "senawa-commit-cost-"));
  await execute("git", ["init", "--quiet", root]);
  await execute("git", ["-C", root, "config", "user.email", "probe@example.com"]);
  await execute("git", ["-C", root, "config", "user.name", "probe"]);
  await execute("git", ["-C", root, "config", "beads.role", "maintainer"]);
  return root;
}

async function measure(
  label: string,
  root: string,
  run: (store: BeadsRuntimeStateStore) => Promise<void>,
): Promise<Sample> {
  const byVerb: Record<string, number> = {};
  let commands = 0;
  const client = new BeadsClient(root, {
    runCommand: async (executable, argumentList, options) => {
      commands += 1;
      const verb = argumentList[0] ?? "unknown";
      byVerb[verb] = (byVerb[verb] ?? 0) + 1;
      const result = await execute(executable, [...argumentList], {
        cwd: options.cwd,
        env: options.env,
        maxBuffer: 64 * 1024 * 1024,
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    },
  });
  const store = new BeadsRuntimeStateStore(root, { client });
  const startedAt = Date.now();
  await run(store);
  return { label, durationMs: Date.now() - startedAt, commands, byVerb };
}

function writeCommands(byVerb: Record<string, number>): number {
  return ["update", "set-state", "create", "dep", "gate"].reduce(
    (total, verb) => total + (byVerb[verb] ?? 0),
    0,
  );
}

// One unchanged commit against a graph of `tasks` tasks. Returns its write cost.
async function unchangedCommitWrites(tasks: number): Promise<Sample> {
  const root = await createGitRoot();
  const runId = `benchmark-unchanged-${tasks}`;
  await new BeadsRuntimeStateStore(root).createRuntimeState(
    runId,
    taskFixture(runId, tasks),
    "create",
    {
      phases: [
        { id: "phase", title: "Benchmark phase", dependsOn: [], executorKind: "task-frontier" },
      ],
    },
  );
  return measure(`unchanged-commit-${tasks}-tasks`, root, async (store) => {
    const current = await store.readRuntimeState(runId);
    await store.commitRuntimeState({
      runId,
      expectedRevision: current.revision,
      operationId: "commit-unchanged",
      state: structuredClone(current.state),
    });
  });
}

function benchmarkTask(index: number): RuntimeTask {
  const key = `task-${index}`;
  return {
    key,
    title: key,
    dependsOn: [],
    paths: [`src/${key}.ts`],
    acceptance: [`${key} passes`],
    role: "worker",
    status: "pending",
    attempt: 0,
    dispatchFailures: 0,
    sessionId: null,
    steering: [],
    reworkFindings: [],
  };
}

function taskFixture(runId: string, taskCount: number): StoredRuntimeState {
  const state = createRuntimeFixture(runId);
  return {
    apiVersion: state.apiVersion,
    status: state.status,
    endReason: state.endReason,
    phases: state.phases,
    tasks: Array.from({ length: taskCount }, (_value, index) => benchmarkTask(index)),
    activeTurn: state.activeTurn,
    dispatches: state.dispatches,
  };
}

async function main(): Promise<void> {
  const { tasks, output } = parseArguments(process.argv.slice(2));
  const root = await createGitRoot();
  const runId = "benchmark-commit-cost";

  await new BeadsRuntimeStateStore(root).createRuntimeState(
    runId,
    taskFixture(runId, tasks),
    "create",
    {
      phases: [
        { id: "phase", title: "Benchmark phase", dependsOn: [], executorKind: "task-frontier" },
      ],
    },
  );

  const changed = await measure("changed-commit", root, async (store) => {
    const current = await store.readRuntimeState(runId);
    const next = structuredClone(current.state);
    const task = next.tasks[0];
    if (task === undefined) throw new Error("benchmark requires at least one task");
    task.status = "in_progress";
    await store.commitRuntimeState({
      runId,
      expectedRevision: current.revision,
      operationId: "commit-changed",
      state: next,
    });
  });

  const unchanged = await measure("unchanged-commit", root, async (store) => {
    const current = await store.readRuntimeState(runId);
    await store.commitRuntimeState({
      runId,
      expectedRevision: current.revision,
      operationId: "commit-unchanged",
      state: structuredClone(current.state),
    });
  });

  // The run epic always rewrites its revision and receipt, so an unchanged
  // commit is never free. What must hold is that its cost does not grow with
  // the graph, which is what the convergence skip buys.
  const small = await unchangedCommitWrites(1);
  const large = await unchangedCommitWrites(tasks);

  const summary = {
    apiVersion: "senawa.dev/probe/beads-commit-cost/v1",
    capturedAt: new Date().toISOString(),
    graph: { phases: 1, tasks },
    samples: [changed, unchanged, small, large],
    scaling: {
      unchangedWritesAtOneTask: writeCommands(small.byVerb),
      unchangedWritesAtManyTasks: writeCommands(large.byVerb),
      constantInGraphSize: writeCommands(small.byVerb) === writeCommands(large.byVerb),
    },
  };
  await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  process.stdout.write(`Beads commit cost (1 phase, ${tasks} tasks)\n`);
  for (const sample of summary.samples) {
    process.stdout.write(
      `  ${sample.label.padEnd(26)} ${String(sample.commands).padStart(4)} commands  ${String(writeCommands(sample.byVerb)).padStart(3)} writes  ${String(sample.durationMs).padStart(7)} ms\n`,
    );
  }
  process.stdout.write(`  summary written to ${output}\n`);

  if (!summary.scaling.constantInGraphSize) {
    process.stderr.write(
      `Unchanged commit writes grew from ${summary.scaling.unchangedWritesAtOneTask} to ${summary.scaling.unchangedWritesAtManyTasks} as the graph grew; convergence skipping regressed.\n`,
    );
    process.exitCode = 1;
  }
}

await main();
