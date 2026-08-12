import {
  compileWorkflowGraph,
  consumerKey,
  criterionId,
  definitionGeneration,
  phaseId,
  type Sha256,
  sha256Digest,
  taskId,
  workflowId,
} from "@senawa/kernel";
import {
  type CommandEnvelope,
  type CommandIntent,
  canonicalBytes,
  decodeCommandEnvelope,
  PROTOCOL_VERSION,
} from "@senawa/protocol";
import type { AdmissionFacts, AllocationKind } from "@senawa/runtime";

export interface DeterministicSequence {
  next(): string;
}

export function createSequence(prefix: string): DeterministicSequence {
  let value = 0;
  return {
    next() {
      value += 1;
      return `${prefix}-${value}`;
    },
  };
}

export const deterministicSha256: Sha256 = Object.freeze({
  digest(bytes: Uint8Array): string {
    let accumulator = 0x811c9dc5;
    for (const byte of bytes) {
      accumulator = Math.imul(accumulator ^ byte, 0x01000193) >>> 0;
    }
    return accumulator.toString(16).padStart(8, "0").repeat(8);
  },
});

export const runtimeFixture = Object.freeze({
  repositoryId: "repository_fixture",
  runId: "run_fixture",
  workflowId: workflowId("workflow_fixture"),
  phase: Object.freeze({
    phaseId: phaseId("phase_delivery"),
    definitionGeneration: definitionGeneration(1),
  }),
  task: Object.freeze({
    taskId: taskId("task_verify"),
    definitionGeneration: definitionGeneration(1),
    contextRevisionDigest: sha256Digest("a".repeat(64)),
  }),
  criterionId: criterionId("criterion_verified"),
  dependencyBarrierDigest: sha256Digest("b".repeat(64)),
  escalationPolicyDigest: sha256Digest("c".repeat(64)),
  currentTime: "2026-08-12T12:00:00.000Z",
});

export const runtimePrincipal = Object.freeze({
  issuer: "https://issuer.example.test",
  subject: "user_fixture",
  tenant: "tenant_fixture",
  assurance: "multi-factor" as const,
  roles: Object.freeze(["release-manager"]),
});

export function createRuntimeGraph(revision = 1) {
  return compileWorkflowGraph(
    {
      workflow: {
        id: runtimeFixture.workflowId,
        key: consumerKey("fixture"),
        generation: definitionGeneration(1),
        source: { locator: "fixture://runtime", pointer: "" },
      },
      phases: [
        {
          id: runtimeFixture.phase.phaseId,
          key: consumerKey("delivery"),
          generation: runtimeFixture.phase.definitionGeneration,
          parentId: runtimeFixture.workflowId,
          source: { locator: "fixture://runtime", pointer: "/phases/delivery" },
        },
      ],
      executableWork: [
        {
          id: runtimeFixture.task.taskId,
          key: consumerKey("verify"),
          generation: runtimeFixture.task.definitionGeneration,
          parentId: runtimeFixture.phase.phaseId,
          source: { locator: "fixture://runtime", pointer: "/tasks/verify" },
          completionPolicy: {
            criteria: [{ criterionId: runtimeFixture.criterionId, required: true }],
            evidencePolicy: { mode: "none", requirements: [] },
          },
          input: { revision },
        },
      ],
      criteria: [
        {
          id: runtimeFixture.criterionId,
          key: consumerKey("verified"),
          generation: definitionGeneration(1),
          parentId: runtimeFixture.task.taskId,
          source: { locator: "fixture://runtime", pointer: "/criteria/verified" },
        },
      ],
    },
    deterministicSha256,
  );
}

export function createAdmissionFixture(): {
  at(currentTime?: string): AdmissionFacts;
} {
  let approval = 0;
  let streamEvent = 0;
  return {
    at(currentTime = runtimeFixture.currentTime): AdmissionFacts {
      return {
        currentTime,
        facts: { source: "runtime-conformance" },
        allocateId(kind: AllocationKind): string {
          if (kind === "approval") {
            approval += 1;
            return `approval_fixture-${approval}`;
          }
          streamEvent += 1;
          return `stream-event-${streamEvent}`;
        },
      };
    },
  };
}

export interface RuntimeCommandFixtureInput {
  readonly commandId: string;
  readonly intent: CommandIntent["type"];
  readonly payload: unknown;
  readonly expectedDefinitionRevision?: string;
  readonly expectedGraphRevision?: string;
  readonly exactObjectDigest?: string;
  readonly expiresAt?: string;
  readonly roles?: readonly string[];
}

export function runtimeCommand(input: RuntimeCommandFixtureInput): CommandEnvelope {
  const payloadDigest = deterministicSha256.digest(canonicalBytes(input.payload));
  return decodeCommandEnvelope({
    apiVersion: PROTOCOL_VERSION,
    commandId: input.commandId,
    principal: { ...runtimePrincipal, roles: input.roles ?? runtimePrincipal.roles },
    transport: { kind: "cli", requestId: `request_${input.commandId}` },
    repositoryId: runtimeFixture.repositoryId,
    runId: runtimeFixture.runId,
    intent: { type: input.intent },
    payload: input.payload,
    payloadDigest,
    ...(input.expectedDefinitionRevision === undefined
      ? {}
      : { expectedDefinitionRevision: input.expectedDefinitionRevision }),
    ...(input.expectedGraphRevision === undefined
      ? {}
      : { expectedGraphRevision: input.expectedGraphRevision }),
    ...(input.exactObjectDigest === undefined
      ? {}
      : { exactObjectDigest: input.exactObjectDigest }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  });
}
