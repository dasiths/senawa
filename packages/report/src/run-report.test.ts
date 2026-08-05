import { describe, expect, it } from "vitest";
import { type ReportRun, renderRunReport } from "./run-report.js";

describe("renderRunReport", () => {
  it("summarizes durable evidence and escapes worker output", () => {
    const run = {
      identity: {
        runId: "run-report",
        backend: "file",
        workflow: "standard-delivery",
        request: { goal: "Render a report", constraints: [] },
        createdAt: "2026-08-04T10:00:00.000Z",
        fingerprint: "a".repeat(64),
      },
      status: "finished",
      endReason: null,
      phases: [
        {
          id: "verify",
          status: "accepted",
          iteration: 1,
          artifactVersion: 1,
          sessionId: "session",
          rejectionReason: null,
        },
      ],
      tasks: [
        {
          key: "validate",
          title: "Validate | output<script>",
          dependsOn: [],
          paths: ["packages"],
          acceptance: ["tests pass"],
          role: "implementor",
          status: "closed",
          attempt: 2,
          dispatchFailures: 0,
          sessionId: "task-session",
          steering: [],
        },
      ],
      artifactCount: 1,
      decomposition: [{ id: "verify", title: "Verify", dependsOn: [], executorKind: "agent" }],
      journal: [
        {
          apiVersion: "senawa.dev/event/v1",
          seq: 1,
          ts: "2026-08-04T10:02:00.000Z",
          runId: "run-report",
          event: "work.finished",
          actor: { channel: "driver" },
          data: {},
        },
      ],
      outputs: [],
      workerEvents: [],
    } satisfies ReportRun;

    const report = renderRunReport(run);
    expect(report).toContain("artifacts/verify/v1.json");
    expect(report).toContain("Validate \\| output");
    expect(report).toContain("&lt;script&gt;");
    expect(report).not.toContain("<script>");
  });
});
