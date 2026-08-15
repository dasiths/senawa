import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStandardTemplateFiles } from "@senawa/configuration";
import { describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { createNodeCliDependencies } from "./node-cli.js";

describe("atomic standard workflow init", () => {
  it("publishes one complete doctor-valid tree with exact template bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-atomic-init-"));
    const dependencies = createNodeCliDependencies();

    expect(await runCli(["init", root], dependencies)).toEqual({
      output: `${root}/.senawa: created`,
      exitCode: 0,
    });
    expect(await runCli(["doctor", root], dependencies)).toEqual({
      output: `${root}/.senawa/workflow.json: valid`,
      exitCode: 0,
    });
    for (const [path, content] of Object.entries(createStandardTemplateFiles())) {
      expect(await readFile(join(root, path), "utf8")).toBe(content);
    }
    expect((await readdir(root)).filter((name) => name.startsWith(".senawa.init-"))).toEqual([]);
  });

  it("allows one concurrent publisher and never mutates an existing tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-atomic-race-"));
    const dependencies = createNodeCliDependencies();
    const results = await Promise.all([
      runCli(["init", root], dependencies),
      runCli(["init", root], dependencies),
    ]);
    expect(results.filter(({ exitCode }) => exitCode === 0)).toHaveLength(1);
    expect(results.filter(({ exitCode }) => exitCode === 1)).toHaveLength(1);

    const workflowPath = join(root, ".senawa", "workflow.json");
    await writeFile(workflowPath, "owned replacement", "utf8");
    expect(await runCli(["init", root], dependencies)).toEqual({
      output: `${root}/.senawa: already exists`,
      exitCode: 1,
    });
    expect(await readFile(workflowPath, "utf8")).toBe("owned replacement");
  });
});
