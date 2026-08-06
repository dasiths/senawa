import { spawnSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const repositoryRoot = resolve(process.cwd());
const arguments_ = process.argv.slice(2);
if (arguments_[0] === "--") arguments_.shift();
const command = arguments_[0]?.startsWith("-") === false ? arguments_.shift() : "run";
const autoApprove = arguments_.includes("--auto-approve");
const timestamp = new Date().toISOString().replaceAll(/[-:]/gu, "").replace(/\..+$/u, "Z");
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
  await prepareRepository();
} else if (command === "run") {
  requireCostConfirmation();
  await prepareRepository();
  await startWorkflow();
  await driveWorkflow();
} else if (command === "start") {
  requireCostConfirmation();
  await requireDemoRepository();
  assertNoActiveRun();
  await startWorkflow();
  await driveWorkflow();
} else if (command === "resume") {
  requireCostConfirmation();
  await requireDemoRepository();
  await driveWorkflow();
} else if (command === "verify") {
  await requireDemoRepository();
  await verifyRepository();
} else {
  throw new Error(`Unknown command ${command}. Use run, prepare, start, resume, verify, or help.`);
}

async function prepareRepository() {
  requireExecutable("git", ["--version"]);
  requireExecutable("pnpm", ["--version"]);
  requireExecutable("bd", ["--version"]);
  requireExecutable("copilot", ["--version"]);
  const discoveredRoot = resolve(output("git", ["rev-parse", "--show-toplevel"], repositoryRoot));
  assert(
    discoveredRoot === repositoryRoot,
    `Run this demo from the repository root: ${discoveredRoot}`,
  );
  run("git", ["check-ref-format", "--branch", branch], { cwd: repositoryRoot });
  const baseBranch = output("git", ["branch", "--show-current"], repositoryRoot);
  assert(baseBranch.length > 0, "The repository is in detached HEAD state");
  const dirty = output("git", ["status", "--porcelain"], repositoryRoot);
  assert(
    dirty.length === 0,
    "The repository must have a clean worktree before the demo creates a branch",
  );
  await assertMissing(
    metadataPath(),
    "A documentation-consistency demo is already prepared in this repository",
  );
  const branchCheck = run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: repositoryRoot,
    stdio: "pipe",
    acceptedCodes: [0, 1],
  });
  assert(branchCheck.status === 1, `Branch already exists: ${branch}`);
  const baseCommit = output("git", ["rev-parse", "HEAD"], repositoryRoot);

  run("pnpm", ["install", "--frozen-lockfile"], { cwd: repositoryRoot });
  run("pnpm", ["build"], { cwd: repositoryRoot });
  runSenawa(["doctor"]);
  runSenawa(["workflow", "validate", "standard-delivery"]);
  assertNoActiveRun();
  run("git", ["switch", "-c", branch], { cwd: repositoryRoot });
  await writeMetadata({
    branch,
    baseBranch,
    baseCommit,
    goal,
    repositoryRoot,
    createdAt: new Date().toISOString(),
  });
  print(`Prepared repository in place: ${repositoryRoot}`);
  print(`Created branch: ${branch}`);
}

async function startWorkflow() {
  runSenawa(["work", "start", goal, "--workflow", "standard-delivery"], [0, 2]);
  const status = senawaJson(["work", "show"]);
  assert(status !== null, "Started workflow did not establish active ownership");
  await writeMetadata({ ...(await readMetadata()), runId: status.runId });
}

async function driveWorkflow() {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const status = await activeStatus();
      if (status.status === "finished") {
        await verifyRepository(status);
        return;
      }
      if (status.status === "ended") {
        throw new Error(
          `The workflow ended without completion: ${status.endReason ?? "no reason"}`,
        );
      }
      if (status.needs?.action === "approve-or-reject") {
        const phaseId = status.needs.phaseId;
        print(`\nPhase ${phaseId} produced a schema-valid artifact:`);
        runSenawa(["phase", "artifact", phaseId]);
        if (autoApprove) {
          runSenawa([
            "note",
            `Integration demo auto-approval was explicitly authorized for phase ${phaseId}.`,
          ]);
          runSenawa(["approve", phaseId]);
          runSenawa(["work", "resume"], [0, 2]);
          continue;
        }
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
      if (autoApprove) {
        runSenawa(["work", "resume"], [0, 2]);
        continue;
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
    print(
      `Repository retained on branch: ${output("git", ["branch", "--show-current"], repositoryRoot)}`,
    );
    print(
      `Resume with: pnpm demo:docs -- resume --confirm-cost${autoApprove ? " --auto-approve" : ""}`,
    );
  }
}

async function verifyRepository(existingStatus) {
  const metadata = await readMetadata();
  const status = existingStatus ?? (await activeStatus());
  assert(status.backend === "beads", `Expected Beads backend, received ${status.backend}`);
  assert(status.workflow === "standard-delivery", `Unexpected workflow ${status.workflow}`);
  assert(status.status === "finished", `Workflow status is ${status.status}, not finished`);
  assert(status.needs === null, "Finished workflow still requires a human decision");
  assert(status.unsettledDispatch === null, "Finished workflow has an unsettled dispatch");
  assertCompleteProgress(status.progress.phases, "accepted");
  assertCompleteProgress(status.progress.tasks, "closed");
  assert(
    status.phases.length > 0 && status.phases.every((phase) => phase.status === "accepted"),
    "Not every workflow phase was accepted",
  );
  assert(
    status.tasks.length > 0 && status.tasks.every((task) => task.status === "closed"),
    "Not every implementation task was closed",
  );
  const currentBranch = output("git", ["branch", "--show-current"], repositoryRoot);
  assert(
    currentBranch === metadata.branch,
    `Expected branch ${metadata.branch}, found ${currentBranch}`,
  );

  const changedPaths = new Set([
    ...lines(output("git", ["diff", "--name-only", metadata.baseCommit], repositoryRoot)),
    ...lines(output("git", ["ls-files", "--others", "--exclude-standard"], repositoryRoot)),
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

  run("git", ["diff", "--check", metadata.baseCommit], { cwd: repositoryRoot });
  for (const script of [
    "docs:links",
    "lint",
    "typecheck",
    "test",
    "build",
    "check:boundaries",
    "bundle:check",
  ]) {
    run("pnpm", [script], { cwd: repositoryRoot });
  }
  runSenawa(["sensor", "audit", status.runId]);
  runSenawa(["work", "report", status.runId]);
  print(
    JSON.stringify(
      {
        ok: true,
        repository: repositoryRoot,
        baseBranch: metadata.baseBranch,
        baseCommit: metadata.baseCommit,
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

async function requireDemoRepository() {
  const metadata = await readMetadata();
  assert(
    resolve(metadata.repositoryRoot) === repositoryRoot,
    `Demo metadata belongs to another repository: ${metadata.repositoryRoot}`,
  );
  const currentBranch = output("git", ["branch", "--show-current"], repositoryRoot);
  assert(
    currentBranch === metadata.branch,
    `Expected branch ${metadata.branch}, found ${currentBranch}`,
  );
  run("pnpm", ["build"], { cwd: repositoryRoot });
  runSenawa(["doctor"]);
}

function runSenawa(arguments_, acceptedCodes = [0]) {
  return run(
    process.execPath,
    [
      join(repositoryRoot, "apps", "senawa", "dist", "senawa.mjs"),
      "--worker-host",
      "sdk",
      ...arguments_,
    ],
    { cwd: repositoryRoot, acceptedCodes },
  );
}

function senawaJson(arguments_) {
  const result = run(
    process.execPath,
    [
      join(repositoryRoot, "apps", "senawa", "dist", "senawa.mjs"),
      "--worker-host",
      "sdk",
      ...arguments_,
    ],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
  return JSON.parse(result.stdout);
}

async function activeStatus() {
  const metadata = await readMetadata();
  const status = senawaJson([
    "work",
    "show",
    ...(typeof metadata.runId === "string" ? [metadata.runId] : []),
  ]);
  assert(status !== null, "No workflow exists in the prepared demo repository");
  return status;
}

function assertNoActiveRun() {
  const result = run(
    process.execPath,
    [
      join(repositoryRoot, "apps", "senawa", "dist", "senawa.mjs"),
      "--worker-host",
      "sdk",
      "work",
      "show",
    ],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
  assert(
    JSON.parse(result.stdout) === null,
    `Repository already contains an active run: ${result.stdout.trim()}`,
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
    run(command_, arguments_, { cwd: repositoryRoot, stdio: "pipe" });
  } catch {
    throw new Error(`Required executable is unavailable: ${command_}`);
  }
}

async function writeMetadata(metadata) {
  await writeFile(metadataPath(), JSON.stringify(metadata, null, 2));
}

async function readMetadata() {
  try {
    return JSON.parse(await readFile(metadataPath(), "utf8"));
  } catch (error) {
    throw new Error(
      `Repository is not a prepared documentation-consistency demo: ${error.message}`,
    );
  }
}

function metadataPath() {
  const gitDirectory = output("git", ["rev-parse", "--absolute-git-dir"], repositoryRoot);
  return join(gitDirectory, "senawa-documentation-consistency-demo.json");
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

function assertCompleteProgress(value, state) {
  const match = new RegExp(`^(\\d+)/(\\d+) ${state}$`, "u").exec(value);
  assert(match !== null, `Unexpected ${state} progress: ${value}`);
  const complete = Number(match[1]);
  const total = Number(match[2]);
  assert(total > 0 && complete === total, `Incomplete ${state} progress: ${value}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function print(value) {
  process.stdout.write(`${value}\n`);
}

function printHelp() {
  print(`Usage:
  pnpm demo:docs -- --confirm-cost [--auto-approve] [--branch <name>]
  pnpm demo:docs -- prepare [--branch <name>]
  pnpm demo:docs -- start --confirm-cost [--auto-approve]
  pnpm demo:docs -- resume --confirm-cost [--auto-approve]
  pnpm demo:docs -- verify

Commands:
  run      Create a branch in place, run the live workflow, and verify it
  prepare  Validate the repository and create the branch without starting an SDK session
  start    Start the live workflow on the prepared branch
  resume   Continue an interrupted workflow interactively or with authorized auto-approval
  verify   Re-run all completion and repository assertions without using AI credits`);
}
