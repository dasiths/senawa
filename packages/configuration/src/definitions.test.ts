import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    await writeFile(policyPath, policy.replace("kind: deterministic", "kind: inferential"));

    await expect(loadRepositoryDefinitions(fixture)).rejects.toThrow(
      "Gate definition-accepted has no deterministic non-advisory sensor anchor",
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
});

async function copyRepositoryConfiguration(): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "senawa-configuration-"));
  await cp(resolve(repositoryRoot, ".senawa"), resolve(fixture, ".senawa"), { recursive: true });
  await cp(resolve(repositoryRoot, ".agents"), resolve(fixture, ".agents"), { recursive: true });
  return fixture;
}
