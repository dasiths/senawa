import { canonicalValue, sha256Digest } from "@senawa/kernel";
import { SqliteAuthority } from "@senawa/storage-sqlite";
import { runtimePrincipal } from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";
import { advanceRun } from "./advance-run.js";
import {
  agentTurn,
  BASE,
  compileScenario,
  dependencies,
  disposeScenarios,
  NOW,
  type Scenario,
  startScenario,
} from "./brief-scenarios.js";
import { decidePhase } from "./decide.js";
import { runGates } from "./run-gates.js";

afterEach(disposeScenarios);

function advance(scenario: Scenario) {
  return advanceRun({
    projectRoot: scenario.project,
    ...scenario.paths,
    repositoryId: scenario.repositoryId,
    runId: scenario.runId,
    principal: runtimePrincipal,
    dependencies,
    currentTime: NOW,
    workflowInput: {
      bindingDigest: sha256Digest("3".repeat(64)),
      value: canonicalValue({ request: "Add a health endpoint" }),
    },
    repositoryBase: BASE,
  });
}

describe("fan-out in sequence", () => {
  it("refuses a fan-out that does not name the shape of one element", async () => {
    const diagnostics = await compileScenario({ fanOut: "no-item-schema" });

    // A member reads one item, so the element schema is not optional.
    expect(diagnostics.map(({ code }) => code)).toContain("missing-field");
    expect(diagnostics.map(({ message }) => message).join(" ")).toContain(
      "must name that item's schema",
    );
  });

  it("compiles a fan-out that names both the collection and the element", async () => {
    const scenario = await startScenario("fanout", { fanOut: "complete" });

    expect(scenario.phaseKey).toBe("define");
  });
});

describe("one phase in sequence", () => {
  it("dispatches the assignment when the run starts", async () => {
    const scenario = await startScenario("dispatch");

    expect(scenario.phaseKey).toBe("define");
    expect(scenario.dispatchId).toMatch(/^dispatch_[0-9a-f]{64}$/u);
  });

  it("waits rather than gating work the agent has not finished", async () => {
    const scenario = await startScenario("unfinished");

    expect(await advance(scenario)).toEqual({ kind: "awaiting-agent", phaseKey: "define" });
  });

  it("refuses an output that violates its declared schema", async () => {
    const scenario = await startScenario("schema", { strictOutput: true });

    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ wrong: 1 }));
    const outcome = await advance(scenario);

    // Nothing may be published, so the phase is left exactly as it was.
    expect(outcome).toMatchObject({ kind: "output-refused", phaseKey: "define" });
    if (outcome.kind !== "output-refused") throw new Error("expected a refusal");
    expect(outcome.reasons.join(" ")).toContain("define");
  });

  it("leaves the dispatch awaiting completion when the agent only writes output", async () => {
    const scenario = await startScenario("nocomplete");

    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }), {
      omitCompletion: true,
    });

    expect(await advance(scenario)).toEqual({ kind: "awaiting-agent", phaseKey: "define" });
  });

  it("refuses when a blocking rule is red, naming the sensor", async () => {
    const scenario = await startScenario("red", { sensorCommand: "false" });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));

    const outcome = await advance(scenario);

    expect(outcome).toMatchObject({ kind: "gate-refused", phaseKey: "define" });
    if (outcome.kind !== "gate-refused") throw new Error("expected a refusal");
    expect(outcome.reasons.join(" ")).toContain("measure");
  });

  it("fails closed when a sensor cannot produce a reading", async () => {
    const scenario = await startScenario("nosensor", {
      sensorCommand: "senawa-no-such-command",
    });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));

    const outcome = await advance(scenario);

    // An unreported blocking reading resolves to unknown rather than to pass.
    expect(outcome).toMatchObject({ kind: "gate-refused", phaseKey: "define" });
  });

  it("closes the phase when every blocking rule is green", async () => {
    const scenario = await startScenario("green");
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));

    expect(await advance(scenario)).toEqual({ kind: "finished" });
  });

  it("waits for a person when the phase declares an approval", async () => {
    const scenario = await startScenario("approval", { approval: true });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));

    expect(await advance(scenario)).toEqual({ kind: "awaiting-approval", phaseKey: "define" });
  });

  it("refuses a rejection that carries no reason", async () => {
    const scenario = await startScenario("noreason", { approval: true });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));
    await advance(scenario);

    const result = decidePhase({
      ...scenario.paths,
      repositoryId: scenario.repositoryId,
      runId: scenario.runId,
      decision: "reject",
      principal: runtimePrincipal,
      dependencies,
      currentTime: NOW,
    });

    // The brief makes the reason required, because the next attempt is a guess
    // without it.
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("reason");
  });

  it("closes the phase once a person approves", async () => {
    const scenario = await startScenario("approved", { approval: true });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));
    expect(await advance(scenario)).toEqual({ kind: "awaiting-approval", phaseKey: "define" });

    const decision = decidePhase({
      ...scenario.paths,
      repositoryId: scenario.repositoryId,
      runId: scenario.runId,
      decision: "approve",
      principal: runtimePrincipal,
      dependencies,
      currentTime: NOW,
    });

    if (decision.exitCode !== 0) throw new Error(decision.output);
    expect(await advance(scenario)).toEqual({ kind: "finished" });
  });

  it("carries the human's reason back when they reject", async () => {
    const scenario = await startScenario("rejected", { approval: true });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));
    await advance(scenario);

    const decision = decidePhase({
      ...scenario.paths,
      repositoryId: scenario.repositoryId,
      runId: scenario.runId,
      decision: "reject",
      reason: "the endpoint returns the wrong status",
      principal: runtimePrincipal,
      dependencies,
      currentTime: NOW,
    });

    if (decision.exitCode !== 0) throw new Error(decision.output);
    // The reason has to survive the decision, because the next attempt is a
    // guess without it.
    const authority = new SqliteAuthority({ ...scenario.paths, dependencies });
    try {
      const recorded = JSON.stringify(
        authority.queryReceiptHistory(scenario.repositoryId, scenario.runId),
      );
      expect(recorded).toContain("the endpoint returns the wrong status");
    } finally {
      authority.close();
    }
  });

  it("lets an agent measure the gate without spending an attempt", async () => {
    const scenario = await startScenario("selfcheck", { sensorCommand: "false" });

    const first = await runGates({
      projectRoot: scenario.project,
      phaseKey: "define",
      dependencies,
    });
    const second = await runGates({
      projectRoot: scenario.project,
      phaseKey: "define",
      dependencies,
    });

    // A self-check reports the same measurement twice and changes nothing, so
    // an agent can ask before submitting.
    expect(first.exitCode).toBe(1);
    expect(second).toEqual(first);
    expect(await advance(scenario)).toEqual({ kind: "awaiting-agent", phaseKey: "define" });
  });

  it("advances to the next phase once the first closes", async () => {
    const scenario = await startScenario("advance", { secondPhase: true });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));

    expect(await advance(scenario)).toEqual({ kind: "closed", phaseKey: "define" });
    expect(await advance(scenario)).toMatchObject({ kind: "dispatched", phaseKey: "verify" });
  });
});
