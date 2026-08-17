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
    { intent: "create-escalation", roles: ["engine", "release-manager"] },
  ]),
};
const REPOSITORY_ID = "repository_escalation";
const RUN_ID = "run_escalation";
const NOW = "2026-08-17T00:00:00.000Z";

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("escalating a phase that cannot reach its gate", () => {
  it("refuses an escalation with no gate evidence to escalate", async () => {
    const { authority, snapshot } = await instantiated();
    try {
      const receipt = submitEscalation(authority, snapshot.graph.revisionDigest, ["waive"]);
      // Escalating before a gate has refused anything would let an agent skip
      // measurement entirely, which is the property the product exists to keep.
      expect(receipt.status).toBe("refused");
      expect(receipt.error?.code).toBe("candidate-required");
    } finally {
      authority.close();
    }
  });

  it("refuses an escalation that offers the human no response", async () => {
    const { authority, snapshot } = await instantiated();
    try {
      const receipt = submitEscalation(authority, snapshot.graph.revisionDigest, []);
      expect(receipt.status).toBe("refused");
    } finally {
      authority.close();
    }
  });

  it("is a recognised intent rather than an unimplemented one", async () => {
    const { authority, snapshot } = await instantiated();
    try {
      const receipt = submitEscalation(authority, snapshot.graph.revisionDigest, ["waive"]);
      // Before this phase the intent fell through to `unsupported-intent`, so a
      // blocked run had no terminal move at all.
      expect(receipt.error?.code).not.toBe("unsupported-intent");
    } finally {
      authority.close();
    }
  });
});

let commandOrdinal = 0;

function submitEscalation(
  authority: SqliteAuthority,
  graphRevision: string,
  allowedResponses: readonly string[],
) {
  commandOrdinal += 1;
  const payload = { allowedResponses };
  let allocation = 0;
  return authority.submit(
    decodeCommandEnvelope({
      apiVersion: PROTOCOL_VERSION,
      commandId: `command_escalation-${commandOrdinal}`,
      principal: runtimePrincipal,
      transport: { kind: "cli", requestId: `request_escalation-${commandOrdinal}` },
      repositoryId: REPOSITORY_ID,
      runId: RUN_ID,
      intent: { type: "create-escalation" },
      expectedGraphRevision: graphRevision,
      payload,
      payloadDigest: dependencies.sha256.digest(canonicalBytes(payload)),
    }),
    {
      currentTime: NOW,
      facts: { source: "escalation-test" },
      allocateId: (kind) => {
        allocation += 1;
        return `${kind}-escalation-${allocation}`;
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
  const root = await mkdtemp(join(tmpdir(), "senawa-escalation-"));
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
