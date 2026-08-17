import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  compileWorkflowConfiguration,
  createStandardTemplateFiles,
  doctorWorkflowConfiguration,
} from "@senawa/configuration";
import { RootScopedConfigurationResources } from "@senawa/execution-host";
import { deterministicSha256 } from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

// The lowered internal document is generated, so the generator is the oracle.
// A tracked copy would only be a second thing to keep in step, and `.senawa/`
// now holds the authored tree a consumer actually writes.
async function generatedTemplateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "senawa-standard-template-"));
  roots.add(root);
  for (const [path, content] of Object.entries(createStandardTemplateFiles())) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
  return join(root, ".senawa");
}

describe("generated standard-delivery template", () => {
  it("doctors and compiles the complete v1alpha3 resource tree", async () => {
    const templateRoot = await generatedTemplateRoot();
    const document = JSON.parse(await readFile(resolve(templateRoot, "workflow.json"), "utf8"));
    const resources = await RootScopedConfigurationResources.create(templateRoot, ".");

    const diagnosis = await doctorWorkflowConfiguration(
      { document, locator: ".senawa/workflow.json", resources },
      deterministicSha256,
    );
    expect(diagnosis.diagnostics).toEqual([]);

    const snapshot = await compileWorkflowConfiguration(
      { document, locator: ".senawa/workflow.json", resources },
      deterministicSha256,
    );
    expect(snapshot.graph.nodes.filter(({ kind }) => kind === "phase")).toHaveLength(5);
    expect(snapshot.prompts.map(({ key }) => key)).toEqual([
      "definer",
      "implementor",
      "planner",
      "researcher",
      "verifier",
    ]);
    expect(snapshot.forEach).toEqual([
      expect.objectContaining({
        key: "plan-tasks",
        value: expect.objectContaining({ pointer: "/tasks" }),
      }),
    ]);
  });
});
