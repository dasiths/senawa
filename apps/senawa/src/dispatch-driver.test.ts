import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileAuthoredWorkflow } from "@senawa/execution-host";
import { canonicalValue, sha256Digest } from "@senawa/kernel";
import {
  createRoleAuthorizationPolicy,
  RuntimeDataflowAuthority,
  type RuntimeDependencies,
} from "@senawa/runtime";
import {
  SqliteAuthority,
  SqliteCanonicalJsonAssetStore,
  SqliteContextBroker,
} from "@senawa/storage-sqlite";
import { runtimePrincipal } from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";
import { instantiateAuthoredRun } from "./authored-run.js";
import { runtimeDependencies as productionDependencies } from "./daemon.js";
import {
  configurationRuntimeSchemaValidator,
  runtimeSchemaContract,
} from "./dataflow-composition.js";
import { dispatchPhase } from "./dispatch-driver.js";

const roots = new Set<string>();
const dependencies: RuntimeDependencies = {
  sha256: productionDependencies.sha256,
  authorization: createRoleAuthorizationPolicy([
    { intent: "instantiate-run", roles: ["release-manager"] },
  ]),
};
const REPOSITORY_ID = "repository_driver";
const RUN_ID = "run_driver";
const NOW = "2026-08-17T00:00:00.000Z";

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("dispatch driver", () => {
  it("turns an instantiated phase into a registered worker dispatch", async () => {
    const project = await authoredProject();
    const snapshot = await compileAuthoredWorkflow(project, dependencies.sha256);
    const databasePath = join(project, "authority.db");
    const assetDirectory = join(project, "assets");
    const authority = new SqliteAuthority({ databasePath, assetDirectory, dependencies });
    const contextBroker = new SqliteContextBroker({
      databasePath,
      dependencies: {
        sha256: dependencies.sha256,
        currentTime: () => NOW,
        issueGrantToken: () => new Uint8Array(32).fill(7),
      },
    });
    try {
      expect(
        instantiateAuthoredRun({
          authority,
          snapshot,
          repositoryId: REPOSITORY_ID,
          runId: RUN_ID,
          principal: runtimePrincipal,
          currentTime: NOW,
          dependencies,
        }).status,
      ).toBe("completed");

      const dataflow = new RuntimeDataflowAuthority(
        dependencies.sha256,
        configurationRuntimeSchemaValidator(),
        new SqliteCanonicalJsonAssetStore(authority),
        authority,
      );
      const value = canonicalValue({ request: "Add a health endpoint" });
      const binding = dataflow.bindWorkflowInput({
        repositoryId: REPOSITORY_ID,
        runId: RUN_ID,
        workflowId: snapshot.graph.workflowId,
        graphRevisionDigest: snapshot.graph.revisionDigest,
        configurationSnapshotDigest: snapshot.snapshotDigest,
        schema: runtimeSchemaContract(snapshot, "request", dependencies.sha256),
        value,
      });

      const result = dispatchPhase({
        snapshot,
        dataflow,
        contextBroker,
        dependencies,
        repositoryId: REPOSITORY_ID,
        runId: RUN_ID,
        phaseKey: "define",
        workflowInput: { bindingDigest: binding.bindingDigest, value },
        repositoryBase: {
          commitDigest: sha256Digest("1".repeat(64)),
          treeDigest: sha256Digest("2".repeat(64)),
        },
        currentTime: NOW,
      });

      expect(result.dispatch.dispatchId).toMatch(/^dispatch_[0-9a-f]{64}$/u);
      expect(result.dispatch.worker.roleKey).toBe("definer");
      // Without the protocol capabilities the agent could not submit anything.
      expect(result.dispatch.capabilities).toContain("worker.submit.phase-output");
      expect(result.dispatch.capabilities).toContain("worker.submit.completion");

      const dispatches = contextBroker.listWorkerDispatches(REPOSITORY_ID, RUN_ID);
      expect(dispatches.map(({ dispatch }) => dispatch.dispatchId)).toEqual([
        result.dispatch.dispatchId,
      ]);
    } finally {
      contextBroker.close();
      authority.close();
    }
  });
});

const AGENTS = `
definer:
  model: gpt-5
  prompt: prompts/definer.md
`;

const WORKFLOW = `
name: delivery
input: schemas/request.schema.json
phases:
  - name: define
    agent: definer
    output: schemas/definition.schema.json
`;

async function authoredProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "senawa-driver-"));
  roots.add(root);
  const configuration = join(root, ".senawa");
  await mkdir(join(configuration, "prompts"), { recursive: true });
  await mkdir(join(configuration, "schemas"), { recursive: true });
  await writeFile(join(configuration, "agents.yaml"), AGENTS);
  await writeFile(join(configuration, "workflow.yaml"), WORKFLOW);
  await writeFile(join(configuration, "sensors.yaml"), "sensors: {}\n");
  await writeFile(
    join(configuration, "prompts", "definer.md"),
    "Define the work.\n\nRequest: ${{ input.request }}\n",
  );
  for (const name of ["request", "definition"]) {
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
