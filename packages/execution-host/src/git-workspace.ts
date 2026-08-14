import { createHash } from "node:crypto";
import type { GitRevisionDescriptor } from "@senawa/kernel";
import type { GitCommandEnvironment, GitCommandPort } from "./git-command.js";
import {
  exactContainedPath,
  type GitWorktreeRecord,
  parseGitWorktreePorcelain,
  requireAbsentPath,
  requireCanonicalContainedPath,
  requireSuccessfulGit,
  type VerifiedGitRepository,
} from "./git-repository.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface PrepareGitWorkspaceInput {
  readonly workspaceId: string;
  readonly baseRevision: GitRevisionDescriptor;
  readonly signal?: AbortSignal;
}

export interface PreparedGitWorkspace {
  readonly workspaceId: string;
  readonly path: string;
  readonly baseRevision: GitRevisionDescriptor;
  readonly lockReason: string;
}

export type GitWorkspaceInspection =
  | { readonly status: "absent"; readonly workspaceId: string; readonly path: string }
  | { readonly status: "exact"; readonly workspace: PreparedGitWorkspace }
  | {
      readonly status: "mismatch";
      readonly workspaceId: string;
      readonly path: string;
      readonly record: GitWorktreeRecord;
    };

export interface CaptureGitWorkspaceInput {
  readonly workspace: PreparedGitWorkspace;
  readonly identity: GitCommandEnvironment;
  readonly message: string;
  readonly signal?: AbortSignal;
}

export class GitWorkspaceAdapter {
  constructor(
    readonly command: GitCommandPort,
    readonly repository: VerifiedGitRepository,
  ) {}

  describe(input: PrepareGitWorkspaceInput): PreparedGitWorkspace {
    validateWorkspaceId(input.workspaceId);
    requireRevision(input.baseRevision, this.repository);
    return freezeWorkspace({
      workspaceId: input.workspaceId,
      path: this.workspacePath(input.workspaceId),
      baseRevision: input.baseRevision,
      lockReason: `senawa:${input.workspaceId}`,
    });
  }

  async prepare(input: PrepareGitWorkspaceInput): Promise<PreparedGitWorkspace> {
    validateWorkspaceId(input.workspaceId);
    requireRevision(input.baseRevision, this.repository);
    const resolvedTree = await this.command.run({
      rootDirectory: this.repository.repositoryRoot,
      args: ["rev-parse", "--verify", `${input.baseRevision.commit.oid}^{tree}`],
      timeoutMs: DEFAULT_TIMEOUT_MS,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (
      oneLine(
        requireSuccessfulGit(resolvedTree, "Verify workspace base"),
        "workspace base tree",
      ) !== input.baseRevision.tree.oid
    ) {
      throw new GitWorkspaceError("Workspace base commit does not match its exact tree");
    }
    const workspace = this.describe(input);
    const path = workspace.path;
    await requireAbsentPath(path);
    const result = await this.command.run({
      rootDirectory: this.repository.repositoryRoot,
      args: [
        "worktree",
        "add",
        "--detach",
        "--lock",
        "--reason",
        workspace.lockReason,
        path,
        input.baseRevision.commit.oid,
      ],
      timeoutMs: DEFAULT_TIMEOUT_MS,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    requireSuccessfulGit(result, "Prepare Git workspace");
    await requireCanonicalContainedPath(this.repository.ownedRoot, path);
    const inspection = await this.inspect(workspace);
    if (inspection.status !== "exact") {
      throw new GitWorkspaceError(
        "Prepared workspace did not match its exact detached locked state",
      );
    }
    return workspace;
  }

  async inspect(workspace: PreparedGitWorkspace): Promise<GitWorkspaceInspection> {
    this.requireOwnedWorkspace(workspace);
    const records = await this.worktrees();
    const record = records.find(({ path }) => path === workspace.path);
    if (record === undefined) {
      return Object.freeze({
        status: "absent",
        workspaceId: workspace.workspaceId,
        path: workspace.path,
      });
    }
    const exact =
      record.head === workspace.baseRevision.commit.oid &&
      record.detached &&
      !record.bare &&
      record.branch === undefined &&
      record.locked === workspace.lockReason;
    if (!exact) {
      return Object.freeze({
        status: "mismatch",
        workspaceId: workspace.workspaceId,
        path: workspace.path,
        record,
      });
    }
    await requireCanonicalContainedPath(this.repository.ownedRoot, workspace.path);
    return Object.freeze({ status: "exact", workspace });
  }

  async capture(input: CaptureGitWorkspaceInput): Promise<GitRevisionDescriptor> {
    const inspection = await this.inspect(input.workspace);
    if (inspection.status !== "exact") {
      throw new GitWorkspaceError("Capture requires the exact owned detached workspace");
    }
    if (input.message.length === 0 || input.message.includes("\0")) {
      throw new GitWorkspaceError("Capture commit message must be non-empty and NUL-free");
    }
    const workspaceRun = async (args: readonly string[]) => {
      const result = await this.command.run({
        rootDirectory: input.workspace.path,
        args,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      return requireSuccessfulGit(result, "Capture Git workspace");
    };
    await workspaceRun(["add", "--all", "--", "."]);
    const tree = oneLine(await workspaceRun(["write-tree"]), "captured tree");
    const commitResult = await this.command.run({
      rootDirectory: this.repository.repositoryRoot,
      args: [
        "commit-tree",
        tree,
        "-p",
        input.workspace.baseRevision.commit.oid,
        "-m",
        input.message,
      ],
      timeoutMs: DEFAULT_TIMEOUT_MS,
      identity: input.identity,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const commit = oneLine(
      requireSuccessfulGit(commitResult, "Create captured Git commit"),
      "captured commit",
    );
    return freezeRevision(this.repository.objectFormat, commit, tree);
  }

  async cleanup(workspace: PreparedGitWorkspace): Promise<"removed" | "absent"> {
    const inspection = await this.inspect(workspace);
    if (inspection.status === "absent") return "absent";
    if (inspection.status !== "exact") {
      throw new GitWorkspaceError(
        "Cleanup refused a workspace with mismatched path, lock, or HEAD",
      );
    }
    const unlock = await this.command.run({
      rootDirectory: this.repository.repositoryRoot,
      args: ["worktree", "unlock", workspace.path],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    requireSuccessfulGit(unlock, "Unlock exact Git workspace");
    const remove = await this.command.run({
      rootDirectory: this.repository.repositoryRoot,
      args: ["worktree", "remove", "--force", workspace.path],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    requireSuccessfulGit(remove, "Remove exact Git workspace");
    if ((await this.inspect(workspace)).status !== "absent") {
      throw new GitWorkspaceError("Removed workspace remains registered");
    }
    return "removed";
  }

  private workspacePath(workspaceId: string): string {
    const digest = createHash("sha256").update(workspaceId).digest("hex");
    const path = `${this.repository.ownedRoot}/workspace-${digest}`;
    exactContainedPath(this.repository.ownedRoot, path);
    return path;
  }

  private requireOwnedWorkspace(workspace: PreparedGitWorkspace): void {
    validateWorkspaceId(workspace.workspaceId);
    requireRevision(workspace.baseRevision, this.repository);
    if (workspace.path !== this.workspacePath(workspace.workspaceId)) {
      throw new GitWorkspaceError("Workspace path does not match its stable identity");
    }
    if (workspace.lockReason !== `senawa:${workspace.workspaceId}`) {
      throw new GitWorkspaceError("Workspace lock reason does not match its stable identity");
    }
  }

  private async worktrees(): Promise<readonly GitWorktreeRecord[]> {
    const result = await this.command.run({
      rootDirectory: this.repository.repositoryRoot,
      args: ["worktree", "list", "--porcelain", "-z"],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    return parseGitWorktreePorcelain(
      requireSuccessfulGit(result, "Inspect Git worktrees"),
      this.repository.objectFormat,
    );
  }
}

export class GitWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitWorkspaceError";
  }
}

function validateWorkspaceId(workspaceId: string): void {
  if (workspaceId.length === 0 || workspaceId.length > 512 || workspaceId.includes("\0")) {
    throw new GitWorkspaceError("Workspace ID must be a bounded non-empty NUL-free string");
  }
}

function requireRevision(revision: GitRevisionDescriptor, repository: VerifiedGitRepository): void {
  const length = repository.objectFormat === "sha1" ? 40 : 64;
  for (const object of [revision.commit, revision.tree]) {
    if (
      object.objectFormat !== repository.objectFormat ||
      !new RegExp(`^[0-9a-f]{${length}}$`, "u").test(object.oid)
    ) {
      throw new GitWorkspaceError(
        "Workspace revision does not match the verified repository format",
      );
    }
  }
}

function oneLine(text: string, label: string): string {
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
    throw new GitWorkspaceError(`Git ${label} output is not one line`);
  }
  return text.slice(0, -1);
}

function freezeRevision(
  objectFormat: VerifiedGitRepository["objectFormat"],
  commit: string,
  tree: string,
): GitRevisionDescriptor {
  return Object.freeze({
    commit: Object.freeze({ objectFormat, oid: commit }),
    tree: Object.freeze({ objectFormat, oid: tree }),
  });
}

function freezeWorkspace(input: PreparedGitWorkspace): PreparedGitWorkspace {
  return Object.freeze({ ...input });
}
