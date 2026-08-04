import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
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
} from "@senawa/core";
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
}

export class CommandGateEvaluator implements GateEvaluator {
  private readonly runner: CommandRunner;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly repositoryRoot: string,
    options: CommandGateEvaluatorOptions = {},
  ) {
    this.runner = options.runner ?? new SpawnCommandRunner();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SENSOR_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
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

    for (const check of gate.checks) {
      const sensor = policy.sensors.find((candidate) => candidate.id === check.sensor);
      if (sensor === undefined) throw new Error(`Unknown sensor: ${check.sensor}`);
      const startedAt = this.now();
      const result = await this.runSensor(sensor, input, declaredExtensions);
      const durationMs = Math.max(0, this.now() - startedAt);
      const executionError = "error" in result;
      const matched = !executionError && expectationMatches(result, check.expect);
      const advisory = check.advisory || sensor.trust === "advisory";
      const reading = {
        sensorId: sensor.id,
        extension: sensor.extension,
        result,
        expect: check.expect,
        matched,
        advisory,
        durationMs,
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
    }

    return GateEvaluationSchema.parse({ gateId: gate.id, accepted, readings, findings });
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
    const stdout = sanitizeEvidence(execution.stdout);
    const stderr = sanitizeEvidence(execution.stderr);
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
              ...(stderr === "" ? {} : { evidence: stderr }),
            },
          ],
      data: { exitCode: execution.exitCode, stdout, stderr },
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

function sanitizeEvidence(value: string): string {
  return [...value.replaceAll("\r\n", "\n").replaceAll(ansiEscapePattern, "")]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return character === "\n" || character === "\t" || (code >= 32 && (code < 127 || code > 159));
    })
    .join("")
    .trim()
    .slice(0, SENSOR_OUTPUT_LIMIT);
}
