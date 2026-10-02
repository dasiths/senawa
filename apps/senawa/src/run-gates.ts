import type { ConfigurationSnapshot } from "@senawa/configuration";
import { loadAuthoredWorkflow, runSensors } from "@senawa/execution-host";
import type { RuntimeDependencies } from "@senawa/runtime";
import type { CliResult } from "./cli.js";

export interface RunGatesInput {
  readonly projectRoot: string;
  readonly phaseKey: string;
  readonly dependencies: RuntimeDependencies;
}

/**
 * Runs a phase's gate sensors and reports what they measured.
 *
 * This exists so an agent, or a human, can find out whether a phase would pass
 * before asking for completion. Without it the only way to learn a gate is red
 * is to submit and be refused, which wastes an attempt and teaches nothing.
 */
export async function runGates(input: RunGatesInput): Promise<CliResult> {
  const loaded = await loadAuthoredWorkflow(input.projectRoot, input.dependencies.sha256);
  if (loaded.snapshot === undefined) {
    return { exitCode: 2, output: loaded.diagnostics.map(formatDiagnostic).join("\n") };
  }
  const snapshot = loaded.snapshot;
  const sensorKeys = gateSensorKeys(snapshot, input.phaseKey);
  if (sensorKeys === undefined) {
    return { exitCode: 2, output: `Phase ${input.phaseKey} is not declared in this workflow` };
  }
  if (sensorKeys.length === 0) {
    return { exitCode: 0, output: `Phase ${input.phaseKey} declares no gate sensors` };
  }
  const result = await runSensors({
    snapshot,
    sensorKeys,
    rootDirectory: input.projectRoot,
    sha256: input.dependencies.sha256,
  });
  const lines = result.readings.map((reading) => {
    // A failing gate has to say what failed and why, because "refused" without
    // a reason forces the next attempt to be a guess.
    if (reading.outcome === "failed") {
      return `fail ${reading.sensorKey} ${describe(reading.error)}`;
    }
    const data = reading.data as unknown as { readonly exitCode?: number };
    return `${data.exitCode === 0 ? "pass" : "fail"} ${reading.sensorKey} exit=${data.exitCode} ${describe(reading.data)}`;
  });
  return { exitCode: result.passed ? 0 : 1, output: lines.join("\n") };
}

/** The sensors every blocking rule on the phase's gate reads, sorted and unique. */
function gateSensorKeys(
  snapshot: ConfigurationSnapshot,
  phaseKey: string,
): readonly string[] | undefined {
  const phase = snapshot.phaseDataflow.find((entry) => entry.key === phaseKey);
  if (phase === undefined) return undefined;
  const gateKey = (phase.value as unknown as { readonly exit?: { readonly gate?: string } }).exit
    ?.gate;
  if (gateKey === undefined) return [];
  const gate = snapshot.gates.find((entry) => entry.key === gateKey);
  if (gate === undefined) return [];
  const rules = (
    gate.value as unknown as {
      readonly definition?: {
        readonly blocking?: readonly {
          readonly condition?: { readonly accessor?: { readonly sensorKey?: string } };
        }[];
      };
    }
  ).definition?.blocking;
  const keys = new Set<string>();
  for (const rule of rules ?? []) {
    const sensorKey = rule.condition?.accessor?.sensorKey;
    if (sensorKey !== undefined) keys.add(sensorKey);
  }
  return [...keys].sort();
}

function formatDiagnostic(diagnostic: {
  readonly locator: string;
  readonly pointer: string;
  readonly message: string;
}): string {
  return `${diagnostic.locator}${diagnostic.pointer} ${diagnostic.message}`;
}

/** Renders a reading's payload compactly so a refusal reads as a reason. */
function describe(value: unknown): string {
  return JSON.stringify(value) ?? "no detail recorded";
}
