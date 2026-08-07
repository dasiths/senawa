import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import {
  arch,
  cpus,
  freemem,
  loadavg,
  platform,
  release,
  tmpdir,
  totalmem,
} from "node:os";
import { basename, join, resolve } from "node:path";
import type { StoredRuntimeState } from "@senawa/application";
import type { RuntimeTask } from "@senawa/domain";
import {
  BeadsClient,
  BeadsCommandError,
  type BeadsCommandResult,
  type BeadsCommandRunner,
  BeadsRuntimeStateStore,
} from "@senawa/runtime-beads";
import { createRuntimeFixture } from "@senawa/testing";

const benchmarkName = "senawa-beads-fresh-read";
const shuffleSeed = 2_026_080_6;
const repositoryRoot = resolve(
  process.env["SENAWA_BENCHMARK_REPOSITORY_ROOT"] ?? process.cwd(),
);

interface Profile {
  readonly name: "smoke" | "full";
  readonly warmups: number;
  readonly samples: number;
  readonly scenarios: readonly ScenarioDefinition[];
}

interface ScenarioDefinition {
  readonly id: string;
  readonly selectedIssues: number;
  readonly totalIssues: number;
}

interface CanonicalRows {
  readonly run: ExportedIssue;
  readonly phase: ExportedIssue;
  readonly task: ExportedIssue;
}

interface ExportedIssue extends Record<string, unknown> {
  readonly id: string;
  readonly title: string;
  readonly issue_type: string;
  readonly metadata: Record<string, unknown>;
}

interface ListedIssue {
  readonly id: string;
  readonly issue_type: string;
  readonly metadata?: Record<string, unknown>;
}

interface ScenarioRuntime {
  readonly definition: ScenarioDefinition;
  readonly root: string;
  readonly runId: string;
  readonly store: BeadsRuntimeStateStore;
  readonly counter: ListCounter;
  readonly payloadBytes: number;
  readonly databaseBytes: number;
  readonly diagnostic: {
    readonly executable: string;
    readonly version: string;
    readonly supported: boolean;
  };
  readonly beadsContext: Record<string, unknown>;
  readonly correctness: {
    readonly expectedRevision: string;
    readonly expectedPhases: number;
    readonly expectedTasks: number;
    readonly totalIssues: number;
    readonly freshnessObserved: boolean;
    readonly restorationObserved: boolean;
  };
  readonly samplesNs: bigint[];
  measuredListCommands: number;
}

interface ListCounter {
  enabled: boolean;
  count: number;
}

interface SummaryStatistics {
  readonly minimumMs: number;
  readonly p50Ms: number;
  readonly p90Ms: number;
  readonly p95Ms: number;
  readonly maximumMs: number;
  readonly meanMs: number;
  readonly standardDeviationMs: number;
  readonly medianAbsoluteDeviationMs: number;
  readonly coefficientOfVariation: number;
}

interface BenchmarkArguments {
  readonly profile: "smoke" | "full";
  readonly output: string;
}

const scenarioDefinitions = {
  selected2Isolated: {
    id: "selected-2-isolated",
    selectedIssues: 2,
    totalIssues: 2,
  },
  selected32Isolated: {
    id: "selected-32-isolated",
    selectedIssues: 32,
    totalIssues: 32,
  },
  selected128Isolated: {
    id: "selected-128-isolated",
    selectedIssues: 128,
    totalIssues: 128,
  },
  selected2In1024: {
    id: "selected-2-in-1024",
    selectedIssues: 2,
    totalIssues: 1_024,
  },
  selected32In1024: {
    id: "selected-32-in-1024",
    selectedIssues: 32,
    totalIssues: 1_024,
  },
  selected128In1024: {
    id: "selected-128-in-1024",
    selectedIssues: 128,
    totalIssues: 1_024,
  },
} satisfies Record<string, ScenarioDefinition>;

const profiles: Record<Profile["name"], Profile> = {
  smoke: {
    name: "smoke",
    warmups: 1,
    samples: 3,
    scenarios: [
      scenarioDefinitions.selected2Isolated,
      scenarioDefinitions.selected32Isolated,
    ],
  },
  full: {
    name: "full",
    warmups: 5,
    samples: 30,
    scenarios: [
      scenarioDefinitions.selected2Isolated,
      scenarioDefinitions.selected32Isolated,
      scenarioDefinitions.selected128Isolated,
      scenarioDefinitions.selected2In1024,
      scenarioDefinitions.selected32In1024,
      scenarioDefinitions.selected128In1024,
    ],
  },
};

const arguments_ = parseArguments(process.argv.slice(2));
const startedAt = new Date();

try {
  await runBenchmark(arguments_);
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  await writeFile(
    arguments_.output,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        benchmark: benchmarkName,
        profile: arguments_.profile,
        status: "failed",
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        error: message,
      },
      null,
      2,
    )}\n`,
  );
  console.error(message);
  process.exitCode = 1;
}

async function runBenchmark(options: BenchmarkArguments): Promise<void> {
  const profile = profiles[options.profile];
  const keepDirectories = process.env["SENAWA_BENCHMARK_KEEP"] === "1";
  const startResources = resourceSnapshot();
  const environment = await captureEnvironment(profile, keepDirectories);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "senawa-beads-fresh-read-"));
  const scenarioRuntimes: ScenarioRuntime[] = [];
  let canonicalRoot: string | undefined;

  try {
    const canonical = await createCanonicalRows(temporaryRoot);
    canonicalRoot = canonical.root;
    for (const definition of profile.scenarios) {
      scenarioRuntimes.push(
        await createScenario(temporaryRoot, definition, canonical.rows, keepDirectories),
      );
    }

    for (const scenario of scenarioRuntimes) {
      for (let warmup = 0; warmup < profile.warmups; warmup += 1) {
        await assertRead(scenario);
      }
    }

    const scenarioOrderByRound: string[][] = [];
    const random = seededRandom(shuffleSeed);
    for (let round = 0; round < profile.samples; round += 1) {
      const roundOrder = shuffled([...scenarioRuntimes], random);
      scenarioOrderByRound.push(roundOrder.map((scenario) => scenario.definition.id));
      for (const scenario of roundOrder) {
        scenario.counter.enabled = true;
        const beforeCount = scenario.counter.count;
        const start = process.hrtime.bigint();
        await assertRead(scenario);
        const duration = process.hrtime.bigint() - start;
        scenario.counter.enabled = false;
        const commandCount = scenario.counter.count - beforeCount;
        if (commandCount !== 1) {
          throw new Error(
            `${scenario.definition.id} measured read issued ${commandCount} list commands; expected 1`,
          );
        }
        scenario.measuredListCommands += commandCount;
        scenario.samplesNs.push(duration);
      }
    }

    const finishResources = resourceSnapshot();
    const summaries = new Map(
      scenarioRuntimes.map((scenario) => [scenario.definition.id, summarize(scenario.samplesNs)]),
    );
    const baseline = requireSummary(summaries, "selected-2-isolated");
    const normalizedLoad =
      Math.max(startResources.loadAverage[0] ?? 0, finishResources.loadAverage[0] ?? 0) /
      environment.machine.logicalCpuCount;
    const results = scenarioRuntimes.map((scenario) => {
      const summary = requireSummary(summaries, scenario.definition.id);
      const isolatedId = `selected-${scenario.definition.selectedIssues}-isolated`;
      const isolated = summaries.get(isolatedId);
      return {
        id: scenario.definition.id,
        fixture: {
          selectedRunIssues: scenario.definition.selectedIssues,
          selectedPhases: 1,
          selectedTasks: scenario.definition.selectedIssues - 2,
          totalDatabaseIssues: scenario.definition.totalIssues,
          listJsonEnvelopeBytes: scenario.payloadBytes,
          beadsDiskBytes: scenario.databaseBytes,
        },
        correctness: {
          ...scenario.correctness,
          measuredReads: scenario.samplesNs.length,
          measuredListCommands: scenario.measuredListCommands,
        },
        rawSamplesNs: scenario.samplesNs.map(String),
        summary,
        ratios: {
          p50VersusSelected2Isolated: ratio(summary.p50Ms, baseline.p50Ms),
          p95VersusSelected2Isolated: ratio(summary.p95Ms, baseline.p95Ms),
          ambientP50Amplification:
            isolated === undefined ? null : ratio(summary.p50Ms, isolated.p50Ms),
          ambientP95Amplification:
            isolated === undefined ? null : ratio(summary.p95Ms, isolated.p95Ms),
        },
        noisy: summary.coefficientOfVariation > 0.25 || normalizedLoad > 0.5,
      };
    });
    const finishedAt = new Date();
    const document = {
      schemaVersion: 1,
      benchmark: benchmarkName,
      status: "passed",
      interpretation: {
        timingsAreGating: false,
        hardFailures: [
          "command execution",
          "fixture issue counts",
          "runtime reconstruction",
          "cross-client freshness",
          "one bd list per measured read",
        ],
        percentileMethod: "nearest-rank: ceil(percentile * sampleCount) - 1",
      },
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      environment: {
        ...environment,
        beads: {
          diagnostic: scenarioRuntimes[0]?.diagnostic,
          context: scenarioRuntimes[0]?.beadsContext,
          jsonEnvelopeSchemaVersion: 1,
        },
        resources: { start: startResources, finish: finishResources },
      },
      configuration: {
        profile: profile.name,
        warmupsPerScenario: profile.warmups,
        samplesPerScenario: profile.samples,
        shuffleSeed,
        scenarioIds: profile.scenarios.map((scenario) => scenario.id),
        keepDirectories,
      },
      scenarioOrderByRound,
      scenarios: results,
    };
    await writeFile(options.output, `${JSON.stringify(document, null, 2)}\n`);
    printSummary(profile, results, document.durationMs, options.output);
  } finally {
    for (const scenario of scenarioRuntimes) {
      if (!keepDirectories) await rm(scenario.root, { recursive: true, force: true });
    }
    if (!keepDirectories && canonicalRoot !== undefined) {
      await rm(canonicalRoot, { recursive: true, force: true });
    }
    if (!keepDirectories) await rm(temporaryRoot, { recursive: true, force: true });
    else console.log(`Kept benchmark directories under ${temporaryRoot}`);
  }
}

async function createCanonicalRows(
  temporaryRoot: string,
): Promise<{ readonly root: string; readonly rows: CanonicalRows }> {
  const root = await createGitRoot(temporaryRoot, "canonical");
  const runId = "benchmark-canonical";
  const fixture = taskFixture(runId, 1);
  const client = new BeadsClient(root, { environment: benchmarkEnvironment() });
  const store = new BeadsRuntimeStateStore(root, { client });
  await store.createRuntimeState(runId, fixture, "benchmark-canonical-create", {
    phases: [
      {
        id: "phase",
        title: "Benchmark phase",
        dependsOn: [],
        executorKind: "task-frontier",
      },
    ],
  });
  const exported = await client.raw(["export"]);
  const rows = exported
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
    .filter(hasIndexedSenawaMetadata)
    .map(requireExportedIssue);
  const run = rows.find((row) => metadataKind(row) === "run");
  const phase = rows.find((row) => metadataKind(row) === "phase");
  const task = rows.find((row) => metadataKind(row) === "task");
  if (run === undefined || phase === undefined || task === undefined || rows.length !== 3) {
    throw new Error(`Canonical export contained ${rows.length} rows; expected run, phase, and task`);
  }
  return { root, rows: { run, phase, task } };
}

async function createScenario(
  temporaryRoot: string,
  definition: ScenarioDefinition,
  canonical: CanonicalRows,
  keepDirectories: boolean,
): Promise<ScenarioRuntime> {
  const root = await createGitRoot(temporaryRoot, definition.id);
  const runId = `benchmark-${definition.id}`;
  const environment = benchmarkEnvironment();
  const setupClient = new BeadsClient(root, { environment });
  await setupClient.ensureInitialized();
  const rows = buildScenarioRows(definition, runId, canonical);
  const fixturePath = join(root, "benchmark-fixture.jsonl");
  await writeFile(fixturePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  await setupClient.json(["import", fixturePath]);
  if (!keepDirectories) await rm(fixturePath, { force: true });

  const listed = await setupClient.json<ListedIssue[]>(["list", "--all", "--limit", "0"]);
  if (listed.length !== definition.totalIssues) {
    throw new Error(
      `${definition.id} imported ${listed.length} issues; expected ${definition.totalIssues}`,
    );
  }
  const selectedCount = listed.filter(
    (issue) => issue.metadata?.["senawa_run_id"] === runId && issue.issue_type !== "event",
  ).length;
  if (selectedCount !== definition.selectedIssues) {
    throw new Error(
      `${definition.id} selected ${selectedCount} issues; expected ${definition.selectedIssues}`,
    );
  }

  const counter: ListCounter = { enabled: false, count: 0 };
  const measuringClient = new BeadsClient(root, {
    environment,
    runCommand: countingRunner(counter),
  });
  const store = new BeadsRuntimeStateStore(root, { client: measuringClient });
  const expectedTasks = definition.selectedIssues - 2;
  const initial = await assertRuntimeState(store, runId, expectedTasks, "pending");
  const phaseIssue = listed.find(
    (issue) =>
      issue.metadata?.["senawa_run_id"] === runId &&
      issue.metadata?.["senawa_kind"] === "phase",
  );
  if (phaseIssue?.metadata === undefined) throw new Error(`${definition.id} is missing its phase`);
  const originalMetadata = structuredClone(phaseIssue.metadata);
  const changedMetadata = structuredClone(originalMetadata);
  const changedSenawa = requireRecord(
    changedMetadata["senawa"],
    `${definition.id} phase metadata`,
  );
  changedSenawa["status"] = "running";
  const independentClient = new BeadsClient(root, { environment });
  await independentClient.json([
    "update",
    phaseIssue.id,
    "--metadata",
    JSON.stringify(changedMetadata),
  ]);
  const fresh = await assertRuntimeState(store, runId, expectedTasks, "running");
  await independentClient.json([
    "update",
    phaseIssue.id,
    "--metadata",
    JSON.stringify(originalMetadata),
  ]);
  const restored = await assertRuntimeState(store, runId, expectedTasks, "pending");

  const inspection = await runClosedCommand("bd", ["list", "--all", "--limit", "0", "--json"], {
    cwd: root,
    env: resolvedEnvironment(root),
  });
  JSON.parse(inspection.stdout);
  const context = await setupClient.json<Record<string, unknown>>(["context"]);
  const diagnostic = await setupClient.diagnose();
  if (!diagnostic.supported) throw new Error(`Unsupported Beads version ${diagnostic.version}`);
  return {
    definition,
    root,
    runId,
    store,
    counter,
    payloadBytes: Buffer.byteLength(inspection.stdout),
    databaseBytes: await directoryBytes(join(root, ".beads")),
    diagnostic,
    beadsContext: sanitizeContext(context, root),
    correctness: {
      expectedRevision: initial.revision,
      expectedPhases: 1,
      expectedTasks,
      totalIssues: listed.length,
      freshnessObserved: fresh.state.phases[0]?.status === "running",
      restorationObserved: restored.state.phases[0]?.status === "pending",
    },
    samplesNs: [],
    measuredListCommands: 0,
  };
}

function buildScenarioRows(
  definition: ScenarioDefinition,
  runId: string,
  canonical: CanonicalRows,
): ExportedIssue[] {
  const rows: ExportedIssue[] = [
    cloneIssue(canonical.run, definition.id, 0, runId, "run", "run", 0),
    cloneIssue(canonical.phase, definition.id, 1, runId, "phase", "phase", 0),
  ];
  const selectedTasks = definition.selectedIssues - 2;
  for (let index = 0; index < selectedTasks; index += 1) {
    rows.push(
      cloneIssue(canonical.task, definition.id, rows.length, runId, "task", `task-${index}`, index),
    );
  }
  while (rows.length < definition.totalIssues) {
    const index = rows.length;
    rows.push(
      cloneIssue(
        canonical.task,
        definition.id,
        index,
        `ambient-run-${Math.floor(index / 32)}`,
        "task",
        `ambient-task-${index}`,
        index,
      ),
    );
  }
  return rows;
}

function cloneIssue(
  canonical: ExportedIssue,
  scenarioId: string,
  index: number,
  runId: string,
  kind: "run" | "phase" | "task",
  nodeId: string,
  order: number,
): ExportedIssue {
  const clone = structuredClone(canonical);
  const shortScenario = createHash("sha256").update(scenarioId).digest("hex").slice(0, 8);
  const id = `bench-${shortScenario}-${index.toString().padStart(4, "0")}`;
  const metadata = requireRecord(clone.metadata, `${scenarioId} canonical metadata`);
  const senawa = requireRecord(metadata["senawa"], `${scenarioId} canonical Senawa metadata`);
  metadata["senawa_run_id"] = runId;
  metadata["senawa_kind"] = kind;
  senawa["run_id"] = runId;
  senawa["kind"] = kind;
  if (kind !== "run") {
    senawa["node_id"] = nodeId;
    senawa["order"] = order;
  }
  if (kind === "task") {
    senawa["parent_phase_id"] = "phase";
    const definition = requireRecord(senawa["definition"], `${scenarioId} task definition`);
    definition["key"] = nodeId;
    definition["title"] = nodeId;
    definition["dependsOn"] = [];
    definition["paths"] = [`src/${nodeId}.ts`];
    definition["acceptance"] = [`${nodeId} passes`];
  }
  return {
    ...clone,
    id,
    title: kind === "run" ? `Senawa run ${runId}` : nodeId,
    status: "open",
    metadata,
    dependencies: [],
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
  };
}

async function assertRead(scenario: ScenarioRuntime): Promise<void> {
  await assertRuntimeState(
    scenario.store,
    scenario.runId,
    scenario.definition.selectedIssues - 2,
    "pending",
  );
}

async function assertRuntimeState(
  store: BeadsRuntimeStateStore,
  runId: string,
  expectedTasks: number,
  phaseStatus: "pending" | "running",
) {
  const current = await store.readRuntimeState(runId);
  if (current.revision !== "1") throw new Error(`${runId} reconstructed revision ${current.revision}`);
  if (current.state.phases.length !== 1 || current.state.phases[0]?.status !== phaseStatus) {
    throw new Error(`${runId} did not reconstruct its expected ${phaseStatus} phase`);
  }
  if (current.state.tasks.length !== expectedTasks) {
    throw new Error(
      `${runId} reconstructed ${current.state.tasks.length} tasks; expected ${expectedTasks}`,
    );
  }
  return current;
}

function taskFixture(runId: string, taskCount: number): StoredRuntimeState {
  const state = createRuntimeFixture(runId);
  const tasks = Array.from({ length: taskCount }, (_, index) => benchmarkTask(index));
  return {
    apiVersion: state.apiVersion,
    status: state.status,
    endReason: state.endReason,
    phases: state.phases,
    tasks,
    activeTurn: state.activeTurn,
    dispatches: state.dispatches,
  };
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

function countingRunner(counter: ListCounter): BeadsCommandRunner {
  return async (executable, commandArguments, options) => {
    if (
      counter.enabled &&
      commandArguments[0] === "list" &&
      commandArguments.includes("--all") &&
      commandArguments.includes("--limit")
    ) {
      counter.count += 1;
    }
    return runClosedCommand(executable, commandArguments, options);
  };
}

function runClosedCommand(
  executable: string,
  commandArguments: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<BeadsCommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, commandArguments, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", rejectCommand);
    child.once("close", (code, signal) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const diagnostics = Buffer.concat(stderr).toString("utf8");
      if (code === 0) {
        resolveCommand({ stdout: output, stderr: diagnostics });
        return;
      }
      rejectCommand(
        new BeadsCommandError(
          `Command exited ${code === null ? `for signal ${signal ?? "unknown"}` : `with code ${code}`}: ${diagnostics.trim() || output.trim() || "no diagnostics"}`,
          [executable, ...commandArguments],
        ),
      );
    });
  });
}

async function createGitRoot(temporaryRoot: string, name: string): Promise<string> {
  const root = await mkdtemp(join(temporaryRoot, `${name}-`));
  await runClosedCommand("git", ["init", "--quiet", root], {
    cwd: repositoryRoot,
    env: process.env,
  });
  await runClosedCommand("git", ["-C", root, "config", "user.email", "benchmark@example.com"], {
    cwd: repositoryRoot,
    env: process.env,
  });
  await runClosedCommand("git", ["-C", root, "config", "user.name", "senawa-benchmark"], {
    cwd: repositoryRoot,
    env: process.env,
  });
  await runClosedCommand("git", ["-C", root, "config", "beads.role", "maintainer"], {
    cwd: repositoryRoot,
    env: process.env,
  });
  return root;
}

function benchmarkEnvironment(): NodeJS.ProcessEnv {
  return {
    BEADS_ACTOR: "senawa-benchmark",
    BD_JSON_ENVELOPE: "1",
    BD_NON_INTERACTIVE: "1",
    DO_NOT_TRACK: "1",
  };
}

function resolvedEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...benchmarkEnvironment(),
    BEADS_DIR: join(root, ".beads"),
  };
}

async function captureEnvironment(profile: Profile, keepDirectories: boolean) {
  const [head, branch, dirtyState, lockfile, nodeVersion, pnpmVersion, esbuildVersion, gitVersion, bdVersion] =
    await Promise.all([
      commandText("git", ["rev-parse", "HEAD"]),
      commandText("git", ["branch", "--show-current"]),
      commandText("git", ["status", "--porcelain"]),
      readFile(join(repositoryRoot, "pnpm-lock.yaml")),
      commandText("node", ["--version"]),
      commandText("pnpm", ["--version"]),
      commandText("pnpm", ["exec", "esbuild", "--version"]),
      commandText("git", ["--version"]),
      commandText("bd", ["version"]),
    ]);
  const temporaryFilesystem = await commandText("stat", ["-f", "-c", "%T", tmpdir()]);
  const cpu = cpus()[0];
  return {
    repository: {
      head,
      branch,
      dirty: dirtyState.length > 0,
      porcelain: dirtyState.split("\n").filter(Boolean),
      pnpmLockSha256: createHash("sha256").update(lockfile).digest("hex"),
    },
    versions: { node: nodeVersion, pnpm: pnpmVersion, esbuild: esbuildVersion, git: gitVersion, bd: bdVersion },
    machine: {
      platform: platform(),
      release: release(),
      architecture: arch(),
      logicalCpuCount: cpus().length,
      cpuModel: cpu?.model ?? "unknown",
      totalMemoryBytes: totalmem(),
      temporaryFilesystem,
    },
    execution: {
      ci: process.env["CI"] === "true",
      providers: {
        githubActions: process.env["GITHUB_ACTIONS"] === "true",
        azurePipelines: process.env["TF_BUILD"] === "True",
        gitlabCi: process.env["GITLAB_CI"] === "true",
      },
      container: await fileExists("/.dockerenv") || await fileExists("/run/.containerenv"),
      wsl: /microsoft/iu.test(release()) || process.env["WSL_DISTRO_NAME"] !== undefined,
      tmpdir: tmpdir(),
      profile: profile.name,
      keepDirectories,
    },
  };
}

function resourceSnapshot() {
  return {
    capturedAt: new Date().toISOString(),
    loadAverage: loadavg(),
    freeMemoryBytes: freemem(),
  };
}

async function commandText(executable: string, commandArguments: readonly string[]): Promise<string> {
  return (
    await runClosedCommand(executable, commandArguments, {
      cwd: repositoryRoot,
      env: process.env,
    })
  ).stdout.trim();
}

async function directoryBytes(path: string): Promise<number> {
  const entries = await import("node:fs/promises").then(({ readdir }) =>
    readdir(path, { withFileTypes: true }),
  );
  let total = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? await directoryBytes(child) : (await stat(child)).size;
  }
  return total;
}

function summarize(samplesNs: readonly bigint[]): SummaryStatistics {
  if (samplesNs.length === 0) throw new Error("Cannot summarize an empty sample set");
  const values = samplesNs.map((sample) => Number(sample) / 1_000_000).toSorted((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const standardDeviation = Math.sqrt(variance);
  const medianValue = percentile(values, 0.5);
  const deviations = values.map((value) => Math.abs(value - medianValue)).toSorted((a, b) => a - b);
  return {
    minimumMs: round(values[0] ?? 0),
    p50Ms: round(medianValue),
    p90Ms: round(percentile(values, 0.9)),
    p95Ms: round(percentile(values, 0.95)),
    maximumMs: round(values.at(-1) ?? 0),
    meanMs: round(mean),
    standardDeviationMs: round(standardDeviation),
    medianAbsoluteDeviationMs: round(percentile(deviations, 0.5)),
    coefficientOfVariation: round(mean === 0 ? 0 : standardDeviation / mean),
  };
}

function percentile(sortedValues: readonly number[], requested: number): number {
  const index = Math.max(0, Math.ceil(requested * sortedValues.length) - 1);
  const value = sortedValues[index];
  if (value === undefined) throw new Error(`Missing percentile ${requested}`);
  return value;
}

function requireSummary(
  summaries: ReadonlyMap<string, SummaryStatistics>,
  id: string,
): SummaryStatistics {
  const summary = summaries.get(id);
  if (summary === undefined) throw new Error(`Missing summary for ${id}`);
  return summary;
}

function ratio(numerator: number, denominator: number): number {
  return round(denominator === 0 ? 0 : numerator / denominator);
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function shuffled<T>(values: T[], random: () => number): T[] {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const value = values[index];
    const replacement = values[other];
    if (value === undefined || replacement === undefined) throw new Error("Invalid shuffle index");
    values[index] = replacement;
    values[other] = value;
  }
  return values;
}

function sanitizeContext(context: Record<string, unknown>, root: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [
      key,
      key === "database"
        ? "<scenario-database>"
        : typeof value === "string"
          ? value.replaceAll(root, "<scenario-root>")
          : value,
    ]),
  );
}

function metadataKind(issue: ExportedIssue): unknown {
  return issue.metadata["senawa_kind"];
}

function hasIndexedSenawaMetadata(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value["metadata"]) &&
    typeof value["metadata"]["senawa_kind"] === "string"
  );
}

function requireExportedIssue(value: unknown): ExportedIssue {
  const issue = requireRecord(value, "canonical exported issue");
  if (
    typeof issue["id"] !== "string" ||
    typeof issue["title"] !== "string" ||
    typeof issue["issue_type"] !== "string" ||
    !isRecord(issue["metadata"])
  ) {
    throw new Error("Canonical Beads export has an unsupported issue shape");
  }
  return issue as ExportedIssue;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseArguments(values: readonly string[]): BenchmarkArguments {
  let profile: BenchmarkArguments["profile"] | undefined;
  let output: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--profile") {
      const candidate = values[index + 1];
      if (candidate !== "smoke" && candidate !== "full") {
        throw new Error("--profile must be smoke or full");
      }
      profile = candidate;
      index += 1;
    } else if (value === "--output") {
      const candidate = values[index + 1];
      if (candidate === undefined || candidate.length === 0) throw new Error("--output requires a path");
      output = resolve(candidate);
      index += 1;
    } else {
      throw new Error(`Unknown argument ${JSON.stringify(value)}`);
    }
  }
  if (profile === undefined || output === undefined) {
    throw new Error("Usage: fresh-read-benchmark --profile smoke|full --output <path>");
  }
  if (basename(output).length === 0) throw new Error("Output must name a JSON file");
  return { profile, output };
}

function printSummary(
  profile: Profile,
  results: readonly {
    readonly id: string;
    readonly fixture: { readonly totalDatabaseIssues: number };
    readonly summary: SummaryStatistics;
    readonly noisy: boolean;
  }[],
  durationMs: number,
  output: string,
): void {
  console.log(`Fresh Beads read benchmark (${profile.name})`);
  console.log("Scenario                         issues     p50     p90     p95    mean      cv noisy");
  for (const result of results) {
    const summary = result.summary;
    console.log(
      `${result.id.padEnd(31)} ${String(result.fixture.totalDatabaseIssues).padStart(6)} ${summary.p50Ms.toFixed(1).padStart(7)} ${summary.p90Ms.toFixed(1).padStart(7)} ${summary.p95Ms.toFixed(1).padStart(7)} ${summary.meanMs.toFixed(1).padStart(7)} ${summary.coefficientOfVariation.toFixed(3).padStart(7)} ${result.noisy ? "yes" : "no"}`,
    );
  }
  console.log(`Completed in ${(durationMs / 1_000).toFixed(1)} s; JSON: ${output}`);
  console.log("Timing is descriptive and does not affect the exit code.");
}