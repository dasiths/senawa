import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileAuthoredWorkflow, loadAuthoredWorkflow } from "@senawa/execution-host";
import { createRoleAuthorizationPolicy, type RuntimeDependencies } from "@senawa/runtime";
import { SqliteAuthority } from "@senawa/storage-sqlite";
import { runtimePrincipal } from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";
import { instantiateAuthoredRun } from "./authored-run.js";
import { runtimeDependencies as productionDependencies } from "./daemon.js";

const roots = new Set<string>();
const dependencies: RuntimeDependencies = {
  sha256: productionDependencies.sha256,
  authorization: createRoleAuthorizationPolicy([
    { intent: "instantiate-run", roles: ["release-manager"] },
  ]),
};

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("authored workflow to run", () => {
  it("compiles an authored project and instantiates a run from it", async () => {
    const project = await authoredProject();
    const snapshot = await compileAuthoredWorkflow(project, dependencies.sha256);
    expect(snapshot.graph.nodes.filter((node) => node.kind === "phase")).toHaveLength(2);

    const authority = new SqliteAuthority({
      databasePath: join(project, "authority.db"),
      assetDirectory: join(project, "assets"),
      dependencies,
    });
    try {
      const receipt = instantiateAuthoredRun({
        authority,
        snapshot,
        repositoryId: "repository_authored",
        runId: "run_authored",
        principal: runtimePrincipal,
        currentTime: "2026-08-17T00:00:00.000Z",
        dependencies,
      });
      expect(receipt.status).toBe("completed");
      expect(receipt.result).toMatchObject({
        graphRevision: snapshot.graph.revisionDigest,
        configurationSnapshotDigest: snapshot.snapshotDigest,
      });
    } finally {
      authority.close();
    }
  });

  it("reports the authored file, path, and reason when the project is wrong", async () => {
    const project = await authoredProject({
      workflow: WORKFLOW.replace("agent: verifier", "agent: absent"),
    });
    const result = await loadAuthoredWorkflow(project, dependencies.sha256);
    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toEqual([
      {
        code: "unknown-reference",
        locator: "workflow.yaml",
        pointer: "/phases/1/agent",
        message: "Unknown agent absent",
      },
    ]);
  });

  it("refuses to read an authored document outside the configuration directory", async () => {
    const project = await authoredProject();
    await rm(join(project, ".senawa", "agents.yaml"));
    const result = await loadAuthoredWorkflow(project, dependencies.sha256);
    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics[0]?.code).toBe("resource-read-failed");
    expect(result.diagnostics[0]?.locator).toBe("agents.yaml");
  });
});

const AGENTS = `
definer:
  model: gpt-5
  prompt: prompts/definer.md
verifier:
  model: gpt-5
  prompt: prompts/verifier.md
`;

const WORKFLOW = `
name: delivery
input: schemas/request.schema.json
phases:
  - name: define
    agent: definer
    output: schemas/definition.schema.json
  - name: verify
    agent: verifier
    needs: [define]
    output: schemas/verification.schema.json
`;

const SENSORS = "sensors: {}\n";

async function authoredProject(overrides: { readonly workflow?: string } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "senawa-authored-"));
  roots.add(root);
  const configuration = join(root, ".senawa");
  await mkdir(join(configuration, "prompts"), { recursive: true });
  await mkdir(join(configuration, "schemas"), { recursive: true });
  await writeFile(join(configuration, "agents.yaml"), AGENTS);
  await writeFile(join(configuration, "workflow.yaml"), overrides.workflow ?? WORKFLOW);
  await writeFile(join(configuration, "sensors.yaml"), SENSORS);
  await writeFile(
    join(configuration, "prompts", "definer.md"),
    "Define it.\n\nRequest: ${{ input.request }}\n",
  );
  await writeFile(
    join(configuration, "prompts", "verifier.md"),
    "Verify it.\n\nDefinition: ${{ input.define }}\n",
  );
  for (const name of ["request", "definition", "verification"]) {
    await writeFile(
      join(configuration, "schemas", `${name}.schema.json`),
      `${JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: `urn:senawa:${name}`,
        type: "object",
        additionalProperties: true,
      })}\n`,
    );
  }
  return root;
}
