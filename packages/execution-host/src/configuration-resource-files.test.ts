import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RootScopedConfigurationResources } from "./configuration-resource-files.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("RootScopedConfigurationResources", () => {
  it("reads exact bytes below the configuration root", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, ".senawa", "prompts"), { recursive: true });
    await writeFile(join(root, ".senawa", "prompts", "worker.md"), "exact\n");
    const reader = await RootScopedConfigurationResources.create(root);

    const bytes = await reader.read({ kind: "prompt", path: "prompts/worker.md", maxBytes: 32 });
    expect(new TextDecoder().decode(bytes)).toBe("exact\n");
  });

  it("refuses final, parent, and configuration-root symlinks", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await mkdir(join(root, ".senawa", "prompts"), { recursive: true });
    await writeFile(join(outside, "secret.md"), "secret\n");
    await symlink(join(outside, "secret.md"), join(root, ".senawa", "prompts", "file.md"));
    await symlink(outside, join(root, ".senawa", "prompts", "parent"), "dir");
    const reader = await RootScopedConfigurationResources.create(root);

    await expect(
      reader.read({ kind: "prompt", path: "prompts/file.md", maxBytes: 32 }),
    ).rejects.toMatchObject({ code: "symlink" });
    await expect(
      reader.read({ kind: "prompt", path: "prompts/parent/file.md", maxBytes: 32 }),
    ).rejects.toMatchObject({ code: "symlink" });

    const rootSwap = await temporaryRoot();
    await symlink(outside, join(rootSwap, ".senawa"), "dir");
    await expect(RootScopedConfigurationResources.create(rootSwap)).rejects.toMatchObject({
      code: "symlink",
    });

    const projectAlias = join(await temporaryRoot(), "project-link");
    await symlink(root, projectAlias, "dir");
    await expect(RootScopedConfigurationResources.create(projectAlias)).rejects.toMatchObject({
      code: "symlink",
    });
  });

  it("refuses hardlinks, non-files, and oversized files", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, ".senawa", "prompts"), { recursive: true });
    const original = join(root, ".senawa", "prompts", "original.md");
    await writeFile(original, "linked\n");
    await link(original, join(root, ".senawa", "prompts", "linked.md"));
    await mkdir(join(root, ".senawa", "prompts", "directory.md"));
    await writeFile(join(root, ".senawa", "prompts", "large.md"), "x".repeat(33));
    const reader = await RootScopedConfigurationResources.create(root);

    await expect(
      reader.read({ kind: "prompt", path: "prompts/linked.md", maxBytes: 32 }),
    ).rejects.toMatchObject({ code: "hardlink" });
    await expect(
      reader.read({ kind: "prompt", path: "prompts/directory.md", maxBytes: 32 }),
    ).rejects.toMatchObject({ code: "not-regular-file" });
    await expect(
      reader.read({ kind: "prompt", path: "prompts/large.md", maxBytes: 32 }),
    ).rejects.toMatchObject({ code: "too-large" });
  });

  it("rejects replacement after descriptor read and never returns replacement bytes", async () => {
    const root = await temporaryRoot();
    const prompt = join(root, ".senawa", "prompts", "worker.md");
    await mkdir(join(root, ".senawa", "prompts"), { recursive: true });
    await writeFile(prompt, "original\n");
    const reader = await RootScopedConfigurationResources.create(root, ".senawa", {
      testHooks: {
        beforeIdentityCheck: async () => {
          await rename(prompt, `${prompt}.old`);
          await writeFile(prompt, "replacement\n");
        },
      },
    });

    await expect(
      reader.read({ kind: "prompt", path: "prompts/worker.md", maxBytes: 32 }),
    ).rejects.toMatchObject({ code: "changed-during-read" });
    await expect(readFile(prompt, "utf8")).resolves.toBe("replacement\n");
  });

  it("rejects growth after read before identity acceptance", async () => {
    const root = await temporaryRoot();
    const prompt = join(root, ".senawa", "prompts", "worker.md");
    await mkdir(join(root, ".senawa", "prompts"), { recursive: true });
    await writeFile(prompt, "original\n");
    const reader = await RootScopedConfigurationResources.create(root, ".senawa", {
      testHooks: { beforeIdentityCheck: async () => writeFile(prompt, "original\ngrowth\n") },
    });

    await expect(
      reader.read({ kind: "prompt", path: "prompts/worker.md", maxBytes: 32 }),
    ).rejects.toMatchObject({ code: "changed-during-read" });
  });

  it("rejects a parent swap to an outside symlink after descriptor read", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const prompts = join(root, ".senawa", "prompts");
    await mkdir(prompts, { recursive: true });
    await writeFile(join(prompts, "worker.md"), "original\n");
    await writeFile(join(outside, "worker.md"), "outside\n");
    const reader = await RootScopedConfigurationResources.create(root, ".senawa", {
      testHooks: {
        beforeIdentityCheck: async () => {
          await rename(prompts, `${prompts}.old`);
          await symlink(outside, prompts, "dir");
        },
      },
    });

    await expect(
      reader.read({ kind: "prompt", path: "prompts/worker.md", maxBytes: 32 }),
    ).rejects.toMatchObject({ code: "changed-during-read" });
    await expect(readFile(join(outside, "worker.md"), "utf8")).resolves.toBe("outside\n");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "senawa-configuration-resources-"));
  roots.push(root);
  return root;
}
