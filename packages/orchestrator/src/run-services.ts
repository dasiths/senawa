import { randomUUID } from "node:crypto";
import {
  RunCommandService as ApplicationRunCommandService,
  RunQueryService as ApplicationRunQueryService,
  type RunPersistencePort,
  type RunStatusProjection,
  type TransitionResult,
} from "@senawa/application";
import { createRunSnapshot, type RepositoryDefinitions } from "@senawa/configuration";
import type { CommandActor, WorkRequest } from "@senawa/domain";
import type { RunReportService } from "@senawa/reporting";
import type { GateEvaluator } from "@senawa/sensors";
import {
  AjvArtifactValidationAdapter,
  RepositoryWorkflowCatalogAdapter,
} from "./application-adapters.js";
import type { WorkerHost } from "./worker-host.js";

export type { RunStatusProjection, TransitionResult } from "@senawa/application";

export interface StartRunInput {
  readonly actor: CommandActor;
  readonly request: WorkRequest;
  readonly definitions: RepositoryDefinitions;
  readonly runId?: string;
}

export class RunCommandService {
  private readonly application: ApplicationRunCommandService;
  private readonly now: () => Date;

  constructor(
    store: RunPersistencePort,
    workerHost: WorkerHost,
    gateEvaluator: GateEvaluator,
    now: () => Date = () => new Date(),
    driverLeaseTtlMs = 30_000,
  ) {
    this.now = now;
    this.application = new ApplicationRunCommandService(
      store,
      workerHost,
      gateEvaluator,
      new AjvArtifactValidationAdapter(),
      { now },
      { createId: randomUUID },
      {
        scheduleEvery(intervalMs, task) {
          const timer = setInterval(task, intervalMs);
          timer.unref();
          return () => clearInterval(timer);
        },
      },
      driverLeaseTtlMs,
    );
  }

  start(input: StartRunInput): Promise<TransitionResult> {
    const runId = input.runId ?? `run-${randomUUID()}`;
    return this.application.start({
      actor: input.actor,
      request: input.request,
      runId,
      snapshot: createRunSnapshot(runId, input.definitions, this.now()),
    });
  }

  approve(runId: string, phaseId: string, actor: CommandActor, note?: string) {
    return this.application.approve(runId, phaseId, actor, note);
  }

  reject(runId: string, phaseId: string, reason: string, actor: CommandActor) {
    return this.application.reject(runId, phaseId, reason, actor);
  }

  steer(runId: string, taskId: string, instruction: string, actor: CommandActor) {
    return this.application.steer(runId, taskId, instruction, actor);
  }

  resume(runId: string, actor: CommandActor) {
    return this.application.resume(runId, actor);
  }

  end(runId: string, reason: string, actor: CommandActor) {
    return this.application.end(runId, reason, actor);
  }

  finish(runId: string, actor: CommandActor) {
    return this.application.finish(runId, actor);
  }

  drive(runId: string, actor: CommandActor, maxTransitions?: number) {
    return this.application.drive(runId, actor, maxTransitions);
  }

  advance(runId: string, actor: CommandActor) {
    return this.application.advance(runId, actor);
  }
}

export class RunQueryService {
  private readonly application: ApplicationRunQueryService;

  constructor(store: RunPersistencePort, repositoryRoot?: string, reports?: RunReportService) {
    this.application = new ApplicationRunQueryService(
      store,
      repositoryRoot === undefined
        ? undefined
        : new RepositoryWorkflowCatalogAdapter(repositoryRoot),
      reports,
    );
  }

  activeRunId() {
    return this.application.activeRunId();
  }

  status(runId?: string): Promise<RunStatusProjection | null> {
    return this.application.status(runId);
  }

  journal(runId: string, after?: number, limit?: number) {
    return this.application.journal(runId, after, limit);
  }

  output(
    runId: string,
    ownerKind: "run" | "phase" | "task",
    ownerId: string,
    after?: number,
    limit?: number,
  ) {
    return this.application.output(runId, ownerKind, ownerId, after, limit);
  }

  artifact(runId: string, phaseId: string, version?: number) {
    return this.application.artifact(runId, phaseId, version);
  }

  workflows() {
    return this.application.workflows();
  }

  workflow(workflowName: string) {
    return this.application.workflow(workflowName);
  }

  renderWorkflow(workflowName: string) {
    return this.application.renderWorkflow(workflowName);
  }

  report(runId: string) {
    return this.application.report(runId);
  }
}
