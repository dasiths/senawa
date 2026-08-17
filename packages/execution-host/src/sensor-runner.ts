import type { ConfigurationRegistryEntry, ConfigurationSnapshot } from "@senawa/configuration";
import {
  canonicalValue,
  consumerKey,
  createSensorReading,
  type SensorReading,
  type Sha256,
  sha256Digest,
} from "@senawa/kernel";
import { measureExecutableSensor } from "./process-sensor.js";

/** A sensor as the configuration snapshot stores it. */
interface SnapshotSensor {
  readonly key: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly inheritedEnvironment: readonly string[];
}

export interface RunSensorsInput {
  readonly snapshot: ConfigurationSnapshot;
  readonly sensorKeys: readonly string[];
  readonly rootDirectory: string;
  readonly sha256: Sha256;
  readonly ambientEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}

export interface SensorRunResult {
  readonly readings: readonly SensorReading[];
  /** True when every reading is a measurement whose command exited zero. */
  readonly passed: boolean;
}

const TERMINATION_GRACE_MS = 5_000;

/**
 * Executes declared sensors and turns each result into a kernel reading.
 *
 * Nothing produced a reading in production before this: readings arrived as
 * caller-supplied command payload, so a gate could only agree with whoever
 * submitted it. A reading now carries what a real process actually did.
 */
export async function runSensors(input: RunSensorsInput): Promise<SensorRunResult> {
  const readings: SensorReading[] = [];
  let passed = true;
  for (const key of [...input.sensorKeys].sort()) {
    const sensor = sensorByKey(input.snapshot, key);
    // The input digest binds a reading to the exact command that produced it, so
    // a reading cannot be presented as evidence for a different command.
    const inputDigest = sha256Digest(
      input.sha256.digest(
        new TextEncoder().encode(
          JSON.stringify({ argv: sensor.argv, cwd: sensor.cwd, root: input.rootDirectory }),
        ),
      ),
    );
    const outcome = await measureExecutableSensor({
      rootDirectory: input.rootDirectory,
      command: {
        argv: sensor.argv as [string, ...string[]],
        cwd: sensor.cwd,
        timeoutMs: sensor.timeoutMs,
        maxStdoutBytes: sensor.maxStdoutBytes,
        maxStderrBytes: sensor.maxStderrBytes,
        inheritedEnvironment: sensor.inheritedEnvironment,
      },
      ambientEnvironment: input.ambientEnvironment ?? { PATH: process.env.PATH },
      terminationGraceMs: TERMINATION_GRACE_MS,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    if (outcome.type === "failure") {
      passed = false;
      readings.push(
        createSensorReading(
          {
            sensorKey: consumerKey(key),
            inputDigest,
            outcome: "failed",
            error: canonicalValue({
              code: outcome.failure.code,
              message: outcome.failure.message,
            }),
          },
          input.sha256,
        ),
      );
      continue;
    }

    const measurement = outcome.measurement;
    if (measurement.exitCode !== 0) passed = false;
    readings.push(
      createSensorReading(
        {
          sensorKey: consumerKey(key),
          inputDigest,
          outcome: "succeeded",
          data: canonicalValue({
            exitCode: measurement.exitCode,
            timedOut: measurement.timedOut,
            stdout: measurement.stdout.text,
            stderr: measurement.stderr.text,
          }),
        },
        input.sha256,
      ),
    );
  }
  return { readings, passed };
}

function sensorByKey(snapshot: ConfigurationSnapshot, key: string): SnapshotSensor {
  const entry: ConfigurationRegistryEntry | undefined = snapshot.sensors.find(
    (candidate) => candidate.key === key,
  );
  if (entry === undefined) throw new Error(`Workflow declares no sensor named ${key}`);
  return entry.value as unknown as SnapshotSensor;
}
