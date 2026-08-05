import type { RunPersistencePort } from "@senawa/application";
import type { RuntimeState } from "@senawa/domain";

export type ReportRun = Pick<
  RuntimeState,
  "identity" | "status" | "endReason" | "phases" | "tasks" | "artifacts" | "journal" | "outputs"
>;

export class RunReportService {
  constructor(private readonly store: RunPersistencePort) {}

  async render(runId: string): Promise<string> {
    return renderRunReport((await this.store.readRun(runId)).state);
  }
}

export function renderRunReport(run: ReportRun): string {
  const outputCount = Object.values(run.outputs).reduce(
    (total, records) => total + records.length,
    0,
  );
  const lines = [
    `# Senawa Run ${escapeMarkdown(run.identity.runId)}`,
    "",
    `Status: **${escapeMarkdown(run.status)}**`,
    "",
    `Workflow: ${escapeMarkdown(run.identity.workflow)}`,
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
    `Journal events: ${run.journal.length}`,
    "",
    `Worker output records: ${outputCount}`,
    "",
    `Versioned artifacts: ${run.artifacts.length}`,
    "",
  );
  const latestEvent = run.journal.at(-1);
  if (latestEvent !== undefined) {
    lines.push(
      `Latest event: ${escapeMarkdown(latestEvent.event)} at ${escapeMarkdown(latestEvent.ts)}`,
      "",
    );
  }

  const latestOutput = Object.values(run.outputs)
    .flat()
    .sort((left, right) => left.ts.localeCompare(right.ts))
    .at(-1);
  if (latestOutput !== undefined) {
    lines.push("## Latest Output", "", escapeMarkdown(latestOutput.text), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function escapeCell(value: string): string {
  return escapeMarkdown(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
