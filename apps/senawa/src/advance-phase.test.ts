import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileAuthoredWorkflow } from "@senawa/execution-host";
import { canonicalBytes, decodeCommandEnvelope, PROTOCOL_VERSION } from "@senawa/protocol";
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
    { intent: "start-phase-attempt", roles: ["release-manager"] },
  ]),
};
const REPOSITORY_ID = "repository_advance";
const RUN_ID = "run_advance";
const NOW = "2026-08-17T00:00:00.000Z";

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("advancing a run to its next phase", () => {
  it("refuses to advance while the current phase is open", async () => {
    const { authority, snapshot } = await instantiated();
    try {
      const verify = phaseNode(snapshot, "verify");
      const receipt = submitAdvance(authority, verify, snapshot.graph.revisionDigest);
      expect(receipt.status).toBe("refused");
      expect(receipt.error?.code).toBe("closure-required");
    } finally {
      authority.close();
    }
  });

  it("refuses a phase the graph does not declare", async () => {
    const { authority, snapshot } = await instantiated();
    try {
      const receipt = submitAdvance(
        authority,
        { id: "phase_absent", generation: 1 },
        snapshot.graph.revisionDigest,
      );
      // An open current phase is refused before the graph is consulted at all.
      expect(receipt.status).toBe("refused");
      expect(receipt.error?.code).toBe("closure-required");
    } finally {
      authority.close();
    }
  });

  it("refuses to re-enter the phase the run is already on", async () => {
    const { authority, snapshot } = await instantiated();
    try {
      const define = phaseNode(snapshot, "define");
      const receipt = submitAdvance(authority, define, snapshot.graph.revisionDigest);
      expect(receipt.status).toBe("refused");
    } finally {
      authority.close();
    }
  });
});

function phaseNode(
  snapshot: Awaited<ReturnType<typeof compileAuthoredWorkflow>>,
  key: string,
): { readonly id: string; readonly generation: number } {
  const node = snapshot.graph.nodes.find(
    (candidate) => candidate.kind === "phase" && candidate.definition.key === key,
  );
  if (node === undefined || node.kind !== "phase") throw new Error(`no phase ${key}`);
  return { id: node.definition.id, generation: node.definition.generation };
}

let commandOrdinal = 0;

function submitAdvance(
  authority: SqliteAuthority,
  phase: { readonly id: string; readonly generation: number },
  graphRevision: string,
) {
  commandOrdinal += 1;
  const payload = { phaseId: phase.id, definitionGeneration: phase.generation };
  let allocation = 0;
  return authority.submit(
    decodeCommandEnvelope({
      apiVersion: PROTOCOL_VERSION,
      commandId: `command_advance-${commandOrdinal}`,
      principal: runtimePrincipal,
      transport: { kind: "cli", requestId: `request_advance-${commandOrdinal}` },
      repositoryId: REPOSITORY_ID,
      runId: RUN_ID,
      intent: { type: "start-phase-attempt" },
      expectedGraphRevision: graphRevision,
      payload,
      payloadDigest: dependencies.sha256.digest(canonicalBytes(payload)),
    }),
    {
      currentTime: NOW,
      facts: { source: "advance-test" },
      allocateId: (kind) => {
        allocation += 1;
        return `${kind}-advance-${allocation}`;
      },
    },
  );
}

async function instantiated() {
  const project = await authoredProject();
  const snapshot = await compileAuthoredWorkflow(project, dependencies.sha256);
  const authority = new SqliteAuthority({
    databasePath: join(project, "authority.db"),
    assetDirectory: join(project, "assets"),
    dependencies,
  });
  instantiateAuthoredRun({
    authority,
    snapshot,
    repositoryId: REPOSITORY_ID,
    runId: RUN_ID,
    principal: runtimePrincipal,
    currentTime: NOW,
    dependencies,
  });
  return { authority, snapshot };
}

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
