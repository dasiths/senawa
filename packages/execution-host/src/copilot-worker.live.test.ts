import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalDigest,
  canonicalValue,
  consumerKey,
  createPhaseAttempt,
  createPhaseInputBinding,
  createWorkerContextBase,
  createWorkerDispatch,
  createWorkerModelRouteSelection,
  definitionGeneration,
  phaseId,
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
import { deriveLiveWorkerTestTimeout } from "./live-worker-timeout.js";

const liveEnabled = process.env.SENAWA_COPILOT_LIVE === "1";
const modelTimeoutMs = liveEnabled ? positiveIntegerEnvironment("SENAWA_COPILOT_TIMEOUT_MS") : 1;
const liveTestTimeoutMs = deriveLiveWorkerTestTimeout(modelTimeoutMs);
const sha256: Sha256 = {
  digest(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
  },
};
const COMPLETION_PROMPT_TEMPLATE = Object.freeze({
  key: "completion-only-prompt",
  path: "prompts/completion-only.md",
  utf8: "Submit the completion result.\n",
});
const PHASE_OUTPUT_PROMPT_TEMPLATE = Object.freeze({
  key: "phase-output-prompt",
  path: "prompts/phase-output.md",
  utf8:
    "Call senawa_complete exactly once with verified set to true and summary set to one short sentence. " +
    "Then call senawa_complete.\n",
});
const LIVE_OUTPUT_SCHEMA = canonicalValue({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://senawa.test/worker/live-verification-output",
  type: "object",
  additionalProperties: false,
  required: ["verified", "summary"],
  properties: {
    verified: { type: "boolean" },
    summary: { type: "string", minLength: 1, maxLength: 200 },
  },
});
const LIVE_OUTPUT_CONTRACT = Object.freeze({
  key: "verification-output",
  schemaResourceDigest: sha256Digest("e".repeat(64)),
  validatorProfileDigest: sha256Digest("f".repeat(64)),
  schema: LIVE_OUTPUT_SCHEMA,
  externalSchemas: [],
});
const LIVE_OUTPUT_DECLARATION = Object.freeze({
  outputName: consumerKey("verification"),
  schemaKey: consumerKey("verification-output"),
  schemaResourceDigest: LIVE_OUTPUT_CONTRACT.schemaResourceDigest,
  maxBytes: 4_096,
  sensitivity: "internal" as const,
});

describe.skipIf(!liveEnabled)("Copilot live worker", () => {
  it(
    "admits one bounded completion-only dispatch",
    async () => {
      const model = requiredEnvironment("SENAWA_COPILOT_MODEL");
      const maxAiCredits = positiveNumberEnvironment("SENAWA_COPILOT_MAX_AI_CREDITS");
      if (process.env.SENAWA_COPILOT_ACKNOWLEDGE_COST_AND_DATA !== "1") {
        throw new Error("Live Copilot probe requires explicit cost and data acknowledgement");
      }
      const isolatedRoot = await mkdtemp(join(tmpdir(), "senawa-copilot-live-"));
      const workingDirectory = await mkdtemp(join(isolatedRoot, "work-"));
      const baseDirectory = await mkdtemp(join(isolatedRoot, "home-"));
      let port: ProductionCopilotSdkPort | undefined;
      const controller = new AbortController();
      const cancellation = setTimeout(() => controller.abort(), modelTimeoutMs);
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
        const graphRevisionDigest = sha256Digest("1".repeat(64));
        const configurationSnapshotDigest = sha256Digest("2".repeat(64));
        const mappedInput = liveMappedInput();
        const phase = {
          phaseId: phaseId("phase_live-probe"),
          definitionGeneration: definitionGeneration(1),
          attempt: 1,
        };
        const sourceSetDigest = canonicalDigest(canonicalValue({ mappings: [] }), sha256);
        const phaseInputBinding = createPhaseInputBinding(
          {
            phase,
            schemaKey: consumerKey("live-input"),
            schemaResourceDigest: sha256Digest("8".repeat(64)),
            mappings: [],
            contentDigest: mappedInput.valueDigest,
            byteLength: 2,
            validationReceiptDigest: sha256Digest("9".repeat(64)),
            sourceSetDigest,
          },
          sha256,
        );
        const phaseAttempt = createPhaseAttempt(
          {
            repositoryId: "repository_live-probe",
            runId: runId("run_live-probe"),
            phase,
            inputBindingDigest: phaseInputBinding.bindingDigest,
            sourceSetDigest,
            executorDigest: sha256Digest("a".repeat(64)),
            graphRevisionDigest,
            configurationSnapshotDigest,
            upstreamClosureSetDigest: sha256Digest("b".repeat(64)),
            upstreamOutputSetDigest: sha256Digest("c".repeat(64)),
          },
          sha256,
        );
        const context = createWorkerContextBase(
          {
            task,
            graphRevisionDigest,
            configurationSnapshotDigest,
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
            prompt: livePrompt(),
            mappedInput,
            phaseAttempt,
            phaseInputBinding,
            phaseOutputDeclarations: [],
            completionPolicy: {
              criteria: [],
              completionEvidencePolicy: { mode: "none", requirements: [] },
            },
            priorRefusals: [],
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
          promptResource: livePromptReference(),
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
        const broker = new ContextBroker(new InMemoryContextAssetAuthority(sha256), {
          sha256,
          currentTime: () => "2026-08-13T00:00:00.000Z",
          issueGrantToken: () => randomBytes(32),
        });
        broker.registerDispatch({
          context,
          dispatch,
          taskScope: {
            runId: dispatch.runId,
            taskId: dispatch.task.taskId,
            definitionGeneration: dispatch.task.definitionGeneration,
            acceptedContextDigest: context.contextDigest,
            fenceGeneration: 1,
          },
          completionRequirements: {
            task: dispatch.task,
            criteria: [],
            completionEvidencePolicy: { mode: "none", requirements: [] },
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
          timeoutMs: modelTimeoutMs,
          signal: controller.signal,
        });
        expect(result.status).toBe("completed");
      } catch {
        throw new Error("Live Copilot probe failed");
      } finally {
        clearTimeout(cancellation);
        if (port?.clientOwnership === "port-created") {
          try {
            await port.stopOwnedClient();
          } catch {}
        }
        await rm(isolatedRoot, { recursive: true, force: true });
      }
    },
    liveTestTimeoutMs,
  );

  it(
    "submits one bounded schema-validated phase output",
    async () => {
      const model = requiredEnvironment("SENAWA_COPILOT_MODEL");
      const maxAiCredits = positiveNumberEnvironment("SENAWA_COPILOT_MAX_AI_CREDITS");
      if (process.env.SENAWA_COPILOT_ACKNOWLEDGE_COST_AND_DATA !== "1") {
        throw new Error("Live Copilot probe requires explicit cost and data acknowledgement");
      }
      const isolatedRoot = await mkdtemp(join(tmpdir(), "senawa-copilot-live-output-"));
      const workingDirectory = await mkdtemp(join(isolatedRoot, "work-"));
      const baseDirectory = await mkdtemp(join(isolatedRoot, "home-"));
      let port: ProductionCopilotSdkPort | undefined;
      const controller = new AbortController();
      const cancellation = setTimeout(() => controller.abort(), modelTimeoutMs);
      try {
        port = await ProductionCopilotSdkPort.create({
          repositoryDirectory: process.cwd(),
          workingDirectory,
          baseDirectory,
        });
        const task = {
          taskId: taskId("task_submit-phase-output"),
          definitionGeneration: definitionGeneration(1),
        };
        const graphRevisionDigest = sha256Digest("1".repeat(64));
        const configurationSnapshotDigest = sha256Digest("2".repeat(64));
        const mappedInput = liveMappedInput();
        const phase = {
          phaseId: phaseId("phase_live-output-probe"),
          definitionGeneration: definitionGeneration(1),
          attempt: 1,
        };
        const sourceSetDigest = canonicalDigest(canonicalValue({ mappings: [] }), sha256);
        const phaseInputBinding = createPhaseInputBinding(
          {
            phase,
            schemaKey: consumerKey("live-input"),
            schemaResourceDigest: sha256Digest("8".repeat(64)),
            mappings: [],
            contentDigest: mappedInput.valueDigest,
            byteLength: 2,
            validationReceiptDigest: sha256Digest("9".repeat(64)),
            sourceSetDigest,
          },
          sha256,
        );
        const phaseAttempt = createPhaseAttempt(
          {
            repositoryId: "repository_live-output-probe",
            runId: runId("run_live-output-probe"),
            phase,
            inputBindingDigest: phaseInputBinding.bindingDigest,
            sourceSetDigest,
            executorDigest: sha256Digest("a".repeat(64)),
            graphRevisionDigest,
            configurationSnapshotDigest,
            upstreamClosureSetDigest: sha256Digest("b".repeat(64)),
            upstreamOutputSetDigest: sha256Digest("c".repeat(64)),
          },
          sha256,
        );
        const capabilities = [WORKER_CAPABILITIES.phaseOutput, WORKER_CAPABILITIES.completion];
        const context = createWorkerContextBase(
          {
            task,
            graphRevisionDigest,
            configurationSnapshotDigest,
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
            role: { key: consumerKey("phase-output"), roleDigest: sha256Digest("7".repeat(64)) },
            prompt: livePrompt(PHASE_OUTPUT_PROMPT_TEMPLATE),
            mappedInput,
            phaseAttempt,
            phaseInputBinding,
            phaseOutputDeclarations: [LIVE_OUTPUT_DECLARATION],
            completionPolicy: {
              criteria: [],
              completionEvidencePolicy: { mode: "none", requirements: [] },
            },
            priorRefusals: [],
            capabilities,
            budgets: [{ unit: "work-attempt", limit: 1 }],
          },
          sha256,
        );
        const dispatchInput = {
          repositoryId: "repository_live-output-probe",
          runId: runId("run_live-output-probe"),
          ordinal: 1,
          workerPrincipalId: "principal_live-output-probe",
          roleKey: consumerKey("phase-output"),
          capabilities,
          promptResource: livePromptReference(PHASE_OUTPUT_PROMPT_TEMPLATE),
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
            maxTurns: 2,
            maxSubmissions: 2,
            maxMillidollars: 1,
            maxAiCredits,
          },
          context,
          dispatch,
          sha256,
        );
        const broker = new ContextBroker(new InMemoryContextAssetAuthority(sha256), {
          sha256,
          currentTime: () => "2026-08-13T00:00:00.000Z",
          issueGrantToken: () => randomBytes(32),
        });
        broker.registerDispatch({
          context,
          dispatch,
          taskScope: {
            runId: dispatch.runId,
            taskId: dispatch.task.taskId,
            definitionGeneration: dispatch.task.definitionGeneration,
            acceptedContextDigest: context.contextDigest,
            fenceGeneration: 1,
          },
          completionRequirements: {
            task: dispatch.task,
            criteria: [],
            completionEvidencePolicy: { mode: "none", requirements: [] },
          },
        });
        const result = await new CopilotSerialWorkerAdapter(port, sha256).run({
          context,
          dispatch,
          routeSelection: selection,
          broker,
          grantTokens: new Map(),
          phaseOutputSchemas: new Map([["verification", LIVE_OUTPUT_CONTRACT]]),
          workingDirectory,
          sessionBaseDirectory: baseDirectory,
          timeoutMs: modelTimeoutMs,
          signal: controller.signal,
        });
        expect(
          result.submissions.some(
            ({ type, status }) => type === "phase-output" && status === "accepted",
          ),
        ).toBe(true);
      } catch {
        throw new Error("Live Copilot structured output probe failed");
      } finally {
        clearTimeout(cancellation);
        if (port?.clientOwnership === "port-created") {
          try {
            await port.stopOwnedClient();
          } catch {}
        }
        await rm(isolatedRoot, { recursive: true, force: true });
      }
    },
    liveTestTimeoutMs,
  );
});

interface LivePromptTemplate {
  readonly key: string;
  readonly path: string;
  readonly utf8: string;
}

function livePrompt(template: LivePromptTemplate = COMPLETION_PROMPT_TEMPLATE) {
  const key = consumerKey(template.key);
  const path = template.path;
  const utf8 = template.utf8;
  const bytes = new TextEncoder().encode(utf8);
  const contentDigest = sha256Digest(sha256.digest(bytes));
  const inputPaths: readonly string[] = [];
  const source = {
    path,
    mediaType: "text/markdown; charset=utf-8",
    byteLength: bytes.byteLength,
    contentDigest,
    utf8,
  };
  return {
    key,
    path,
    resourceDigest: canonicalDigest(canonicalValue({ key, source, inputPaths }), sha256),
    contentDigest,
    byteLength: bytes.byteLength,
    utf8,
    inputPaths,
  };
}

function livePromptReference(template: LivePromptTemplate = COMPLETION_PROMPT_TEMPLATE) {
  const prompt = livePrompt(template);
  return {
    key: prompt.key,
    resourceDigest: prompt.resourceDigest,
    contentDigest: prompt.contentDigest,
  };
}

function liveMappedInput() {
  const value = canonicalValue({});
  return { value, valueDigest: canonicalDigest(value, sha256) };
}

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
