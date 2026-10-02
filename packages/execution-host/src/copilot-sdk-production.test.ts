import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProductionCopilotSdkPort } from "./copilot-sdk-production.js";

describe("ProductionCopilotSdkPort", () => {
  it("constructs the exact SDK wrapper without starting a client", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-copilot-sdk-"));
    const repositoryDirectory = join(root, "repository");
    const workingDirectory = join(root, "isolated", "work");
    const baseDirectory = join(root, "isolated", "home");
    await Promise.all([
      mkdir(repositoryDirectory, { recursive: true }),
      mkdir(workingDirectory, { recursive: true }),
      mkdir(baseDirectory, { recursive: true }),
    ]);

    const port = await ProductionCopilotSdkPort.create({
      repositoryDirectory,
      workingDirectory,
      baseDirectory,
    });

    expect(port).toMatchObject({
      baseDirectory,
      workingDirectory,
      clientOwnership: "port-created",
    });
  });

  it("rejects Copilot state or working directories inside the repository", async () => {
    const repositoryDirectory = await mkdtemp(join(tmpdir(), "senawa-copilot-repository-"));
    const outside = await mkdtemp(join(tmpdir(), "senawa-copilot-outside-"));
    const inside = join(repositoryDirectory, "copilot");
    await mkdir(inside);

    await expect(
      ProductionCopilotSdkPort.create({
        repositoryDirectory,
        workingDirectory: inside,
        baseDirectory: outside,
      }),
    ).rejects.toThrow("working directory must be outside");
    await expect(
      ProductionCopilotSdkPort.create({
        repositoryDirectory,
        workingDirectory: outside,
        baseDirectory: inside,
      }),
    ).rejects.toThrow("base directory must be outside");
  });

  it("rejects Copilot state or working directories that contain the repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-copilot-ancestor-"));
    const repositoryDirectory = join(root, "repository");
    const outside = await mkdtemp(join(tmpdir(), "senawa-copilot-outside-"));
    await mkdir(repositoryDirectory);

    await expect(
      ProductionCopilotSdkPort.create({
        repositoryDirectory,
        workingDirectory: root,
        baseDirectory: outside,
      }),
    ).rejects.toThrow("working directory must be outside");
    await expect(
      ProductionCopilotSdkPort.create({
        repositoryDirectory,
        workingDirectory: outside,
        baseDirectory: root,
      }),
    ).rejects.toThrow("base directory must be outside");
  });
});
