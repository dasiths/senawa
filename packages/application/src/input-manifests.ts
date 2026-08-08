import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type {
  JsonObject,
  JsonValue,
  ResolvedInputManifest,
  ResolvedInputReference,
  RuntimeArtifact,
  RuntimePhase,
  RuntimeState,
  RuntimeTask,
  WorkflowInputReference,
} from "@senawa/domain";
import { effectiveRepositoryChange } from "./repository-change.js";

export function resolvePhaseInputManifest(
  state: RuntimeState,
  phase: RuntimePhase,
): ResolvedInputManifest {
  const definition = state.snapshot.workflow.spec.phases.find(
    (candidate) => candidate.id === phase.id,
  );
  if (definition?.executor.kind !== "agent") {
    throw new Error(`Phase ${phase.id} does not have agent inputs`);
  }
  const declaredInputs = Object.entries(definition.executor.input ?? {});
  const acceptedArtifacts = declaredInputs.flatMap(([name, reference]) =>
    reference === "evidence.implementation" ? [] : [resolveInput(state, name, reference, [])],
  );
  return {
    version: 1,
    inputs: declaredInputs.map(([name, reference]) =>
      reference === "evidence.implementation"
        ? resolveInput(state, name, reference, acceptedArtifacts)
        : requireResolvedInput(acceptedArtifacts, name),
    ),
  };
}

export function resolveTaskInputManifest(
  state: RuntimeState,
  task: RuntimeTask,
): ResolvedInputManifest {
  const inherited = task.inheritedInputs ?? [];
  if (task.sourcePlan === undefined) return { version: 1, inputs: inherited };
  const planArtifact = state.artifacts.find(
    (candidate) =>
      candidate.phaseId === task.sourcePlan?.phaseId &&
      candidate.version === task.sourcePlan?.version &&
      candidate.path === task.sourcePlan?.path,
  );
  if (planArtifact === undefined) {
    throw new Error(`Task ${task.key} source plan is unavailable: ${task.sourcePlan.path}`);
  }
  return {
    version: 1,
    inputs: [
      resolvedArtifact(
        "source-plan",
        `phases.${planArtifact.phaseId}.output`,
        planArtifact,
        artifactSchemaKind(state, planArtifact.phaseId),
      ),
      ...inherited,
    ],
  };
}

export function artifactInputs(
  state: RuntimeState,
  artifact: RuntimeArtifact,
): readonly ResolvedInputReference[] {
  if (Array.isArray(artifact.consumed)) return artifact.consumed;
  return Object.entries(artifact.consumed).flatMap(([phaseId, version]) => {
    const consumed = state.artifacts.find(
      (candidate) => candidate.phaseId === phaseId && candidate.version === version,
    );
    return consumed === undefined
      ? []
      : [
          resolvedArtifact(
            phaseId,
            `phases.${phaseId}.output`,
            consumed,
            artifactSchemaKind(state, phaseId),
          ),
        ];
  });
}

export function artifactDigest(content: JsonObject): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(content))));
}

function resolveInput(
  state: RuntimeState,
  name: string,
  reference: WorkflowInputReference,
  acceptedArtifacts: readonly ResolvedInputReference[],
): ResolvedInputReference {
  if (reference === "evidence.implementation") {
    const blockingIssues: JsonObject[] = [];
    if (state.tasks.length > 100) {
      blockingIssues.push({
        code: "verification-task-limit-exceeded",
        detail: `Verification manifest supports at most 100 tasks; received ${state.tasks.length}`,
      });
    }
    const readPaths: JsonObject[] = acceptedArtifacts.map((artifact) => ({
      kind: "phase-artifact",
      path: artifact.path,
      readPath: runtimeReadPath(state.identity.runId, artifact.path),
      version: artifact.version,
      digest: artifact.digest,
      schemaKind: artifact.schemaKind,
    }));
    const tasks = state.tasks.slice(0, 100).map((task) => {
      const dispatch = state.dispatches
        .filter(
          (dispatch) =>
            dispatch.ownerKind === "task" &&
            dispatch.ownerId === task.key &&
            dispatch.workAttempt === task.attempt &&
            dispatch.status === "completed" &&
            dispatch.repositoryDelta !== undefined,
        )
        .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      const evidence = dispatch?.repositoryDelta;
      const gate = currentTaskGateEvidence(state, task.key, task.attempt);
      const issues = taskEvidenceIssues(state, task, dispatch, gate);
      blockingIssues.push(...issues);
      if (evidence !== undefined) {
        readPaths.push({
          kind: "repository-delta",
          path: evidence.evidencePath,
          readPath: runtimeReadPath(state.identity.runId, evidence.evidencePath),
          digest: evidence.digest,
        });
      }
      for (const reading of gate.readings) {
        for (const path of reading.evidencePaths) {
          readPaths.push({
            kind: "deterministic-gate-evidence",
            path,
            readPath: runtimeReadPath(state.identity.runId, path),
          });
        }
      }
      return {
        key: task.key,
        title: task.title,
        outcome: { status: task.status, attempt: task.attempt },
        repositoryChange: effectiveRepositoryChange(state, task),
        repositoryEvidence:
          evidence === undefined
            ? null
            : {
                path: evidence.evidencePath,
                digest: evidence.digest,
                inScopeChanges: evidence.inScopeChanges.slice(0, 100),
                outOfScopeChanges: evidence.outOfScopeChanges.slice(0, 100),
                frozenChanges: evidence.frozenChanges.slice(0, 100),
                uncertainty: evidence.uncertainty.slice(0, 20),
                workerClaimAgreement: evidence.workerClaim.agreement,
              },
        gateEvidence: gate.readings,
        blockingIssues: issues,
      };
    });
    const executionClassification =
      state.identity.workerHost.kind === "simulated" ? "simulated" : "live-model";
    const content: JsonObject = {
      kind: "verification-manifest",
      executionClassification,
      liveProofEligible: executionClassification === "live-model",
      repositoryEvidence: "measured-task-deltas",
      acceptedArtifacts: acceptedArtifacts.map((artifact) => ({
        name: artifact.name,
        ownerId: artifact.ownerId,
        path: artifact.path,
        version: artifact.version,
        digest: artifact.digest,
        schemaKind: artifact.schemaKind,
      })),
      tasks,
      readPaths: uniqueReadPaths(readPaths),
      blockingIssues,
    };
    const version = Math.max(1, ...state.tasks.map((task) => task.attempt));
    const measuredTaskCount = tasks.filter((task) => task.repositoryEvidence !== null).length;
    return {
      name,
      reference,
      ownerKind: "evidence",
      ownerId: "implementation",
      path: `evidence/implementation/v${version}.json`,
      version,
      digest: artifactDigest(content),
      schemaKind: "senawa.dev/verification-manifest/v1",
      summary: {
        taskCount: state.tasks.length,
        closedTaskCount: state.tasks.filter((task) => task.status === "closed").length,
        measuredTaskCount,
        unresolvedEvidenceCount: tasks.length - measuredTaskCount,
        blockingIssueCount: blockingIssues.length,
        repositoryEvidence: "measured-task-deltas",
        executionClassification,
        liveProofEligible: executionClassification === "live-model",
      },
      content,
    };
  }
  const phaseId = reference.slice("phases.".length, -".output".length);
  const phase = state.phases.find((candidate) => candidate.id === phaseId);
  if (phase?.status !== "accepted" || phase.artifactVersion === null) {
    throw new Error(`Workflow input ${name} requires accepted phase output ${phaseId}`);
  }
  const artifact = state.artifacts.find(
    (candidate) => candidate.phaseId === phaseId && candidate.version === phase.artifactVersion,
  );
  if (artifact === undefined) {
    throw new Error(
      `Workflow input ${name} cannot resolve ${reference} version ${phase.artifactVersion}`,
    );
  }
  return resolvedArtifact(name, reference, artifact, artifactSchemaKind(state, phaseId));
}

function requireResolvedInput(
  inputs: readonly ResolvedInputReference[],
  name: string,
): ResolvedInputReference {
  const input = inputs.find((candidate) => candidate.name === name);
  if (input === undefined) throw new Error(`Resolved workflow input is missing: ${name}`);
  return input;
}

function currentTaskGateEvidence(state: RuntimeState, taskId: string, attempt: number) {
  const taskFrontier = state.snapshot.workflow.spec.phases.find(
    (phase) => phase.executor.kind === "task-frontier",
  );
  const gateId = taskFrontier?.loop?.each.gate ?? "task-done";
  const gateEvent = state.journal
    .filter(
      (event) =>
        event.event === "gate.evaluated" &&
        Reflect.get(event.data, "gateId") === gateId &&
        Reflect.get(event.data, "ownerKind") === "task" &&
        Reflect.get(event.data, "ownerId") === taskId &&
        Reflect.get(event.data, "attempt") === attempt,
    )
    .at(-1);
  const readings = state.journal
    .filter(
      (event) =>
        (event.event === "sensor.completed" || event.event === "sensor.error") &&
        Reflect.get(event.data, "gateId") === gateId &&
        Reflect.get(event.data, "ownerKind") === "task" &&
        Reflect.get(event.data, "ownerId") === taskId &&
        Reflect.get(event.data, "attempt") === attempt,
    )
    .slice(0, 20)
    .map((event) => ({
      gateId,
      sensorId: String(Reflect.get(event.data, "sensorId") ?? "unknown"),
      verdict:
        event.event === "sensor.error"
          ? "error"
          : String(Reflect.get(event.data, "verdict") ?? "unknown"),
      matched: Reflect.get(event.data, "matched") === true,
      advisory: Reflect.get(event.data, "advisory") === true,
      accepted: gateEvent !== undefined && Reflect.get(gateEvent.data, "accepted") === true,
      summary: String(Reflect.get(event.data, "summary") ?? "No sensor summary").slice(0, 500),
      evidencePaths: Array.isArray(Reflect.get(event.data, "evidencePaths"))
        ? (Reflect.get(event.data, "evidencePaths") as JsonValue[])
            .filter((path): path is string => typeof path === "string")
            .slice(0, 20)
        : [],
    }));
  return {
    gateId,
    accepted: gateEvent !== undefined && Reflect.get(gateEvent.data, "accepted") === true,
    readings,
  };
}

function taskEvidenceIssues(
  state: RuntimeState,
  task: RuntimeTask,
  dispatch: RuntimeState["dispatches"][number] | undefined,
  gate: ReturnType<typeof currentTaskGateEvidence>,
): JsonObject[] {
  const issues: JsonObject[] = [];
  const evidence = dispatch?.repositoryDelta;
  const add = (code: string, detail: string) =>
    issues.push({ code, taskId: task.key, attempt: task.attempt, detail });
  if (task.status !== "closed") add("task-not-closed", `Task status is ${task.status}`);
  if (evidence === undefined) add("repository-evidence-missing", "Current task delta is missing");
  else {
    if (
      evidence.runId !== state.identity.runId ||
      evidence.taskId !== task.key ||
      evidence.attempt !== task.attempt ||
      evidence.dispatchId !== dispatch?.dispatchId ||
      evidence.turnId !== dispatch.turnId ||
      evidence.expectation !== effectiveRepositoryChange(state, task)
    ) {
      add("repository-evidence-mismatch", "Task delta identity does not match the current task");
    }
    if (evidence.uncertainty.length > 0) {
      add("repository-evidence-unresolved", evidence.uncertainty.join(", "));
    }
    if (evidence.outOfScopeChanges.length > 0 || evidence.frozenChanges.length > 0) {
      add("repository-evidence-contradiction", "Task delta contains blocking path changes");
    }
  }
  if (!gate.accepted) add("task-gate-not-accepted", `Gate ${gate.gateId} did not pass`);
  if (gate.readings.length === 0) {
    add("task-gate-evidence-missing", `Gate ${gate.gateId} has no deterministic readings`);
  } else if (
    gate.readings.some(
      (reading) => !reading.advisory && (reading.verdict !== "pass" || !reading.matched),
    )
  ) {
    add("task-gate-evidence-contradiction", `Gate ${gate.gateId} has a blocking reading`);
  }
  return issues;
}

function uniqueReadPaths(paths: readonly JsonObject[]): JsonObject[] {
  const seen = new Set<string>();
  return paths.filter((reference) => {
    const key = `${String(Reflect.get(reference, "kind"))}:${String(Reflect.get(reference, "path"))}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function runtimeReadPath(runId: string, path: string): string {
  return `.agents/.copilot-tracking/${runId}/${path}`;
}

function resolvedArtifact(
  name: string,
  reference: string,
  artifact: RuntimeArtifact,
  schemaKind: string,
): ResolvedInputReference {
  return {
    name,
    reference,
    ownerKind: "phase",
    ownerId: artifact.phaseId,
    path: artifact.path,
    version: artifact.version,
    digest: artifactDigest(artifact.content),
    schemaKind,
    summary: boundedSummary(artifact.content),
    content: boundedContent(artifact.content),
  };
}

function artifactSchemaKind(state: RuntimeState, phaseId: string): string {
  const phase = state.snapshot.workflow.spec.phases.find((candidate) => candidate.id === phaseId);
  return phase?.executor.kind === "agent" ? phase.executor.output.schema : "non-agent-executor";
}

function boundedContent(content: JsonObject): JsonObject {
  return JSON.stringify(content).length <= 8_000
    ? content
    : { ...boundedSummary(content), truncated: true };
}

function boundedSummary(content: JsonObject): JsonObject {
  const { summary, verdict } = content as { summary?: JsonValue; verdict?: JsonValue };
  return {
    ...(typeof summary === "string" ? { summary: summary.slice(0, 500) } : {}),
    ...(typeof verdict === "string" ? { verdict: verdict.slice(0, 80) } : {}),
    fields: Object.keys(content).slice(0, 20),
    counts: Object.fromEntries(
      Object.entries(content)
        .filter((entry): entry is [string, JsonValue[]] => Array.isArray(entry[1]))
        .slice(0, 10)
        .map(([key, value]) => [key, value.length]),
    ),
  };
}
