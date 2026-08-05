import { randomUUID } from "node:crypto";
import { posix, resolve } from "node:path";
import {
  RunCommandService as ApplicationRunCommandService,
  type ArtifactValidationPort,
  type GateEvaluationPort,
  type RunChangeNotificationPort,
  type RunPersistencePort,
  RunQueryService,
  RunReportEvidenceReader,
  type TransitionResult,
  type WorkerExecutionPort,
  type WorkflowCatalogPort,
} from "@senawa/application";
import {
  createRunSnapshot,
  listRepositoryWorkflows,
  loadRepositoryDefinitions,
  type RepositoryDefinitions,
  readRepositoryWorkflow,
} from "@senawa/configuration";
import type {
  CommandActor,
  RunSnapshot,
  RuntimeBackend,
  RuntimeLease,
  WorkRequest,
} from "@senawa/domain";
import { RunReportService } from "@senawa/reporting";
import { CommandGateEvaluator } from "@senawa/sensors";
import { DeterministicWorkerHost } from "@senawa/workers";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export interface SenawaServices {
  readonly repositoryRoot: string;
  readonly commands: RunCommands;
  readonly queries: RunQueryService;
  readonly notifier: RunChangeNotificationPort;
  loadDefinitions(workflowName?: string): Promise<RepositoryDefinitions>;
  acquireWebLease(runId: string, owner: string, ttlMs: number): Promise<RuntimeLease>;
  renewWebLease(runId: string, lease: RuntimeLease, ttlMs: number): Promise<RuntimeLease>;
  releaseWebLease(runId: string, lease: RuntimeLease): Promise<void>;
}

export interface SenawaServiceOptions {
  readonly persistence: RunPersistencePort;
  readonly notifier: RunChangeNotificationPort;
  readonly runtimeBackend?: RuntimeBackend;
  readonly workerHost?: WorkerExecutionPort;
  readonly gateEvaluator?: GateEvaluationPort;
  readonly now?: () => Date;
}

export interface StartRunInput {
  readonly actor: CommandActor;
  readonly request: WorkRequest;
  readonly definitions: RepositoryDefinitions;
  readonly runId?: string;
}

export class RunCommands {
  private readonly application: ApplicationRunCommandService;

  constructor(
    store: RunPersistencePort,
    workerHost: WorkerExecutionPort,
    gateEvaluator: GateEvaluationPort,
    private readonly now: () => Date,
    backend: RuntimeBackend,
  ) {
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
      30_000,
      backend,
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

  pause(runId: string, actor: CommandActor) {
    return this.application.pause(runId, actor);
  }

  checkGate(
    runId: string,
    gateId: string,
    owner: { readonly kind: "phase" | "task"; readonly id: string },
    actor: CommandActor,
  ) {
    return this.application.checkGate(runId, gateId, owner, actor);
  }

  ask(runId: string, question: string, actor: CommandActor) {
    return this.application.ask(runId, question, actor);
  }

  answer(runId: string, questionId: string, answer: string, actor: CommandActor) {
    return this.application.answer(runId, questionId, answer, actor);
  }

  discover(runId: string, title: string, actor: CommandActor) {
    return this.application.discover(runId, title, actor);
  }

  note(runId: string, note: string, actor: CommandActor) {
    return this.application.note(runId, note, actor);
  }

  revisePlan(
    runId: string,
    plan: Parameters<ApplicationRunCommandService["revisePlan"]>[1],
    actor: CommandActor,
  ) {
    return this.application.revisePlan(runId, plan, actor);
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

export function createSenawaServices(
  repositoryRoot: string,
  options: SenawaServiceOptions,
): SenawaServices {
  const root = resolve(repositoryRoot);
  const reports = new RunReportService(new RunReportEvidenceReader(options.persistence));
  return {
    repositoryRoot: root,
    commands: new RunCommands(
      options.persistence,
      options.workerHost ?? new DeterministicWorkerHost(),
      options.gateEvaluator ?? new CommandGateEvaluator(root),
      options.now ?? (() => new Date()),
      options.runtimeBackend ?? "file",
    ),
    queries: new RunQueryService(
      options.persistence,
      new RepositoryWorkflowCatalogAdapter(root),
      reports,
    ),
    notifier: options.notifier,
    loadDefinitions: (workflowName) => loadRepositoryDefinitions(root, workflowName),
    acquireWebLease: (runId, owner, ttlMs) =>
      options.persistence.acquireLease(runId, "web", owner, ttlMs),
    renewWebLease: (runId, lease, ttlMs) =>
      options.persistence.renewLease(runId, "web", lease, ttlMs),
    releaseWebLease: (runId, lease) => options.persistence.releaseLease(runId, "web", lease),
  };
}

class RepositoryWorkflowCatalogAdapter implements WorkflowCatalogPort {
  constructor(private readonly repositoryRoot: string) {}

  listWorkflows(): Promise<string[]> {
    return listRepositoryWorkflows(this.repositoryRoot);
  }

  readWorkflow(workflowName: string) {
    return readRepositoryWorkflow(this.repositoryRoot, workflowName);
  }
}

class AjvArtifactValidationAdapter implements ArtifactValidationPort {
  validatePhaseArtifact(input: {
    readonly snapshot: RunSnapshot;
    readonly phaseId: string;
    readonly schemaReference: string;
    readonly artifact: object;
  }): void {
    const schemaPath = posix.normalize(posix.join(".senawa/workflows", input.schemaReference));
    const schemaFile = input.snapshot.files.find((file) => file.path === schemaPath);
    if (schemaFile === undefined) {
      throw new Error(`Phase ${input.phaseId} frozen output schema is missing: ${schemaPath}`);
    }
    const ajv = new Ajv2020.default({ allErrors: true, strict: true });
    addFormats.default(ajv);
    const validate = ajv.compile(JSON.parse(schemaFile.content));
    if (validate(input.artifact)) return;
    const details = ajv.errorsText(validate.errors, { separator: "; " });
    throw new Error(
      `Phase ${input.phaseId} artifact does not match its frozen output schema: ${details.slice(0, 1_000)}`,
    );
  }
}
