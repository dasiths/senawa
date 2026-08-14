import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { GitRevisionDescriptor } from "@senawa/kernel";
import {
  BoundedGitCommandPort,
  type GitCommandPort,
  type GitCommandRequest,
  type GitCommandResult,
} from "./git-command.js";
import { parseGitWorktreePorcelain, requireSuccessfulGit } from "./git-repository.js";

const GIT_EXECUTABLE = "/usr/bin/git";
const SENAWA_ROOT = "/workspaces/senawa";
const MUTATING_WORKTREE_OPERATIONS = new Set(["add", "remove", "move", "lock", "unlock", "prune"]);

export interface TemporaryGitRepository {
  readonly root: string;
  readonly repositoryRoot: string;
  readonly ownedRoot: string;
  readonly command: AuditedGitCommandPort;
  readonly baseRevision: GitRevisionDescriptor;
  readonly targetRef: string;
  write(relativePath: string, content: string): Promise<void>;
  remove(relativePath: string): Promise<void>;
  chmod(relativePath: string, mode: number): Promise<void>;
  git(args: readonly string[]): Promise<string>;
  cleanup(): Promise<void>;
}

export class AuditedGitCommandPort implements GitCommandPort {
  readonly operations: { readonly rootDirectory: string; readonly args: readonly string[] }[] = [];

  constructor(readonly delegate: GitCommandPort) {}

  async run(request: GitCommandRequest): Promise<GitCommandResult> {
    assertNoSenawaWorktreeMutation(request);
    this.operations.push(
      Object.freeze({
        rootDirectory: request.rootDirectory,
        args: Object.freeze([...request.args]),
      }),
    );
    return this.delegate.run(request);
  }
}

export async function createTemporaryGitRepository(
  options: { readonly objectFormat?: "sha1" | "sha256" } = {},
): Promise<TemporaryGitRepository> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "senawa-git-repository-")));
  try {
    return await initializeTemporaryGitRepository(root, options);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function initializeTemporaryGitRepository(
  root: string,
  options: { readonly objectFormat?: "sha1" | "sha256" },
): Promise<TemporaryGitRepository> {
  assertOutsideSenawa(root);
  const repositoryRoot = join(root, "repository");
  const ownedRoot = join(root, "owned-workspaces");
  const home = join(root, "isolated-home");
  await Promise.all([mkdir(ownedRoot), mkdir(home)]);
  const command = new AuditedGitCommandPort(
    new BoundedGitCommandPort({ gitExecutable: GIT_EXECUTABLE, isolatedHome: home }),
  );
  const senawaBefore = await senawaWorktrees(command);
  const run = async (rootDirectory: string, args: readonly string[]): Promise<string> => {
    const result = await command.run({ rootDirectory, args, timeoutMs: 10_000 });
    return requireSuccessfulGit(result, `Test Git ${args.join(" ")}`);
  };
  await run(root, [
    "init",
    "--initial-branch=main",
    `--object-format=${options.objectFormat ?? "sha1"}`,
    repositoryRoot,
  ]);
  await run(repositoryRoot, ["config", "user.name", "Senawa Test"]);
  await run(repositoryRoot, ["config", "user.email", "test@senawa.invalid"]);
  await Promise.all([
    writeFile(join(repositoryRoot, "edit.txt"), "base\n", "utf8"),
    writeFile(join(repositoryRoot, "delete.txt"), "delete me\n", "utf8"),
    writeFile(join(repositoryRoot, "mode.sh"), "#!/bin/sh\nexit 0\n", "utf8"),
    writeFile(join(repositoryRoot, "binary.bin"), Buffer.from([0, 1, 2, 3])),
  ]);
  await run(repositoryRoot, ["add", "--all", "--", "."]);
  await run(repositoryRoot, ["commit", "-m", "base"]);
  const objectFormat = oneLine(await run(repositoryRoot, ["rev-parse", "--show-object-format"]));
  if (objectFormat !== "sha1" && objectFormat !== "sha256") throw new Error("Unsupported test Git");
  const commit = oneLine(await run(repositoryRoot, ["rev-parse", "HEAD^{commit}"]));
  const tree = oneLine(await run(repositoryRoot, ["rev-parse", "HEAD^{tree}"]));
  const targetRef = "refs/heads/senawa/integration";
  await run(repositoryRoot, ["update-ref", targetRef, commit]);
  let cleaned = false;
  const fixture: TemporaryGitRepository = {
    root,
    repositoryRoot,
    ownedRoot,
    command,
    targetRef,
    baseRevision: Object.freeze({
      commit: Object.freeze({ objectFormat, oid: commit }),
      tree: Object.freeze({ objectFormat, oid: tree }),
    }),
    async write(relativePath, content) {
      await writeFile(join(repositoryRoot, relativePath), content, "utf8");
    },
    async remove(relativePath) {
      await rm(join(repositoryRoot, relativePath), { force: true });
    },
    async chmod(relativePath, mode) {
      await chmod(join(repositoryRoot, relativePath), mode);
    },
    git(args) {
      return run(repositoryRoot, args);
    },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        const list = await run(repositoryRoot, ["worktree", "list", "--porcelain", "-z"]);
        const records = parseGitWorktreePorcelain(list, objectFormat);
        for (const record of records) {
          if (record.path === repositoryRoot) continue;
          assertOutsideSenawa(record.path);
          if (record.locked !== undefined) {
            await run(repositoryRoot, ["worktree", "unlock", record.path]);
          }
          await run(repositoryRoot, ["worktree", "remove", "--force", record.path]);
        }
        const finalList = parseGitWorktreePorcelain(
          await run(repositoryRoot, ["worktree", "list", "--porcelain", "-z"]),
          objectFormat,
        );
        if (finalList.length !== 1 || finalList[0]?.path !== repositoryRoot) {
          throw new Error("Temporary repository retained a linked worktree");
        }
        const senawaAfter = await senawaWorktrees(command);
        if (senawaAfter !== senawaBefore)
          throw new Error("Senawa worktree state changed during test");
        if (process.env.SENAWA_GIT_TEST_AUDIT === "1") {
          console.info(`SENAWA_GIT_TEST_ROOT ${root}`);
          for (const operation of command.operations) {
            console.info(
              `SENAWA_GIT_OPERATION ${operation.rootDirectory} :: git ${operation.args.join(" ")}`,
            );
          }
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
  return fixture;
}

export const deterministicIdentity = Object.freeze({
  authorName: "Senawa Worker",
  authorEmail: "worker@senawa.invalid",
  authorDate: "2026-08-13T00:00:00Z",
  committerName: "Senawa Integration",
  committerEmail: "integration@senawa.invalid",
  committerDate: "2026-08-13T00:00:00Z",
});

async function senawaWorktrees(command: GitCommandPort): Promise<string> {
  const result = await command.run({
    rootDirectory: SENAWA_ROOT,
    args: ["worktree", "list", "--porcelain"],
    timeoutMs: 10_000,
  });
  return requireSuccessfulGit(result, "Read Senawa worktree baseline");
}

function assertNoSenawaWorktreeMutation(request: GitCommandRequest): void {
  const relativePath = relative(SENAWA_ROOT, request.rootDirectory);
  const inside =
    relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
  if (!inside) return;
  const worktreeIndex = request.args.indexOf("worktree");
  const operation = worktreeIndex < 0 ? undefined : request.args[worktreeIndex + 1];
  if (operation !== undefined && MUTATING_WORKTREE_OPERATIONS.has(operation)) {
    throw new Error(`Refused Git worktree ${operation} against ${SENAWA_ROOT}`);
  }
}

function assertOutsideSenawa(path: string): void {
  const relativePath = relative(SENAWA_ROOT, path);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    throw new Error(`Temporary Git path is inside ${SENAWA_ROOT}`);
  }
}

function oneLine(text: string): string {
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n"))
    throw new Error("Expected one line");
  return text.slice(0, -1);
}
