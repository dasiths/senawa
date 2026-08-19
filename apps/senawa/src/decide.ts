import {
  type AuthenticatedPrincipal,
  canonicalBytes,
  decodeCommandEnvelope,
  PROTOCOL_VERSION,
} from "@senawa/protocol";
import type { RuntimeDependencies } from "@senawa/runtime";
import {
  SqliteAuthority,
  SqliteContextBroker,
  SqlitePortalQueryAuthority,
} from "@senawa/storage-sqlite";
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
    return {
      exitCode: 2,
      output: "A rejection must carry a reason. The next attempt is given it word for word.",
    };
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
      return {
        exitCode: 1,
        output:
          "Nothing is waiting for a decision on this run. Run senawa status to see what it is waiting for.",
      };
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

export interface AnswerInput extends Omit<DecideInput, "decision" | "reason"> {
  readonly answer: string;
}

/** Answers a worker's question, so a blocked agent is not the portal's problem alone. */
export function answerQuestion(input: AnswerInput): CliResult {
  if (input.answer.length === 0)
    return {
      exitCode: 2,
      output: "An answer must carry text. The agent that asked reads it as written.",
    };
  let pending: { readonly sourceId: string; readonly title: string };
  let portal: SqlitePortalQueryAuthority;
  try {
    portal = new SqlitePortalQueryAuthority({
      assetDirectory: input.assetDirectory,
      databasePath: input.databasePath,
      dependencies: input.dependencies,
    });
  } catch {
    return { exitCode: 1, output: `${input.runId}: no such run` };
  }
  try {
    const asked = portal
      .listHumanNeeds(input.repositoryId, input.runId)
      .needs.find((need) => need.kind === "question");
    if (asked === undefined)
      return {
        exitCode: 1,
        output:
          "Nothing is waiting for an answer. Run senawa status to see what it is waiting for.",
      };
    pending = { sourceId: asked.sourceId, title: asked.title };
  } finally {
    portal.close();
  }

  const authority = new SqliteAuthority({
    assetDirectory: input.assetDirectory,
    databasePath: input.databasePath,
    dependencies: input.dependencies,
  });
  try {
    const payload = { answer: input.answer, submissionId: pending.sourceId };
    const commandId = `command_answer-${input.dependencies.sha256
      .digest(canonicalBytes(payload))
      .slice(0, 32)}`;
    let allocation = 0;
    const receipt = authority.submit(
      decodeCommandEnvelope({
        apiVersion: PROTOCOL_VERSION,
        commandId,
        intent: { type: "answer-question" },
        payload,
        payloadDigest: input.dependencies.sha256.digest(canonicalBytes(payload)),
        principal: input.principal,
        repositoryId: input.repositoryId,
        runId: input.runId,
        transport: { kind: "cli", requestId: `request_${commandId}` },
      }),
      {
        allocateId: (kind) => {
          allocation += 1;
          return `${kind}_${commandId.slice(8)}${allocation}`;
        },
        currentTime: input.currentTime,
        facts: { source: "cli-answer" },
      },
    );
    if (receipt.status !== "completed") {
      return {
        exitCode: 1,
        output: `refused: ${receipt.error?.code ?? "unknown"}: ${receipt.error?.message ?? ""}`,
      };
    }
    return { exitCode: 0, output: `answered: ${pending.title}` };
  } finally {
    authority.close();
  }
}

export interface SteerInput extends Omit<DecideInput, "decision" | "reason"> {
  readonly instruction: string;
  readonly delivery: "live" | "queued" | "abort-retry";
}

/**
 * Redirects an agent that is already working.
 *
 * The instruction is recorded before anything tries to deliver it, so a run that
 * changes course can always say who changed it and what they said, even when
 * delivery itself fails.
 */
export function steerAgent(input: SteerInput): CliResult {
  if (input.instruction.length === 0)
    return {
      exitCode: 2,
      output: "A steering must carry text. The agent reads it as written.",
    };

  const broker = new SqliteContextBroker({
    databasePath: input.databasePath,
    dependencies: {
      sha256: input.dependencies.sha256,
      currentTime: () => input.currentTime,
      issueGrantToken: () => new Uint8Array(32),
    },
  });
  let live:
    | ReturnType<SqliteContextBroker["authority"]["snapshot"]>["dispatches"][number]
    | undefined;
  try {
    const state = broker.authority.snapshot();
    const finished = new Set(state.terminalCompletions.map((entry) => entry.dispatchId));
    // The newest unfinished dispatch is the agent a person means when they say
    // "the agent": an earlier attempt is history, and a finished one cannot be
    // redirected any more.
    live = state.dispatches
      .filter((candidate) => candidate.runId === input.runId && !finished.has(candidate.dispatchId))
      .sort((left, right) => left.ordinal - right.ordinal)
      .at(-1);
  } finally {
    broker.close();
  }
  if (live === undefined)
    return {
      exitCode: 1,
      output: "No agent is working. Run senawa status to see what the run is waiting for.",
    };

  const authority = new SqliteAuthority({
    assetDirectory: input.assetDirectory,
    databasePath: input.databasePath,
    dependencies: input.dependencies,
  });
  try {
    const payload = {
      contextDigest: live.contextDigest,
      definitionGeneration: live.task.definitionGeneration,
      delivery: input.delivery,
      dispatchId: live.dispatchId,
      instruction: input.instruction,
      taskId: live.task.taskId,
    };
    const commandId = `command_steer-${input.dependencies.sha256
      .digest(canonicalBytes(payload))
      .slice(0, 32)}`;
    let allocation = 0;
    const receipt = authority.submit(
      decodeCommandEnvelope({
        apiVersion: PROTOCOL_VERSION,
        commandId,
        intent: { type: "steer-agent" },
        payload,
        payloadDigest: input.dependencies.sha256.digest(canonicalBytes(payload)),
        principal: input.principal,
        repositoryId: input.repositoryId,
        runId: input.runId,
        transport: { kind: "cli", requestId: `request_${commandId}` },
      }),
      {
        allocateId: (kind) => {
          allocation += 1;
          return `${kind}_${commandId.slice(8)}${allocation}`;
        },
        currentTime: input.currentTime,
        facts: { source: "cli-steer" },
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
      output:
        input.delivery === "abort-retry"
          ? "steered: the attempt will start again carrying your instruction"
          : `steered: ${input.delivery}`,
    };
  } finally {
    authority.close();
  }
}
