import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumerKey,
  createWorkerContextBase,
  createWorkerDispatch,
  createWorkerModelRouteSelection,
  definitionGeneration,
  runId,
  type Sha256,
  sha256Digest,
  taskId,
} from "@senawa/kernel";
import {
  ContextBroker,
  InMemoryContextAssetAuthority,
  renderPromptPack,
  WORKER_CAPABILITIES,
} from "@senawa/runtime";
import { describe, expect, it } from "vitest";
import { ProductionCopilotSdkPort } from "./copilot-sdk-production.js";
import { CopilotSerialWorkerAdapter } from "./copilot-worker.js";

const liveEnabled = process.env.SENAWA_COPILOT_LIVE === "1";
const sha256: Sha256 = {
  digest(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
  },
};

describe.skipIf(!liveEnabled)("Copilot live worker", () => {
  it("admits one bounded completion-only dispatch", async () => {
    const model = requiredEnvironment("SENAWA_COPILOT_MODEL");
    const maxAiCredits = positiveNumberEnvironment("SENAWA_COPILOT_MAX_AI_CREDITS");
    const timeoutMs = positiveIntegerEnvironment("SENAWA_COPILOT_TIMEOUT_MS");
    if (process.env.SENAWA_COPILOT_ACKNOWLEDGE_COST_AND_DATA !== "1") {
      throw new Error("Live Copilot probe requires explicit cost and data acknowledgement");
    }
    const isolatedRoot = await mkdtemp(join(tmpdir(), "senawa-copilot-live-"));
    const workingDirectory = await mkdtemp(join(isolatedRoot, "work-"));
    const baseDirectory = await mkdtemp(join(isolatedRoot, "home-"));
    let port: ProductionCopilotSdkPort | undefined;
    try {
      port = await ProductionCopilotSdkPort.create({
        repositoryDirectory: process.cwd(),
        workingDirectory,
        baseDirectory,
      });
      const task = {
        taskId: taskId("task_submit-completion"),
        definitionGeneration: definitionGeneration(1),
      };
      const context = createWorkerContextBase(
        {
          task,
          graphRevisionDigest: sha256Digest("1".repeat(64)),
          configurationSnapshotDigest: sha256Digest("2".repeat(64)),
          contracts: [],
          dependencyBarrier: { task, dependencies: [] },
          assets: [],
          repositoryBase: {
            commitDigest: sha256Digest("3".repeat(64)),
            treeDigest: sha256Digest("4".repeat(64)),
          },
          modelPolicy: {
            key: consumerKey("live-policy"),
            policyDigest: sha256Digest("5".repeat(64)),
            orderedRoutesDigest: sha256Digest("6".repeat(64)),
          },
          role: { key: consumerKey("completion-only"), roleDigest: sha256Digest("7".repeat(64)) },
          capabilities: [WORKER_CAPABILITIES.completion],
          budgets: [{ unit: "work-attempt", limit: 1 }],
        },
        sha256,
      );
      const dispatchInput = {
        repositoryId: "repository_live-probe",
        runId: runId("run_live-probe"),
        ordinal: 1,
        workerPrincipalId: "principal_live-probe",
        roleKey: consumerKey("completion-only"),
        capabilities: [WORKER_CAPABILITIES.completion],
        promptPackDigest: sha256Digest("0".repeat(64)),
      };
      const provisional = createWorkerDispatch(dispatchInput, context, sha256);
      const prompt = renderPromptPack(context, provisional, sha256, 65_536);
      const dispatch = createWorkerDispatch(
        { ...dispatchInput, promptPackDigest: prompt.digest },
        context,
        sha256,
      );
      const selection = createWorkerModelRouteSelection(
        {
          routeIndex: 0,
          provider: "github-copilot",
          model,
          maxTurns: 1,
          maxSubmissions: 1,
          maxMillidollars: 1,
          maxAiCredits,
        },
        context,
        dispatch,
        sha256,
      );
      const broker = new ContextBroker(new InMemoryContextAssetAuthority(), {
        sha256,
        currentTime: () => "2026-08-13T00:00:00.000Z",
        issueGrantToken: () => randomBytes(32),
      });
      broker.registerDispatch({
        context,
        dispatch,
        completionRequirements: {
          task: dispatch.task,
          criteria: [],
          evidencePolicy: { mode: "none", requirements: [] },
        },
      });
      const result = await new CopilotSerialWorkerAdapter(port, sha256).run({
        context,
        dispatch,
        routeSelection: selection,
        broker,
        grantTokens: new Map(),
        workingDirectory,
        sessionBaseDirectory: baseDirectory,
        timeoutMs,
        currentContextDigest: () => context.contextDigest,
        currentTask: () => dispatch.task,
      });
      expect(result.status).toBe("completed");
    } catch {
      throw new Error("Live Copilot probe failed");
    } finally {
      if (port?.clientOwnership === "port-created") {
        try {
          await port.stopOwnedClient();
        } catch {}
      }
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || value.includes("\0")) {
    throw new Error(`Live Copilot probe requires ${name}`);
  }
  return value;
}

function positiveNumberEnvironment(name: string): number {
  const value = Number(requiredEnvironment(name));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Live Copilot probe requires ${name}`);
  return value;
}

function positiveIntegerEnvironment(name: string): number {
  const value = Number(requiredEnvironment(name));
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error(`Live Copilot probe requires ${name}`);
  }
  return value;
}
