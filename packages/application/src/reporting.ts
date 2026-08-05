import type { JournalEvent, OutputRecord, RuntimeState } from "@senawa/domain";
import type { RunPersistencePort } from "./ports.js";

export type RunReportProjection = Pick<
  RuntimeState,
  "identity" | "status" | "endReason" | "phases" | "tasks"
> & {
  readonly artifactCount: number;
  readonly journalCount: number;
  readonly outputCount: number;
  readonly latestEvent: JournalEvent | null;
  readonly latestOutput: OutputRecord | null;
};

export interface ReportEvidenceReaderPort {
  readReportProjection(runId: string): Promise<RunReportProjection>;
}

export class RunReportEvidenceReader implements ReportEvidenceReaderPort {
  constructor(private readonly persistence: RunPersistencePort) {}

  async readReportProjection(runId: string): Promise<RunReportProjection> {
    const state = (await this.persistence.readRun(runId)).state;
    const latestOutput = Object.values(state.outputs)
      .flat()
      .sort((left, right) => left.ts.localeCompare(right.ts))
      .at(-1);
    return {
      identity: state.identity,
      status: state.status,
      endReason: state.endReason,
      phases: state.phases,
      tasks: state.tasks,
      artifactCount: state.artifacts.length,
      journalCount: state.journal.length,
      outputCount: Object.values(state.outputs).reduce(
        (total, records) => total + records.length,
        0,
      ),
      latestEvent: state.journal.at(-1) ?? null,
      latestOutput: latestOutput ?? null,
    };
  }
}
