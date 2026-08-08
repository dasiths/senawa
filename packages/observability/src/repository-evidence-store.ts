import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { RepositoryEvidencePort } from "@senawa/application";
import type {
  RepositoryBaselineEvidence,
  RepositoryDeltaEvidence,
  RepositoryStateEntry,
} from "@senawa/domain";
import { matchesPathPattern as pathMatches } from "@senawa/domain";

interface RepositorySnapshot {
  readonly head: string | null;
  readonly entries: readonly RepositoryStateEntry[];
}

export class GitRepositoryEvidenceStore implements RepositoryEvidencePort {
  private readonly root: string;
  private readonly trackingDirectory: string;

  constructor(repositoryRoot: string) {
    this.root = resolve(repositoryRoot);
    this.trackingDirectory = resolve(repositoryRoot, ".agents", ".copilot-tracking");
  }

  async captureBaseline(
    input: Parameters<RepositoryEvidencePort["captureBaseline"]>[0],
  ): Promise<RepositoryBaselineEvidence> {
    const snapshot = await this.snapshot();
    const payload = {
      version: 1 as const,
      kind: "repository-baseline" as const,
      runId: input.runId,
      taskId: input.taskId,
      attempt: input.attempt,
      dispatchId: input.dispatchId,
      turnId: input.turnId,
      expectation: input.expectation,
      authorizedPaths: [...input.authorizedPaths].toSorted(),
      frozenPaths: [...input.frozenPaths].toSorted(),
      head: snapshot.head,
      entries: snapshot.entries,
      capturedAt: input.capturedAt,
      uncertainty: input.recovered ? ["baseline-captured-during-recovery"] : [],
    };
    const digest = evidenceDigest(payload);
    const evidencePath = this.evidencePath(input, `baseline-${digest.slice(0, 16)}.json`);
    const evidence = { ...payload, digest, evidencePath } satisfies RepositoryBaselineEvidence;
    await this.writeEvidence(input.runId, evidencePath, evidence);
    return evidence;
  }

  async captureDelta(
    input: Parameters<RepositoryEvidencePort["captureDelta"]>[0],
  ): Promise<RepositoryDeltaEvidence> {
    const after = await this.snapshot();
    const changedPaths = await this.changedPaths(input.baseline, after);
    const frozenChanges = changedPaths
      .map((entry) => entry.path)
      .filter((path) => input.baseline.frozenPaths.some((pattern) => pathMatches(path, pattern)));
    const inScopeChanges = changedPaths
      .map((entry) => entry.path)
      .filter(
        (path) =>
          !frozenChanges.includes(path) &&
          input.baseline.authorizedPaths.some((pattern) => pathMatches(path, pattern)),
      );
    const outOfScopeChanges = changedPaths
      .map((entry) => entry.path)
      .filter((path) => !frozenChanges.includes(path) && !inScopeChanges.includes(path));
    const measuredChanged = changedPaths.length > 0;
    const workerClaim = {
      reported: input.workerClaim.reported,
      changed: input.workerClaim.changed,
      ...(input.workerClaim.patch === undefined
        ? {}
        : { patchDigest: createHash("sha256").update(input.workerClaim.patch).digest("hex") }),
      agreement: !input.workerClaim.reported
        ? ("unreported" as const)
        : input.workerClaim.changed === measuredChanged
          ? ("agree" as const)
          : ("disagree" as const),
    };
    const payload = {
      version: 1 as const,
      kind: "repository-delta" as const,
      runId: input.baseline.runId,
      taskId: input.baseline.taskId,
      attempt: input.baseline.attempt,
      dispatchId: input.baseline.dispatchId,
      turnId: input.baseline.turnId,
      expectation: input.baseline.expectation,
      baselineDigest: input.baseline.digest,
      headBefore: input.baseline.head,
      headAfter: after.head,
      preExistingChanges: input.baseline.entries.map((entry) => entry.path),
      changedPaths,
      inScopeChanges,
      outOfScopeChanges,
      frozenChanges,
      uncertainty: input.recovered ? ["delta-captured-during-recovery"] : [],
      workerClaim,
      capturedAt: input.capturedAt,
    };
    const digest = evidenceDigest(payload);
    const evidencePath = this.evidencePath(input.baseline, `delta-${digest.slice(0, 16)}.json`);
    const evidence = { ...payload, digest, evidencePath } satisfies RepositoryDeltaEvidence;
    await this.writeEvidence(input.baseline.runId, evidencePath, evidence);
    return evidence;
  }

  private async snapshot(): Promise<RepositorySnapshot> {
    const headResult = await runGit(this.root, ["rev-parse", "--verify", "HEAD"], true);
    const head = headResult.exitCode === 0 ? headResult.stdout.toString("utf8").trim() : null;
    const status = await runGit(this.root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    const records = parseStatus(status.stdout).filter((entry) => !isRuntimeInternal(entry.path));
    const entries = await Promise.all(
      records.map(async ({ path, status }) => ({
        path,
        status,
        digest: await pathDigest(this.root, path, status),
      })),
    );
    return {
      head,
      entries: entries.toSorted((left, right) => left.path.localeCompare(right.path)),
    };
  }

  private async changedPaths(
    baseline: RepositoryBaselineEvidence,
    after: RepositorySnapshot,
  ): Promise<readonly RepositoryStateEntry[]> {
    const beforeEntries = new Map(baseline.entries.map((entry) => [entry.path, entry]));
    const afterEntries = new Map(after.entries.map((entry) => [entry.path, entry]));
    const paths = new Set([...beforeEntries.keys(), ...afterEntries.keys()]);
    if (baseline.head !== null && after.head !== null && baseline.head !== after.head) {
      const committed = await runGit(this.root, [
        "diff",
        "--name-only",
        "-z",
        baseline.head,
        after.head,
      ]);
      for (const path of splitNull(committed.stdout)) {
        if (!isRuntimeInternal(path)) paths.add(path);
      }
    }
    const changed: RepositoryStateEntry[] = [];
    for (const path of paths) {
      const before = beforeEntries.get(path);
      const afterEntry = afterEntries.get(path);
      if (before?.status === afterEntry?.status && before?.digest === afterEntry?.digest) continue;
      changed.push(
        afterEntry ?? {
          path,
          status: "clean",
          digest: await pathDigest(this.root, path, "clean"),
        },
      );
    }
    return changed.toSorted((left, right) => left.path.localeCompare(right.path));
  }

  private evidencePath(
    input: { readonly taskId: string; readonly attempt: number; readonly dispatchId: string },
    fileName: string,
  ): string {
    return join(
      "evidence",
      "repository",
      "tasks",
      input.taskId,
      `attempt-${input.attempt}`,
      input.dispatchId,
      fileName,
    );
  }

  private async writeEvidence(runId: string, relativePath: string, value: unknown): Promise<void> {
    const path = join(this.trackingDirectory, runId, relativePath);
    const content = `${JSON.stringify(value, null, 2)}\n`;
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      if ((await readFile(path, "utf8")) !== content) {
        throw new Error(`Repository evidence conflict at ${relativePath}`);
      }
    }
  }
}

function parseStatus(output: Buffer): Array<{ readonly path: string; readonly status: string }> {
  const values = splitNull(output);
  const entries: Array<{ path: string; status: string }> = [];
  for (let index = 0; index < values.length; index += 1) {
    const record = values[index] as string;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    entries.push({ path, status });
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return entries;
}

function splitNull(value: Buffer): string[] {
  return value
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry !== "");
}

async function pathDigest(root: string, relativePath: string, status: string): Promise<string> {
  const path = join(root, relativePath);
  const hash = createHash("sha256").update(status).update("\0");
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) return hash.update(await readlink(path)).digest("hex");
    if (metadata.isFile()) return hash.update(await readFile(path)).digest("hex");
    return hash.update(`mode:${metadata.mode}:size:${metadata.size}`).digest("hex");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return hash.update("missing").digest("hex");
    throw error;
  }
}

function isRuntimeInternal(path: string): boolean {
  return (
    path === ".agents/.copilot-tracking" ||
    path.startsWith(".agents/.copilot-tracking/") ||
    path === ".beads" ||
    path.startsWith(".beads/")
  );
}

function evidenceDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function runGit(
  cwd: string,
  arguments_: readonly string[],
  allowFailure = false,
): Promise<{ readonly exitCode: number; readonly stdout: Buffer; readonly stderr: Buffer }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("git", arguments_, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", rejectRun);
    child.once("close", (exitCode) => {
      const result = {
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };
      if (result.exitCode !== 0 && !allowFailure) {
        rejectRun(
          new Error(`git ${arguments_.join(" ")} failed: ${result.stderr.toString("utf8").trim()}`),
        );
        return;
      }
      resolveRun(result);
    });
  });
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && Reflect.get(error, "code") === code;
}
