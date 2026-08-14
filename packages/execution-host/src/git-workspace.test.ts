import { chmod, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GitRepositoryVerificationError,
  parseGitWorktreePorcelain,
  verifyGitRepository,
} from "./git-repository.js";
import {
  createTemporaryGitRepository,
  deterministicIdentity,
  type TemporaryGitRepository,
} from "./git-test-fixture.js";
import { GitWorkspaceAdapter } from "./git-workspace.js";

const fixtures: TemporaryGitRepository[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("Git repository verification", () => {
  it("binds canonical roots, exact target commit and tree, and supported object format", async () => {
    const fixture = await temporaryRepository();
    const verified = await verify(fixture);

    expect(verified).toMatchObject({
      repositoryRoot: fixture.repositoryRoot,
      ownedRoot: fixture.ownedRoot,
      targetRef: fixture.targetRef,
      targetRevision: fixture.baseRevision,
    });
  });

  it("verifies an exact SHA-256 repository when Git supports that object format", async () => {
    const fixture = await createTemporaryGitRepository({ objectFormat: "sha256" });
    fixtures.push(fixture);

    await expect(verify(fixture)).resolves.toMatchObject({ objectFormat: "sha256" });
    expect(fixture.baseRevision.commit.oid).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects a checked-out target, external filter, and submodule declaration", async () => {
    const checkedOut = await temporaryRepository();
    await expect(
      verifyGitRepository(checkedOut.command, {
        repositoryRoot: checkedOut.repositoryRoot,
        ownedRoot: checkedOut.ownedRoot,
        targetRef: "refs/heads/main",
      }),
    ).rejects.toThrow("checked out");

    const filtered = await temporaryRepository();
    await filtered.git(["config", "filter.hostile.clean", "/bin/false"]);
    await expect(verify(filtered)).rejects.toThrow("filters");

    const submodule = await temporaryRepository();
    await writeFile(join(submodule.repositoryRoot, ".gitmodules"), '[submodule "x"]\n', "utf8");
    await submodule.git(["add", ".gitmodules"]);
    await submodule.git(["commit", "-m", "submodule declaration"]);
    const head = oneLine(await submodule.git(["rev-parse", "HEAD"]));
    await submodule.git(["update-ref", submodule.targetRef, head]);
    await expect(
      verifyGitRepository(submodule.command, {
        repositoryRoot: submodule.repositoryRoot,
        ownedRoot: submodule.ownedRoot,
        targetRef: submodule.targetRef,
      }),
    ).rejects.toThrow("Submodules");
  });

  it("parses strict NUL porcelain and rejects unstable records", () => {
    const oid = "a".repeat(40);
    expect(
      parseGitWorktreePorcelain(
        `worktree /tmp/root\0HEAD ${oid}\0detached\0locked senawa:test\0\0`,
        "sha1",
      ),
    ).toEqual([
      {
        path: "/tmp/root",
        head: oid,
        detached: true,
        bare: false,
        locked: "senawa:test",
      },
    ]);
    expect(() => parseGitWorktreePorcelain(`worktree /tmp/root\0HEAD ${oid}`, "sha1")).toThrow(
      GitRepositoryVerificationError,
    );
    expect(() =>
      parseGitWorktreePorcelain(`worktree /tmp/root\0HEAD ${oid}\0unknown value\0\0`, "sha1"),
    ).toThrow("Unknown");
  });
});

describe("GitWorkspaceAdapter", () => {
  it("prepares a stable detached locked workspace at the immutable base", async () => {
    const fixture = await temporaryRepository();
    const adapter = new GitWorkspaceAdapter(fixture.command, await verify(fixture));

    const workspace = await adapter.prepare({
      workspaceId: "workspace_task_a",
      baseRevision: fixture.baseRevision,
    });

    expect(workspace.path.startsWith(`${fixture.ownedRoot}/workspace-`)).toBe(true);
    expect(await adapter.inspect(workspace)).toEqual({ status: "exact", workspace });
    expect(
      oneLine(await fixture.git(["rev-parse", `${workspace.baseRevision.commit.oid}^{tree}`])),
    ).toBe(fixture.baseRevision.tree.oid);
    await expect(readFile(join(workspace.path, "edit.txt"), "utf8")).resolves.toBe("base\n");
  });

  it("refuses a base commit whose declared tree does not match", async () => {
    const fixture = await temporaryRepository();
    const adapter = new GitWorkspaceAdapter(fixture.command, await verify(fixture));

    await expect(
      adapter.prepare({
        workspaceId: "workspace_mismatched_base",
        baseRevision: {
          commit: fixture.baseRevision.commit,
          tree: {
            objectFormat: fixture.baseRevision.tree.objectFormat,
            oid: fixture.baseRevision.commit.oid,
          },
        },
      }),
    ).rejects.toThrow("does not match");
    expect(await fixture.git(["worktree", "list", "--porcelain"])).not.toContain(
      "workspace_mismatched_base",
    );
  });

  it("captures edits, additions, deletions, executable mode, and untracked files", async () => {
    const fixture = await temporaryRepository();
    const adapter = new GitWorkspaceAdapter(fixture.command, await verify(fixture));
    const workspace = await adapter.prepare({
      workspaceId: "workspace_capture",
      baseRevision: fixture.baseRevision,
    });
    await Promise.all([
      writeFile(join(workspace.path, "edit.txt"), "changed\n", "utf8"),
      writeFile(join(workspace.path, "untracked.txt"), "new\n", "utf8"),
      rm(join(workspace.path, "delete.txt")),
      chmod(join(workspace.path, "mode.sh"), 0o755),
    ]);

    const captured = await adapter.capture({
      workspace,
      identity: deterministicIdentity,
      message: "senawa workspace workspace_capture",
    });

    expect(captured.commit.oid).not.toBe(fixture.baseRevision.commit.oid);
    expect(oneLine(await fixture.git(["show", `${captured.commit.oid}:edit.txt`]))).toBe("changed");
    expect(oneLine(await fixture.git(["show", `${captured.commit.oid}:untracked.txt`]))).toBe(
      "new",
    );
    await expectGitFailure(fixture, ["cat-file", "-e", `${captured.commit.oid}:delete.txt`]);
    expect(await fixture.git(["ls-tree", captured.tree.oid, "mode.sh"])).toMatch(/^100755 blob /u);
  });

  it("refuses symlink substitution and removes only an exact path and HEAD", async () => {
    const fixture = await temporaryRepository();
    const adapter = new GitWorkspaceAdapter(fixture.command, await verify(fixture));
    const workspace = await adapter.prepare({
      workspaceId: "workspace_cleanup",
      baseRevision: fixture.baseRevision,
    });
    const movedPath = `${workspace.path}-moved`;
    await rename(workspace.path, movedPath);
    await symlink(fixture.repositoryRoot, workspace.path, "dir");

    await expect(adapter.cleanup(workspace)).rejects.toThrow();
    await rm(workspace.path);
    await rename(movedPath, workspace.path);

    const changed = await adapter.capture({
      workspace,
      identity: deterministicIdentity,
      message: "changed cleanup head",
    });
    await fixture.command.run({
      rootDirectory: workspace.path,
      args: ["update-ref", "HEAD", changed.commit.oid, fixture.baseRevision.commit.oid],
      timeoutMs: 10_000,
    });
    await expect(adapter.cleanup(workspace)).rejects.toThrow("mismatched");
    await fixture.command.run({
      rootDirectory: workspace.path,
      args: ["update-ref", "HEAD", fixture.baseRevision.commit.oid, changed.commit.oid],
      timeoutMs: 10_000,
    });

    expect(await adapter.cleanup(workspace)).toBe("removed");
    expect(await adapter.cleanup(workspace)).toBe("absent");
  });

  it("does not create a worktree when cancelled before command execution", async () => {
    const fixture = await temporaryRepository();
    const adapter = new GitWorkspaceAdapter(fixture.command, await verify(fixture));
    const controller = new AbortController();
    controller.abort();

    await expect(
      adapter.prepare({
        workspaceId: "workspace_cancelled",
        baseRevision: fixture.baseRevision,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(await fixture.git(["worktree", "list", "--porcelain"])).not.toContain(
      "workspace_cancelled",
    );
  });
});

async function temporaryRepository(): Promise<TemporaryGitRepository> {
  const fixture = await createTemporaryGitRepository();
  fixtures.push(fixture);
  return fixture;
}

function verify(fixture: TemporaryGitRepository) {
  return verifyGitRepository(fixture.command, {
    repositoryRoot: fixture.repositoryRoot,
    ownedRoot: fixture.ownedRoot,
    targetRef: fixture.targetRef,
    expectedRevision: fixture.baseRevision,
  });
}

async function expectGitFailure(
  fixture: TemporaryGitRepository,
  args: readonly string[],
): Promise<void> {
  await expect(fixture.git(args)).rejects.toThrow();
}

function oneLine(text: string): string {
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n"))
    throw new Error("Expected one line");
  return text.slice(0, -1);
}
