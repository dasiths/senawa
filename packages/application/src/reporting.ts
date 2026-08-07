import type { JournalEvent, OutputRecord, RuntimeState } from "@senawa/domain";
import type { RunPersistencePort, WorkerEventRecord } from "./ports.js";

export type RunReportProjection = Pick<
  RuntimeState,
  "identity" | "status" | "endReason" | "phases" | "tasks" | "artifacts" | "dispatches"
> & {
  readonly artifactCount: number;
  readonly journal: readonly JournalEvent[];
  readonly outputs: readonly OutputRecord[];
  readonly workerEvents: readonly WorkerEventRecord[];
  readonly decomposition: readonly {
    readonly id: string;
    readonly title: string;
    readonly dependsOn: readonly string[];
    readonly executorKind: string;
  }[];
};

export interface ReportEvidenceReaderPort {
  readReportProjection(runId: string): Promise<RunReportProjection>;
}

export class RunReportEvidenceReader implements ReportEvidenceReaderPort {
  constructor(private readonly persistence: RunPersistencePort) {}

  async readReportProjection(runId: string): Promise<RunReportProjection> {
    const state = (await this.persistence.readRun(runId)).state;
    return {
      identity: state.identity,
      status: state.status,
      endReason: state.endReason,
      phases: state.phases,
      tasks: state.tasks,
      artifacts: state.artifacts,
      dispatches: state.dispatches,
      artifactCount: state.artifacts.length,
      journal: state.journal,
      outputs: Object.values(state.outputs)
        .flat()
        .toSorted((left, right) => left.ts.localeCompare(right.ts)),
      workerEvents: await this.persistence.readWorkerEvents(runId),
      decomposition: state.snapshot.workflow.spec.phases.map((phase) => ({
        id: phase.id,
        title: phase.id,
        dependsOn: phase.dependsOn,
        executorKind: phase.executor.kind,
      })),
    };
  }
}
