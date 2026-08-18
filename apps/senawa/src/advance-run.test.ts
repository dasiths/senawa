import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalValue, sha256Digest } from "@senawa/kernel";
import { createRoleAuthorizationPolicy, type RuntimeDependencies } from "@senawa/runtime";
import { runtimePrincipal } from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";
import { advanceRun } from "./advance-run.js";
import { runtimeDependencies as productionDependencies } from "./daemon.js";
import { startAuthoredRun } from "./start-run.js";

const roots = new Set<string>();
const dependencies: RuntimeDependencies = {
  sha256: productionDependencies.sha256,
  authorization: createRoleAuthorizationPolicy([
    { intent: "instantiate-run", roles: ["release-manager"] },
    { intent: "evaluate-gate", roles: ["release-manager"] },
    { intent: "record-authority-decision", roles: ["release-manager"] },
    { intent: "close-phase", roles: ["release-manager"] },
    { intent: "start-phase-attempt", roles: ["release-manager"] },
  ]),
};
const NOW = "2026-08-18T00:00:00.000Z";
const BASE = {
  commitDigest: sha256Digest("1".repeat(64)),
  treeDigest: sha256Digest("2".repeat(64)),
};

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("advancing a run", () => {
  it("waits for the agent rather than advancing past an unfinished phase", async () => {
    const project = await authoredProject();
    const paths = {
      databasePath: join(project, "authority.db"),
      assetDirectory: join(project, "assets"),
    };
    await startAuthoredRun({
      projectRoot: project,
      ...paths,
      dependencies,
      repositoryId: "repository_advance",
      runId: "run_advance",
      principal: runtimePrincipal,
      input: canonicalValue({ request: "Add a health endpoint" }),
      currentTime: NOW,
      repositoryBase: BASE,
    });

    const outcome = await advanceRun({
      projectRoot: project,
      ...paths,
      repositoryId: "repository_advance",
      runId: "run_advance",
      principal: runtimePrincipal,
      dependencies,
      currentTime: NOW,
      workflowInput: {
        bindingDigest: sha256Digest("3".repeat(64)),
        value: canonicalValue({ request: "Add a health endpoint" }),
      },
      repositoryBase: BASE,
    });

    // The phase is dispatched but no agent has completed it, so the driver must
    // stop rather than evaluating a gate over work that does not exist.
    expect(outcome).toEqual({ kind: "awaiting-agent", phaseKey: "define" });
  });

  it("refuses to advance a run it cannot find", async () => {
    const project = await authoredProject();
    await expect(
      advanceRun({
        projectRoot: project,
        databasePath: join(project, "authority.db"),
        assetDirectory: join(project, "assets"),
        repositoryId: "repository_absent",
        runId: "run_absent",
        principal: runtimePrincipal,
        dependencies,
        currentTime: NOW,
        workflowInput: {
          bindingDigest: sha256Digest("3".repeat(64)),
          value: canonicalValue({}),
        },
        repositoryBase: BASE,
      }),
    ).rejects.toThrow(/run_absent: no such run/u);
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
  const root = await mkdtemp(join(tmpdir(), "senawa-advance-"));
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
  for (const [name, id] of [
    ["request.schema.json", "urn:senawa:request"],
    ["definition.schema.json", "urn:senawa:definition"],
  ]) {
    await writeFile(
      join(configuration, "schemas", String(name)),
      `${JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: id,
        type: "object",
        additionalProperties: true,
      })}\n`,
    );
  }
  return root;
}
