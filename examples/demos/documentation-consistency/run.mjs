import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const sourceRoot = process.cwd();
const arguments_ = process.argv.slice(2);
const command = arguments_[0]?.startsWith("-") === false ? arguments_.shift() : "run";
const timestamp = new Date().toISOString().replaceAll(/[-:]/gu, "").replace(/\..+$/u, "Z");
const workspace = resolve(
  optionValue(arguments_, "--workspace") ??
    join(sourceRoot, "..", `senawa-documentation-consistency-${timestamp}`),
);
const branch = optionValue(arguments_, "--branch") ?? `demo/documentation-consistency-${timestamp}`;
const goal =
  optionValue(arguments_, "--goal") ??
  [
    "Review README.md and the numbered docs/design guides for contradictions in current",
    "production architecture and CLI behavior. Make the smallest documentation-only",
    "consistency changes, preserve measured history and probe-local paths, validate links,",
    "and do not modify runtime code or Senawa configuration.",
  ].join(" ");

if (arguments_.includes("--help") || command === "help") {
  printHelp();
} else if (command === "prepare") {
  await prepareWorkspace();
} else if (command === "run") {
  requireCostConfirmation();
  await prepareWorkspace();
  await startWorkflow();
  await driveWorkflow();
} else if (command === "start") {
  requireCostConfirmation();
  await requireDemoWorkspace();
  assertNoActiveRun();
  await startWorkflow();
  await driveWorkflow();
} else if (command === "resume") {
  requireCostConfirmation();
  await requireDemoWorkspace();
  await driveWorkflow();
} else if (command === "verify") {
  await requireDemoWorkspace();
  await verifyWorkspace();
} else {
  throw new Error(`Unknown command ${command}. Use run, prepare, resume, verify, or help.`);
}

async function prepareWorkspace() {
  requireExecutable("git", ["--version"]);
  requireExecutable("pnpm", ["--version"]);
  requireExecutable("bd", ["--version"]);
  requireExecutable("copilot", ["--version"]);
  run("git", ["rev-parse", "--show-toplevel"], { cwd: sourceRoot });
  run("git", ["check-ref-format", "--branch", branch], { cwd: sourceRoot });
  const sourceBranch = output("git", ["branch", "--show-current"], sourceRoot);
  if (sourceBranch.length === 0) throw new Error("The source repository is in detached HEAD state");
  const dirty = output("git", ["status", "--porcelain"], sourceRoot);
  if (dirty.length > 0) {
    print("Source changes are not copied. The demo clone starts from the committed HEAD.");
  }

  await assertMissing(workspace, `Demo workspace already exists: ${workspace}`);
  await mkdir(dirname(workspace), { recursive: true });
  run(
    "git",
    [
      "clone",
      "--local",
      "--no-hardlinks",
      "--single-branch",
      "--branch",
      sourceBranch,
      sourceRoot,
      workspace,
    ],
    { cwd: sourceRoot },
  );
  run("git", ["switch", "-c", branch], { cwd: workspace });
  run("pnpm", ["install", "--frozen-lockfile"], { cwd: workspace });
  run("pnpm", ["build"], { cwd: workspace });
  runSenawa(["doctor"]);
  runSenawa(["workflow", "validate", "standard-delivery"]);
  assertNoActiveRun();
  await writeMetadata({ branch, goal, sourceRoot, createdAt: new Date().toISOString() });
  print(`Prepared real demo workspace: ${workspace}`);
  print(`Created branch: ${branch}`);
}

async function startWorkflow() {
  printCostWarning();
  runSenawa(["work", "start", goal, "--workflow", "standard-delivery"], [0, 2]);
}

async function driveWorkflow() {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const status = activeStatus();
      if (status.status === "finished") {
        await verifyWorkspace(status);
        return;
      }
      if (status.status === "ended") {
        throw new Error(
          `The workflow ended without completion: ${status.endReason ?? "no reason"}`,
        );
      }
      if (status.needs?.action === "approve-or-reject") {
        const phaseId = status.needs.phaseId;
        print(`\nPhase ${phaseId} requires your decision. Full artifact:`);
        runSenawa(["phase", "artifact", phaseId]);
        const decision = await askChoice(
          terminal,
          "Choose [a]pprove, [r]eject, or [e]nd: ",
          new Set(["a", "r", "e"]),
        );
        if (decision === "a") runSenawa(["approve", phaseId]);
        if (decision === "r") {
          const reason = await askRequired(terminal, "Rejection reason: ");
          runSenawa(["reject", phaseId, "--reason", reason]);
        }
        if (decision === "e") {
          const reason = await askRequired(terminal, "End reason: ");
          runSenawa(["work", "end", "--reason", reason]);
          return;
        }
        runSenawa(["work", "resume"], [0, 2]);
        continue;
      }

      print(`\nWorkflow is ${status.status}.`);
      if (status.unsettledDispatch !== null) {
        print(`Dispatch requires reconciliation: ${status.unsettledDispatch.operatorAction}`);
      }
      const decision = await askChoice(terminal, "Choose [r]esume or [e]nd: ", new Set(["r", "e"]));
      if (decision === "e") {
        const reason = await askRequired(terminal, "End reason: ");
        runSenawa(["work", "end", "--reason", reason]);
        return;
      }
      runSenawa(["work", "resume"], [0, 2]);
    }
  } finally {
    terminal.close();
    print(`Demo workspace retained at: ${workspace}`);
    print(`Resume with: pnpm demo:docs -- resume --confirm-cost --workspace ${workspace}`);
  }
}

async function verifyWorkspace(existingStatus) {
  const metadata = await readMetadata();
  const status = existingStatus ?? activeStatus();
  assert(status.backend === "beads", `Expected Beads backend, received ${status.backend}`);
  assert(status.workflow === "standard-delivery", `Unexpected workflow ${status.workflow}`);
  assert(status.status === "finished", `Workflow status is ${status.status}, not finished`);
  assert(status.needs === null, "Finished workflow still requires a human decision");
  assert(status.unsettledDispatch === null, "Finished workflow has an unsettled dispatch");
  assert(
    status.phases.length > 0 && status.phases.every((phase) => phase.status === "accepted"),
    "Not every workflow phase was accepted",
  );
  assert(
    status.tasks.length > 0 && status.tasks.every((task) => task.status === "closed"),
    "Not every implementation task was closed",
  );
  const currentBranch = output("git", ["branch", "--show-current"], workspace);
  assert(
    currentBranch === metadata.branch,
    `Expected branch ${metadata.branch}, found ${currentBranch}`,
  );

  const changedPaths = new Set([
    ...lines(output("git", ["diff", "--name-only", "HEAD"], workspace)),
    ...lines(output("git", ["ls-files", "--others", "--exclude-standard"], workspace)),
  ]);
  const authoredPaths = [...changedPaths].filter(
    (path) =>
      !path.startsWith(".agents/.copilot-tracking/") &&
      !path.startsWith(".beads/") &&
      !path.startsWith(".copilot-tracking/"),
  );
  assert(authoredPaths.length > 0, "The workflow produced no repository change");
  assert(
    authoredPaths.every((path) => path === "README.md" || path.startsWith("docs/")),
    `Documentation workflow changed files outside README.md and docs/: ${authoredPaths.join(", ")}`,
  );

  run("git", ["diff", "--check"], { cwd: workspace });
  for (const script of [
    "docs:links",
    "lint",
    "typecheck",
    "test",
    "build",
    "check:boundaries",
    "bundle:check",
  ]) {
    run("pnpm", [script], { cwd: workspace });
  }
  runSenawa(["sensor", "audit", status.runId]);
  runSenawa(["work", "report", status.runId]);
  print(
    JSON.stringify(
      {
        ok: true,
        workspace,
        branch: currentBranch,
        runId: status.runId,
        backend: status.backend,
        phases: status.progress.phases,
        tasks: status.progress.tasks,
        changedDocumentation: authoredPaths.sort(),
      },
      null,
      2,
    ),
  );
}

async function requireDemoWorkspace() {
  const metadata = await readMetadata();
  const currentBranch = output("git", ["branch", "--show-current"], workspace);
  assert(
    currentBranch === metadata.branch,
    `Expected branch ${metadata.branch}, found ${currentBranch}`,
  );
  run("pnpm", ["build"], { cwd: workspace });
  runSenawa(["doctor"]);
}

function runSenawa(arguments_, acceptedCodes = [0]) {
  return run(
    process.execPath,
    [
      join(workspace, "apps", "senawa", "dist", "senawa.mjs"),
      "--worker-host",
      "sdk",
      ...arguments_,
    ],
    { cwd: workspace, acceptedCodes },
  );
}

function senawaJson(arguments_) {
  const result = run(
    process.execPath,
    [
      join(workspace, "apps", "senawa", "dist", "senawa.mjs"),
      "--worker-host",
      "sdk",
      ...arguments_,
    ],
    { cwd: workspace, stdio: "pipe" },
  );
  return JSON.parse(result.stdout);
}

function activeStatus() {
  const status = senawaJson(["work", "show"]);
  assert(status !== null, "No active workflow exists in the prepared demo workspace");
  return status;
}

function assertNoActiveRun() {
  const result = run(
    process.execPath,
    [
      join(workspace, "apps", "senawa", "dist", "senawa.mjs"),
      "--worker-host",
      "sdk",
      "work",
      "show",
    ],
    { cwd: workspace, stdio: "pipe" },
  );
  assert(
    JSON.parse(result.stdout) === null,
    `Fresh clone unexpectedly contains an active run: ${result.stdout.trim()}`,
  );
}

function run(command_, arguments_, options) {
  print(`$ ${command_} ${arguments_.join(" ")}`);
  const result = spawnSync(command_, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
  });
  if (result.error !== undefined) throw result.error;
  const acceptedCodes = options.acceptedCodes ?? [0];
  if (!acceptedCodes.includes(result.status ?? 1)) {
    throw new Error(
      `${command_} exited ${result.status ?? `from signal ${result.signal}`}${
        result.stderr ? `: ${result.stderr.trim()}` : ""
      }`,
    );
  }
  return result;
}

function output(command_, arguments_, cwd) {
  return run(command_, arguments_, { cwd, stdio: "pipe" }).stdout.trim();
}

function requireExecutable(command_, arguments_) {
  try {
    run(command_, arguments_, { cwd: sourceRoot, stdio: "pipe" });
  } catch {
    throw new Error(`Required executable is unavailable: ${command_}`);
  }
}

async function writeMetadata(metadata) {
  const gitDirectory = output("git", ["rev-parse", "--absolute-git-dir"], workspace);
  await writeFile(
    join(gitDirectory, "senawa-documentation-consistency-demo.json"),
    JSON.stringify(metadata, null, 2),
  );
}

async function readMetadata() {
  const gitDirectory = output("git", ["rev-parse", "--absolute-git-dir"], workspace);
  try {
    return JSON.parse(
      await readFile(join(gitDirectory, "senawa-documentation-consistency-demo.json"), "utf8"),
    );
  } catch (error) {
    throw new Error(`Workspace is not a prepared documentation-consistency demo: ${error.message}`);
  }
}

async function assertMissing(path, message) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(message);
}

async function askChoice(terminal, question, choices) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Human decisions require an interactive terminal");
  }
  for (;;) {
    const answer = (await terminal.question(question)).trim().toLowerCase();
    if (choices.has(answer)) return answer;
    print(`Choose one of: ${[...choices].join(", ")}`);
  }
}

async function askRequired(terminal, question) {
  for (;;) {
    const answer = (await terminal.question(question)).trim();
    if (answer.length > 0) return answer;
    print("A reason is required.");
  }
}

function requireCostConfirmation() {
  printCostWarning();
  if (!arguments_.includes("--confirm-cost")) {
    throw new Error("Re-run with --confirm-cost to authorize GitHub Copilot credit spending");
  }
}

function printCostWarning() {
  print("WARNING: this demo runs real SDK workers and spends GitHub Copilot AI credits.");
}

function optionValue(values, name) {
  const index = values.indexOf(name);
  if (index < 0) return undefined;
  const value = values[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function lines(value) {
  return value.length === 0 ? [] : value.split("\n").filter(Boolean);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function print(value) {
  process.stdout.write(`${value}\n`);
}

function printHelp() {
  print(`Usage:
  pnpm demo:docs -- --confirm-cost [--workspace <path>] [--branch <name>]
  pnpm demo:docs -- prepare [--workspace <path>] [--branch <name>]
  pnpm demo:docs -- start --confirm-cost --workspace <path>
  pnpm demo:docs -- resume --confirm-cost --workspace <path>
  pnpm demo:docs -- verify --workspace <path>

Commands:
  run      Prepare a clone, create a branch, run the live workflow, and verify it
  prepare  Prepare and validate the real clone without starting an SDK session
  start    Start the live workflow in an existing prepared clone
  resume   Continue an interrupted workflow with explicit human decisions
  verify   Re-run all completion and repository assertions without using AI credits`);
}
