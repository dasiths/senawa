import { describe, expect, it } from "vitest";
import { type ReportRun, renderRunReport } from "./run-report.js";

describe("renderRunReport", () => {
  it("summarizes durable evidence and escapes worker output", () => {
    const run = {
      identity: {
        runId: "run-report",
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
          title: "Validate | output",
          dependsOn: [],
          paths: ["packages"],
          acceptance: ["tests pass"],
          role: "implementor",
          status: "closed",
          attempt: 2,
          sessionId: "task-session",
          steering: [],
        },
      ],
      artifacts: [
        {
          phaseId: "verify",
          version: 1,
          path: "artifacts/verify/v1.json",
          createdAt: "2026-08-04T10:01:00.000Z",
          content: { verdict: "pass" },
          consumed: {},
        },
      ],
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
      outputs: {
        "task:validate": [
          {
            apiVersion: "senawa.dev/output/v1",
            seq: 1,
            ts: "2026-08-04T10:01:30.000Z",
            runId: "run-report",
            owner: { kind: "task", id: "validate" },
            stream: "stdout",
            text: "<script>alert('unsafe')</script>",
          },
        ],
      },
    } satisfies ReportRun;

    const report = renderRunReport(run);
    expect(report).toContain("artifacts/verify/v1.json");
    expect(report).toContain("Validate \\| output");
    expect(report).toContain("&lt;script&gt;");
    expect(report).not.toContain("<script>");
  });
});
