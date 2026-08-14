import type { CommandServicePort, RuntimeDependencies, RuntimeQueryPort } from "@senawa/runtime";
import { describe, expect, it } from "vitest";
import {
  createAdmissionFixture,
  createRuntimeGraph,
  runtimeCommand,
  runtimeFixture,
  runtimePrincipal,
} from "./index.js";

export interface RuntimeAuthorityConformanceHarness {
  readonly service: CommandServicePort & RuntimeQueryPort;
  canonicalJson(): string;
  reopen(): RuntimeAuthorityConformanceHarness;
  dispose(): void;
}

export type RuntimeAuthorityConformanceFactory = (
  dependencies: RuntimeDependencies,
) => RuntimeAuthorityConformanceHarness;

export function registerRuntimeAuthorityConformance(
  name: string,
  dependencies: RuntimeDependencies,
  createHarness: RuntimeAuthorityConformanceFactory,
): void {
  describe(`${name} runtime authority conformance`, () => {
    it("persists command history, events, projection, and exact duplicate receipts", () => {
      const harness = createHarness(dependencies);
      let active = harness;
      try {
        const admission = createAdmissionFixture();
        const command = instantiateCommand("command_conformance-instantiate");
        const receipt = harness.service.submit(command, admission.at());
        expect(receipt.status).toBe("completed");
        expect(
          harness.service
            .queryReceiptHistory(runtimeFixture.repositoryId, runtimeFixture.runId)
            .map((entry) => entry.status),
        ).toEqual(["queued", "claimed", "completed"]);
        expect(
          harness.service.queryEvents(runtimeFixture.repositoryId, runtimeFixture.runId),
        ).toHaveLength(3);
        expect(
          harness.service.queryProjection(runtimeFixture.repositoryId, runtimeFixture.runId),
        ).toMatchObject({ payload: { status: "awaiting-completion" } });
        const snapshot = harness.canonicalJson();

        active = harness.reopen();
        expect(active.canonicalJson()).toBe(snapshot);
        expect(active.service.queryReceipt(command.commandId)).toEqual(receipt);
        expect(active.service.submit(command, admission.at())).toEqual(receipt);
        expect(active.canonicalJson()).toBe(snapshot);
      } finally {
        active.dispose();
      }
    });

    it("persists refusal history without granting authority effects", () => {
      const harness = createHarness(dependencies);
      let active = harness;
      try {
        const command = {
          ...instantiateCommand("command_conformance-refused"),
          payloadDigest: "0".repeat(64),
        };
        const receipt = harness.service.submit(command, createAdmissionFixture().at());
        expect(receipt.status).toBe("refused");
        expect(receipt.error?.code).toBe("payload-digest-mismatch");
        expect(
          harness.service.queryProjection(runtimeFixture.repositoryId, runtimeFixture.runId),
        ).toBeUndefined();

        active = harness.reopen();
        expect(active.service.queryReceipt(command.commandId)).toEqual(receipt);
        expect(
          active.service.queryProjection(runtimeFixture.repositoryId, runtimeFixture.runId),
        ).toBeUndefined();
      } finally {
        active.dispose();
      }
    });

    it("enforces one active run per repository and global command identity", () => {
      const harness = createHarness(dependencies);
      try {
        const admission = createAdmissionFixture();
        expect(
          harness.service.submit(instantiateCommand("command_conformance-owner"), admission.at())
            .status,
        ).toBe("completed");
        const conflict = harness.service.submit(
          {
            ...instantiateCommand("command_conformance-other-run"),
            runId: "run_conformance-other",
          },
          admission.at(),
        );
        expect(conflict.status).toBe("refused");
        expect(conflict.error?.code).toBe("repository-run-conflict");
      } finally {
        harness.dispose();
      }
    });
  });
}

function instantiateCommand(commandId: string) {
  return runtimeCommand({
    commandId,
    intent: "instantiate-run",
    payload: {
      workflowId: runtimeFixture.workflowId,
      configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
      execution: runtimeFixture.execution,
      graph: createRuntimeGraph(),
      phase: runtimeFixture.phase,
      approvalPolicy: { policy: "approval-required" as const, authority: runtimePrincipal },
      escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
    },
  });
}
