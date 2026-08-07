import type { WorkerHostKind } from "@senawa/domain";

export interface ParsedWorkerHostOption {
  readonly kind: WorkerHostKind;
  readonly alias?: "deterministic" | "copilot" | "sdk";
}

export function parseWorkerHostOption(value: string | undefined): ParsedWorkerHostOption {
  switch (value ?? "copilot-sdk") {
    case "simulated":
      return { kind: "simulated" };
    case "copilot-subprocess":
      return { kind: "copilot-subprocess" };
    case "copilot-sdk":
      return { kind: "copilot-sdk" };
    case "deterministic":
      return { kind: "simulated", alias: "deterministic" };
    case "copilot":
      return { kind: "copilot-subprocess", alias: "copilot" };
    case "sdk":
      return { kind: "copilot-sdk", alias: "sdk" };
    default:
      throw new Error(`Unknown worker host ${value}`);
  }
}

export function optionValue(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  if (index >= 0) return arguments_[index + 1];
  const prefix = `${name}=`;
  return arguments_.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
