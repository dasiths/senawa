import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import type { GateEvaluationPort } from "@senawa/application";
import {
  GateEvaluationSchema,
  type JsonObject,
  type JsonValue,
  type RepositoryPolicy,
  RepositoryPolicySchema,
  type SensorAssessment,
  type SensorExecutionError,
  type SensorFinding,
  type SensorReading,
  type SensorResult,
} from "@senawa/domain";
import { z } from "zod";

const artifactExtension = "@senawa/sensor-artifact";
const commandExtension = "@senawa/sensor-command";
const supportedExtensions = new Set([artifactExtension, commandExtension]);
const ansiEscapePattern = new RegExp(`${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");
const missing = Symbol("missing");

export const SENSOR_OUTPUT_LIMIT = 8_000;
export const DEFAULT_SENSOR_TIMEOUT_MS = 120_000;

const ArtifactSensorConfigSchema = z.object({ artifactKind: z.literal("phase-output") }).strict();
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

    const config = CommandSensorConfigSchema.safeParse(sensor.config);
    if (!config.success) return executionError(`Invalid ${sensor.id} configuration`);
    const execution = await this.runner.execute(config.data.command, {
      cwd: this.repositoryRoot,
      timeoutMs: config.data.timeoutMs ?? this.timeoutMs,
      env: {
        ...process.env,
        SENAWA_RUN_ID: input.runId,
        SENAWA_OWNER_ID: input.owner.id,
        SENAWA_ATTEMPT: String(input.attempt),
      },
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

export class SpawnCommandRunner implements CommandRunner {
  execute(
    command: string,
    options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number },
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
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = appendCapped(stdout, chunk.toString());
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = appendCapped(stderr, chunk.toString());
      });
      child.once("error", (error) => {
        spawnError = error.message;
      });
      child.once("close", (exitCode) => {
        clearTimeout(timer);
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
