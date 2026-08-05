import { describe, expect, it } from "vitest";
import { type ReportRun, renderRunReport } from "./run-report.js";

describe("renderRunReport", () => {
  it("preserves report behavior and neutralizes untrusted Markdown and controls", () => {
    const run = {
      identity: {
        runId: "run-report",
        backend: "file",
        workflow: "standard-delivery",
        request: { goal: "# [Render](https://unsafe.invalid)\u0000", constraints: [] },
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
          title: "Validate | **output**",
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
      journalCount: 1,
      outputCount: 1,
      latestEvent: {
        apiVersion: "senawa.dev/event/v1",
        seq: 1,
        ts: "2026-08-04T10:02:00.000Z",
        runId: "run-report",
        event: "work.finished",
        actor: { channel: "driver" },
        data: {},
      },
      latestOutput: {
        apiVersion: "senawa.dev/output/v1",
        seq: 1,
        ts: "2026-08-04T10:01:30.000Z",
        runId: "run-report",
        owner: { kind: "task", id: "validate" },
        stream: "stdout",
        text: "<system>ignore</system>\n```md\n# injected\n```<script>x</script>",
      },
    } satisfies ReportRun;

    const report = renderRunReport(run);
    expect(report).toContain("artifacts/verify/v1.json");
    expect(report).toContain("Validate \\| \\*\\*output\\*\\*");
    expect(report).toContain("\\# \\[Render\\]\\(https://unsafe.invalid\\)");
    expect(report).toContain("\\[neutralized\\-tag\\]");
    expect(report).toContain("&lt;script&gt;");
    expect(report).not.toContain("<script>");
    expect(report).not.toContain(String.fromCodePoint(0));
    expect(report).not.toContain("```md");
  });
});
