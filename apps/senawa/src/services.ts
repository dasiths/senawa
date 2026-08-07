import { randomUUID } from "node:crypto";
import { posix, resolve } from "node:path";
import {
  RunCommandService as ApplicationRunCommandService,
  type ArtifactDecisionExpectation,
  type ArtifactValidationPort,
  type BrowserCommandReceiptStore,
  DurableBrowserCommandService,
  type EndRunOptions,
  type GateEvaluationPort,
  type RepositoryEvidencePort,
  type RunChangeNotificationPort,
  type RunPersistencePort,
  RunQueryService,
  RunReportEvidenceReader,
  type TransitionResult,
  type WorkerExecutionPort,
  type WorkerHostResolverPort,
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
  WorkerHostIdentity,
  WorkRequest,
} from "@senawa/domain";
import { FileSensorEvidenceStore } from "@senawa/observability";
import { RunReportService } from "@senawa/reporting";
import { CommandGateEvaluator } from "@senawa/sensors";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export interface SenawaServices {
  readonly repositoryRoot: string;
  readonly commands: RunCommands;
  readonly browserCommands: DurableBrowserCommandService;
  readonly queries: RunQueryService;
  readonly notifier: RunChangeNotificationPort;
  loadDefinitions(workflowName?: string): Promise<RepositoryDefinitions>;
  acquireWebLease(runId: string, owner: string, ttlMs: number): Promise<RuntimeLease>;
  renewWebLease(runId: string, lease: RuntimeLease, ttlMs: number): Promise<RuntimeLease>;
  releaseWebLease(runId: string, lease: RuntimeLease): Promise<void>;
}

export interface SenawaServiceOptions {
  readonly persistence: RunPersistencePort;
  readonly receiptStore: BrowserCommandReceiptStore;
  readonly notifier: RunChangeNotificationPort;
  readonly runtimeBackend?: RuntimeBackend;
  readonly workerHost?: WorkerExecutionPort;
  readonly workerHostResolver?: WorkerHostResolverPort;
  readonly workerHostIdentity?: WorkerHostIdentity;
  readonly repositoryEvidence: RepositoryEvidencePort;
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
    workerHost: WorkerExecutionPort | WorkerHostResolverPort,
    gateEvaluator: GateEvaluationPort,
    private readonly now: () => Date,
    backend: RuntimeBackend,
    workerHostIdentity: WorkerHostIdentity,
    repositoryEvidence: RepositoryEvidencePort,
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
      workerHostIdentity,
      repositoryEvidence,
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

  approve(
    runId: string,
    phaseId: string,
    actor: CommandActor,
    note?: string,
    expectation?: ArtifactDecisionExpectation,
  ) {
    return this.application.approve(runId, phaseId, actor, note, undefined, expectation);
  }

  reject(
    runId: string,
    phaseId: string,
    reason: string,
    actor: CommandActor,
    expectation?: ArtifactDecisionExpectation,
  ) {
    return this.application.reject(runId, phaseId, reason, actor, undefined, expectation);
  }

  steer(runId: string, taskId: string, instruction: string, actor: CommandActor) {
    return this.application.steer(runId, taskId, instruction, actor);
  }

  resume(runId: string, actor: CommandActor, expectedWorkerHost?: WorkerHostIdentity["kind"]) {
    return this.application.resume(runId, actor, undefined, expectedWorkerHost);
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

  ask(
    runId: string,
    question: string,
    actor: CommandActor,
    workerContext?: Parameters<ApplicationRunCommandService["ask"]>[3],
  ) {
    return this.application.ask(runId, question, actor, workerContext);
  }

  answer(
    runId: string,
    questionId: string,
    answer: string,
    actor: CommandActor,
    options?: Parameters<ApplicationRunCommandService["answer"]>[4],
  ) {
    return this.application.answer(runId, questionId, answer, actor, options);
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

  end(runId: string, reason: string, actor: CommandActor, options?: EndRunOptions) {
    return this.application.end(runId, reason, actor, options);
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

  listModels() {
    return this.application.listModels();
  }

  liveReadiness(definitions: RepositoryDefinitions) {
    const runId = `readiness-${randomUUID()}`;
    return this.application.liveReadiness(createRunSnapshot(runId, definitions, this.now()));
  }

  executeBrowserCommand(
    runId: string,
    command: Parameters<ApplicationRunCommandService["executeBrowserCommand"]>[1],
  ) {
    return this.application.executeBrowserCommand(runId, command);
  }
}

export function createSenawaServices(
  repositoryRoot: string,
  options: SenawaServiceOptions,
): SenawaServices {
  const root = resolve(repositoryRoot);
  const reports = new RunReportService(new RunReportEvidenceReader(options.persistence));
  const workerHostIdentity = options.workerHostIdentity ?? {
    kind: "copilot-sdk",
    adapter: "copilot-sdk",
    adapterVersion: "1.0.7",
    legacy: false,
  };
  const workerHost = options.workerHostResolver ?? options.workerHost;
  if (workerHost === undefined) {
    throw new Error("Senawa service composition requires an explicit worker host resolver");
  }
  const commands = new RunCommands(
    options.persistence,
    workerHost,
    options.gateEvaluator ??
      new CommandGateEvaluator(root, { evidenceStore: new FileSensorEvidenceStore(root) }),
    options.now ?? (() => new Date()),
    options.runtimeBackend ?? "file",
    workerHostIdentity,
    options.repositoryEvidence,
  );
  const scheduler = {
    scheduleEvery(intervalMs: number, task: () => void) {
      const timer = setInterval(task, intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
  return {
    repositoryRoot: root,
    commands,
    browserCommands: new DurableBrowserCommandService(options.receiptStore, commands, scheduler),
    queries: new RunQueryService(
      options.persistence,
      new RepositoryWorkflowCatalogAdapter(root),
      reports,
      { now: options.now ?? (() => new Date()) },
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
