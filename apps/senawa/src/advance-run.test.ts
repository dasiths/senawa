import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAuthoredWorkflow } from "@senawa/execution-host";
import { canonicalBytes, canonicalDigest, canonicalValue, sha256Digest } from "@senawa/kernel";
import {
  createRoleAuthorizationPolicy,
  type RuntimeDependencies,
  SimulatedSerialWorkerAdapter,
} from "@senawa/runtime";
import {
  SqliteAuthority,
  SqliteCanonicalJsonAssetStore,
  SqliteContextBroker,
} from "@senawa/storage-sqlite";
import { runtimePrincipal } from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";
import { advanceRun, dispatchNeverStarted } from "./advance-run.js";
import { runtimeDependencies as productionDependencies } from "./daemon.js";
import { runtimeSchemaContract } from "./dataflow-composition.js";
import { startAuthoredRun } from "./start-run.js";

const roots = new Set<string>();
const dependencies: RuntimeDependencies = {
  sha256: productionDependencies.sha256,
  authorization: createRoleAuthorizationPolicy([
    { intent: "instantiate-run", roles: ["release-manager"] },
    { intent: "submit-completion", roles: ["release-manager"] },
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

  it("closes a phase after a scripted agent publishes its output and completes", async () => {
    const project = await authoredProject();
    const paths = {
      databasePath: join(project, "authority.db"),
      assetDirectory: join(project, "assets"),
    };
    const started = await startAuthoredRun({
      projectRoot: project,
      ...paths,
      dependencies,
      repositoryId: "repository_close",
      runId: "run_close",
      principal: runtimePrincipal,
      input: canonicalValue({ request: "Add a health endpoint" }),
      currentTime: NOW,
      repositoryBase: BASE,
    });

    await completeDispatch(project, paths, started.dispatchId);

    const outcome = await advanceRun({
      projectRoot: project,
      ...paths,
      repositoryId: "repository_close",
      runId: "run_close",
      principal: runtimePrincipal,
      dependencies,
      currentTime: NOW,
      workflowInput: {
        bindingDigest: sha256Digest("3".repeat(64)),
        value: canonicalValue({ request: "Add a health endpoint" }),
      },
      repositoryBase: BASE,
    });

    // The run closed define and moved to verify, which the next call dispatches.
    expect(outcome).toEqual({ kind: "closed", phaseKey: "define" });

    // The outcome alone would also be reported by a driver that closed nothing,
    // so assert the closure the authority durably recorded.
    const authority = new SqliteAuthority({ ...paths, dependencies });
    try {
      const completed = authority
        .queryReceiptHistory("repository_close", "run_close")
        .filter((receipt) => receipt.status === "completed")
        .map((receipt) => String(receipt.commandId));
      expect(completed.some((id) => id.startsWith("command_gate-"))).toBe(true);
      expect(completed.some((id) => id.startsWith("command_close-"))).toBe(true);

      // The gate identity carries the candidate it decided on. Keyed on the
      // phase and attempt alone, a candidate the authority refused leaves the
      // identity bound to the refused envelope, and the corrected candidate for
      // that same attempt can never be submitted: the phase wedges for good.
      const gateIds = completed.filter((id) => id.startsWith("command_gate-"));
      expect(gateIds.length).toBeGreaterThan(0);
      expect(
        gateIds.every((id) => /^command_gate-[a-z]+-\d+-[0-9a-f]{16}-[0-9a-f]+$/.test(id)),
      ).toBe(true);

      // A gate refusal is cached under the identity that earned it, and that
      // identity is re-derived every cycle, so a phase gated on evidence the
      // authority has not accepted yet can never be gated again. The driver has
      // to wait instead of submitting, which means a driven run refuses nothing.
      expect(
        authority
          .queryReceiptHistory("repository_close", "run_close")
          .filter((receipt) => receipt.status === "refused")
          .map((receipt) => String(receipt.commandId)),
      ).toEqual([]);
    } finally {
      authority.close();
    }

    // The run must actually be on the second phase, not merely report that it
    // closed the first, so advancing again dispatches verify.
    const next = await advanceRun({
      projectRoot: project,
      ...paths,
      repositoryId: "repository_close",
      runId: "run_close",
      principal: runtimePrincipal,
      dependencies,
      currentTime: NOW,
      workflowInput: {
        bindingDigest: sha256Digest("3".repeat(64)),
        value: canonicalValue({ request: "Add a health endpoint" }),
      },
      repositoryBase: BASE,
    });
    expect(next).toMatchObject({ kind: "dispatched", phaseKey: "verify" });

    // Drive the second phase too, so the workflow reaches its end rather than
    // merely proving one hand-off.
    if (next.kind !== "dispatched") throw new Error("verify was not dispatched");
    await completeDispatch(project, paths, next.dispatchId);
    expect(
      await advanceRun({
        projectRoot: project,
        ...paths,
        repositoryId: "repository_close",
        runId: "run_close",
        principal: runtimePrincipal,
        dependencies,
        currentTime: NOW,
        workflowInput: {
          bindingDigest: sha256Digest("3".repeat(64)),
          value: canonicalValue({ request: "Add a health endpoint" }),
        },
        repositoryBase: BASE,
      }),
    ).toEqual({ kind: "finished" });
    // Two phases, each spawning a real sensor process, exceed the default
    // budget when the suite runs in parallel.
  }, 30_000);

  it("recovers an in-flight dispatch instead of dispatching it twice", async () => {
    const project = await authoredProject();
    const paths = {
      databasePath: join(project, "authority.db"),
      assetDirectory: join(project, "assets"),
    };
    const started = await startAuthoredRun({
      projectRoot: project,
      ...paths,
      dependencies,
      repositoryId: "repository_restart",
      runId: "run_restart",
      principal: runtimePrincipal,
      input: canonicalValue({ request: "Add a health endpoint" }),
      currentTime: NOW,
      repositoryBase: BASE,
    });

    // Every call opens the state root fresh, so this is what a restart sees.
    const advance = () =>
      advanceRun({
        projectRoot: project,
        ...paths,
        repositoryId: "repository_restart",
        runId: "run_restart",
        principal: runtimePrincipal,
        dependencies,
        currentTime: NOW,
        workflowInput: {
          bindingDigest: sha256Digest("3".repeat(64)),
          value: canonicalValue({ request: "Add a health endpoint" }),
        },
        repositoryBase: BASE,
      });

    expect(await advance()).toEqual({ kind: "awaiting-agent", phaseKey: "define" });
    expect(await advance()).toEqual({ kind: "awaiting-agent", phaseKey: "define" });

    const broker = new SqliteContextBroker({
      databasePath: paths.databasePath,
      dependencies: {
        sha256: dependencies.sha256,
        currentTime: () => NOW,
        issueGrantToken: () => new Uint8Array(32),
      },
    });
    try {
      // A driver that re-dispatched would leave the phase with two agents.
      const dispatches = broker.listWorkerDispatches("repository_restart", "run_restart");
      expect(dispatches.map(({ dispatch }) => dispatch.dispatchId)).toEqual([started.dispatchId]);
    } finally {
      broker.close();
    }
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

// The window is between registering a dispatch and enqueuing its runner
// command. A supervisor stopped inside it leaves a dispatch no recovery can
// see, because they all key off an intent that was never written.
describe("a dispatch the runner was never told about", () => {
  const worker = (dispatchId: string, status: string | undefined) => ({
    intent: { command: { kind: "worker", input: { dispatchId } } },
    ...(status === undefined ? {} : { outcome: { status } }),
  });

  it("is left behind when the runner has finished everything else", () => {
    expect(dispatchNeverStarted([worker("dispatch_ran", "completed")], "dispatch_lost")).toBe(true);
  });

  it("is not claimed when the runner is still working", () => {
    expect(
      dispatchNeverStarted(
        [worker("dispatch_ran", "completed"), worker("dispatch_busy", "active")],
        "dispatch_lost",
      ),
    ).toBe(false);
  });

  // A scheduler that has not run yet looks exactly like one that skipped this
  // dispatch. Retrying here would dispatch a second agent for the same turn.
  it("is not claimed before the runner has been given anything", () => {
    expect(dispatchNeverStarted([], "dispatch_lost")).toBe(false);
  });

  it("is not claimed for a dispatch the runner does hold", () => {
    expect(dispatchNeverStarted([worker("dispatch_lost", "completed")], "dispatch_lost")).toBe(
      false,
    );
  });

  it("ignores work that is not an agent's turn", () => {
    const git = {
      intent: { command: { kind: "git", input: {} } },
      outcome: { status: "completed" },
    };
    expect(dispatchNeverStarted([git], "dispatch_lost")).toBe(true);
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
    gates: [define]

  - name: verify
    agent: verifier
    needs: [define]
    output: schemas/verification.schema.json
    gates: [define]
`;

async function authoredProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "senawa-advance-"));
  roots.add(root);
  const configuration = join(root, ".senawa");
  await mkdir(join(configuration, "prompts"), { recursive: true });
  await mkdir(join(configuration, "schemas"), { recursive: true });
  await writeFile(join(configuration, "agents.yaml"), AGENTS);
  await writeFile(join(configuration, "workflow.yaml"), WORKFLOW);
  await writeFile(
    join(configuration, "sensors.yaml"),
    `sensors:
  always-ready:
    run: "true"
    deterministic: true

gates:
  define:
    blocking:
      - sensor: always-ready
        exitCode: 0
`,
  );
  await writeFile(
    join(configuration, "prompts", "definer.md"),
    "Define the work.\n\nRequest: ${{ input.request }}\n",
  );
  await writeFile(join(configuration, "prompts", "verifier.md"), "Verify the work.\n");
  for (const [name, id] of [
    ["request.schema.json", "urn:senawa:request"],
    ["definition.schema.json", "urn:senawa:definition"],
    ["verification.schema.json", "urn:senawa:verification"],
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

/** Drives one dispatch to a published output and an accepted completion, with no model. */
async function completeDispatch(
  projectRoot: string,
  paths: { readonly databasePath: string; readonly assetDirectory: string },
  dispatchId: string,
): Promise<void> {
  const loaded = await loadAuthoredWorkflow(projectRoot, dependencies.sha256);
  const snapshot = loaded.snapshot;
  if (snapshot === undefined) throw new Error("Fixture workflow does not compile");
  const authority = new SqliteAuthority({ ...paths, dependencies });
  const assets = new SqliteCanonicalJsonAssetStore(authority);
  const broker = new SqliteContextBroker({
    databasePath: paths.databasePath,
    dependencies: {
      sha256: dependencies.sha256,
      currentTime: () => NOW,
      issueGrantToken: () => new Uint8Array(32),
    },
  });
  try {
    const stored = broker
      .listWorkerDispatches("repository_close", "run_close")
      .find((entry) => entry.dispatch.dispatchId === dispatchId);
    if (stored === undefined) throw new Error("Dispatch was not stored");
    const declaration = stored.context.phaseOutputDeclarations[0];
    if (declaration === undefined) throw new Error("Phase declares no output");
    const value = canonicalValue({ definition: "Scripted definition" });
    const installed = assets.install(value);
    const contract = runtimeSchemaContract(
      snapshot,
      String(declaration.schemaKey),
      dependencies.sha256,
    );
    const receipt = canonicalDigest(
      canonicalValue({
        boundary: "phase output",
        schemaKey: String(contract.key),
        schemaResourceDigest: String(contract.schemaResourceDigest),
        validatorProfileDigest: String(contract.validatorProfileDigest),
        contentDigest: String(installed.contentDigest),
        findings: [],
      }),
      dependencies.sha256,
    );
    broker.installCanonicalOutputAsset(
      {
        contentDigest: installed.contentDigest,
        byteLength: installed.byteLength,
        mediaType: "application/json",
        schemaResourceDigest: declaration.schemaResourceDigest,
        validationReceiptDigest: receipt,
      },
      canonicalBytes(value),
    );
    const suffix = dispatchId.replace("dispatch_", "").slice(0, 30);
    let scriptError: unknown;
    const result = await adapterRun(broker, stored, (session) => {
      try {
        session.submitOutput(`submission_${suffix}o`, {
          phase: stored.context.phaseAttempt.phase,
          outputName: declaration.outputName,
          schemaKey: declaration.schemaKey,
          schemaResourceDigest: declaration.schemaResourceDigest,
          contentDigest: installed.contentDigest,
          byteLength: installed.byteLength,
          mediaType: "application/json",
          graphRevisionDigest: stored.context.graphRevisionDigest,
          configurationSnapshotDigest: stored.context.configurationSnapshotDigest,
          inputBindingDigest: stored.context.phaseInputBinding.bindingDigest,
          validationReceiptDigest: receipt,
        });
        session.complete(`submission_${suffix}c`, {
          task: stored.dispatch.task,
          disposition: "completed",
          summary: "Scripted definition",
          criteria: stored.completionRequirements.criteria.map(({ criterionId }) => ({
            criterionId,
            disposition: "satisfied" as const,
          })),
          completionEvidence: [],
        });
      } catch (error) {
        scriptError = error;
        throw error;
      }
    });
    if (scriptError !== undefined) throw scriptError;
    if (result.status !== "completed") throw new Error(`Scripted worker was ${result.status}`);
  } finally {
    broker.close();
    authority.close();
  }
}

function adapterRun(
  broker: SqliteContextBroker,
  stored: { readonly dispatch: Parameters<SimulatedSerialWorkerAdapter["run"]>[0]["dispatch"] },
  script: Parameters<SimulatedSerialWorkerAdapter["run"]>[1],
) {
  return new SimulatedSerialWorkerAdapter(broker).run({ dispatch: stored.dispatch }, script);
}
