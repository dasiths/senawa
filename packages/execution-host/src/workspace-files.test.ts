import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RootScopedWorkspaceFiles, WORKSPACE_FILE_LIMITS } from "./workspace-files.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("RootScopedWorkspaceFiles", () => {
  it("lists, reads, atomically writes, and compare-applies dispatch-root files", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.txt"), "before\n", "utf8");
    const files = await RootScopedWorkspaceFiles.create(root);

    expect(await files.list("src")).toEqual([{ path: "src/a.txt", type: "file", size: 7 }]);
    await expect(files.read("src/a.txt")).resolves.toBe("before\n");
    await files.write("src/a.txt", "written\n");
    await files.applyPatch([
      { path: "src/a.txt", expectedText: "written\n", replacementText: "patched\n" },
    ]);

    await expect(readFile(join(root, "src", "a.txt"), "utf8")).resolves.toBe("patched\n");
    expect((await files.list("src")).map(({ path }) => path)).toEqual(["src/a.txt"]);
  });

  it.each(["../outside", "/tmp/outside", "src/../../outside"])(
    "rejects hostile path %s",
    async (path) => {
      const root = await temporaryRoot();
      const files = await RootScopedWorkspaceFiles.create(root);

      await expect(files.read(path)).rejects.toThrow("relative");
      await expect(files.write(path, "hostile")).rejects.toThrow("relative");
    },
  );

  it("refuses file and parent symlinks without following them", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeFile(join(outside, "secret.txt"), "secret\n", "utf8");
    await symlink(join(outside, "secret.txt"), join(root, "file-link"));
    await symlink(outside, join(root, "directory-link"), "dir");
    const files = await RootScopedWorkspaceFiles.create(root);

    await expect(files.read("file-link")).rejects.toThrow("symbolic");
    await expect(files.write("file-link", "changed")).rejects.toThrow("symbolic");
    await expect(files.write("directory-link/new.txt", "changed")).rejects.toThrow();
    await expect(readFile(join(outside, "secret.txt"), "utf8")).resolves.toBe("secret\n");
  });

  // Nothing makes a directory, so a nested path could not be written at all: a
  // live agent asked for `scripts/check.mjs`, was told the parent could not be
  // opened, and stopped to ask a person what to do.
  it("makes the directories a nested write names, and still cannot leave the root", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlink(outside, join(root, "directory-link"), "dir");
    const files = await RootScopedWorkspaceFiles.create(root);

    await files.write("scripts/deep/check.mjs", "export const ok = true;\n");

    await expect(files.read("scripts/deep/check.mjs")).resolves.toContain("ok");
    await expect(readFile(join(root, "scripts", "deep", "check.mjs"), "utf8")).resolves.toContain(
      "ok",
    );
    // Making directories must obey the same rules as opening them.
    await expect(files.write("../escaped/file.txt", "no")).rejects.toThrow();
    await expect(files.write("directory-link/made/file.txt", "no")).rejects.toThrow();
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("rejects oversized reads and writes and leaves compare-mismatched files unchanged", async () => {
    const root = await temporaryRoot();
    const files = await RootScopedWorkspaceFiles.create(root);
    await writeFile(join(root, "large.txt"), "x".repeat(33), "utf8");
    await writeFile(join(root, "stable.txt"), "stable\n", "utf8");
    await writeFile(join(root, "second.txt"), "second\n", "utf8");

    await expect(files.read("large.txt", 32)).rejects.toThrow("bound");
    await expect(
      files.write("oversized.txt", "x".repeat(WORKSPACE_FILE_LIMITS.maxFileBytes + 1)),
    ).rejects.toThrow("bound");
    await expect(
      files.applyPatch([
        { path: "stable.txt", expectedText: "stale\n", replacementText: "changed\n" },
      ]),
    ).rejects.toThrow("does not match");
    await expect(
      files.applyPatch([
        { path: "stable.txt", expectedText: "stable\n", replacementText: "changed\n" },
        { path: "second.txt", expectedText: "second\n", replacementText: "changed\n" },
      ]),
    ).rejects.toThrow("count");
    await expect(readFile(join(root, "stable.txt"), "utf8")).resolves.toBe("stable\n");
    await expect(readFile(join(root, "second.txt"), "utf8")).resolves.toBe("second\n");
  });

  it("rejects a target symlink swap after descriptor validation", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeFile(join(root, "target.txt"), "expected\n", "utf8");
    await writeFile(join(outside, "outside.txt"), "outside\n", "utf8");
    const files = await RootScopedWorkspaceFiles.create(root, {
      testHooks: {
        beforeCommit: async () => {
          await rename(join(root, "target.txt"), join(root, "original.txt"));
          await symlink(join(outside, "outside.txt"), join(root, "target.txt"));
        },
      },
    });

    await expect(
      files.applyPatch([
        {
          path: "target.txt",
          expectedText: "expected\n",
          replacementText: "replacement\n",
        },
      ]),
    ).rejects.toThrow("changed before commit");
    await expect(readFile(join(root, "original.txt"), "utf8")).resolves.toBe("expected\n");
    await expect(readFile(join(outside, "outside.txt"), "utf8")).resolves.toBe("outside\n");
  });

  it("confines a parent directory swap during mutation to the opened directory", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await mkdir(join(root, "parent"));
    await writeFile(join(root, "parent", "target.txt"), "expected\n", "utf8");
    await writeFile(join(outside, "target.txt"), "outside\n", "utf8");
    const files = await RootScopedWorkspaceFiles.create(root, {
      testHooks: {
        beforeCommit: async () => {
          await rename(join(root, "parent"), join(root, "opened-parent"));
          await symlink(outside, join(root, "parent"), "dir");
        },
      },
    });

    const result = await files
      .applyPatch([
        {
          path: "parent/target.txt",
          expectedText: "expected\n",
          replacementText: "replacement\n",
        },
      ])
      .then(
        () => "fulfilled" as const,
        () => "rejected" as const,
      );

    await expect(readFile(join(outside, "target.txt"), "utf8")).resolves.toBe("outside\n");
    await expect(readFile(join(root, "opened-parent", "target.txt"), "utf8")).resolves.toBe(
      result === "fulfilled" ? "replacement\n" : "expected\n",
    );
  });

  it("serializes concurrent expected-text patches across instances", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "target.txt"), "expected\n", "utf8");
    const first = await RootScopedWorkspaceFiles.create(root);
    const second = await RootScopedWorkspaceFiles.create(root);

    const results = await Promise.allSettled([
      first.applyPatch([
        { path: "target.txt", expectedText: "expected\n", replacementText: "first\n" },
      ]),
      second.applyPatch([
        { path: "target.txt", expectedText: "expected\n", replacementText: "second\n" },
      ]),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
    await expect(readFile(join(root, "target.txt"), "utf8")).resolves.toMatch(
      /^(first|second)\n$/u,
    );
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "senawa-workspace-files-"));
  roots.push(root);
  return root;
}
