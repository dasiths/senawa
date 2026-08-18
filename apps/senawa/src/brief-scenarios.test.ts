import { DatabaseSync } from "node:sqlite";
import { loadAuthoredWorkflow } from "@senawa/execution-host";
import { canonicalBytes, canonicalValue, sha256Digest } from "@senawa/kernel";
import { decodeCommandEnvelope, PROTOCOL_VERSION } from "@senawa/protocol";
import { SqliteAuthority } from "@senawa/storage-sqlite";
import { runtimePrincipal } from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";
import { advanceRun } from "./advance-run.js";
import {
  agentTurn,
  BASE,
  compileScenario,
  compileSnapshot,
  completeThroughSink,
  dependencies,
  disposeScenarios,
  NOW,
  promptPackText,
  type Scenario,
  startScenario,
} from "./brief-scenarios.js";
import { decidePhase } from "./decide.js";
import { listArtifacts } from "./inspect.js";
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

  it("refuses a member that itself fans out", async () => {
    const diagnostics = await compileScenario({ nestedFanOut: true });

    // v1 runs members as tasks beneath one phase, so nesting cannot work.
    // Refusing it here beats a run that fails once it is already going.
    expect(diagnostics.map(({ message }) => message).join(" ")).toContain("which already fans out");
  });

  it("carries an authored fail-fast policy into the compiled run", async () => {
    const stopping = await compileScenario({ fanOut: "complete", failFast: true });
    expect(stopping).toEqual([]);

    // The policy has to come from the YAML rather than a constant, and the
    // default has to be the other one.
    const stated = (await compileSnapshot({ fanOut: "complete", failFast: true })) as {
      readonly execution: { readonly failurePolicy: string };
    };
    const carrying = (await compileSnapshot({
      continueOnFailure: true,
      fanOut: "complete",
    })) as { readonly execution: { readonly failurePolicy: string } };
    expect(stated.execution.failurePolicy).toBe("fail-fast");
    expect(carrying.execution.failurePolicy).toBe("continue");
  });

  it("compiles a fan-out that names both the collection and the element", async () => {
    const scenario = await startScenario("fanout", { fanOut: "complete" });

    expect(scenario.phaseKey).toBe("define");
  });
});

describe("what an author can state", () => {
  it("refuses a blocking gate with no deterministic reading behind it", async () => {
    const diagnostics = await compileScenario({ unanchored: true });

    // A gate resting on a non-deterministic reading agrees with whoever
    // submitted the work, which is the property the product exists to keep.
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.map(({ message }) => message).join(" ")).toMatch(/anchor|deterministic/iu);
  });

  it("records an advisory reading without letting it refuse", async () => {
    const scenario = await startScenario("advisory", { advisory: true });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));

    // The advisory sensor exits non-zero. The phase must still close.
    expect(await advance(scenario)).toEqual({ kind: "finished" });
  });

  it("refuses a field it does not know rather than ignoring it", async () => {
    const diagnostics = await compileScenario({ unknownField: true });

    // A misspelled `approve` configured nothing and said nothing, which reads
    // as the feature being broken rather than the spelling being wrong.
    expect(diagnostics.map(({ code }) => code)).toContain("unknown-field");
    expect(diagnostics.map(({ message }) => message).join(" ")).toContain("aproove");
  });

  it("dispatches under the limits the first authored route declares", async () => {
    const scenario = await startScenario("routed", { routeLimits: true });
    const database = new DatabaseSync(scenario.paths.databasePath, { readOnly: true });
    let state: string;
    try {
      const row = database
        .prepare(`SELECT canonical_json AS json FROM context_authority_state`)
        .get() as { readonly json: string };
      state = row.json;
    } finally {
      database.close();
    }

    const selection = JSON.parse(state) as Record<string, unknown>;
    const found = JSON.stringify(selection);

    // The authored route declares 7 turns, 3 submissions, and 250 spend. Those
    // have to be the limits carried into the dispatch rather than the defaults,
    // and the first route has to be the one selected.
    expect(found).toContain('"maxTurns":7');
    expect(found).toContain('"maxSubmissions":3');
    expect(found).toContain('"maxMillidollars":250');
    expect(found).toContain('"model":"gpt-5"');
    expect(found).not.toContain("gpt-5-mini");
  });

  it("lowers ordered model routes with their per-route limits", async () => {
    const loaded = await loadAuthoredWorkflow(process.cwd(), dependencies.sha256);
    const snapshot = loaded.snapshot;
    if (snapshot === undefined) throw new Error("the repository tree does not compile");

    const planner = snapshot.modelPolicies
      .map(
        (entry) =>
          entry.value as unknown as { readonly key: string; readonly routes: readonly unknown[] },
      )
      .find((policy) => policy.key === "planner");
    if (planner === undefined) throw new Error("planner has no model policy");

    // The repository's planner declares two routes with different turn budgets,
    // so order and per-route limits both have to survive lowering.
    expect(planner.routes.length).toBe(2);
    expect(planner.routes[0]).toMatchObject({ model: "gpt-5", maxTurns: 24 });
    expect(planner.routes[1]).toMatchObject({ model: "gpt-5-mini", maxTurns: 12 });
  });

  it("lowers an authored completion evidence view", async () => {
    const loaded = await loadAuthoredWorkflow(process.cwd(), dependencies.sha256);
    const snapshot = loaded.snapshot;
    if (snapshot === undefined) throw new Error("the repository tree does not compile");

    // The repository's own workflow reads implement's evidence from verify.
    // Before this the field was accepted and discarded, so an author who wrote
    // it got silence.
    const views = snapshot.completionEvidenceViews.map((entry) => entry.key);
    expect(views).toContain("verify-from-implement");
  });

  it("compiles the attempt limit an author writes", async () => {
    const diagnostics = await compileScenario({ attempts: 2 });

    expect(diagnostics).toEqual([]);
  });

  it("refuses an attempt limit outside the supported range", async () => {
    const diagnostics = await compileScenario({ attempts: 99 });

    expect(diagnostics.map(({ message }) => message).join(" ")).toContain("attempts must be");
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

  it("keeps a confidential output labelled and its content out of the prompt", async () => {
    const scenario = await startScenario("confidential", { confidentialOutput: true });
    const secret = "the-confidential-body";

    // The contract tells the agent what it is producing, which is a label and
    // never the content of anything.
    const pack = await promptPackText(scenario, scenario.dispatchId);
    const contract = JSON.parse(pack).sections.find(
      (section: { kind: string }) => section.kind === "senawa-operating-contract",
    ) as { value: { completion: { requiredOutputs: { sensitivity: string }[] } } };
    expect(contract.value.completion.requiredOutputs).toEqual([
      expect.objectContaining({ sensitivity: "confidential" }),
    ]);
    expect(pack).not.toContain(secret);

    await completeThroughSink(scenario, scenario.dispatchId, [
      { name: "define", value: canonicalValue({ definition: secret }) },
    ]);
    expect(await advance(scenario)).toEqual({ kind: "finished" });

    // Whoever reads the listing has to be able to see which artifacts carry a
    // classification before deciding to share one.
    const listed = listArtifacts({
      ...scenario.paths,
      repositoryId: scenario.repositoryId,
      runId: scenario.runId,
      dependencies,
      currentTime: NOW,
    });
    expect(listed.output).toContain("confidential");
    expect(listed.output).not.toContain(secret);
  });

  it("refuses a completion that owes evidence, naming the kind and the count", async () => {
    const scenario = await startScenario("owed", { requireEvidence: 2 });

    const refused = await completeThroughSink(scenario, scenario.dispatchId, [
      { name: "define", value: canonicalValue({ definition: "x" }) },
    ]);

    expect(refused.status).toBe("refused");
    expect(refused.reason).toContain("2 of definition-note");
    expect(refused.reason).toContain("carries 0");
    // Nothing was published, so the phase is still waiting on the agent.
    expect(await advance(scenario)).toEqual({ kind: "awaiting-agent", phaseKey: "define" });
  });

  it("grants the same completion once the evidence it owed is attached", async () => {
    const scenario = await startScenario("owed-met", { requireEvidence: 2 });

    const accepted = await completeThroughSink(
      scenario,
      scenario.dispatchId,
      [{ name: "define", value: canonicalValue({ definition: "x" }) }],
      [
        { kind: "definition-note", path: "notes/one.md", content: "first" },
        { kind: "definition-note", path: "notes/two.md", content: "second" },
      ],
    );

    expect(accepted).toEqual({ status: "accepted" });
    expect(await advance(scenario)).toEqual({ kind: "finished" });
  });

  it("leaves the dispatch awaiting completion when the agent only writes output", async () => {
    const scenario = await startScenario("nocomplete");

    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }), {
      omitCompletion: true,
    });

    expect(await advance(scenario)).toEqual({ kind: "awaiting-agent", phaseKey: "define" });
  });

  it("retries a refused phase with the reasons the gate gave", async () => {
    const scenario = await startScenario("retry", { sensorCommand: "false", attempts: 3 });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));

    const outcome = await advance(scenario);

    expect(outcome).toMatchObject({ kind: "retrying", phaseKey: "define", attempt: 2 });
    if (outcome.kind !== "retrying") throw new Error("expected a retry");
    expect(outcome.reasons.join(" ")).toContain("measure");

    // The next attempt has to be told what the last one failed, or it spends an
    // attempt learning nothing.
    const pack = await promptPackText(scenario, outcome.dispatchId);
    expect(pack).toContain("This is attempt 2");
    expect(pack).toContain("measure did not pass");
  });

  it("stops at the authored attempt ceiling rather than retrying forever", async () => {
    const scenario = await startScenario("ceiling", { sensorCommand: "false", attempts: 1 });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));

    expect(await advance(scenario)).toMatchObject({ kind: "gate-refused", phaseKey: "define" });
  });

  it("refuses when a blocking rule is red, naming the sensor", async () => {
    const scenario = await startScenario("red", { sensorCommand: "false", attempts: 1 });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));

    const outcome = await advance(scenario);

    expect(outcome).toMatchObject({ kind: "gate-refused", phaseKey: "define" });
    if (outcome.kind !== "gate-refused") throw new Error("expected a refusal");
    expect(outcome.reasons.join(" ")).toContain("measure");
  });

  it("fails closed when a sensor cannot produce a reading", async () => {
    const scenario = await startScenario("nosensor", {
      sensorCommand: "senawa-no-such-command",
      attempts: 1,
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

  it("escalates a refused phase carrying the recorded gate evidence", async () => {
    const scenario = await startScenario("escalate", { sensorCommand: "false", attempts: 1 });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));
    expect(await advance(scenario)).toMatchObject({ kind: "gate-refused" });

    const loaded = await loadAuthoredWorkflow(scenario.project, dependencies.sha256);
    const snapshot = loaded.snapshot;
    if (snapshot === undefined) throw new Error("scenario does not compile");
    const authority = new SqliteAuthority({ ...scenario.paths, dependencies });
    try {
      const payload = canonicalValue({ allowedResponses: ["waive", "mark-done", "end-run"] });
      const commandId = "command_escalate-scenario";
      let allocation = 0;
      const receipt = authority.submit(
        decodeCommandEnvelope({
          apiVersion: PROTOCOL_VERSION,
          commandId,
          principal: runtimePrincipal,
          transport: { kind: "cli", requestId: `request_${commandId}` },
          repositoryId: scenario.repositoryId,
          runId: scenario.runId,
          intent: { type: "create-escalation" },
          expectedGraphRevision: snapshot.graph.revisionDigest,
          payload,
          payloadDigest: dependencies.sha256.digest(canonicalBytes(payload)),
        }),
        {
          currentTime: NOW,
          facts: { source: "scenario" },
          allocateId: (kind) => {
            allocation += 1;
            return `${kind}_${commandId.slice(8)}${allocation}`;
          },
        },
      );

      // Before the driver recorded evidence on a refusal this was
      // candidate-required, meaning there was nothing to escalate with. It now
      // reaches the digest check, which is the next gate a real escalation
      // passes by naming the candidate it escalates.
      expect(receipt.error?.code).not.toBe("candidate-required");
      expect(receipt.error?.code).toBe("stale-object");
    } finally {
      authority.close();
    }
  });

  it("advances to the next phase once the first closes", async () => {
    const scenario = await startScenario("advance", { secondPhase: true });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));

    expect(await advance(scenario)).toEqual({ kind: "closed", phaseKey: "define" });
    expect(await advance(scenario)).toMatchObject({ kind: "dispatched", phaseKey: "verify" });
  });
});
