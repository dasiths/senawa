import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadRepositoryDefinitions,
  parseWorkerProfileSource,
  RepositoryDefinitionsSchema,
} from "./definitions.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

describe("repository definitions", () => {
  it("parses the standard delivery inputs and every referenced definition", async () => {
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
    expect(Object.keys(definitions.workerProfileSources)).toEqual([
      ".senawa/agents/definer.senawa.md",
      ".senawa/agents/implementor.senawa.md",
      ".senawa/agents/planner.senawa.md",
      ".senawa/agents/researcher.senawa.md",
      ".senawa/agents/verifier.senawa.md",
    ]);
    expect(definitions).not.toHaveProperty("hookConfiguration");
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
    expect(() =>
      parseWorkerProfileSource(
        source.replace("kind: WorkerProfile", "kind: WorkerProfile\nunknown: true"),
        "reviewer.senawa.md",
      ),
    ).toThrow();
    expect(() => parseWorkerProfileSource(source, "different.senawa.md")).toThrow(
      "declares metadata.name reviewer; expected different",
    );
  });

  it("fails closed when a workflow references a missing worker profile", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "senawa-definitions-"));
    await cp(resolve(repositoryRoot, ".senawa"), resolve(fixture, ".senawa"), {
      recursive: true,
    });
    await cp(resolve(repositoryRoot, ".agents"), resolve(fixture, ".agents"), {
      recursive: true,
    });
    const workflowPath = resolve(fixture, ".senawa/workflows/standard-delivery.yaml");
    const workflow = await readFile(workflowPath, "utf8");
    await writeFile(workflowPath, workflow.replace("role: definer", "role: missing-role"));

    await expect(loadRepositoryDefinitions(fixture)).rejects.toThrow(
      "Workflow phase define references missing worker profile missing-role",
    );
  });
});
