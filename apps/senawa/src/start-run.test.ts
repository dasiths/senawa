import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalValue, sha256Digest } from "@senawa/kernel";
import { createRoleAuthorizationPolicy, type RuntimeDependencies } from "@senawa/runtime";
import { SqliteAuthority, SqliteContextBroker } from "@senawa/storage-sqlite";
import { runtimePrincipal } from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeDependencies as productionDependencies } from "./daemon.js";
import { startAuthoredRun } from "./start-run.js";

const roots = new Set<string>();
const dependencies: RuntimeDependencies = {
  sha256: productionDependencies.sha256,
  authorization: createRoleAuthorizationPolicy([
    { intent: "instantiate-run", roles: ["release-manager"] },
    { intent: "record-phase-attempt-transition", roles: ["release-manager"] },
  ]),
};
const NOW = "2026-08-17T00:00:00.000Z";

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("starting an authored run", () => {
  it("compiles, instantiates, binds the request, and dispatches the first phase", async () => {
    const project = await authoredProject();
    const started = await startAuthoredRun({
      projectRoot: project,
      databasePath: join(project, "authority.db"),
      assetDirectory: join(project, "assets"),
      dependencies,
      repositoryId: "repository_start",
      runId: "run_start",
      principal: runtimePrincipal,
      input: canonicalValue({ request: "Add a health endpoint" }),
      currentTime: NOW,
      repositoryBase: {
        commitDigest: sha256Digest("1".repeat(64)),
        treeDigest: sha256Digest("2".repeat(64)),
      },
    });

    expect(started.phaseKey).toBe("define");
    expect(started.dispatchId).toMatch(/^dispatch_[0-9a-f]{64}$/u);

    // The dispatch must be durable, or the scheduler has nothing to pick up.
    const broker = new SqliteContextBroker({
      databasePath: join(project, "authority.db"),
      dependencies: {
        sha256: dependencies.sha256,
        currentTime: () => NOW,
        issueGrantToken: () => new Uint8Array(32),
      },
    });
    try {
      const stored = broker.listWorkerDispatches("repository_start", "run_start");
      expect(stored.map(({ dispatch }) => dispatch.dispatchId)).toEqual([started.dispatchId]);
      // Without an effect seed the scheduler skips the dispatch silently.
      expect(stored[0]?.effect).toBeDefined();
    } finally {
      broker.close();
    }

    // The first dispatch of a run is an attempt like any other. Leaving it
    // unrecorded left the one-agent rule blind to the first turn, and the
    // driver could not tell a turn that was over from one that never started:
    // the live run sat with one agent dispatched and nothing moving.
    const authority = new SqliteAuthority({
      databasePath: join(project, "authority.db"),
      assetDirectory: join(project, "assets"),
      dependencies,
    });
    try {
      expect(authority.queryRunScheduling("repository_start", "run_start")?.attempts).toEqual([
        expect.objectContaining({
          taskId: expect.stringMatching(/^task_/u),
          disposition: "opened",
        }),
      ]);
    } finally {
      authority.close();
    }
  });

  it("starts a second run in the same state root", async () => {
    const project = await authoredProject();
    const paths = {
      databasePath: join(project, "authority.db"),
      assetDirectory: join(project, "assets"),
    };
    const common = {
      projectRoot: project,
      ...paths,
      dependencies,
      principal: runtimePrincipal,
      input: canonicalValue({ request: "Add a health endpoint" }),
      currentTime: NOW,
      repositoryBase: {
        commitDigest: sha256Digest("1".repeat(64)),
        treeDigest: sha256Digest("2".repeat(64)),
      },
    };

    await startAuthoredRun({ ...common, repositoryId: "repository_one", runId: "run_first" });

    // Allocated identities are globally unique, so a fixed suffix would let
    // only the first run in a state root ever start.
    await expect(
      startAuthoredRun({ ...common, repositoryId: "repository_two", runId: "run_second" }),
    ).resolves.toMatchObject({ runId: "run_second" });
  });

  it("refuses a request the workflow input schema does not accept", async () => {
    const project = await authoredProject({ strictSchema: true });
    await expect(
      startAuthoredRun({
        projectRoot: project,
        databasePath: join(project, "authority.db"),
        assetDirectory: join(project, "assets"),
        dependencies,
        repositoryId: "repository_bad",
        runId: "run_bad",
        principal: runtimePrincipal,
        input: canonicalValue({ unexpected: "value" }),
        currentTime: NOW,
        repositoryBase: {
          commitDigest: sha256Digest("1".repeat(64)),
          treeDigest: sha256Digest("2".repeat(64)),
        },
      }),
    ).rejects.toThrow();
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

async function authoredProject(options: { readonly strictSchema?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "senawa-start-"));
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
  await writeFile(
    join(configuration, "schemas", "request.schema.json"),
    `${JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:senawa:request",
      type: "object",
      ...(options.strictSchema === true
        ? { required: ["request"], properties: { request: { type: "string" } } }
        : {}),
      additionalProperties: options.strictSchema !== true,
    })}\n`,
  );
  await writeFile(
    join(configuration, "schemas", "definition.schema.json"),
    `${JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:senawa:definition",
      type: "object",
      additionalProperties: true,
    })}\n`,
  );
  return root;
}
