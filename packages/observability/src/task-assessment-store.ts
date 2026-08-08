import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { TaskAssessmentPort } from "@senawa/application";
import type { TaskCompletionAssessment, TaskCompletionAssessmentEvidence } from "@senawa/domain";

export class FileTaskAssessmentStore implements TaskAssessmentPort {
  private readonly trackingDirectory: string;

  constructor(repositoryRoot: string) {
    this.trackingDirectory = resolve(repositoryRoot, ".agents", ".copilot-tracking");
  }

  async persist(assessment: TaskCompletionAssessment): Promise<TaskCompletionAssessmentEvidence> {
    const digest = createHash("sha256").update(JSON.stringify(assessment)).digest("hex");
    const evidencePath = join(
      "evidence",
      "tasks",
      assessment.taskId,
      `attempt-${assessment.attempt}`,
      assessment.dispatchId,
      `assessment-${assessment.stage}-${digest.slice(0, 16)}.json`,
    );
    const evidence = { ...assessment, digest, evidencePath };
    const path = join(this.trackingDirectory, assessment.runId, evidencePath);
    const content = `${JSON.stringify(evidence, null, 2)}\n`;
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      if ((await readFile(path, "utf8")) !== content) {
        throw new Error(`Task assessment evidence conflict at ${evidencePath}`);
      }
    }
    return evidence;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && Reflect.get(error, "code") === code;
}
