import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import type { GateEvaluationPort } from "@senawa/application";
import {
  GateEvaluationSchema,
  type JsonObject,
  type JsonValue,
  type RepositoryChangeExpectation,
  type RepositoryDeltaEvidence,
  type RepositoryPolicy,
  RepositoryPolicySchema,
  type ResolvedInputManifest,
  type SensorAssessment,
  type SensorExecutionError,
  type SensorFinding,
  type SensorReading,
  type SensorResult,
} from "@senawa/domain";
import { z } from "zod";

const artifactExtension = "@senawa/sensor-artifact";
const commandExtension = "@senawa/sensor-command";
const taskChangeExtension = "@senawa/sensor-task-change";
const supportedExtensions = new Set([artifactExtension, commandExtension, taskChangeExtension]);
const ansiEscapePattern = new RegExp(`${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");
const missing = Symbol("missing");

export const SENSOR_OUTPUT_LIMIT = 8_000;
export const DEFAULT_SENSOR_TIMEOUT_MS = 120_000;

const ArtifactSensorConfigSchema = z
  .object({ artifactKind: z.enum(["phase-output", "verification-output"]) })
  .strict();
const TaskChangeSensorConfigSchema = z
  .object({ evidenceKind: z.literal("repository-delta") })
  .strict();
const CommandSensorConfigSchema = z
  .object({
    command: z.string().trim().min(1),
    parser: z.literal("raw"),
    timeoutMs: z.number().int().positive().max(600_000).optional(),
  })
  .strict();

export interface GateEvaluationInput {
  readonly runId: string;
  readonly owner: { readonly kind: "phase" | "task"; readonly id: string };
  readonly attempt: number;
  readonly gateId: string;
  readonly policy: RepositoryPolicy;
  readonly artifact?: JsonObject;
  readonly inputManifest?: ResolvedInputManifest;
  readonly repositoryChange?: RepositoryChangeExpectation;
  readonly repositoryEvidence?: RepositoryDeltaEvidence;
  readonly onOutput?: (input: {
    readonly sensorId: string;
    readonly stream: "stdout" | "stderr" | "system";
    readonly text: string;
  }) => Promise<void>;
}

export interface GateEvaluator {
  evaluate(input: GateEvaluationInput): Promise<ReturnType<typeof GateEvaluationSchema.parse>>;
}

export interface CommandExecution {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
  readonly timedOut?: boolean;
}

export interface CommandRunner {
  execute(
    command: string,
    options: {
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly timeoutMs: number;
      readonly onOutput?: (stream: "stdout" | "stderr", text: string) => Promise<void>;
    },
  ): Promise<CommandExecution>;
}

export interface CommandGateEvaluatorOptions {
  readonly timeoutMs?: number;
  readonly runner?: CommandRunner;
  readonly now?: () => number;
  readonly cache?: SensorReadingCache;
  readonly cacheIdentity?: SensorCacheIdentity;
  readonly evidenceStore?: SensorEvidenceStore;
}

export interface SensorReadingCache {
  read(key: string): Promise<SensorResult | null>;
  write(key: string, result: SensorResult): Promise<void>;
}

export type SensorCacheIdentity = (
  sensor: RepositoryPolicy["sensors"][number],
  input: GateEvaluationInput,
) => string | null;

export interface SensorEvidenceStore {
  spill(input: {
    readonly runId: string;
    readonly owner: GateEvaluationInput["owner"];
    readonly sensorId: string;
    readonly stream: "stdout" | "stderr";
    readonly content: string;
  }): Promise<string>;
}

export class CommandGateEvaluator implements GateEvaluator, GateEvaluationPort {
  private readonly runner: CommandRunner;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly cache: SensorReadingCache | undefined;
  private readonly cacheIdentity: SensorCacheIdentity | undefined;
  private readonly evidenceStore: SensorEvidenceStore | undefined;

  constructor(
    private readonly repositoryRoot: string,
    options: CommandGateEvaluatorOptions = {},
  ) {
    this.runner = options.runner ?? new SpawnCommandRunner();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SENSOR_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.cache = options.cache;
    this.cacheIdentity = options.cacheIdentity;
    this.evidenceStore = options.evidenceStore;
  }

  async evaluate(input: GateEvaluationInput) {
    const policy = RepositoryPolicySchema.parse(input.policy);
    const gate = policy.gates.find((candidate) => candidate.id === input.gateId);
    if (gate === undefined) throw new Error(`Unknown gate: ${input.gateId}`);

    const declaredExtensions = new Set(
      policy.extensions.flatMap((extension) => ("package" in extension ? [extension.package] : [])),
    );
    const readings: SensorReading[] = [];
    const findings: SensorFinding[] = [];
    let accepted = true;

    const checks = gate.checks
      .map((check, index) => {
        const sensor = policy.sensors.find((candidate) => candidate.id === check.sensor);
        if (sensor === undefined) throw new Error(`Unknown sensor: ${check.sensor}`);
        return { check, sensor, index };
      })
      .sort(
        (left, right) =>
          sensorOrder(left.sensor) - sensorOrder(right.sensor) || left.index - right.index,
      );
    let deterministicBlocked = false;

    for (const { check, sensor } of checks) {
      const advisory = check.advisory || sensor.trust === "advisory";
      if (deterministicBlocked && !advisory && sensor.cost !== "cheap") continue;
      const startedAt = this.now();
      const result = await this.readOrRunSensor(sensor, input, declaredExtensions);
      const durationMs = Math.max(0, this.now() - startedAt);
      const executionError = "error" in result;
      const matched = !executionError && expectationMatches(result, check.expect);
      const reading = {
        sensorId: sensor.id,
        extension: sensor.extension,
        result,
        expect: check.expect,
        matched,
        advisory,
        durationMs,
        evidencePaths: sensorEvidencePaths(result),
      } satisfies SensorReading;
      readings.push(reading);

      if (executionError) {
        accepted = false;
        findings.push({
          severity: "error",
          code: "sensor-execution-error",
          message: `${sensor.id}: ${result.summary}`,
        });
      } else if (matched) {
        findings.push(...result.findings.filter((finding) => finding.severity !== "error"));
      } else if (!matched) {
        findings.push(...result.findings);
        if (result.findings.length === 0) {
          findings.push({
            severity: advisory ? "warning" : "error",
            code: "gate-expectation-failed",
            message: `${sensor.id}: ${result.summary}`,
          });
        }
        if (!advisory) accepted = false;
      }
      if (sensor.kind === "deterministic" && !advisory && (executionError || !matched)) {
        deterministicBlocked = true;
      }
    }

    return GateEvaluationSchema.parse({ gateId: gate.id, accepted, readings, findings });
  }

  private async readOrRunSensor(
    sensor: RepositoryPolicy["sensors"][number],
    input: GateEvaluationInput,
    declaredExtensions: ReadonlySet<string>,
  ): Promise<SensorResult> {
    const cacheKey = this.cacheIdentity?.(sensor, input) ?? null;
    if (cacheKey !== null && this.cache !== undefined) {
      const cached = await this.cache.read(cacheKey);
      if (cached !== null) return cached;
    }
    const result = await this.runSensor(sensor, input, declaredExtensions);
    if (cacheKey !== null && this.cache !== undefined) await this.cache.write(cacheKey, result);
    return result;
  }

  private async runSensor(
    sensor: RepositoryPolicy["sensors"][number],
    input: GateEvaluationInput,
    declaredExtensions: ReadonlySet<string>,
  ): Promise<SensorAssessment | SensorExecutionError> {
    if (
      sensor.kind !== "deterministic" ||
      !supportedExtensions.has(sensor.extension) ||
      !declaredExtensions.has(sensor.extension)
    ) {
      return executionError(`Unsupported sensor extension: ${sensor.extension}`);
    }

    if (sensor.extension === artifactExtension) {
      const config = ArtifactSensorConfigSchema.safeParse(sensor.config);
      if (!config.success) return executionError(`Invalid ${sensor.id} configuration`);
      if (config.data.artifactKind === "verification-output") {
        return assessVerification(input);
      }
      const present = input.owner.kind === "phase" && input.artifact !== undefined;
      return {
        verdict: present ? "pass" : "fail",
        summary: present
          ? "Candidate phase artifact is present"
          : "Candidate phase artifact is missing",
        findings: present
          ? []
          : [
              {
                severity: "error",
                code: "artifact-missing",
                message: "No candidate phase artifact was produced",
              },
            ],
        data: { artifactPresent: present },
      };
    }

    if (sensor.extension === taskChangeExtension) {
      const config = TaskChangeSensorConfigSchema.safeParse(sensor.config);
      if (!config.success) return executionError(`Invalid ${sensor.id} configuration`);
      return assessTaskChange(input);
    }

    const config = CommandSensorConfigSchema.safeParse(sensor.config);
    if (!config.success) return executionError(`Invalid ${sensor.id} configuration`);
    await input.onOutput?.({
      sensorId: sensor.id,
      stream: "system",
      text: `sensor ${sensor.id} started: ${config.data.command}`,
    });
    const execution = await this.runner.execute(config.data.command, {
      cwd: this.repositoryRoot,
      timeoutMs: config.data.timeoutMs ?? this.timeoutMs,
      env: {
        ...process.env,
        SENAWA_RUN_ID: input.runId,
        SENAWA_OWNER_ID: input.owner.id,
        SENAWA_ATTEMPT: String(input.attempt),
      },
      async onOutput(stream, text) {
        await input.onOutput?.({ sensorId: sensor.id, stream, text });
      },
    });
    await input.onOutput?.({
      sensorId: sensor.id,
      stream: "system",
      text:
        execution.exitCode === null
          ? `sensor ${sensor.id} ended without an exit code`
          : `sensor ${sensor.id} exited ${execution.exitCode}`,
    });
    if (
      execution.error !== undefined ||
      execution.timedOut === true ||
      execution.exitCode === null
    ) {
      return executionError(
        execution.timedOut === true
          ? `Command timed out after ${config.data.timeoutMs ?? this.timeoutMs}ms`
          : (execution.error ?? "Command ended without an exit code"),
      );
    }
    const stdout = await this.normalizeEvidence(execution.stdout, input, sensor.id, "stdout");
    const stderr = await this.normalizeEvidence(execution.stderr, input, sensor.id, "stderr");
    const passed = execution.exitCode === 0;
    return {
      verdict: passed ? "pass" : "fail",
      summary: passed
        ? `Command passed: ${config.data.command}`
        : `Command failed with exit ${execution.exitCode}: ${config.data.command}`,
      findings: passed
        ? []
        : [
            {
              severity: "error",
              code: "command-failed",
              message: `Command exited with code ${execution.exitCode}`,
              ...(stderr.summary === "" ? {} : { evidence: stderr.summary }),
            },
          ],
      data: {
        exitCode: execution.exitCode,
        stdout: stdout.summary,
        stderr: stderr.summary,
        ...(stdout.path === undefined ? {} : { stdoutEvidencePath: stdout.path }),
        ...(stderr.path === undefined ? {} : { stderrEvidencePath: stderr.path }),
      },
    };
  }

  private async normalizeEvidence(
    value: string,
    input: GateEvaluationInput,
    sensorId: string,
    stream: "stdout" | "stderr",
  ): Promise<{ readonly summary: string; readonly path?: string }> {
    const sanitized = sanitizeEvidence(value, Number.POSITIVE_INFINITY);
    const summary = sanitized.slice(0, SENSOR_OUTPUT_LIMIT);
    if (sanitized.length <= SENSOR_OUTPUT_LIMIT || this.evidenceStore === undefined) {
      return { summary };
    }
    return {
      summary,
      path: await this.evidenceStore.spill({
        runId: input.runId,
        owner: input.owner,
        sensorId,
        stream,
        content: sanitized,
      }),
    };
  }
}

function assessVerification(input: GateEvaluationInput): SensorAssessment {
  const findings: SensorFinding[] = [];
  const add = (code: string, message: string, evidence?: string) =>
    findings.push({
      severity: "error",
      code,
      message,
      ...(evidence === undefined ? {} : { evidence }),
    });
  const artifact = input.owner.kind === "phase" ? input.artifact : undefined;
  if (artifact === undefined) {
    add("verification-artifact-missing", "No current verification candidate was produced");
  } else {
    if (Reflect.get(artifact, "verdict") !== "pass") {
      add("verification-verdict-failed", "The current verification candidate verdict is not pass");
    }
    const checksValue = Reflect.get(artifact, "checks");
    const checks = Array.isArray(checksValue) ? checksValue : [];
    if (
      checks.length === 0 ||
      checks.some(
        (check) =>
          check === null || typeof check !== "object" || Reflect.get(check, "verdict") !== "pass",
      )
    ) {
      add(
        "verification-check-contradiction",
        "The current verification candidate contains a missing or non-passing check",
      );
    }
    const candidateFindings = Reflect.get(artifact, "findings");
    if (Array.isArray(candidateFindings) && candidateFindings.length > 0) {
      add(
        "verification-findings-unresolved",
        "The current verification candidate contains unresolved findings",
      );
    }
  }

  const manifest = input.inputManifest?.inputs.find(
    (reference) => reference.schemaKind === "senawa.dev/verification-manifest/v1",
  );
  if (manifest === undefined || Reflect.get(manifest.content, "kind") !== "verification-manifest") {
    add("verification-evidence-missing", "The current verifier evidence manifest is missing");
  } else {
    const blockingIssueValue = Reflect.get(manifest.content, "blockingIssues");
    const blockingIssues = Array.isArray(blockingIssueValue) ? blockingIssueValue : [];
    if (blockingIssues.length > 0) {
      add(
        "verification-evidence-blocked",
        "The current verifier evidence manifest contains blocking issues",
        manifest.path,
      );
    }
    const taskValue = Reflect.get(manifest.content, "tasks");
    const acceptedArtifactValue = Reflect.get(manifest.content, "acceptedArtifacts");
    const readPathValue = Reflect.get(manifest.content, "readPaths");
    const tasks = Array.isArray(taskValue) ? taskValue : [];
    const acceptedArtifacts = Array.isArray(acceptedArtifactValue) ? acceptedArtifactValue : [];
    const readPaths = Array.isArray(readPathValue) ? readPathValue : [];
    const phaseInputs = input.inputManifest?.inputs.filter(
      (reference) => reference.ownerKind === "phase",
    );
    for (const phaseInput of phaseInputs ?? []) {
      const identityMatches = acceptedArtifacts.some(
        (reference) =>
          reference !== null &&
          typeof reference === "object" &&
          Reflect.get(reference, "ownerId") === phaseInput.ownerId &&
          Reflect.get(reference, "path") === phaseInput.path &&
          Reflect.get(reference, "version") === phaseInput.version &&
          Reflect.get(reference, "digest") === phaseInput.digest &&
          Reflect.get(reference, "schemaKind") === phaseInput.schemaKind,
      );
      const pathMatches = readPaths.some(
        (reference) =>
          reference !== null &&
          typeof reference === "object" &&
          Reflect.get(reference, "kind") === "phase-artifact" &&
          Reflect.get(reference, "path") === phaseInput.path &&
          Reflect.get(reference, "readPath") ===
            `.agents/.copilot-tracking/${input.runId}/${phaseInput.path}` &&
          Reflect.get(reference, "version") === phaseInput.version &&
          Reflect.get(reference, "digest") === phaseInput.digest,
      );
      if (!identityMatches || !pathMatches) {
        add(
          "verification-artifact-evidence-mismatch",
          `Accepted artifact ${phaseInput.ownerId} does not match its typed verifier reference`,
        );
      }
    }
    if (tasks.length === 0) {
      add(
        "verification-task-evidence-missing",
        "The current verifier manifest has no task evidence",
      );
    }
    for (const task of tasks) {
      if (task === null || typeof task !== "object") {
        add("verification-task-evidence-invalid", "A verifier task evidence entry is invalid");
        continue;
      }
      const taskId = String(Reflect.get(task, "key") ?? "unknown");
      const outcome = Reflect.get(task, "outcome");
      const repositoryEvidence = Reflect.get(task, "repositoryEvidence");
      const gateEvidence = Reflect.get(task, "gateEvidence");
      const taskIssues = Reflect.get(task, "blockingIssues");
      if (
        outcome === null ||
        typeof outcome !== "object" ||
        Reflect.get(outcome, "status") !== "closed"
      ) {
        add("verification-task-outcome-stale", `Task ${taskId} is not closed in current evidence`);
      }
      if (repositoryEvidence === null || typeof repositoryEvidence !== "object") {
        add(
          "verification-repository-evidence-missing",
          `Task ${taskId} has no current repository delta`,
        );
      } else {
        const path = Reflect.get(repositoryEvidence, "path");
        const digest = Reflect.get(repositoryEvidence, "digest");
        const resolvable =
          typeof path === "string" &&
          typeof digest === "string" &&
          readPaths.some(
            (reference) =>
              reference !== null &&
              typeof reference === "object" &&
              Reflect.get(reference, "kind") === "repository-delta" &&
              Reflect.get(reference, "path") === path &&
              Reflect.get(reference, "readPath") ===
                `.agents/.copilot-tracking/${input.runId}/${path}` &&
              Reflect.get(reference, "digest") === digest,
          );
        if (!resolvable) {
          add(
            "verification-repository-evidence-unresolved",
            `Task ${taskId} repository delta is not resolvable from typed read paths`,
          );
        }
      }
      if (
        !Array.isArray(gateEvidence) ||
        gateEvidence.length === 0 ||
        gateEvidence.some(
          (reading) =>
            reading === null ||
            typeof reading !== "object" ||
            (Reflect.get(reading, "advisory") !== true &&
              (Reflect.get(reading, "accepted") !== true ||
                Reflect.get(reading, "matched") !== true ||
                Reflect.get(reading, "verdict") !== "pass")),
        )
      ) {
        add(
          "verification-gate-evidence-contradiction",
          `Task ${taskId} has missing or non-passing deterministic gate evidence`,
        );
      }
      if (Array.isArray(gateEvidence)) {
        const unresolvedGatePath = gateEvidence.some((reading) => {
          if (reading === null || typeof reading !== "object") return true;
          const evidencePaths = Reflect.get(reading, "evidencePaths");
          return (
            Array.isArray(evidencePaths) &&
            evidencePaths.some(
              (path) =>
                typeof path !== "string" ||
                !readPaths.some(
                  (reference) =>
                    reference !== null &&
                    typeof reference === "object" &&
                    Reflect.get(reference, "kind") === "deterministic-gate-evidence" &&
                    Reflect.get(reference, "path") === path &&
                    Reflect.get(reference, "readPath") ===
                      `.agents/.copilot-tracking/${input.runId}/${path}`,
                ),
            )
          );
        });
        if (unresolvedGatePath) {
          add(
            "verification-gate-evidence-unresolved",
            `Task ${taskId} gate evidence is not resolvable from typed read paths`,
          );
        }
      }
      if (Array.isArray(taskIssues) && taskIssues.length > 0) {
        add("verification-task-evidence-blocked", `Task ${taskId} has blocking evidence issues`);
      }
    }
  }

  const executionClassification =
    manifest !== undefined &&
    Reflect.get(manifest.content, "executionClassification") === "live-model"
      ? "live-model"
      : "simulated";
  const liveProofEligible =
    executionClassification === "live-model" &&
    manifest !== undefined &&
    Reflect.get(manifest.content, "liveProofEligible") === true;
  const blocking = findings.length > 0;
  return {
    verdict: blocking ? "fail" : "pass",
    summary: blocking
      ? "Current verification candidate or evidence did not satisfy work completion policy"
      : "Current verification candidate passed with resolvable evidence",
    findings,
    data: {
      artifactPresent: artifact !== undefined,
      candidateVerdict: artifact === undefined ? null : (Reflect.get(artifact, "verdict") ?? null),
      evidenceCurrent: manifest !== undefined && !blocking,
      executionClassification,
      liveProofEligible,
      verificationManifestPath: manifest?.path ?? null,
      verificationManifestDigest: manifest?.digest ?? null,
    },
  };
}

function assessTaskChange(input: GateEvaluationInput): SensorAssessment {
  const evidence = input.repositoryEvidence;
  const expectation = input.repositoryChange;
  if (input.owner.kind !== "task" || evidence === undefined || expectation === undefined) {
    return {
      verdict: "fail",
      summary: "Trusted task repository evidence is missing",
      findings: [
        {
          severity: "error",
          code: "task-change-evidence-missing",
          message: "The task gate did not receive a measured repository delta",
        },
      ],
      data: { evidencePresent: false },
    };
  }
  const findings: SensorFinding[] = [];
  if (evidence.uncertainty.length > 0) {
    findings.push({
      severity: "error",
      code: "task-change-uncertain",
      message: `Repository attribution is uncertain: ${evidence.uncertainty.join(", ")}`,
      evidence: evidence.evidencePath,
    });
  }
  if (evidence.outOfScopeChanges.length > 0) {
    findings.push({
      severity: "error",
      code: "task-change-out-of-scope",
      message: `Out-of-scope changes: ${evidence.outOfScopeChanges.join(", ")}`,
      evidence: evidence.evidencePath,
    });
  }
  if (evidence.frozenChanges.length > 0) {
    findings.push({
      severity: "error",
      code: "task-change-frozen",
      message: `Frozen-path changes: ${evidence.frozenChanges.join(", ")}`,
      evidence: evidence.evidencePath,
    });
  }
  if (expectation === "required" && evidence.inScopeChanges.length === 0) {
    findings.push({
      severity: "error",
      code: "task-change-required-noop",
      message: "The task required an in-scope repository change but none was measured",
      evidence: evidence.evidencePath,
    });
  }
  if (expectation === "forbidden" && evidence.changedPaths.length > 0) {
    findings.push({
      severity: "error",
      code: "task-change-forbidden",
      message: "The task forbade repository changes but a delta was measured",
      evidence: evidence.evidencePath,
    });
  }
  if (evidence.workerClaim.agreement === "disagree") {
    findings.push({
      severity: "warning",
      code: "worker-change-claim-mismatch",
      message: "The worker-reported change claim disagrees with trusted repository measurement",
      evidence: evidence.evidencePath,
    });
  }
  const blocking = findings.some((finding) => finding.severity === "error");
  return {
    verdict: blocking ? "fail" : "pass",
    summary: blocking
      ? "Trusted repository change evidence did not satisfy task policy"
      : `Trusted repository change evidence satisfied ${expectation} policy`,
    findings,
    data: {
      expectation,
      changedPaths: evidence.changedPaths.map((entry) => entry.path),
      inScopeChanges: [...evidence.inScopeChanges],
      outOfScopeChanges: [...evidence.outOfScopeChanges],
      frozenChanges: [...evidence.frozenChanges],
      workerClaimAgreement: evidence.workerClaim.agreement,
      repositoryEvidencePath: evidence.evidencePath,
    },
  };
}

export class SpawnCommandRunner implements CommandRunner {
  execute(
    command: string,
    options: {
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly timeoutMs: number;
      readonly onOutput?: (stream: "stdout" | "stderr", text: string) => Promise<void>;
    },
  ): Promise<CommandExecution> {
    return new Promise((resolve) => {
      const child = spawn(command, {
        cwd: options.cwd,
        env: options.env,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let spawnError: string | undefined;
      let timedOut = false;
      let outputWrites = Promise.resolve();
      const publish = (stream: "stdout" | "stderr", text: string) => {
        outputWrites = outputWrites.then(() => options.onOutput?.(stream, text));
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout = appendCapped(stdout, text);
        publish("stdout", text);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr = appendCapped(stderr, text);
        publish("stderr", text);
      });
      child.once("error", (error) => {
        spawnError = error.message;
      });
      child.once("close", async (exitCode) => {
        clearTimeout(timer);
        try {
          await outputWrites;
        } catch (error) {
          resolve({ exitCode: null, stdout, stderr, error: String(error) });
          return;
        }
        resolve({
          exitCode,
          stdout,
          stderr,
          ...(spawnError === undefined ? {} : { error: spawnError }),
          ...(timedOut ? { timedOut: true } : {}),
        });
      });
    });
  }
}

function expectationMatches(
  assessment: SensorAssessment,
  expectation: RepositoryPolicy["gates"][number]["checks"][number]["expect"],
): boolean {
  const actual = readPointer(assessment as unknown as JsonValue, expectation.path);
  const expected = expectation.value;
  switch (expectation.operator) {
    case "equals":
      return actual !== missing && isDeepStrictEqual(actual, expected);
    case "notEquals":
      return actual === missing || !isDeepStrictEqual(actual, expected);
    case "greaterThan":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "greaterThanOrEqual":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "contains":
      return (
        (typeof actual === "string" && typeof expected === "string" && actual.includes(expected)) ||
        (Array.isArray(actual) && actual.some((value) => isDeepStrictEqual(value, expected)))
      );
    case "matches":
      if (typeof actual !== "string" || typeof expected !== "string") return false;
      try {
        return new RegExp(expected, "u").test(actual);
      } catch {
        return false;
      }
    case "exists":
      return actual !== missing;
  }
}

function readPointer(value: JsonValue, pointer: string): JsonValue | typeof missing {
  if (pointer === "") return value;
  let current: JsonValue | undefined = value;
  for (const token of pointer.slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return missing;
      current = current[index];
    } else if (typeof current === "object" && current !== null && key in current) {
      current = current[key];
    } else {
      return missing;
    }
  }
  return current ?? (current === null ? null : missing);
}

function sensorEvidencePaths(result: SensorResult): string[] {
  if (
    "error" in result ||
    result.data === undefined ||
    typeof result.data !== "object" ||
    result.data === null ||
    Array.isArray(result.data)
  ) {
    return [];
  }
  return Object.entries(result.data)
    .filter(
      ([key, value]) =>
        key.endsWith("EvidencePath") && typeof value === "string" && value.trim() !== "",
    )
    .map(([, value]) => value as string)
    .slice(0, 20);
}

function executionError(summary: string): SensorExecutionError {
  return {
    error: true,
    summary: sanitizeEvidence(summary) || "Sensor execution failed",
    retryable: true,
  };
}

function appendCapped(current: string, addition: string): string {
  if (current.length >= SENSOR_OUTPUT_LIMIT) return current;
  return (current + addition).slice(0, SENSOR_OUTPUT_LIMIT);
}

function sanitizeEvidence(value: string, limit = SENSOR_OUTPUT_LIMIT): string {
  const neutralized = value
    .replaceAll("\r\n", "\n")
    .replaceAll(ansiEscapePattern, "")
    .replace(/<\/?(?:system|assistant|user|tool|instructions?)\b[^>]*>/giu, "[neutralized-tag]");
  return [...neutralized]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return character === "\n" || character === "\t" || (code >= 32 && (code < 127 || code > 159));
    })
    .join("")
    .trim()
    .slice(0, limit);
}

function sensorOrder(sensor: RepositoryPolicy["sensors"][number]): number {
  if (sensor.kind === "inferential") return 3;
  switch (sensor.cost) {
    case "cheap":
      return 0;
    case "standard":
      return 1;
    case "expensive":
      return 2;
  }
}
