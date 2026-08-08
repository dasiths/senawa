import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { FileSensorEvidenceStore, FileWorkerEventStore } from "./file-observability-store.js";
import { FileTaskAssessmentStore } from "./task-assessment-store.js";

it("keeps mixed-case task keys inside the run evidence directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "senawa-artifact-id-"));
  const runId = "run-abc";
  const taskId = "Extend.Schemas_2";

  const workers = new FileWorkerEventStore(root);
  await workers.appendWorkerEvent({
    runId,
    entryId: "e1",
    record: {
      apiVersion: "senawa.dev/worker-event/v1",
      runId,
      owner: { kind: "task", id: taskId },
      event: {
        eventId: "e1",
        sessionId: "session-1",
        turnId: "turn-1",
        ts: "2026-01-01T00:00:00.000Z",
        kind: "text",
        stream: "stdout",
        text: "hello",
      },
    } as never,
  });

  const sensors = new FileSensorEvidenceStore(root);
  const sensorPath = await sensors.spill({
    runId,
    owner: { kind: "task", id: taskId },
    sensorId: "lint",
    stream: "stdout",
    content: "ok",
  });

  const assessments = new FileTaskAssessmentStore(root);
  const assessment = await assessments.persist({
    version: 1,
    kind: "task-completion-assessment",
    runId,
    taskId,
    attempt: 2,
    dispatchId: "dispatch-1",
    turnId: "turn-1",
    stage: "final",
    gateId: null,
    submission: { present: true, valid: true, duplicateCount: 0 },
    criteria: [],
    unmatchedClaims: [],
    repositoryDeltaDigest: null,
    verdict: "pass",
    findings: [],
    uncertainty: [],
    assessedAt: "2026-01-01T00:00:00.000Z",
  });

  const runDirectory = resolve(root, ".agents", ".copilot-tracking", runId);
  expect(await readdir(join(runDirectory, "tasks", taskId))).toEqual([
    "diff.patch",
    "transcript.md",
  ]);
  expect(sensorPath).toContain(`task-${taskId}-stdout-`);
  expect(assessment.evidencePath.startsWith(join("evidence", "tasks", taskId, "attempt-2"))).toBe(
    true,
  );
  expect(resolve(runDirectory, assessment.evidencePath).startsWith(runDirectory)).toBe(true);
  expect(resolve(runDirectory, sensorPath).startsWith(runDirectory)).toBe(true);
});
