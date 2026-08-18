import {
  type AuthenticatedPrincipal,
  canonicalBytes,
  decodeCommandEnvelope,
  PROTOCOL_VERSION,
} from "@senawa/protocol";
import type { RuntimeDependencies } from "@senawa/runtime";
import { SqliteAuthority, SqlitePortalQueryAuthority } from "@senawa/storage-sqlite";
import type { CliResult } from "./cli.js";

export interface DecideInput {
  readonly databasePath: string;
  readonly assetDirectory: string;
  readonly repositoryId: string;
  readonly runId: string;
  readonly decision: "approve" | "reject";
  readonly reason?: string;
  readonly principal: AuthenticatedPrincipal;
  readonly dependencies: RuntimeDependencies;
  readonly currentTime: string;
}

/**
 * Records a human decision on whatever the run is currently waiting for.
 *
 * The pending need already carries the graph revision and the candidate digest,
 * so a person never computes either. Without this the loop could only be closed
 * from the portal, which the brief says must never be required.
 */
export function decidePhase(input: DecideInput): CliResult {
  if (input.decision === "reject" && (input.reason ?? "").length === 0) {
    return { exitCode: 2, output: "A rejection must carry a reason" };
  }
  let pending: {
    readonly expectedGraphRevision: string;
    readonly exactObjectDigest: string;
    readonly title: string;
  };
  let portal: SqlitePortalQueryAuthority;
  try {
    portal = new SqlitePortalQueryAuthority({
      databasePath: input.databasePath,
      assetDirectory: input.assetDirectory,
      dependencies: input.dependencies,
    });
  } catch {
    // A missing store means no run has been started here, which is worth saying
    // rather than surfacing whatever the driver called the failure.
    return { exitCode: 1, output: `${input.runId}: no such run` };
  }
  try {
    const needs = portal.listHumanNeeds(input.repositoryId, input.runId);
    const candidate = needs.needs.find((need) => need.kind === "candidate-approval");
    if (
      candidate?.expectedGraphRevision === undefined ||
      candidate.exactObjectDigest === undefined
    ) {
      return { exitCode: 1, output: "Nothing is waiting for a decision on this run" };
    }
    pending = {
      expectedGraphRevision: candidate.expectedGraphRevision,
      exactObjectDigest: candidate.exactObjectDigest,
      title: candidate.title,
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
    const payload = {
      decision: input.decision,
      ...(input.reason === undefined || input.reason.length === 0 ? {} : { reason: input.reason }),
    };
    const commandId = `command_decide-${input.dependencies.sha256
      .digest(canonicalBytes({ digest: pending.exactObjectDigest, decision: input.decision }))
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
        intent: { type: "record-authority-decision" },
        expectedGraphRevision: pending.expectedGraphRevision,
        exactObjectDigest: pending.exactObjectDigest,
        payload,
        payloadDigest: input.dependencies.sha256.digest(canonicalBytes(payload)),
      }),
      {
        currentTime: input.currentTime,
        facts: { source: "cli-decision" },
        // Identities are globally unique, so they carry the command they serve.
        allocateId: (kind) => {
          allocation += 1;
          return `${kind}_${commandId.slice(8)}${allocation}`;
        },
      },
    );
    if (receipt.status !== "completed") {
      return {
        exitCode: 1,
        output: `refused: ${receipt.error?.code ?? "unknown"}: ${receipt.error?.message ?? ""}`,
      };
    }
    return { exitCode: 0, output: `${input.decision}d: ${pending.title}` };
  } finally {
    authority.close();
  }
}
