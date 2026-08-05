import type { ReportEvidenceReaderPort, RunReportProjection } from "@senawa/application";

export type ReportRun = RunReportProjection;

export class RunReportService {
  constructor(private readonly evidence: ReportEvidenceReaderPort) {}

  async render(runId: string): Promise<string> {
    return renderRunReport(await this.evidence.readReportProjection(runId));
  }
}

export function renderRunReport(run: ReportRun): string {
  const lines = [
    `# Senawa Run ${escapeMarkdown(run.identity.runId)}`,
    "",
    `Status: **${escapeMarkdown(run.status)}**`,
    "",
    `Workflow: ${escapeMarkdown(run.identity.workflow)}`,
    "",
    `Runtime: ${escapeMarkdown(run.identity.backend)}`,
    "",
    `Goal: ${escapeMarkdown(run.identity.request.goal)}`,
    "",
  ];
  if (run.endReason !== null) {
    lines.push(`End reason: ${escapeMarkdown(run.endReason)}`, "");
  }

  lines.push(
    "## Phases",
    "",
    "| Phase | Status | Iteration | Artifact |",
    "|-------|--------|-----------|----------|",
  );
  for (const phase of run.phases) {
    const artifact =
      phase.artifactVersion === null ? "" : `artifacts/${phase.id}/v${phase.artifactVersion}.json`;
    lines.push(
      `| ${escapeCell(phase.id)} | ${escapeCell(phase.status)} | ${phase.iteration} | ${escapeCell(artifact)} |`,
    );
  }

  lines.push("", "## Tasks", "", "| Task | Status | Attempts |", "|------|--------|----------|");
  if (run.tasks.length === 0) {
    lines.push("| None | n/a | 0 |");
  } else {
    for (const task of run.tasks) {
      lines.push(`| ${escapeCell(task.title)} | ${escapeCell(task.status)} | ${task.attempt} |`);
    }
  }

  lines.push(
    "",
    "## Evidence",
    "",
    `Journal events: ${run.journalCount}`,
    "",
    `Worker output records: ${run.outputCount}`,
    "",
    `Versioned artifacts: ${run.artifactCount}`,
    "",
  );
  const latestEvent = run.latestEvent;
  if (latestEvent !== null) {
    lines.push(
      `Latest event: ${escapeMarkdown(latestEvent.event)} at ${escapeMarkdown(latestEvent.ts)}`,
      "",
    );
  }

  const latestOutput = run.latestOutput;
  if (latestOutput !== null) {
    lines.push("## Latest Output", "", escapeMarkdown(latestOutput.text), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function escapeCell(value: string): string {
  return escapeMarkdown(value).replaceAll("\n", " ");
}

function escapeMarkdown(value: string): string {
  const neutralized = [...value.replaceAll("\r\n", "\n")]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return character === "\n" || character === "\t" || (code >= 32 && (code < 127 || code > 159));
    })
    .join("")
    .replace(/<\/?(?:system|assistant|user|tool|instructions?)\b[^>]*>/giu, "[neutralized-tag]")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return neutralized.replace(/([\\`*_{}[\]()#+!|~-])/gu, "\\$1");
}
