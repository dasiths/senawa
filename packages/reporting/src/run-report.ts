import type {
  ReportEvidenceReaderPort,
  RunReportProjection,
  WorkerEventRecord,
} from "@senawa/application";

export type ReportRun = RunReportProjection;
type JournalEvent = ReportRun["journal"][number];
type JsonObject = JournalEvent["data"];
type ReportDispatch = ReportRun["dispatches"][number];
type TaskAssessment = NonNullable<ReportDispatch["taskAssessment"]>;
type AssessedCriterion = TaskAssessment["criteria"][number];
type ResolvedEvidence = AssessedCriterion["evidence"][number];

const fieldLimit = 2_000;

export class RunReportService {
  constructor(private readonly evidence: ReportEvidenceReaderPort) {}

  async render(runId: string): Promise<string> {
    return renderRunReport(await this.evidence.readReportProjection(runId));
  }
}

export function renderRunReport(run: ReportRun): string {
  const executions = executionSummaries(run.workerEvents, run.identity.workerHost);
  const lines = [
    `# Senawa Run ${escapeMarkdown(run.identity.runId)}`,
    "",
    "## Request and Outcome",
    "",
    `Request: ${escapeMarkdown(run.identity.request.goal)}`,
    "",
    `Workflow: ${escapeMarkdown(run.identity.workflow)}`,
    "",
    `Runtime: ${escapeMarkdown(run.identity.backend)}`,
    "",
    `Worker host: ${escapeMarkdown(run.identity.workerHost.kind)}`,
    "",
    `Worker adapter: ${escapeMarkdown(`${run.identity.workerHost.adapter}@${run.identity.workerHost.adapterVersion}`)}`,
    "",
    `Outcome: **${escapeMarkdown(run.status)}**`,
    "",
  ];
  if (run.endReason !== null) lines.push(`End reason: ${escapeMarkdown(run.endReason)}`, "");
  const artifacts = run.phases.flatMap((phase) =>
    phase.artifactVersion === null ? [] : [`artifacts/${phase.id}/v${phase.artifactVersion}.json`],
  );
  lines.push(
    `Current artifacts: ${artifacts.length === 0 ? "none" : artifacts.map(escapeMarkdown).join(", ")}`,
    "",
  );

  lines.push("## Work Decomposition Graph", "", "```mermaid", "flowchart TD");
  const phaseNodes = new Map<string, string>();
  run.decomposition.forEach((phase, index) => {
    const node = `phase${index}`;
    phaseNodes.set(phase.id, node);
    lines.push(`  ${node}[${JSON.stringify(mermaidText(phase.title))}]`);
  });
  run.decomposition.forEach((phase) => {
    const target = phaseNodes.get(phase.id);
    if (target === undefined) return;
    for (const dependency of phase.dependsOn) {
      const source = phaseNodes.get(dependency);
      if (source !== undefined) lines.push(`  ${source} --> ${target}`);
    }
  });
  const taskFrontier = run.decomposition.find((phase) => phase.executorKind === "task-frontier");
  run.tasks.forEach((task, index) => {
    const node = `task${index}`;
    lines.push(`  ${node}[${JSON.stringify(mermaidText(task.title))}]`);
    if (task.dependsOn.length === 0 && taskFrontier !== undefined) {
      const parent = phaseNodes.get(taskFrontier.id);
      if (parent !== undefined) lines.push(`  ${parent} --> ${node}`);
    }
    for (const dependency of task.dependsOn) {
      const sourceIndex = run.tasks.findIndex((candidate) => candidate.key === dependency);
      if (sourceIndex >= 0) lines.push(`  task${sourceIndex} --> ${node}`);
    }
  });
  lines.push("```", "", "| Node | Status |", "|------|--------|");
  for (const phase of run.phases) {
    lines.push(`| ${escapeCell(phase.id)} | ${escapeCell(phase.status)} |`);
  }
  for (const task of run.tasks) {
    lines.push(`| ${escapeCell(task.title)} | ${escapeCell(task.status)} |`);
  }
  lines.push("");

  lines.push(
    "## Worker Execution",
    "",
    "| Owner | Role | Host | Adapter | Execution Classification | Evidence Kind | Model Invoked | Configured Model | Configured Effort | Requested Model | Requested Effort | Resolved Model | Resolved Effort | Invoked Model | Invoked Effort | Attempt | Duration | AIU | Cost |",
    "|-------|------|------|---------|--------------------------|---------------|---------------|------------------|-------------------|-----------------|------------------|----------------|-----------------|---------------|----------------|---------|----------|-----|------|",
  );
  if (executions.length === 0) {
    lines.push(
      "| None | n/a | n/a | n/a | unreported | unreported | no | n/a | n/a | n/a | n/a | n/a | n/a | none | none | 0 | n/a | n/a | n/a |",
    );
  } else {
    for (const execution of executions) {
      lines.push(
        `| ${escapeCell(`${execution.owner.kind}:${execution.owner.id}`)} | ${escapeCell(execution.role)} | ${escapeCell(execution.workerHost.kind)} | ${escapeCell(`${execution.workerHost.adapter}@${execution.workerHost.adapterVersion}`)} | ${escapeCell(execution.executionClassification)} | ${escapeCell(execution.evidenceKind)} | ${execution.modelInvoked ? "yes" : "no"} | ${escapeCell(execution.configuredModel)} | ${escapeCell(execution.configuredEffort)} | ${escapeCell(execution.requestedModel)} | ${escapeCell(execution.requestedEffort)} | ${escapeCell(execution.resolvedModel)} | ${escapeCell(execution.resolvedEffort)} | ${escapeCell(execution.invokedModel)} | ${escapeCell(execution.invokedEffort)} | ${execution.attempt} | ${escapeCell(formatDuration(execution.durationMs))} | ${escapeCell(formatAiu(execution.nanoAiu))} | ${escapeCell(formatCost(execution.costUsdMicros))} |`,
      );
    }
  }
  lines.push("");

  renderGateRefusals(lines, run.journal);
  renderHumanHistory(lines, run.journal);
  renderDiscoveries(lines, run.journal);
  renderCost(lines, executions);

  lines.push(
    "## Consumed Inputs",
    "",
    "| Consumer | Dispatch | Attempt | Input | Reference | Owner | Path | Version | Digest | Schema Kind |",
    "|----------|----------|---------|-------|-----------|-------|------|---------|--------|-------------|",
  );
  const consumedInputs = run.dispatches.flatMap((dispatch) =>
    (dispatch.inputManifest?.inputs ?? []).map((input) => ({ dispatch, input })),
  );
  if (consumedInputs.length === 0) {
    lines.push("| None | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |");
  } else {
    for (const { dispatch, input } of consumedInputs) {
      lines.push(
        `| ${escapeCell(`${dispatch.ownerKind}:${dispatch.ownerId}`)} | ${escapeCell(dispatch.dispatchId)} | ${dispatch.workAttempt} | ${escapeCell(input.name)} | ${escapeCell(input.reference)} | ${escapeCell(`${input.ownerKind}:${input.ownerId}`)} | ${escapeCell(input.path)} | ${input.version} | ${escapeCell(input.digest)} | ${escapeCell(input.schemaKind)} |`,
      );
    }
  }
  lines.push("");

  lines.push(
    "## Trusted Task Evidence",
    "",
    "| Task | Attempt | Expectation | Evidence Kind | Path | Digest | In Scope | Out of Scope | Frozen | Uncertainty | Worker Claim |",
    "|------|---------|-------------|---------------|------|--------|----------|--------------|--------|-------------|--------------|",
  );
  const taskEvidence = run.dispatches.flatMap((dispatch) =>
    dispatch.ownerKind === "task" && dispatch.repositoryDelta !== undefined
      ? [{ dispatch, evidence: dispatch.repositoryDelta }]
      : [],
  );
  if (taskEvidence.length === 0) {
    lines.push("| None | n/a | n/a | unreported | n/a | n/a | n/a | n/a | n/a | n/a | n/a |");
  } else {
    for (const { dispatch, evidence } of taskEvidence) {
      lines.push(
        `| ${escapeCell(dispatch.ownerId)} | ${dispatch.workAttempt} | ${escapeCell(evidence.expectation)} | measured | ${escapeCell(evidence.evidencePath)} | ${escapeCell(evidence.digest)} | ${evidence.inScopeChanges.length} | ${evidence.outOfScopeChanges.length} | ${evidence.frozenChanges.length} | ${evidence.uncertainty.length} | ${escapeCell(evidence.workerClaim.agreement)} |`,
      );
    }
  }
  lines.push("");

  renderTaskAcceptance(lines, run.dispatches);

  lines.push(
    "## Evidence Inventory",
    "",
    `Journal events: ${run.journal.length}`,
    "",
    `Normalized worker events: ${run.workerEvents.length}`,
    "",
    `Worker output records: ${run.outputs.length}`,
    "",
    `Versioned artifacts: ${run.artifactCount}`,
    "",
  );
  return `${lines.join("\n").trimEnd()}\n`;
}

interface ExecutionSummary {
  readonly dispatchId: string;
  readonly owner: WorkerEventRecord["owner"];
  readonly role: string;
  readonly attempt: number;
  readonly workerHost: ReportRun["identity"]["workerHost"];
  modelInvoked: boolean;
  executionClassification: "simulated" | "live-model" | "unreported";
  evidenceKind: "simulated" | "live-model" | "unreported";
  configuredModel: string;
  configuredEffort: string;
  requestedModel: string;
  resolvedModel: string;
  invokedModel: string;
  requestedEffort: string;
  resolvedEffort: string;
  invokedEffort: string;
  durationMs: number | null;
  nanoAiu: number | null;
  costUsdMicros: number | null;
}

function executionSummaries(
  events: readonly WorkerEventRecord[],
  defaultWorkerHost: ReportRun["identity"]["workerHost"],
): ExecutionSummary[] {
  const summaries = new Map<string, ExecutionSummary>();
  for (const record of events) {
    let summary = summaries.get(record.dispatchId);
    if (summary === undefined) {
      summary = {
        dispatchId: record.dispatchId,
        owner: record.owner,
        role: record.role,
        attempt: record.attempt,
        workerHost: record.workerHost ?? defaultWorkerHost,
        modelInvoked: false,
        executionClassification:
          (record.workerHost ?? defaultWorkerHost).kind === "simulated"
            ? "simulated"
            : "unreported",
        evidenceKind:
          (record.workerHost ?? defaultWorkerHost).kind === "simulated"
            ? "simulated"
            : "unreported",
        configuredModel: "unreported",
        configuredEffort: "unreported",
        requestedModel: "unreported",
        resolvedModel: "unreported",
        invokedModel: "none",
        requestedEffort: "unreported",
        resolvedEffort: "unreported",
        invokedEffort: "none",
        durationMs: null,
        nanoAiu: null,
        costUsdMicros: null,
      };
      summaries.set(record.dispatchId, summary);
    }
    if (record.event.kind === "model") {
      summary.configuredModel = record.configuredModel?.id ?? record.event.requested;
      summary.configuredEffort = record.configuredModel?.effort ?? "default";
      summary.requestedModel = record.event.requested;
      summary.resolvedModel = record.event.resolved;
      summary.modelInvoked = summary.workerHost.kind !== "simulated";
      summary.executionClassification = summary.modelInvoked ? "live-model" : "simulated";
      summary.evidenceKind = summary.executionClassification;
      summary.invokedModel = summary.modelInvoked ? record.event.resolved : "none";
      summary.requestedEffort = record.event.requestedEffort ?? "default";
      summary.resolvedEffort = record.event.resolvedEffort ?? "default";
      summary.invokedEffort = summary.modelInvoked ? summary.resolvedEffort : "none";
    } else if (record.event.kind === "usage") {
      summary.nanoAiu = Math.max(summary.nanoAiu ?? 0, record.event.cumulativeNanoAiu);
      if (record.event.cumulativeCostUsdMicros !== undefined) {
        summary.costUsdMicros = Math.max(
          summary.costUsdMicros ?? 0,
          record.event.cumulativeCostUsdMicros,
        );
      }
    } else if (record.event.kind === "lifecycle" && record.event.durationMs !== undefined) {
      summary.durationMs = record.event.durationMs;
    }
  }
  return [...summaries.values()];
}

function renderGateRefusals(lines: string[], journal: readonly JournalEvent[]): void {
  lines.push("## Gate Refusals and Subsequent Changes", "");
  const refusals = journal.filter(
    (event) => event.event === "gate.evaluated" && Reflect.get(event.data, "accepted") === false,
  );
  if (refusals.length === 0) {
    lines.push("No gate refusals were recorded.", "");
    return;
  }
  for (const refusal of refusals) {
    const ownerId = stringField(refusal.data, "ownerId");
    const next = journal.find(
      (event) =>
        event.seq > refusal.seq &&
        ["task.rework", "task.closed", "phase.submitted", "work.ended"].includes(event.event) &&
        (ownerId === "" || stringField(event.data, "taskId") === ownerId),
    );
    lines.push(
      `* ${escapeMarkdown(stringField(refusal.data, "gateId") || "unknown gate")} refused ${escapeMarkdown(ownerId || "unknown owner")} on attempt ${numberField(refusal.data, "attempt") ?? "unknown"}. Findings: ${escapeMarkdown(jsonField(refusal.data, "findings"))}. Subsequent change: ${escapeMarkdown(next?.event ?? "none recorded")}.`,
    );
  }
  lines.push("");
}

function renderHumanHistory(lines: string[], journal: readonly JournalEvent[]): void {
  lines.push("## Human Rejection and Approval History", "");
  const decisions = journal.filter(
    (event) =>
      (event.event === "phase.rejected" || event.event === "phase.approved") &&
      event.actor.channel !== "driver" &&
      event.actor.channel !== "worker",
  );
  if (decisions.length === 0) lines.push("No human phase decisions were recorded.");
  for (const decision of decisions) {
    lines.push(
      `* ${escapeMarkdown(decision.ts)}: ${escapeMarkdown(decision.event)} for ${escapeMarkdown(stringField(decision.data, "phaseId") || "unknown phase")}. ${escapeMarkdown(stringField(decision.data, "reason") || stringField(decision.data, "note") || "No reason or note recorded")}.`,
    );
  }
  lines.push("", "## Human Questions, Answers, and Approvals", "");
  const exchanges = journal.filter((event) =>
    ["question.asked", "question.answered", "phase.approved"].includes(event.event),
  );
  if (exchanges.length === 0) lines.push("No question, answer, or approval events were recorded.");
  for (const event of exchanges) {
    lines.push(
      `* ${escapeMarkdown(event.ts)}: ${escapeMarkdown(event.event)}. ${escapeMarkdown(eventSummary(event))}.`,
    );
  }
  lines.push("");
}

function renderDiscoveries(lines: string[], journal: readonly JournalEvent[]): void {
  lines.push("## Discoveries and Notes", "");
  const facts = journal.filter((event) =>
    ["discovery.recorded", "note.recorded"].includes(event.event),
  );
  if (facts.length === 0) lines.push("No discoveries or notes were recorded.");
  for (const event of facts) {
    lines.push(`* ${escapeMarkdown(event.ts)}: ${escapeMarkdown(eventSummary(event))}.`);
  }
  lines.push("");
}

function renderTaskAcceptance(lines: string[], dispatches: readonly ReportDispatch[]): void {
  lines.push(
    "## Task Acceptance Assessments",
    "",
    "| Task | Attempt | Stage | Assessment | Submission | Criterion | Required | Claimed | Verdict | Resolved Evidence | Assessment Path |",
    "|------|---------|-------|------------|------------|-----------|----------|---------|---------|-------------------|-----------------|",
  );
  const assessments = dispatches.flatMap((dispatch) =>
    dispatch.ownerKind === "task" && dispatch.taskAssessment !== undefined
      ? [{ dispatch, assessment: dispatch.taskAssessment }]
      : [],
  );
  if (assessments.length === 0) {
    lines.push("| None | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |", "");
    return;
  }
  for (const { dispatch, assessment } of assessments) {
    const lead = `| ${escapeCell(dispatch.ownerId)} | ${dispatch.workAttempt} | ${escapeCell(assessment.stage)} | ${escapeCell(assessment.verdict)} | ${escapeCell(submissionState(assessment))}`;
    const trail = `| ${escapeCell(assessment.evidencePath)} |`;
    if (assessment.criteria.length === 0) {
      lines.push(`${lead} | none | n/a | n/a | n/a | none ${trail}`);
      continue;
    }
    for (const criterion of assessment.criteria) {
      lines.push(
        `${lead} | ${escapeCell(criterion.id)} | ${criterion.required ? "yes" : "no"} | ${escapeCell(criterion.claimed)} | ${escapeCell(criterion.verdict)} | ${escapeCell(evidenceCell(criterion.evidence))} ${trail}`,
      );
    }
  }
  lines.push("");
  for (const { dispatch, assessment } of assessments) {
    if (assessment.unmatchedClaims.length === 0 && assessment.uncertainty.length === 0) continue;
    lines.push(
      `* ${escapeMarkdown(dispatch.ownerId)} attempt ${dispatch.workAttempt}: unmatched claims ${escapeMarkdown(listOrNone(assessment.unmatchedClaims))}. Uncertainty ${escapeMarkdown(listOrNone(assessment.uncertainty))}.`,
    );
  }
  lines.push("");
}

function submissionState(assessment: TaskAssessment): string {
  if (!assessment.submission.present) return "missing";
  return assessment.submission.valid ? "valid" : "invalid";
}

function evidenceCell(evidence: readonly ResolvedEvidence[]): string {
  if (evidence.length === 0) return "none";
  return evidence.map(evidenceLabel).join("; ");
}

function evidenceLabel(reference: ResolvedEvidence): string {
  const claim = reference.claim;
  const subject =
    claim.kind === "file"
      ? `${claim.path} (${claim.relationship})`
      : claim.kind === "sensor"
        ? `sensor ${claim.sensorId}`
        : claim.kind === "command"
          ? `command ${claim.command}`
          : `repository-delta ${claim.scope}`;
  return `${subject}: ${reference.resolution} via ${reference.source}`;
}

function listOrNone(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

function renderCost(lines: string[], executions: readonly ExecutionSummary[]): void {
  lines.push(
    "## Usage by Role and Invoked Model",
    "",
    "| Role | Execution Classification | Invoked Model | AIU | Cost |",
    "|------|--------------------------|---------------|-----|------|",
  );
  const totals = new Map<
    string,
    {
      role: string;
      classification: string;
      model: string;
      nanoAiu: number | null;
      cost: number | null;
    }
  >();
  for (const execution of executions) {
    const key = `${execution.role}\u0000${execution.executionClassification}\u0000${execution.invokedModel}`;
    const total = totals.get(key) ?? {
      role: execution.role,
      classification: execution.executionClassification,
      model: execution.invokedModel,
      nanoAiu: null,
      cost: null,
    };
    total.nanoAiu = addReported(total.nanoAiu, execution.nanoAiu);
    total.cost = addReported(total.cost, execution.costUsdMicros);
    totals.set(key, total);
  }
  if (totals.size === 0) lines.push("| None | unreported | none | n/a | n/a |");
  for (const total of totals.values()) {
    lines.push(
      `| ${escapeCell(total.role)} | ${escapeCell(total.classification)} | ${escapeCell(total.model)} | ${escapeCell(formatAiu(total.nanoAiu))} | ${escapeCell(formatCost(total.cost))} |`,
    );
  }
  lines.push("");
}

function eventSummary(event: JournalEvent): string {
  return truncate(JSON.stringify(event.data), fieldLimit);
}

function addReported(total: number | null, value: number | null): number | null {
  return value === null ? total : (total ?? 0) + value;
}

function stringField(data: JsonObject, key: string): string {
  const value = data[key];
  return typeof value === "string" ? truncate(value, fieldLimit) : "";
}

function numberField(data: JsonObject, key: string): number | null {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function jsonField(data: JsonObject, key: string): string {
  return truncate(JSON.stringify(data[key] ?? []), fieldLimit);
}

function formatDuration(value: number | null): string {
  return value === null ? "unreported" : `${value} ms`;
}

function formatAiu(value: number | null): string {
  return value === null ? "unreported" : (value / 1_000_000_000).toFixed(3);
}

function formatCost(value: number | null): string {
  return value === null ? "unreported" : `$${(value / 1_000_000).toFixed(6)}`;
}

function mermaidText(value: string): string {
  return sanitize(value, 200)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("`", "'")
    .replaceAll("[", "(")
    .replaceAll("]", ")");
}

function escapeCell(value: string): string {
  return escapeMarkdown(value).replaceAll("\n", " ");
}

function escapeMarkdown(value: string): string {
  return sanitize(value, fieldLimit)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_{}[\]()#+!|~-])/gu, "\\$1");
}

function sanitize(value: string, limit: number): string {
  return [...truncate(value.replaceAll("\r\n", "\n"), limit)]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return character === "\n" || character === "\t" || (code >= 32 && (code < 127 || code > 159));
    })
    .join("")
    .replace(/<\/?(?:system|assistant|user|tool|instructions?)\b[^>]*>/giu, "[neutralized-tag]");
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 14))}[truncated]`;
}
