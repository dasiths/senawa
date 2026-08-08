import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PlanArtifactSchema } from "@senawa/domain";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  loadRepositoryDefinitions,
  parseWorkerProfileSource,
  RepositoryDefinitionsSchema,
} from "./definitions.js";
import { findRepositoryRoot } from "./repository-paths.js";
import { createRunSnapshot } from "./snapshot.js";
import { listRepositoryWorkflows, readRepositoryWorkflow } from "./workflow-catalog.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

describe("repository configuration", () => {
  it("loads the standard delivery inputs and every referenced definition", async () => {
    const definitions = await loadRepositoryDefinitions(repositoryRoot);

    expect(() => RepositoryDefinitionsSchema.parse(definitions)).not.toThrow();
    expect(definitions.workflow.metadata.name).toBe("standard-delivery");
    expect(definitions.workflow.spec.phases).toHaveLength(5);
    expect(
      definitions.workflow.spec.phases.find((phase) => phase.id === "implement")?.executor,
    ).toMatchObject({ kind: "task-frontier", repositoryChanges: ["required", "optional"] });
    expect(Object.keys(definitions.schemas)).toHaveLength(5);
    expect(Object.keys(definitions.workerProfiles)).toEqual([
      "definer",
      "implementor",
      "planner",
      "researcher",
      "verifier",
    ]);
    expect(definitions).not.toHaveProperty("hookConfiguration");
  });

  it("leaves omitted task change intent for the frontier to derive", () => {
    const plan = PlanArtifactSchema.parse({
      summary: "Legacy plan",
      tasks: [
        {
          key: "minimal-task",
          title: "Minimal task",
          dependsOn: [],
          paths: ["packages/application"],
          acceptance: [{ description: "Done" }],
          role: "implementor",
        },
      ],
    });

    expect(plan.tasks[0]?.repositoryChange).toBeUndefined();
    expect(plan.tasks[0]?.acceptance).toEqual([
      { description: "Done", required: true, satisfies: [] },
    ]);
  });

  it("requires structured acceptance in the frozen plan schema", async () => {
    const definitions = await loadRepositoryDefinitions(repositoryRoot);
    const schema = definitions.schemas[".senawa/schemas/plan.schema.json"];
    expect(schema).toBeDefined();
    const ajv = new Ajv2020.default({ strict: true });
    addFormats.default(ajv);
    const validate = ajv.compile(schema ?? {});
    const plan = (acceptance: unknown) => ({
      summary: "Mixed acceptance",
      tasks: [
        {
          key: "mixed",
          title: "Mixed task",
          paths: ["packages/configuration"],
          acceptance,
          role: "implementor",
        },
      ],
    });

    // A bare string is no longer an acceptance entry; only the structured shape validates.
    expect(validate(plan(["Just a string"]))).toBe(false);
    expect(validate(plan([{ id: "ac-one", description: "Structured", required: false }]))).toBe(
      true,
    );
    expect(validate(plan([{ description: "Derived id" }]))).toBe(true);
    expect(validate(plan([{ required: true }]))).toBe(false);
  });

  it("discovers the repository and owns the workflow catalog", async () => {
    await expect(
      findRepositoryRoot(resolve(repositoryRoot, "packages/configuration/src")),
    ).resolves.toBe(repositoryRoot);
    await expect(listRepositoryWorkflows(repositoryRoot)).resolves.toEqual(["standard-delivery"]);
    await expect(
      readRepositoryWorkflow(repositoryRoot, "standard-delivery"),
    ).resolves.toMatchObject({
      metadata: { name: "standard-delivery" },
    });
  });

  it("creates stable source snapshots and fingerprints", async () => {
    const definitions = await loadRepositoryDefinitions(repositoryRoot);
    const createdAt = new Date("2026-08-05T00:00:00.000Z");
    const first = createRunSnapshot("run-snapshot", definitions, createdAt);
    const second = createRunSnapshot("run-snapshot", definitions, createdAt);

    expect(first).toEqual(second);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.files.some((file) => file.path === ".agents/skills/senawa/SKILL.md")).toBe(true);
  });

  it("strictly parses profile frontmatter and rejects hostile capabilities", () => {
    const source = `---
apiVersion: senawa.dev/worker-profile/v1
kind: WorkerProfile
metadata: { name: reviewer }
spec:
  model: { id: test-model, effort: high }
  tools: [repository.read, senawa.phase.submit]
---
# Reviewer
Review repository evidence.
`;
    expect(parseWorkerProfileSource(source, "reviewer.senawa.md").prompt).toContain("# Reviewer");
    expect(() =>
      parseWorkerProfileSource(
        source.replace("repository.read", "host.shell.unrestricted"),
        "reviewer.senawa.md",
      ),
    ).toThrow();
    expect(() => parseWorkerProfileSource(source, "different.senawa.md")).toThrow(
      "declares metadata.name reviewer; expected different",
    );
  });

  it("fails preflight for invalid built-in sensor configuration", async () => {
    const fixture = await copyRepositoryConfiguration();
    const policyPath = resolve(fixture, ".senawa/sensors.yaml");
    const policy = await readFile(policyPath, "utf8");
    await writeFile(policyPath, policy.replace("parser: raw", "parser: json"));

    await expect(loadRepositoryDefinitions(fixture)).rejects.toThrow(
      "Sensor typecheck has invalid @senawa/sensor-command configuration",
    );
  });

  it("fails preflight when a gate has no deterministic non-advisory anchor", async () => {
    const fixture = await copyRepositoryConfiguration();
    const policyPath = resolve(fixture, ".senawa/sensors.yaml");
    const policy = await readFile(policyPath, "utf8");
    await writeFile(
      policyPath,
      policy.replace(
        '  - id: artifact-present\n    extension: "@senawa/sensor-artifact"\n    kind: deterministic',
        '  - id: artifact-present\n    extension: "@senawa/sensor-artifact"\n    kind: inferential',
      ),
    );

    await expect(loadRepositoryDefinitions(fixture)).rejects.toThrow(
      "Gate plan-accepted has no deterministic non-advisory sensor anchor",
    );
  });

  it("fails closed when a workflow references a missing worker profile", async () => {
    const fixture = await copyRepositoryConfiguration();
    const workflowPath = resolve(fixture, ".senawa/workflows/standard-delivery.yaml");
    const workflow = await readFile(workflowPath, "utf8");
    await writeFile(workflowPath, workflow.replace("role: definer", "role: missing-role"));

    await expect(loadRepositoryDefinitions(fixture)).rejects.toThrow(
      "Workflow phase define references missing worker profile missing-role",
    );
  });

  it.each([
    ["phases.define.result", "Expected phases.<phaseId>.output"],
    ["phases.verify.output", "not an ancestor"],
    ["phases.implement.output", "has no artifact output"],
  ])("rejects invalid workflow input reference %s", async (reference, message) => {
    const fixture = await copyRepositoryConfiguration();
    const workflowPath = resolve(fixture, ".senawa/workflows/standard-delivery.yaml");
    const workflow = await readFile(workflowPath, "utf8");
    await writeFile(
      workflowPath,
      workflow.replace("definition: phases.define.output", `definition: ${reference}`),
    );

    await expect(loadRepositoryDefinitions(fixture)).rejects.toThrow(message);
  });

  it("rejects duplicate workflow input references", async () => {
    const fixture = await copyRepositoryConfiguration();
    const workflowPath = resolve(fixture, ".senawa/workflows/standard-delivery.yaml");
    const workflow = await readFile(workflowPath, "utf8");
    await writeFile(
      workflowPath,
      workflow.replace(
        "definition: phases.define.output\n          research: phases.research.output",
        "definition: phases.define.output\n          research: phases.define.output",
      ),
    );

    await expect(loadRepositoryDefinitions(fixture)).rejects.toThrow(
      "Duplicate workflow input reference",
    );
  });
});

async function copyRepositoryConfiguration(): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "senawa-configuration-"));
  await cp(resolve(repositoryRoot, ".senawa"), resolve(fixture, ".senawa"), { recursive: true });
  // .agents/.copilot-tracking holds live run state, not configuration.
  await cp(resolve(repositoryRoot, ".agents"), resolve(fixture, ".agents"), {
    recursive: true,
    filter: (source) => !source.includes(".copilot-tracking"),
  });
  return fixture;
}
