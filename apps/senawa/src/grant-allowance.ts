import type { AuthenticatedPrincipal } from "@senawa/protocol";
import { canonicalBytes, decodeCommandEnvelope, PROTOCOL_VERSION } from "@senawa/protocol";
import type { RuntimeDependencies } from "@senawa/runtime";
import { SqliteAuthority, SqlitePortalQueryAuthority } from "@senawa/storage-sqlite";
import type { CliResult } from "./cli.js";

export interface GrantAllowanceInput {
  readonly databasePath: string;
  readonly assetDirectory: string;
  readonly repositoryId: string;
  readonly runId: string;
  readonly increaseBy?: number;
  readonly principal: AuthenticatedPrincipal;
  readonly dependencies: RuntimeDependencies;
  readonly currentTime: string;
}

export function grantAllowance(input: GrantAllowanceInput): CliResult {
  let portal: SqlitePortalQueryAuthority;
  try {
    portal = new SqlitePortalQueryAuthority({
      databasePath: input.databasePath,
      assetDirectory: input.assetDirectory,
      dependencies: input.dependencies,
    });
  } catch {
    return { exitCode: 1, output: `${input.runId}: no such run` };
  }
  let pending: {
    readonly payload: Record<string, unknown>;
    readonly expectedGraphRevision: string;
    readonly exactObjectDigest: string;
    readonly unit: string;
    readonly newLimit: number;
  };
  try {
    const needs = portal.listHumanNeeds(input.repositoryId, input.runId);
    const escalations = needs.needs.filter((need) => need.kind === "escalation");
    const grantable = escalations.find((need) => need.allowedCommands.includes("grant-allowance"));
    if (grantable === undefined) {
      // Saying "nothing is waiting" when an escalation is sitting right there,
      // just not grantable, sends a person looking in the wrong place.
      return {
        exitCode: 1,
        output:
          escalations.length === 0
            ? "No allowance has been asked for on this run. Run senawa status to see what it is waiting for."
            : `The ${String(escalations.length)} allowance request(s) on this run cannot be granted from here: the budget they name has already moved. Run senawa status to see what it is waiting for.`,
      };
    }
    const review = portal.getAllowanceReview(input.repositoryId, input.runId, grantable.sourceId);
    if (review === undefined) {
      return { exitCode: 1, output: "The allowance request moved while it was being read." };
    }
    // Without a number a person means "give it room", and the policy already
    // says how much room there is. Asking them to guess it helps nobody.
    const increaseBy = input.increaseBy ?? review.maxIncrease;
    if (!Number.isSafeInteger(increaseBy) || increaseBy < 1 || increaseBy > review.maxIncrease) {
      return {
        exitCode: 2,
        output: `The increase must be a whole number between 1 and ${String(review.maxIncrease)}.`,
      };
    }
    pending = {
      payload: {
        escalationCommandId: review.escalationCommandId,
        operationId: review.operationId,
        escalationDigest: review.escalationDigest,
        policyDigest: review.allowancePolicyDigest,
        unit: review.unit,
        expectedLimit: review.currentLimit,
        expectedRunModeRevision: review.expectedRunModeRevision,
        increaseBy,
      },
      expectedGraphRevision: review.expectedGraphRevision,
      exactObjectDigest: review.escalationDigest,
      unit: review.unit,
      newLimit: review.currentLimit + increaseBy,
    };
  } finally {
    portal.close();
  }

  const authority = new SqliteAuthority({
    databasePath: input.databasePath,
    assetDirectory: input.assetDirectory,
    dependencies: input.dependencies,
  });
  try {
    const commandId = `command_grant-${input.dependencies.sha256
      .digest(canonicalBytes(pending.payload))
      .slice(0, 32)}`;
    let allocation = 0;
    const receipt = authority.submit(
      decodeCommandEnvelope({
        apiVersion: PROTOCOL_VERSION,
        commandId,
        principal: input.principal,
        transport: { kind: "cli", requestId: `request_${commandId}` },
        repositoryId: input.repositoryId,
        runId: input.runId,
        intent: { type: "grant-allowance" },
        expectedGraphRevision: pending.expectedGraphRevision,
        exactObjectDigest: pending.exactObjectDigest,
        payload: pending.payload,
        payloadDigest: input.dependencies.sha256.digest(canonicalBytes(pending.payload)),
      }),
      {
        currentTime: input.currentTime,
        facts: { source: "cli-allowance" },
        allocateId: (kind) => {
          allocation += 1;
          return `${kind}_${commandId.slice(8)}${String(allocation)}`;
        },
      },
    );
    if (receipt.status !== "completed") {
      return {
        exitCode: 1,
        output: `refused: ${receipt.error?.code ?? "unknown"}: ${receipt.error?.message ?? ""}`,
      };
    }
    return {
      exitCode: 0,
      output: `granted: ${pending.unit} may now spend ${String(pending.newLimit)}`,
    };
  } finally {
    authority.close();
  }
}
