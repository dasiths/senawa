import { posix } from "node:path";
import type {
  ArtifactValidationPort,
  RunPersistencePort,
  VersionedRunState,
  WorkflowCatalogPort,
} from "@senawa/application";
import { RuntimeRevisionConflictError } from "@senawa/application";
import { listRepositoryWorkflows, readRepositoryWorkflow } from "@senawa/configuration";
import type { RunSnapshot, RuntimeArtifact, RuntimeLease, RuntimeState } from "@senawa/domain";
import type { RuntimeStore } from "@senawa/graph";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export class GraphRunPersistenceAdapter implements RunPersistencePort {
  constructor(private readonly store: RuntimeStore) {}

  createRun(state: RuntimeState): Promise<void> {
    return this.store.createRun(state);
  }

  getActiveRunId(): Promise<string | null> {
    return this.store.getActiveRunId();
  }

  async readRun(runId: string): Promise<VersionedRunState> {
    const state = await this.store.readRun(runId);
    return { state, revision: revisionOf(state) };
  }

  async commitRun(input: {
    readonly runId: string;
    readonly expectedRevision: string;
    readonly operationId: string;
    readonly state: RuntimeState;
  }): Promise<VersionedRunState> {
    const state = await this.store.updateRun(input.runId, (draft) => {
      if (revisionOf(draft) !== input.expectedRevision) {
        throw new RuntimeRevisionConflictError(input.runId, input.operationId);
      }
      Object.assign(draft, structuredClone(input.state));
    });
    return { state, revision: revisionOf(state) };
  }

  publishSnapshot(_snapshot: RunSnapshot, _operationId: string): Promise<void> {
    return Promise.resolve();
  }

  async readArtifact(
    runId: string,
    phaseId: string,
    version?: number,
  ): Promise<RuntimeArtifact | null> {
    const state = await this.store.readRun(runId);
    const matches = state.artifacts.filter((artifact) => artifact.phaseId === phaseId);
    return version === undefined
      ? (matches.at(-1) ?? null)
      : (matches.find((artifact) => artifact.version === version) ?? null);
  }

  async readJournal(runId: string, after: number, limit: number) {
    return (await this.store.readRun(runId)).journal
      .filter((event) => event.seq > after)
      .slice(0, limit);
  }

  async readOutput(
    runId: string,
    ownerKind: "run" | "phase" | "task",
    ownerId: string,
    after: number,
    limit: number,
  ) {
    const records = (await this.store.readRun(runId)).outputs[`${ownerKind}:${ownerId}`] ?? [];
    return records.filter((record) => record.seq > after).slice(0, limit);
  }

  acquireLease(
    runId: string,
    kind: "driver" | "web",
    owner: string,
    ttlMs: number,
  ): Promise<RuntimeLease> {
    return this.store.acquireLease(runId, kind, owner, ttlMs);
  }

  renewLease(
    runId: string,
    kind: "driver" | "web",
    lease: RuntimeLease,
    ttlMs: number,
  ): Promise<RuntimeLease> {
    return this.store.renewLease(runId, kind, lease, ttlMs);
  }

  releaseLease(runId: string, kind: "driver" | "web", lease: RuntimeLease): Promise<void> {
    return this.store.releaseLease(runId, kind, lease);
  }
}

export class AjvArtifactValidationAdapter implements ArtifactValidationPort {
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
      `Phase ${input.phaseId} artifact does not match its frozen output schema: ${truncate(details, 1_000)}`,
    );
  }
}

export class RepositoryWorkflowCatalogAdapter implements WorkflowCatalogPort {
  constructor(private readonly repositoryRoot: string) {}

  listWorkflows(): Promise<string[]> {
    return listRepositoryWorkflows(this.repositoryRoot);
  }

  readWorkflow(workflowName: string) {
    return readRepositoryWorkflow(this.repositoryRoot, workflowName);
  }
}

function revisionOf(state: RuntimeState): string {
  return JSON.stringify(state);
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 3)}...`;
}
