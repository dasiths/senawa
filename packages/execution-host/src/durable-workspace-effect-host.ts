import type { GitRevisionDescriptor, IntegrationBarrier, IntegrationMember } from "@senawa/kernel";
import { canonicalBytes, type JsonValue } from "@senawa/protocol";
import type {
  AsyncEffectHost,
  AsyncEffectHostContext,
  EffectInspection,
  EffectIntent,
  EffectObservation,
  IntegrationAttemptRecord,
  WorkspaceIntegrationAuthorityPort,
} from "@senawa/runtime";
import type { GitCommandEnvironment } from "./git-command.js";
import type {
  GitIntegrationAdapter,
  GitIntegrationGateResult,
  GitIntegrationMember,
  GitPublicationInspection,
  GitPublicationResult,
} from "./git-integration.js";
import type { GitWorkspaceAdapter } from "./git-workspace.js";

export type DurableWorkspaceOperation =
  | "prepare-workspace"
  | "capture-workspace"
  | "prepare-integration"
  | "validate-integration"
  | "publish-integration"
  | "remove-workspace";

export interface DurableWorkspaceEffectHostOptions {
  readonly authority: WorkspaceIntegrationAuthorityPort;
  readonly workspace: GitWorkspaceAdapter;
  readonly integration: GitIntegrationAdapter;
  readonly identity: GitCommandEnvironment;
  readonly sha256: { digest(bytes: Uint8Array): string };
  readonly evaluateIntegration: (
    workspaceRoot: string,
    signal: AbortSignal | undefined,
  ) => Promise<GitIntegrationGateResult>;
  readonly recordTrustedBarrier: (
    repositoryId: string,
    runId: string,
    integrationId: string,
    barrier: IntegrationBarrier,
  ) => void;
  readonly currentTrustedBarrier?: (
    repositoryId: string,
    runId: string,
  ) => IntegrationBarrier | undefined;
  currentTime(): string;
}

interface PrepareWorkspaceInput {
  readonly operation: "prepare-workspace";
  readonly workspaceId: string;
  readonly dispatchId: string;
  readonly taskId: string;
  readonly definitionGeneration: number;
  readonly baseRevision: GitRevisionDescriptor;
  readonly inspectEffectId: string;
}

interface CaptureWorkspaceInput {
  readonly operation: "capture-workspace";
  readonly workspaceId: string;
  readonly resultId: string;
  readonly completionFactDigest: string;
  readonly inspectEffectId: string;
  readonly message: string;
}

interface IntegrationEffectMember {
  readonly workspaceId: string;
  readonly resultId: string;
  readonly member: IntegrationMember;
  readonly resultRevision: GitRevisionDescriptor;
}

interface PrepareIntegrationInput {
  readonly operation: "prepare-integration";
  readonly integrationId: string;
  readonly phaseId: string;
  readonly definitionGeneration: number;
  readonly targetRef: string;
  readonly fanInDigest: string;
  readonly beforeRevision: GitRevisionDescriptor;
  readonly members: readonly IntegrationEffectMember[];
  readonly inspectEffectId: string;
}

interface ValidateIntegrationInput {
  readonly operation: "validate-integration";
  readonly integrationId: string;
  readonly candidateRevision: GitRevisionDescriptor;
  readonly policyDigest: string;
}

interface PublishIntegrationInput {
  readonly operation: "publish-integration";
  readonly integrationId: string;
  readonly expectedOld: GitRevisionDescriptor;
  readonly candidateRevision: GitRevisionDescriptor;
  readonly barrier: IntegrationBarrier;
}

interface RemoveWorkspaceInput {
  readonly operation: "remove-workspace";
  readonly workspaceId: string;
}

type GitEffectInput =
  | PrepareWorkspaceInput
  | CaptureWorkspaceInput
  | PrepareIntegrationInput
  | ValidateIntegrationInput
  | PublishIntegrationInput
  | RemoveWorkspaceInput;

export class DurableWorkspaceEffectHost implements AsyncEffectHost {
  readonly authority: WorkspaceIntegrationAuthorityPort;
  readonly workspace: GitWorkspaceAdapter;
  readonly integration: GitIntegrationAdapter;
  readonly #identity: GitCommandEnvironment;
  readonly #sha256: { digest(bytes: Uint8Array): string };
  readonly #evaluateIntegration: DurableWorkspaceEffectHostOptions["evaluateIntegration"];
  readonly #recordTrustedBarrier: DurableWorkspaceEffectHostOptions["recordTrustedBarrier"];
  readonly #currentTrustedBarrier: DurableWorkspaceEffectHostOptions["currentTrustedBarrier"];
  readonly #currentTime: () => string;

  constructor(options: DurableWorkspaceEffectHostOptions) {
    this.authority = options.authority;
    this.workspace = options.workspace;
    this.integration = options.integration;
    this.#identity = options.identity;
    this.#sha256 = options.sha256;
    this.#evaluateIntegration = options.evaluateIntegration;
    this.#recordTrustedBarrier = options.recordTrustedBarrier;
    this.#currentTrustedBarrier = options.currentTrustedBarrier;
    this.#currentTime = options.currentTime;
  }

  async dispatch(
    intent: EffectIntent,
    context: AsyncEffectHostContext,
  ): Promise<EffectObservation> {
    const input = decodeGitEffect(intent);
    switch (input.operation) {
      case "prepare-workspace":
        return this.#prepareWorkspace(intent, input, context);
      case "capture-workspace":
        return this.#captureWorkspace(intent, input, context);
      case "prepare-integration":
        return this.#prepareIntegration(intent, input, context);
      case "validate-integration":
        return this.#validateIntegration(intent, input, context);
      case "publish-integration":
        return this.#publishIntegration(intent, input, context);
      case "remove-workspace":
        return this.#removeWorkspace(intent, input);
    }
  }

  async inspect(intent: EffectIntent, context: AsyncEffectHostContext): Promise<EffectInspection> {
    const input = decodeGitEffect(intent);
    const now = this.#currentTime();
    if (input.operation === "prepare-workspace" || input.operation === "remove-workspace") {
      const record = this.#workspaceRecord(intent, input.workspaceId);
      if (record === undefined) return { status: "missing", observedAt: now };
      const inspection = await this.workspace.inspect(
        this.workspace.describe({
          workspaceId: record.workspaceId,
          baseRevision: record.baseRevision.revision,
          signal: context.signal,
        }),
      );
      if (input.operation === "remove-workspace") {
        return inspection.status === "absent"
          ? this.#inspection("completed", input)
          : this.#inspection(inspection.status === "exact" ? "active" : "unknown", input);
      }
      return inspection.status === "exact"
        ? this.#inspection("completed", input)
        : this.#inspection(inspection.status === "absent" ? "missing" : "unknown", input);
    }
    if (input.operation === "capture-workspace") {
      const result = this.authority
        .listWorkspaceResults(intent.command.repositoryId, intent.command.runId)
        .find(({ resultId }) => resultId === input.resultId);
      return result === undefined
        ? { status: "missing", observedAt: now }
        : this.#inspection("completed", input, result.resultRevision.revision);
    }
    const attempt = this.#integrationAttempt(intent, input.integrationId);
    if (attempt === undefined) return { status: "missing", observedAt: now };
    if (input.operation === "publish-integration") {
      if (attempt.state === "barrier-recorded") return this.#inspection("completed", input);
      let claimed = this.#claimIntegration(intent, input.integrationId, context);
      let owner = required(claimed.ownerId, "Integration owner");
      let fence = required(claimed.fence, "Integration fence");
      this.#advanceToPublishing(intent, input.integrationId, owner, fence);
      let publication: GitPublicationInspection | GitPublicationResult =
        await this.integration.inspectPublication(
          input.expectedOld,
          input.candidateRevision,
          context.signal,
        );
      if (publication.status === "old") {
        claimed = this.#claimIntegration(intent, input.integrationId, context);
        owner = required(claimed.ownerId, "Integration owner");
        fence = required(claimed.fence, "Integration fence");
        this.#advanceToPublishing(intent, input.integrationId, owner, fence);
        publication = await this.integration.publish({
          integrationId: input.integrationId,
          expectedOld: input.expectedOld,
          candidateRevision: input.candidateRevision,
          reassertAuthority: () => {
            claimed = this.#claimIntegration(intent, input.integrationId, context);
            owner = required(claimed.ownerId, "Integration owner");
            fence = required(claimed.fence, "Integration fence");
            this.#advanceToPublishing(intent, input.integrationId, owner, fence);
          },
          signal: context.signal,
        });
      }
      const current = this.#advanceToPublishing(intent, input.integrationId, owner, fence);
      if (
        publication.status === "new" ||
        publication.status === "published" ||
        publication.status === "already-published"
      ) {
        if (current.state !== "published") {
          this.authority.recordIntegrationState(
            intent.command.repositoryId,
            intent.command.runId,
            input.integrationId,
            "published",
            owner,
            fence,
            this.#currentTime(),
          );
        }
        this.#recordBarrier(intent, input, owner, fence);
        return this.#inspection("completed", input, publication);
      }
      this.authority.recordIntegrationState(
        intent.command.repositoryId,
        intent.command.runId,
        input.integrationId,
        "target-moved",
        owner,
        fence,
        this.#currentTime(),
      );
      return this.#inspection("cancelled", input, publication);
    }
    return terminalIntegrationState(attempt.state)
      ? this.#inspection(attempt.state === "barrier-recorded" ? "completed" : "cancelled", input)
      : this.#inspection("active", input);
  }

  async cancel(intent: EffectIntent, _context: AsyncEffectHostContext): Promise<EffectObservation> {
    const input = decodeGitEffect(intent);
    if (input.operation === "publish-integration") {
      const attempt = this.#integrationAttempt(intent, input.integrationId);
      if (
        attempt?.state === "publishing" ||
        attempt?.state === "published" ||
        attempt?.state === "barrier-recorded"
      ) {
        return this.#observation("unknown", input, {
          reason: "publication-linearization-uncertain",
        });
      }
    }
    if (
      input.operation === "prepare-integration" ||
      input.operation === "validate-integration" ||
      input.operation === "publish-integration"
    ) {
      const attempt = this.#integrationAttempt(intent, input.integrationId);
      if (attempt?.ownerId !== undefined && attempt.fence !== undefined) {
        this.authority.recordIntegrationState(
          intent.command.repositoryId,
          intent.command.runId,
          input.integrationId,
          "cancelled",
          attempt.ownerId,
          attempt.fence,
          this.#currentTime(),
        );
      }
    }
    return this.#observation("cancelled", input);
  }

  workspaceRoot(repositoryId: string, runId: string, workspaceId: string): string | undefined {
    const record = this.authority
      .listWorkspaces(repositoryId, runId)
      .find((candidate) => candidate.workspaceId === workspaceId && candidate.state !== "removed");
    return record === undefined
      ? undefined
      : this.workspace.describe({
          workspaceId: record.workspaceId,
          baseRevision: record.baseRevision.revision,
        }).path;
  }

  async #prepareWorkspace(
    intent: EffectIntent,
    input: PrepareWorkspaceInput,
    context: AsyncEffectHostContext,
  ): Promise<EffectObservation> {
    const record = this.authority.persistWorkspaceIntent({
      repositoryId: intent.command.repositoryId,
      runId: intent.command.runId,
      workspaceId: input.workspaceId,
      dispatchId: input.dispatchId,
      taskId: input.taskId,
      definitionGeneration: input.definitionGeneration,
      baseRevision: input.baseRevision,
      prepareEffectId: intent.command.commandId,
      inspectEffectId: input.inspectEffectId,
    });
    const described = this.workspace.describe({
      workspaceId: input.workspaceId,
      baseRevision: input.baseRevision,
    });
    const inspection = await this.workspace.inspect(described);
    const prepared =
      inspection.status === "exact"
        ? inspection.workspace
        : await this.workspace.prepare({
            workspaceId: input.workspaceId,
            baseRevision: input.baseRevision,
            signal: context.signal,
          });
    if (record.state !== "prepared") {
      this.authority.recordWorkspaceState(
        intent.command.repositoryId,
        intent.command.runId,
        input.workspaceId,
        "prepared",
      );
    }
    return this.#observation("completed", input, { workspaceId: prepared.workspaceId });
  }

  async #captureWorkspace(
    intent: EffectIntent,
    input: CaptureWorkspaceInput,
    context: AsyncEffectHostContext,
  ): Promise<EffectObservation> {
    const existing = this.authority
      .listWorkspaceResults(intent.command.repositoryId, intent.command.runId)
      .find(({ resultId }) => resultId === input.resultId);
    if (existing !== undefined) {
      return this.#observation("completed", input, existing.resultRevision.revision);
    }
    const record = required(this.#workspaceRecord(intent, input.workspaceId), "Workspace");
    if (record.state === "prepared") {
      this.authority.recordWorkspaceState(
        intent.command.repositoryId,
        intent.command.runId,
        input.workspaceId,
        "capture-intent",
      );
    }
    const resultRevision = await this.workspace.capture({
      workspace: this.workspace.describe({
        workspaceId: record.workspaceId,
        baseRevision: record.baseRevision.revision,
      }),
      identity: this.#identity,
      message: input.message,
      signal: context.signal,
    });
    this.authority.persistWorkspaceResult({
      repositoryId: intent.command.repositoryId,
      runId: intent.command.runId,
      resultId: input.resultId,
      workspaceId: input.workspaceId,
      resultRevision,
      completionFactDigest: input.completionFactDigest,
      captureEffectId: intent.command.commandId,
      inspectEffectId: input.inspectEffectId,
      recordedAt: this.#currentTime(),
    });
    return this.#observation("completed", input, resultRevision);
  }

  async #prepareIntegration(
    intent: EffectIntent,
    input: PrepareIntegrationInput,
    context: AsyncEffectHostContext,
  ): Promise<EffectObservation> {
    this.authority.persistIntegrationIntent({
      repositoryId: intent.command.repositoryId,
      runId: intent.command.runId,
      integrationId: input.integrationId,
      phaseId: input.phaseId,
      definitionGeneration: input.definitionGeneration,
      targetRef: input.targetRef,
      fanInDigest: input.fanInDigest,
      members: input.members.map(({ workspaceId, resultId, member }) => ({
        workspaceId,
        resultId,
        member,
      })),
      prepareEffectId: intent.command.commandId,
      inspectEffectId: input.inspectEffectId,
    });
    const attempt = this.#claimIntegration(intent, input.integrationId, context);
    const result = await this.integration.prepare({
      integrationId: input.integrationId,
      beforeRevision: input.beforeRevision,
      members: input.members.map(
        ({ member, resultRevision }): GitIntegrationMember => ({
          memberId: member.taskId,
          resultRevision,
        }),
      ),
      identity: this.#identity,
      signal: context.signal,
    });
    this.authority.recordIntegrationState(
      intent.command.repositoryId,
      intent.command.runId,
      input.integrationId,
      "candidate-created",
      required(attempt.ownerId, "Integration owner"),
      required(attempt.fence, "Integration fence"),
      this.#currentTime(),
    );
    if (result.status === "conflicted") {
      this.authority.recordIntegrationState(
        intent.command.repositoryId,
        intent.command.runId,
        input.integrationId,
        "conflicted",
        required(attempt.ownerId, "Integration owner"),
        required(attempt.fence, "Integration fence"),
        this.#currentTime(),
      );
    }
    return this.#observation(result.status === "candidate" ? "completed" : "failed", input, result);
  }

  async #validateIntegration(
    intent: EffectIntent,
    input: ValidateIntegrationInput,
    context: AsyncEffectHostContext,
  ): Promise<EffectObservation> {
    const attempt = required(this.#integrationAttempt(intent, input.integrationId), "Integration");
    const owner = required(attempt.ownerId, "Integration owner");
    const fence = required(attempt.fence, "Integration fence");
    if (attempt.state === "candidate-created") {
      this.authority.recordIntegrationState(
        intent.command.repositoryId,
        intent.command.runId,
        input.integrationId,
        "validating",
        owner,
        fence,
        this.#currentTime(),
      );
    }
    const validated = await this.integration.validate({
      integrationId: input.integrationId,
      candidateRevision: input.candidateRevision,
      signal: context.signal,
      evaluate: this.#evaluateIntegration,
    });
    const evidence = validated.evidence as JsonValue;
    const readingDigest = this.#digest({ integrationId: input.integrationId, evidence });
    const evaluationDigest = this.#digest({
      integrationId: input.integrationId,
      decision: validated.decision,
      policyDigest: input.policyDigest,
      readingDigest,
    });
    this.authority.recordIntegrationGate(
      intent.command.repositoryId,
      intent.command.runId,
      input.integrationId,
      {
        policyDigest: input.policyDigest,
        readingDigest,
        evaluationDigest,
        decision: validated.decision,
        evidence,
      },
      owner,
      fence,
      this.#currentTime(),
    );
    if (validated.decision === "failed") {
      this.authority.recordIntegrationState(
        intent.command.repositoryId,
        intent.command.runId,
        input.integrationId,
        "rework-required",
        owner,
        fence,
        this.#currentTime(),
      );
    }
    return this.#observation(
      validated.decision === "passed" ? "completed" : "failed",
      input,
      validated,
    );
  }

  async #publishIntegration(
    intent: EffectIntent,
    input: PublishIntegrationInput,
    context: AsyncEffectHostContext,
  ): Promise<EffectObservation> {
    let attempt = this.#claimIntegration(intent, input.integrationId, context);
    const owner = required(attempt.ownerId, "Integration owner");
    const fence = required(attempt.fence, "Integration fence");
    if (attempt.gate?.decision !== "passed") {
      throw new TypeError("Integration publication requires a durable passed gate");
    }
    if (attempt.state === "validating") {
      this.authority.recordIntegrationState(
        intent.command.repositoryId,
        intent.command.runId,
        input.integrationId,
        "publishing",
        owner,
        fence,
        this.#currentTime(),
      );
    }
    attempt = this.#claimIntegration(intent, input.integrationId, context);
    let currentOwner = required(attempt.ownerId, "Integration owner");
    let currentFence = required(attempt.fence, "Integration fence");
    this.#advanceToPublishing(intent, input.integrationId, currentOwner, currentFence);
    const publication = await this.integration.publish({
      integrationId: input.integrationId,
      expectedOld: input.expectedOld,
      candidateRevision: input.candidateRevision,
      reassertAuthority: () => {
        attempt = this.#claimIntegration(intent, input.integrationId, context);
        currentOwner = required(attempt.ownerId, "Integration owner");
        currentFence = required(attempt.fence, "Integration fence");
        this.#advanceToPublishing(intent, input.integrationId, currentOwner, currentFence);
      },
      signal: context.signal,
    });
    if (publication.status === "target-moved") {
      this.authority.recordIntegrationState(
        intent.command.repositoryId,
        intent.command.runId,
        input.integrationId,
        "target-moved",
        currentOwner,
        currentFence,
        this.#currentTime(),
      );
      return this.#observation("failed", input, publication);
    }
    this.authority.recordIntegrationState(
      intent.command.repositoryId,
      intent.command.runId,
      input.integrationId,
      "published",
      currentOwner,
      currentFence,
      this.#currentTime(),
    );
    this.#recordBarrier(intent, input, currentOwner, currentFence);
    return this.#observation("completed", input, publication);
  }

  #recordBarrier(
    intent: EffectIntent,
    input: PublishIntegrationInput,
    owner: string,
    fence: number,
  ): void {
    const current = this.#currentTrustedBarrier?.(
      intent.command.repositoryId,
      intent.command.runId,
    );
    if (current !== undefined && current.barrierDigest !== input.barrier.barrierDigest) {
      this.authority.recordIntegrationState(
        intent.command.repositoryId,
        intent.command.runId,
        input.integrationId,
        "target-moved",
        owner,
        fence,
        this.#currentTime(),
      );
      throw new TypeError("Published integration conflicts with the current runtime barrier");
    }
    this.#recordTrustedBarrier(
      intent.command.repositoryId,
      intent.command.runId,
      input.integrationId,
      input.barrier,
    );
    const recorded = this.#currentTrustedBarrier?.(
      intent.command.repositoryId,
      intent.command.runId,
    );
    if (recorded !== undefined && recorded.barrierDigest !== input.barrier.barrierDigest) {
      this.authority.recordIntegrationState(
        intent.command.repositoryId,
        intent.command.runId,
        input.integrationId,
        "target-moved",
        owner,
        fence,
        this.#currentTime(),
      );
      throw new TypeError("Trusted runtime recorded a different integration barrier");
    }
    this.authority.recordIntegrationBarrier(
      intent.command.repositoryId,
      intent.command.runId,
      input.integrationId,
      input.barrier,
      owner,
      fence,
      this.#currentTime(),
    );
  }

  #advanceToPublishing(
    intent: EffectIntent,
    integrationId: string,
    owner: string,
    fence: number,
  ): IntegrationAttemptRecord {
    let current = required(this.#integrationAttempt(intent, integrationId), "Integration");
    for (const state of ["candidate-created", "validating", "publishing"] as const) {
      if (current.state === "published" || current.state === "publishing") break;
      if (
        (state === "candidate-created" && current.state !== "claimed") ||
        (state === "validating" && current.state !== "candidate-created") ||
        (state === "publishing" && current.state !== "validating" && current.state !== "unknown")
      ) {
        continue;
      }
      current = this.authority.recordIntegrationState(
        intent.command.repositoryId,
        intent.command.runId,
        integrationId,
        state,
        owner,
        fence,
        this.#currentTime(),
      );
    }
    return current;
  }

  async #removeWorkspace(
    intent: EffectIntent,
    input: RemoveWorkspaceInput,
  ): Promise<EffectObservation> {
    const record = required(this.#workspaceRecord(intent, input.workspaceId), "Workspace");
    if (record.state === "removed") return this.#observation("completed", input);
    if (record.state === "captured") {
      this.authority.recordWorkspaceState(
        intent.command.repositoryId,
        intent.command.runId,
        input.workspaceId,
        "removal-intent",
      );
    }
    await this.workspace.cleanup(
      this.workspace.describe({
        workspaceId: record.workspaceId,
        baseRevision: record.baseRevision.revision,
      }),
    );
    this.authority.recordWorkspaceState(
      intent.command.repositoryId,
      intent.command.runId,
      input.workspaceId,
      "removed",
    );
    return this.#observation("completed", input);
  }

  #claimIntegration(
    intent: EffectIntent,
    integrationId: string,
    context: AsyncEffectHostContext,
  ): IntegrationAttemptRecord {
    const claim = this.authority.claimIntegrationSlot({
      repositoryId: intent.command.repositoryId,
      runId: intent.command.runId,
      integrationId,
      ownerId: context.lease.owner,
      currentTime: this.#currentTime(),
      expiresAt: context.lease.expiresAt,
    });
    if (claim.type === "busy") throw new IntegrationSlotBusyError(integrationId);
    return claim.attempt;
  }

  #workspaceRecord(intent: EffectIntent, workspaceId: string) {
    return this.authority
      .listWorkspaces(intent.command.repositoryId, intent.command.runId)
      .find((candidate) => candidate.workspaceId === workspaceId);
  }

  #integrationAttempt(intent: EffectIntent, integrationId: string) {
    return this.authority
      .listIntegrationAttempts(intent.command.repositoryId, intent.command.runId)
      .find((candidate) => candidate.integrationId === integrationId);
  }

  #observation(
    status: EffectObservation["status"],
    input: GitEffectInput,
    details: unknown = {},
  ): EffectObservation {
    const value = { operation: input.operation, details: details as JsonValue } as const;
    return {
      status,
      observedAt: this.#currentTime(),
      details: value,
      outputDigest: this.#digest(value),
    };
  }

  #inspection(
    status: EffectInspection["status"],
    input: GitEffectInput,
    details: unknown = {},
  ): EffectInspection {
    const value = { operation: input.operation, details: details as JsonValue } as const;
    return {
      status,
      observedAt: this.#currentTime(),
      details: value,
      outputDigest: this.#digest(value),
    };
  }

  #digest(value: JsonValue): string {
    return this.#sha256.digest(canonicalBytes(value));
  }
}

export class IntegrationSlotBusyError extends Error {
  constructor(readonly integrationId: string) {
    super(`Integration slot is busy for ${integrationId}`);
    this.name = "IntegrationSlotBusyError";
  }
}

function decodeGitEffect(intent: EffectIntent): GitEffectInput {
  if (intent.command.kind !== "git") {
    throw new TypeError("Durable workspace host only accepts Git effects");
  }
  const value = object(intent.command.input, "Git effect input");
  switch (value.operation) {
    case "prepare-workspace":
      exact(value, [
        "operation",
        "workspaceId",
        "dispatchId",
        "taskId",
        "definitionGeneration",
        "baseRevision",
        "inspectEffectId",
      ]);
      return value as unknown as PrepareWorkspaceInput;
    case "capture-workspace":
      exact(value, [
        "operation",
        "workspaceId",
        "resultId",
        "completionFactDigest",
        "inspectEffectId",
        "message",
      ]);
      return value as unknown as CaptureWorkspaceInput;
    case "prepare-integration":
      exact(value, [
        "operation",
        "integrationId",
        "phaseId",
        "definitionGeneration",
        "targetRef",
        "fanInDigest",
        "beforeRevision",
        "members",
        "inspectEffectId",
      ]);
      return value as unknown as PrepareIntegrationInput;
    case "validate-integration":
      exact(value, ["operation", "integrationId", "candidateRevision", "policyDigest"]);
      return value as unknown as ValidateIntegrationInput;
    case "publish-integration":
      exact(value, ["operation", "integrationId", "expectedOld", "candidateRevision", "barrier"]);
      return value as unknown as PublishIntegrationInput;
    case "remove-workspace":
      exact(value, ["operation", "workspaceId"]);
      return value as unknown as RemoveWorkspaceInput;
    default:
      throw new TypeError("Git effect operation is not supported");
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError("Git effect input contains unexpected fields");
  }
}

function terminalIntegrationState(state: IntegrationAttemptRecord["state"]): boolean {
  return [
    "barrier-recorded",
    "conflicted",
    "target-moved",
    "rework-required",
    "cancelled",
    "failed",
  ].includes(state);
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new TypeError(`${label} is not available`);
  return value;
}
