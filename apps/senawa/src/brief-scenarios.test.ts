import { DatabaseSync } from "node:sqlite";
import { loadAuthoredWorkflow } from "@senawa/execution-host";
import { canonicalBytes, canonicalValue, sha256Digest } from "@senawa/kernel";
import { decodeCommandEnvelope, PROTOCOL_VERSION } from "@senawa/protocol";
import { SqliteAuthority } from "@senawa/storage-sqlite";
import { runtimePrincipal } from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type AdvanceOutcome, advanceRun, classifyOutcome } from "./advance-run.js";
import {
  agentTurn,
  askThroughSink,
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
import { decidePhase, overrideMember, type SteerInput, steerAgent } from "./decide.js";
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

  it("fans out over the collection the earlier phase produced", async () => {
    const scenario = await startScenario("fanout-run", { fanOut: "complete" });
    await agentTurn(
      scenario,
      scenario.dispatchId,
      canonicalValue({ tasks: [{ id: "one" }, { id: "two" }] }),
    );

    expect(await advance(scenario)).toMatchObject({ kind: "closed", phaseKey: "define" });

    // One member per element, materialised from the collection rather than from
    // anything the compiled graph already held.
    expect(await advance(scenario)).toEqual({
      kind: "fanned-out",
      phaseKey: "implement",
      members: 2,
    });

    // Materialising is worth nothing if no member can then be given to an agent.
    const dispatched = await advance(scenario);
    expect(dispatched).toMatchObject({ kind: "dispatched", phaseKey: "implement" });
  });
});

describe("running every member of a fan-out", () => {
  it("dispatches the second member after the first one finishes", async () => {
    const scenario = await startScenario("fanout-all", { fanOut: "complete" });
    await agentTurn(
      scenario,
      scenario.dispatchId,
      canonicalValue({ tasks: [{ id: "one" }, { id: "two" }] }),
    );
    await advance(scenario);
    await advance(scenario);
    const first = await advance(scenario);
    if (first.kind !== "dispatched") throw new Error("expected the first member");

    await agentTurn(scenario, first.dispatchId, canonicalValue({ verified: true }));
    const next = await advance(scenario);

    // Materialising two members and running one is not a fan-out, it is a fan-out
    // that stops. The second member has to be given to an agent in its turn.
    expect(next).toMatchObject({ kind: "dispatched", phaseKey: "implement" });
    if (next.kind !== "dispatched") throw new Error("expected the second member");
    expect(next.dispatchId).not.toBe(first.dispatchId);
  });

  it("closes the phase once every member has finished", async () => {
    const scenario = await startScenario("fanout-close", { fanOut: "complete" });
    await agentTurn(
      scenario,
      scenario.dispatchId,
      canonicalValue({ tasks: [{ id: "one" }, { id: "two" }, { id: "three" }] }),
    );
    await advance(scenario);
    await advance(scenario);
    for (let member = 0; member < 3; member += 1) {
      const dispatched = await advance(scenario);
      if (dispatched.kind !== "dispatched") throw new Error(`member ${member}: ${dispatched.kind}`);
      await agentTurn(scenario, dispatched.dispatchId, canonicalValue({ verified: true }));
    }

    // A fan-out that runs every member and then cannot close never finishes,
    // which is the same outcome for a person as never having started.
    expect(await advance(scenario)).toEqual({ kind: "finished" });
  });

  async function driveMembers(options: { readonly failFast: boolean }) {
    const scenario = await startScenario(`fanout-policy-${String(options.failFast)}`, {
      fanOut: "complete",
      ...(options.failFast ? { failFast: true } : { continueOnFailure: true }),
    });
    await agentTurn(
      scenario,
      scenario.dispatchId,
      canonicalValue({ tasks: [{ id: "one" }, { id: "two" }, { id: "three" }] }),
    );
    await advance(scenario);
    await advance(scenario);

    const reached: string[] = [];
    for (let member = 0; member < 3; member += 1) {
      const dispatched = await advance(scenario);
      if (dispatched.kind !== "dispatched") break;
      reached.push(dispatched.dispatchId);
      // The first member hands in a completion saying it could not finish.
      await agentTurn(scenario, dispatched.dispatchId, canonicalValue({ verified: true }), {
        blocked: member === 0,
      });
    }
    return reached;
  }

  it("runs the members that can finish when an earlier one cannot", async () => {
    // One member failing is that member's answer, not the phase's. Work that can
    // still be done is worth doing, and stopping would throw it away.
    expect(await driveMembers({ failFast: false })).toHaveLength(3);
  });

  it("stops the fan-out on the first failing member under fail-fast", async () => {
    // Spending the remaining attempts on work that will be thrown away is the
    // cost that policy exists to avoid, so it has to actually stop.
    expect(await driveMembers({ failFast: true })).toHaveLength(1);
  });

  it("carries on after a person accepts the work the run would not", async () => {
    const scenario = await startScenario("fanout-override", {
      fanOut: "complete",
      failFast: true,
    });
    await agentTurn(
      scenario,
      scenario.dispatchId,
      canonicalValue({ tasks: [{ id: "one" }, { id: "two" }] }),
    );
    await advance(scenario);
    await advance(scenario);
    const first = await advance(scenario);
    if (first.kind !== "dispatched") throw new Error("expected the first member");
    await agentTurn(scenario, first.dispatchId, canonicalValue({ verified: true }), {
      blocked: true,
    });

    const overridden = overrideMember({
      assetDirectory: scenario.paths.assetDirectory,
      currentTime: NOW,
      databasePath: scenario.paths.databasePath,
      dependencies,
      principal: runtimePrincipal,
      reason: "the remaining work does not depend on this",
      repositoryId: scenario.repositoryId,
      runId: scenario.runId,
    });
    expect(overridden.exitCode).toBe(0);

    // Overriding the work and then halting on it anyway would make the override
    // a gesture rather than a decision.
    expect(await advance(scenario)).toMatchObject({ kind: "dispatched" });

    // The reason survives as written. It is the only thing that explains, later,
    // why this run finished over its own judgement.
    const database = new DatabaseSync(scenario.paths.databasePath, { readOnly: true });
    try {
      const row = database
        .prepare("SELECT reason, canonical_principal, overridden_at FROM context_member_overrides")
        .get() as {
        readonly reason: string;
        readonly canonical_principal: string;
        readonly overridden_at: string;
      };
      expect(row.reason).toBe("the remaining work does not depend on this");
      expect(row.canonical_principal).toContain(runtimePrincipal.subject);
      expect(row.overridden_at).toBe(NOW);
    } finally {
      database.close();
    }
  });

  it("refuses an override when nothing reported that it could not finish", async () => {
    const scenario = await startScenario("fanout-no-override", { fanOut: "complete" });
    const result = overrideMember({
      assetDirectory: scenario.paths.assetDirectory,
      currentTime: NOW,
      databasePath: scenario.paths.databasePath,
      dependencies,
      principal: runtimePrincipal,
      reason: "nothing to accept",
      repositoryId: scenario.repositoryId,
      runId: scenario.runId,
    });

    // Accepting work that is still running would vouch for an outcome nobody
    // has seen.
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("could not finish");
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

describe("a run always has somewhere to go", () => {
  const outcomes: readonly AdvanceOutcome[] = [
    { kind: "dispatched", phaseKey: "define", dispatchId: "dispatch_x" },
    { kind: "retrying", phaseKey: "define", attempt: 2, dispatchId: "dispatch_y", reasons: ["a"] },
    { kind: "awaiting-agent", phaseKey: "define" },
    { kind: "awaiting-approval", phaseKey: "define" },
    { kind: "gate-refused", phaseKey: "define", reasons: ["a"] },
    { kind: "rejected", phaseKey: "define", reasons: ["a"] },
    { kind: "output-refused", phaseKey: "define", reasons: ["a"] },
    { kind: "closed", phaseKey: "define" },
    { kind: "finished" },
  ];

  it("classifies every outcome as progress, a human's turn, or a refusal", () => {
    // There is no fourth disposition, so no outcome means stuck with nothing to
    // do and no way out. The exhaustive switch is what keeps this true as
    // outcomes are added.
    for (const outcome of outcomes) {
      expect(["progress", "awaiting-human", "refused"]).toContain(classifyOutcome(outcome));
    }
  });

  it("gives a person something to act on with every refusal", () => {
    for (const outcome of outcomes) {
      if (classifyOutcome(outcome) !== "refused") continue;
      if (!("reasons" in outcome)) throw new Error(`${outcome.kind} carries no reasons`);
      // An escalation is built from what was measured, so a refusal that named
      // nothing would hand a person a decision with no basis.
      expect(outcome.reasons.length).toBeGreaterThan(0);
    }
  });

  it("refuses an outcome nobody classified", () => {
    expect(() => classifyOutcome({ kind: "invented" } as unknown as AdvanceOutcome)).toThrow(
      /Unclassified/u,
    );
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

  it("retries with the human's reason after they reject", async () => {
    const scenario = await startScenario("rejected-retry", { approval: true, attempts: 3 });
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

    const outcome = await advance(scenario);

    expect(outcome).toMatchObject({ kind: "retrying", phaseKey: "define", attempt: 2 });
    if (outcome.kind !== "retrying") throw new Error("expected a retry");
    // The person's own words, not the driver's summary of them.
    expect(await promptPackText(scenario, outcome.dispatchId)).toContain(
      "the endpoint returns the wrong status",
    );
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

/** Reads the session bindings recorded for a run, oldest first. */
function sessionBindings(scenario: Scenario) {
  const database = new DatabaseSync(scenario.paths.databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        "SELECT session_line_key, predecessor_session_id, predecessor_dispatch_id" +
          " FROM agent_session_resume_bindings ORDER BY rowid",
      )
      .all() as unknown as readonly {
      readonly session_line_key: string;
      readonly predecessor_session_id: string;
      readonly predecessor_dispatch_id: string;
    }[];
  } finally {
    database.close();
  }
}

describe("a persona that keeps its session", () => {
  it("carries one conversation across two phases of the same run", async () => {
    const scenario = await startScenario("session-run", { session: "run" });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));
    expect(await advance(scenario)).toMatchObject({ kind: "closed", phaseKey: "define" });
    const second = await advance(scenario);
    expect(second).toMatchObject({ kind: "dispatched", phaseKey: "verify" });

    // Two dispatches, one conversation: the second binding must name the session
    // the first one opened, not a session of its own.
    const bindings = sessionBindings(scenario);
    expect(bindings).toHaveLength(2);
    expect(bindings[1]?.session_line_key).toBe(bindings[0]?.session_line_key);
    expect(bindings[1]?.predecessor_session_id).toBe(bindings[0]?.predecessor_session_id);
    expect(bindings[1]?.predecessor_dispatch_id).not.toBe(bindings[0]?.predecessor_dispatch_id);
    expect(bindings[0]?.predecessor_session_id).toBe(scenario.dispatchId);
  });

  it("gives each persona its own line, so one never resumes into another's", async () => {
    const scenario = await startScenario("session-lines", { secondPhase: true });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));
    await advance(scenario);
    await advance(scenario);

    // Two personas worked, so there are two lines. Sharing one would let the
    // verifier resume into the definer's conversation and inherit its reasoning.
    const bindings = sessionBindings(scenario);
    expect(bindings).toHaveLength(2);
    expect(bindings[1]?.session_line_key).not.toBe(bindings[0]?.session_line_key);
    expect(bindings[1]?.predecessor_session_id).not.toBe(bindings[0]?.predecessor_session_id);
  });

  it("records nothing for a persona that starts fresh every time it works", async () => {
    const scenario = await startScenario("session-none", { session: "element" });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));
    await advance(scenario);
    await advance(scenario);

    // Recording a binding no successor may use would imply a continuity that
    // does not exist, so an element-scoped persona leaves no trace to resume.
    expect(sessionBindings(scenario)).toHaveLength(0);
  });
});

describe("bounding how far a conversation grows", () => {
  it("renews a conversation that has reached the turns it was allowed", async () => {
    const scenario = await startScenario("session-bound", { session: "run", sessionTurns: 1 });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));
    await advance(scenario);
    expect(await advance(scenario)).toMatchObject({ kind: "dispatched", phaseKey: "verify" });

    // The line continues, but the conversation on it does not: a persona allowed
    // one turn starts a second conversation rather than carrying the first
    // forward, which is what stops a long run growing without bound.
    const bindings = sessionBindings(scenario);
    expect(bindings).toHaveLength(2);
    expect(bindings[1]?.session_line_key).toBe(bindings[0]?.session_line_key);
    expect(bindings[1]?.predecessor_session_id).not.toBe(bindings[0]?.predecessor_session_id);
  });
});

describe("falling back to another model", () => {
  it("moves a retry to the next authored route and tells the agent it moved", async () => {
    const scenario = await startScenario("route-fallback", {
      routeLimits: true,
      sensorCommand: "false",
      attempts: 3,
    });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));

    const outcome = await advance(scenario);
    expect(outcome).toMatchObject({ kind: "retrying", attempt: 2 });
    if (outcome.kind !== "retrying") throw new Error("expected a retry");

    // Repeating a route that just failed spends an attempt to learn nothing, so
    // the second attempt runs on the second authored route under its own
    // ceilings, and the agent is told rather than silently swapped.
    const dispatched = new DatabaseSync(scenario.paths.databasePath, { readOnly: true });
    let command: string;
    try {
      const rows = dispatched
        .prepare("SELECT canonical_json AS json FROM context_authority_state")
        .all() as unknown as readonly { readonly json: string }[];
      command = rows.map((row) => row.json).join("\n");
    } finally {
      dispatched.close();
    }
    expect(command).toContain('"routeIndex":1');
    expect(command).toContain('"model":"gpt-5-mini"');
    expect(command).toContain('"maxTurns":2');
    expect(await promptPackText(scenario, outcome.dispatchId)).toContain("you are gpt-5-mini");
  });

  it("settles on the last route once the policy runs out of alternatives", async () => {
    const scenario = await startScenario("route-settle", {
      sensorCommand: "false",
      attempts: 3,
    });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));
    const outcome = await advance(scenario);

    // A policy with one route has no alternative to fall to, so the retry stays
    // where it was rather than falling off the end of the list.
    expect(outcome).toMatchObject({ kind: "retrying", attempt: 2 });
    if (outcome.kind !== "retrying") throw new Error("expected a retry");
    expect(await promptPackText(scenario, outcome.dispatchId)).not.toContain("you are");
  });
});

describe("an agent that stops to ask", () => {
  it("gets its question recorded through the channel it actually uses", async () => {
    const scenario = await startScenario("ask", {});

    // The channel builds the wire payload itself, and it built an invalid one
    // until 2026-08-19, so asking never worked. Only a test that goes through
    // the sink catches that; one that writes the payload by hand cannot.
    await askThroughSink(scenario, scenario.dispatchId, "which endpoint is authoritative?");

    const database = new DatabaseSync(scenario.paths.databasePath, { readOnly: true });
    try {
      const row = database
        .prepare("SELECT canonical_question AS json FROM context_questions")
        .get() as { readonly json: string } | undefined;
      expect(row?.json).toContain("which endpoint is authoritative?");
    } finally {
      database.close();
    }
  });
});

describe("steering an agent that is already working", () => {
  function steer(scenario: Scenario, instruction: string, delivery: SteerInput["delivery"]) {
    return steerAgent({
      assetDirectory: scenario.paths.assetDirectory,
      currentTime: NOW,
      databasePath: scenario.paths.databasePath,
      delivery,
      dependencies,
      instruction,
      principal: runtimePrincipal,
      repositoryId: scenario.repositoryId,
      runId: scenario.runId,
    });
  }

  it("records who redirected the run and what they said before delivering it", async () => {
    const scenario = await startScenario("steer-record", {});
    const result = steer(scenario, "use the existing health check", "queued");
    expect(result.exitCode).toBe(0);

    // The instruction is durable before anything tries to deliver it, so a run
    // that changes course can say who changed it even if delivery fails.
    const database = new DatabaseSync(scenario.paths.databasePath, { readOnly: true });
    try {
      const row = database
        .prepare("SELECT instruction, delivery, canonical_principal FROM context_agent_steerings")
        .get() as {
        readonly instruction: string;
        readonly delivery: string;
        readonly canonical_principal: string;
      };
      expect(row.instruction).toBe("use the existing health check");
      expect(row.delivery).toBe("queued");
      expect(row.canonical_principal).toContain(runtimePrincipal.subject);
    } finally {
      database.close();
    }
  });

  it("starts the attempt again carrying the instruction when asked to abort", async () => {
    const scenario = await startScenario("steer-abort", { attempts: 3 });
    expect(steer(scenario, "start over and read the schema first", "abort-retry").exitCode).toBe(0);

    // The agent never reported anything, and it does not have to: a person who
    // asked for the attempt to start again is not waiting for it to finish.
    const outcome = await advance(scenario);
    expect(outcome).toMatchObject({ kind: "retrying", phaseKey: "define", attempt: 2 });
    if (outcome.kind !== "retrying") throw new Error("expected a retry");
    expect(await promptPackText(scenario, outcome.dispatchId)).toContain(
      "start over and read the schema first",
    );
  });

  it("hands a queued instruction to the agent when it next stops to ask", async () => {
    const scenario = await startScenario("steer-deliver", {});
    expect(steer(scenario, "prefer the existing health check", "queued").exitCode).toBe(0);

    // An agent that stopped to ask is between turns, so the instruction is due.
    // Answering without it would send the agent back to work on a course a
    // person has already corrected.
    const answered = await askThroughSink(scenario, scenario.dispatchId, "which endpoint?");
    expect(JSON.stringify(answered)).toContain("prefer the existing health check");
  });

  it("records a fan-out steering against the member's own dispatch", async () => {
    const scenario = await startScenario("steer-member", { fanOut: "complete" });
    await agentTurn(
      scenario,
      scenario.dispatchId,
      canonicalValue({ tasks: [{ id: "one" }, { id: "two" }] }),
    );
    await advance(scenario);
    await advance(scenario);
    const dispatched = await advance(scenario);
    expect(dispatched).toMatchObject({ kind: "dispatched", phaseKey: "implement" });
    if (dispatched.kind !== "dispatched") throw new Error("expected a member dispatch");

    expect(steer(scenario, "skip the second item", "queued").exitCode).toBe(0);

    // A member is what is actually working, so it is what a person means by
    // "the agent", and the instruction has to be recorded against the member's
    // own dispatch or the member that reads it will never see it.
    const database = new DatabaseSync(scenario.paths.databasePath, { readOnly: true });
    try {
      const row = database.prepare("SELECT dispatch_id FROM context_agent_steerings").get() as {
        readonly dispatch_id: string;
      };
      expect(row.dispatch_id).toBe(dispatched.dispatchId);
    } finally {
      database.close();
    }
  });

  it("refuses to redirect an agent that has already finished", async () => {
    const scenario = await startScenario("steer-finished", {});
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));

    // An instruction nobody will ever read is worse than a refusal, because the
    // person who gave it would have no way to tell it went nowhere.
    const result = steer(scenario, "too late", "queued");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("No agent is working");

    // Nothing was recorded, so the history does not imply a course change that
    // never happened.
    const database = new DatabaseSync(scenario.paths.databasePath, { readOnly: true });
    try {
      const row = database
        .prepare("SELECT COUNT(*) AS total FROM context_agent_steerings")
        .get() as { readonly total: number };
      expect(row.total).toBe(0);
    } finally {
      database.close();
    }
  });
});

describe("where agents work and how many write at once", () => {
  it("defaults to one writer in the repository, which needs no worktree", async () => {
    const snapshot = (await compileSnapshot({})) as {
      readonly execution: Record<string, unknown>;
    };
    expect(snapshot.execution).toMatchObject({
      workspaceMode: "repository",
      maxWriterConcurrency: 1,
    });
  });

  it("lets an author isolate writers in worktrees and say where work integrates", async () => {
    const snapshot = (await compileSnapshot({
      execution:
        "execution:\n  workspace: worktree\n  maxWriters: 3\n  integrationRef: refs/heads/main",
    })) as { readonly execution: Record<string, unknown> };

    // Worktree mode was documented and unreachable from YAML until 2026-08-19:
    // the lowering hardcoded one writer in the repository.
    expect(snapshot.execution).toMatchObject({
      workspaceMode: "worktree",
      maxWriterConcurrency: 3,
      integrationRef: "refs/heads/main",
    });
  });

  it("refuses parallel writers that would share one directory", async () => {
    const diagnostics = await compileScenario({ execution: "execution:\n  maxWriters: 2" });

    // Two writers in one directory overwrite each other, and nothing can say
    // afterwards which edit belonged to whom.
    expect(diagnostics.map(({ message }) => message).join(" ")).toContain("worktree");
  });

  it("refuses worktree mode that does not say where work integrates", async () => {
    const diagnostics = await compileScenario({
      execution: "execution:\n  workspace: worktree",
    });
    expect(diagnostics.map(({ message }) => message).join(" ")).toContain("integrationRef");
  });

  it("refuses a branch name the runtime would reject when the run started", async () => {
    const diagnostics = await compileScenario({
      execution: "execution:\n  workspace: worktree\n  integrationRef: main",
    });

    // The runtime takes a full local ref. Compiling `main` and failing at start
    // is the worst place for an author to find out.
    expect(diagnostics.map(({ message }) => message).join(" ")).toContain("refs/heads/main");
  });

  it("refuses an execution field the reader does not know", async () => {
    const diagnostics = await compileScenario({ execution: "execution:\n  workspce: worktree" });
    expect(diagnostics.map(({ message }) => message).join(" ")).toContain("workspce");
  });
});
