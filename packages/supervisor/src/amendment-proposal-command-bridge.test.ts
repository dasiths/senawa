import type { JsonValue, SupervisorReceipt } from "@senawa/protocol";
import type { SqliteContextBroker } from "@senawa/storage-sqlite";
import { deterministicSha256 } from "@senawa/testing";
import { describe, expect, it } from "vitest";
import {
  type AmendmentCompilerPort,
  AmendmentProposalCommandBridge,
} from "./amendment-proposal-command-bridge.js";
import type { SqliteSupervisorAuthority } from "./command-queue.js";

const digest = (character: string) => character.repeat(64);

describe("AmendmentProposalCommandBridge", () => {
  it("redelivers exact source and acknowledges only after a terminal queue receipt", () => {
    const source = {
      submission: {
        repositoryId: "repository_bridge",
        runId: "run_bridge",
        amendment: {
          baseContextDigest: digest("a"),
          baseGraphRevisionDigest: digest("b"),
        },
      },
      context: {
        contextDigest: digest("a"),
        graphRevisionDigest: digest("b"),
        configurationSnapshotDigest: digest("c"),
      },
    };
    const claim = {
      submissionId: "submission_bridge",
      sourceDigest: digest("d"),
      ownerId: "owner_bridge",
      fence: 1,
      expiresAt: "2026-08-13T12:00:30.000Z",
    };
    const baseConfigurationSnapshot = { snapshotDigest: digest("c") };
    const resultConfigurationSnapshot = { snapshotDigest: digest("e") };
    const phaseCandidateHistory = [{ phaseId: "phase_build", definitionGeneration: 1 }];
    const proposal = {
      amendmentId: `amendment_${digest("f")}`,
      baseContextDigest: digest("a"),
      baseGraph: { revisionDigest: digest("b") },
      proposalDigest: digest("f"),
    } as unknown as JsonValue;
    let accepts = 0;
    let acknowledgements = 0;
    let loseTerminalResponse = true;
    const receipts = [receipt("queued"), receipt("terminal"), receipt("terminal")];
    const authority = {
      dependencies: { sha256: deterministicSha256 },
      commandAuthority: {
        getConfigurationSnapshot: (snapshotDigest: string) =>
          snapshotDigest === digest("c") ? baseConfigurationSnapshot : undefined,
        queryPhaseCandidateHistory: () => phaseCandidateHistory,
        putConfigurationSnapshot: (snapshot: unknown) => {
          expect(snapshot).toBe(resultConfigurationSnapshot);
        },
      },
      accept: ({ envelope }: { readonly envelope: unknown }) => {
        expect(envelope).toMatchObject({
          repositoryId: "repository_bridge",
          runId: "run_bridge",
          intent: { type: "submit-amendment-proposal" },
          expectedGraphRevision: digest("b"),
          exactObjectDigest: digest("f"),
        });
        const next = receipts[accepts];
        accepts += 1;
        if (next === undefined) throw new Error("unexpected bridge acceptance");
        return next;
      },
      appendLog: () => {
        throw new Error("unexpected compiler diagnostics");
      },
    } as unknown as SqliteSupervisorAuthority;
    const broker = {
      claimAmendmentProposalOutbox: () => claim,
      readClaimedAmendmentProposal: () => source,
      completeAmendmentProposalOutbox: () => {
        acknowledgements += 1;
        return true;
      },
    } as unknown as SqliteContextBroker;
    const compiler: AmendmentCompilerPort = {
      compile: (input) => {
        expect(input).toEqual({ source, baseConfigurationSnapshot, phaseCandidateHistory });
        return { status: "compiled", proposal, resultConfigurationSnapshot };
      },
    };
    const bridge = new AmendmentProposalCommandBridge({
      authority,
      broker: () => broker,
      compiler,
      ownerId: "owner_bridge",
      currentTime: () => "2026-08-13T12:00:00.000Z",
      afterTerminalBeforeAcknowledge: () => {
        if (loseTerminalResponse) throw new Error("lost response after terminal queue commit");
      },
    });

    expect(bridge.deliverOnce()).toBe(true);
    expect(acknowledgements).toBe(0);
    expect(() => bridge.deliverOnce()).toThrow("lost response after terminal queue commit");
    expect(acknowledgements).toBe(0);

    loseTerminalResponse = false;
    expect(bridge.deliverOnce()).toBe(true);
    expect(acknowledgements).toBe(1);
    expect(accepts).toBe(3);
  });
});

function receipt(status: "queued" | "terminal"): SupervisorReceipt {
  return {
    sequence: status === "queued" ? 1 : 3,
    commandId: `command_worker-amendment-${digest("f").slice(0, 32)}`,
    repositoryId: "repository_bridge",
    runId: "run_bridge",
    status,
    recordedAt: "2026-08-13T12:00:00.000Z",
    ...(status === "terminal"
      ? {
          terminalReceipt: {
            apiVersion: "senawa.dev/protocol/v1",
            commandId: `command_worker-amendment-${digest("f").slice(0, 32)}`,
            repositoryId: "repository_bridge",
            runId: "run_bridge",
            status: "completed" as const,
            cursor: 1,
            result: {},
          },
        }
      : {}),
  };
}
