import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compileWorkflowConfiguration, doctorWorkflowConfiguration } from "@senawa/configuration";
import { RootScopedConfigurationResources } from "@senawa/execution-host";
import { deterministicSha256 } from "@senawa/testing";
import { describe, expect, it } from "vitest";

const templateRoot = resolve(import.meta.dirname, "../../..", ".senawa");

describe("tracked standard-delivery template", () => {
  it("doctors and compiles the complete v1alpha3 resource tree", async () => {
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
