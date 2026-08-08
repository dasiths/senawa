import { describe, expect, it } from "vitest";
import { optionValue, parseWorkerHostOption } from "./execution-options.js";

describe("worker-host option", () => {
  it.each([
    [undefined, "copilot-sdk"],
    ["simulated", "simulated"],
    ["copilot-subprocess", "copilot-subprocess"],
    ["copilot-sdk", "copilot-sdk"],
  ] as const)("parses canonical value %s", (value, expected) => {
    expect(parseWorkerHostOption(value)).toEqual({ kind: expected });
  });

  it("reads separated and inline global option values", () => {
    expect(optionValue(["--worker-host", "copilot-sdk"], "--worker-host")).toBe("copilot-sdk");
    expect(optionValue(["--worker-host=copilot-sdk"], "--worker-host")).toBe("copilot-sdk");
  });
});
