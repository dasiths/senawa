import type { DurableReceipt } from "@senawa/protocol";
import { PROTOCOL_VERSION } from "@senawa/protocol";
import { describe, expect, it } from "vitest";
import { PlanImportCommandBridge } from "./plan-import-command-bridge.js";

describe("PlanImportCommandBridge", () => {
  it("publishes the result snapshot before one deterministic amendment command", () => {
    const events: string[] = [];
    const receipt = {
      apiVersion: PROTOCOL_VERSION,
      commandId: "command_plan-import-receipt",
      repositoryId: "repository",
      runId: "run",
      status: "completed",
      cursor: 1,
    } satisfies DurableReceipt;
    const proposalDigest = "a".repeat(64);
    const bridge = new PlanImportCommandBridge({
      coordinator: {
        import: () => ({
          status: "proposal-enqueued",
          evaluation: {} as never,
          diff: {} as never,
          proposal: {
            proposalDigest,
            amendmentId: "amendment_example",
          } as never,
        }),
      },
      commands: {
        putConfigurationSnapshot() {
          events.push("snapshot");
        },
        submit(command) {
          events.push("command");
          expect(command).toMatchObject({
            commandId: `command_plan-import-${proposalDigest.slice(0, 32)}`,
            intent: { type: "submit-amendment-proposal" },
            exactObjectDigest: proposalDigest,
          });
          return receipt;
        },
      },
      sha256: { digest: () => "f".repeat(64) },
    });

    const result = bridge.execute(
      {
        evaluation: {
          repositoryId: "repository",
          runId: "run",
          evaluationDigest: "b".repeat(64),
        } as never,
        baseGraph: { revisionDigest: "c".repeat(64) } as never,
      } as never,
      { snapshotDigest: "d".repeat(64) },
    );
    expect(events).toEqual(["snapshot", "command"]);
    expect(result.receipt).toEqual(receipt);
  });
});
