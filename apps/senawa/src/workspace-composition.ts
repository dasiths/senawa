import { type DurableWorkspaceEffectHost, WorkspaceEffectHost } from "@senawa/execution-host";
import type { IntegrationBarrier } from "@senawa/kernel";
import { canonicalBytes } from "@senawa/protocol";
import type {
  AsyncEffectHost,
  AsyncEffectHostContext,
  CompletionFact,
  CompletionFactAdmission,
  EffectInspection,
  EffectIntent,
  EffectObservation,
  RunExecutionBinding,
} from "@senawa/runtime";
import type {
  SqliteRunnerAuthority,
  SqliteWorkspaceIntegrationAuthority,
} from "@senawa/storage-sqlite";
import type { SqliteSupervisorAuthority } from "@senawa/supervisor";

export interface DynamicWorkspaceEffectHostOptions {
  readonly authority: SqliteSupervisorAuthority;
  readonly workspaceAuthority: SqliteWorkspaceIntegrationAuthority;
  readonly repositoryRoot: string;
  readonly hostWriterCapacity: number;
  readonly createWorkerHost: (workingRoot: string) => AsyncEffectHost | Promise<AsyncEffectHost>;
  readonly createGitHost: (binding: RunExecutionBinding) => Promise<DurableWorkspaceEffectHost>;
}

export class DynamicWorkspaceEffectHost implements AsyncEffectHost {
  readonly #options: DynamicWorkspaceEffectHostOptions;
  readonly #hosts = new Map<string, Promise<WorkspaceEffectHost>>();

  constructor(options: DynamicWorkspaceEffectHostOptions) {
    if (!Number.isSafeInteger(options.hostWriterCapacity) || options.hostWriterCapacity < 1) {
      throw new TypeError("Host writer capacity must be a positive safe integer");
    }
    this.#options = options;
  }

  async dispatch(
    intent: EffectIntent,
    context: AsyncEffectHostContext,
  ): Promise<EffectObservation> {
    return (await this.#host(intent)).dispatch(intent, context);
  }

  async inspect(intent: EffectIntent, context: AsyncEffectHostContext): Promise<EffectInspection> {
    return (await this.#host(intent)).inspect(intent, context);
  }

  async cancel(intent: EffectIntent, context: AsyncEffectHostContext): Promise<EffectObservation> {
    return (await this.#host(intent)).cancel(intent, context);
  }

  async #host(intent: EffectIntent): Promise<WorkspaceEffectHost> {
    const key = `${intent.command.repositoryId}\0${intent.command.runId}`;
    const existing = this.#hosts.get(key);
    if (existing !== undefined) return existing;
    const created = this.#createHost(intent);
    this.#hosts.set(key, created);
    try {
      return await created;
    } catch (error) {
      this.#hosts.delete(key);
      throw error;
    }
  }

  async #createHost(intent: EffectIntent): Promise<WorkspaceEffectHost> {
    const binding = this.#binding(intent.command.repositoryId, intent.command.runId);
    if (binding.execution.workspaceMode === "repository") {
      return new WorkspaceEffectHost({
        policy: { workspaceMode: "repository", hostWriterCapacity: 1 },
        repositoryRoot: this.#options.repositoryRoot,
        createWorkerHost: this.#options.createWorkerHost,
      });
    }
    const gitHost = await this.#options.createGitHost(binding);
    return new WorkspaceEffectHost({
      policy: {
        workspaceMode: "worktree",
        hostWriterCapacity: Math.min(
          binding.execution.maxWriterConcurrency,
          this.#options.hostWriterCapacity,
        ),
      },
      repositoryRoot: this.#options.repositoryRoot,
      createWorkerHost: this.#options.createWorkerHost,
      resolveWorkspaceRoot: (workspaceId, workerIntent) =>
        gitHost.workspaceRoot(
          workerIntent.command.repositoryId,
          workerIntent.command.runId,
          workspaceId,
        ),
      createGitHost: () => gitHost,
    });
  }

  #binding(repositoryId: string, runId: string): RunExecutionBinding {
    const existing = this.#options.workspaceAuthority.loadRunExecution(repositoryId, runId);
    if (existing !== undefined) return existing;
    const runtime = this.#options.authority.commandAuthority.queryRunExecution(repositoryId, runId);
    if (runtime === undefined) throw new TypeError("Run execution policy is not instantiated");
    return this.#options.workspaceAuthority.bindRunExecution(runtime);
  }
}

export interface DurableCompletionEligibilityOptions {
  readonly workspaceAuthority: SqliteWorkspaceIntegrationAuthority;
  readonly runnerAuthority: SqliteRunnerAuthority;
  readonly sha256: { digest(bytes: Uint8Array): string };
  currentIntegrationBarrier(repositoryId: string, runId: string): IntegrationBarrier | undefined;
}

export class DurableCompletionEligibility {
  readonly #options: DurableCompletionEligibilityOptions;

  constructor(options: DurableCompletionEligibilityOptions) {
    this.#options = options;
  }

  completionAdmission(submissionId: string, fact?: CompletionFact): CompletionFactAdmission {
    if (fact === undefined) {
      return this.#options.workspaceAuthority.completionAdmission(submissionId);
    }
    const binding = this.#options.workspaceAuthority.loadRunExecution(
      fact.repositoryId,
      fact.runId,
    );
    if (binding === undefined) return "deferred";
    const terminalCurrentWriter = this.#options.runnerAuthority
      .load({ repositoryId: fact.repositoryId, runId: fact.runId })
      .effects.some(
        ({ intent, outcome }) =>
          intent.command.kind === "worker" &&
          workerDispatchId(intent) === fact.dispatchId &&
          outcome?.status === "completed" &&
          outcome.freshness === "current",
      );
    if (binding.execution.workspaceMode === "repository") {
      this.#options.workspaceAuthority.recordCompletionEligibility({
        submissionId,
        repositoryId: fact.repositoryId,
        runId: fact.runId,
        dispatchId: fact.dispatchId,
        terminalCurrentWriter,
      });
      return this.#options.workspaceAuthority.completionAdmission(submissionId);
    }
    const completionFactDigest = this.#options.sha256.digest(canonicalBytes(fact));
    const workspace = exactlyOne(
      this.#options.workspaceAuthority
        .listWorkspaces(fact.repositoryId, fact.runId)
        .filter((candidate) => candidate.dispatchId === fact.dispatchId),
      "completion workspaces",
    );
    if (workspace === undefined) return "deferred";
    const result = exactlyOne(
      this.#options.workspaceAuthority
        .listWorkspaceResults(fact.repositoryId, fact.runId)
        .filter(
          (candidate) =>
            candidate.workspaceId === workspace.workspaceId &&
            candidate.completionFactDigest === completionFactDigest,
        ),
      "completion workspace results",
    );
    if (result === undefined) return "deferred";
    const successful = this.#options.workspaceAuthority
      .listIntegrationAttempts(fact.repositoryId, fact.runId)
      .filter(
        (candidate) =>
          candidate.state === "barrier-recorded" &&
          candidate.barrier !== undefined &&
          candidate.members.some(
            (member) =>
              member.workspaceId === workspace.workspaceId &&
              member.resultId === result.resultId &&
              member.member.completionFactDigest === completionFactDigest &&
              candidate.barrier?.members.some(
                (barrierMember) => barrierMember.memberDigest === member.member.memberDigest,
              ),
          ),
      );
    const integration = exactlyOne(successful, "successful completion integrations");
    if (integration === undefined) {
      return "deferred";
    }
    const currentBarrier = this.#options.currentIntegrationBarrier(fact.repositoryId, fact.runId);
    if (
      currentBarrier === undefined ||
      integration.barrier?.barrierDigest !== currentBarrier.barrierDigest
    ) {
      return "deferred";
    }
    this.#options.workspaceAuthority.recordCompletionEligibility({
      submissionId,
      repositoryId: fact.repositoryId,
      runId: fact.runId,
      dispatchId: fact.dispatchId,
      terminalCurrentWriter,
      workspaceId: workspace.workspaceId,
      resultId: result.resultId,
      integrationId: integration.integrationId,
    });
    return this.#options.workspaceAuthority.completionAdmission(submissionId);
  }
}

function exactlyOne<T>(values: readonly T[], label: string): T | undefined {
  if (values.length > 1) throw new TypeError(`Authority contains ambiguous ${label}`);
  return values[0];
}

function workerDispatchId(intent: EffectIntent): string | undefined {
  const input = intent.command.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Readonly<Record<string, unknown>>;
  if (typeof record.dispatchId === "string") return record.dispatchId;
  const worker = record.worker;
  const workerRecord = worker as Readonly<Record<string, unknown>> | null;
  return workerRecord !== null && typeof workerRecord === "object" && !Array.isArray(workerRecord)
    ? typeof workerRecord.dispatchId === "string"
      ? workerRecord.dispatchId
      : undefined
    : undefined;
}
