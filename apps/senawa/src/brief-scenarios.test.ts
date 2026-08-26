import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadAuthoredWorkflow } from "@senawa/execution-host";
import { type CanonicalValue, canonicalBytes, canonicalValue, sha256Digest } from "@senawa/kernel";
import { decodeCommandEnvelope, PROTOCOL_VERSION } from "@senawa/protocol";
import {
  SqliteAuthority,
  SqliteCanonicalJsonAssetStore,
  SqlitePortalQueryAuthority,
} from "@senawa/storage-sqlite";
import { SqliteSupervisorAuthority } from "@senawa/supervisor";
import { runtimePrincipal } from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type AdvanceOutcome, advanceRun, classifyOutcome } from "./advance-run.js";
import {
  agentTurn,
  askThroughSink,
  BASE,
  boundUpstreamValue,
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
import {
  answerQuestion,
  decidePhase,
  overrideMember,
  type SteerInput,
  steerAgent,
} from "./decide.js";
import { runGates } from "./run-gates.js";
import { runStatus } from "./run-status.js";

interface SnapshotPhaseInput {
  readonly key: string;
  readonly input: {
    readonly mappings: readonly {
      readonly key: string;
      readonly destinationPointer: string;
    }[];
  };
}

afterEach(disposeScenarios);

function advance(scenario: Scenario) {
  // The run's own input, read back the way the command does. A fabricated one
  // makes a second dispatch of the same attempt disagree with the first about
  // what the run is for.
  const authority = new SqliteAuthority({ ...scenario.paths, dependencies });
  let workflowInput: {
    readonly bindingDigest: ReturnType<typeof sha256Digest>;
    readonly value: CanonicalValue;
  };
  try {
    const bound = authority.queryWorkflowInput(scenario.repositoryId, scenario.runId);
    const value =
      bound === undefined
        ? undefined
        : new SqliteCanonicalJsonAssetStore(authority).load(sha256Digest(bound.contentDigest));
    workflowInput =
      bound === undefined || value === undefined
        ? {
            bindingDigest: sha256Digest("3".repeat(64)),
            value: canonicalValue({ request: "Add a health endpoint" }),
          }
        : { bindingDigest: sha256Digest(bound.bindingDigest), value };
  } finally {
    authority.close();
  }
  return advanceRun({
    projectRoot: scenario.project,
    ...scenario.paths,
    repositoryId: scenario.repositoryId,
    runId: scenario.runId,
    principal: runtimePrincipal,
    dependencies,
    currentTime: NOW,
    workflowInput,
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

  it("waits for the members still working whichever one finishes first", async () => {
    const scenario = await startScenario("fanout-fan-in", { fanOut: "complete" });
    await agentTurn(
      scenario,
      scenario.dispatchId,
      canonicalValue({ tasks: [{ id: "one" }, { id: "two" }, { id: "three" }] }),
    );
    await advance(scenario);
    await advance(scenario);
    const dispatched: string[] = [];
    for (let member = 0; member < 3; member += 1) {
      const outcome = await advance(scenario);
      if (outcome.kind !== "dispatched") throw new Error(`member ${member}: ${outcome.kind}`);
      dispatched.push(outcome.dispatchId);
    }
    const [first, , last] = dispatched as [string, string, string];

    // Members run at the same time and finish in any order, so neither the
    // newest dispatch nor the oldest speaks for the phase. Closing needs every
    // member's assessment: reasoning about one member alone made the phase try
    // to close without the others and refuse its own candidate, on every cycle,
    // for ever. Both orders are checked because each catches a different way of
    // picking the wrong member.
    await agentTurn(scenario, last, canonicalValue({ verified: true }));
    expect(await advance(scenario)).toMatchObject({ kind: "awaiting-agent" });

    await agentTurn(scenario, first, canonicalValue({ verified: true }));
    expect(await advance(scenario)).toMatchObject({ kind: "awaiting-agent" });
  });

  // A member reports once, and the record of that sits in an outbox only until
  // it is drained. Reading "has this member handed work in?" from the outbox
  // therefore answers yes for one cycle and no for every cycle after, so a
  // member that had already finished started speaking for the phase again and
  // closed it while a sibling was still working. The sibling then finished into
  // a phase that had a candidate, its completion was refused for that, and the
  // run waited for ever on an agent that had already done the work.
  it("does not close the phase after a finished member's report is drained", async () => {
    const scenario = await startScenario("fanout-drained", { fanOut: "complete" });
    await agentTurn(
      scenario,
      scenario.dispatchId,
      canonicalValue({ tasks: [{ id: "one" }, { id: "two" }, { id: "three" }] }),
    );
    await advance(scenario);
    await advance(scenario);
    const dispatched: string[] = [];
    for (let member = 0; member < 3; member += 1) {
      const outcome = await advance(scenario);
      if (outcome.kind !== "dispatched") throw new Error(`member ${member}: ${outcome.kind}`);
      dispatched.push(outcome.dispatchId);
    }
    const [first, second, third] = dispatched as [string, string, string];

    await agentTurn(scenario, first, canonicalValue({ verified: true }));
    // Twice, because one cycle is exactly the window in which the outbox still
    // remembers. The phase owes two members and must say so the second time it
    // is asked, not only the first.
    for (let cycle = 0; cycle < 2; cycle += 1) {
      expect(await advance(scenario), `cycle ${String(cycle)}`).toMatchObject({
        kind: "awaiting-agent",
      });
    }

    await agentTurn(scenario, second, canonicalValue({ verified: true }));
    for (let cycle = 0; cycle < 2; cycle += 1) {
      expect(await advance(scenario), `cycle ${String(cycle)}`).toMatchObject({
        kind: "awaiting-agent",
      });
    }

    // With nothing left working, the phase is free to close, and a fan-in that
    // never lets go would be as broken as one that closes early.
    await agentTurn(scenario, third, canonicalValue({ verified: true }));
    const outcomes: string[] = [];
    for (let cycle = 0; cycle < 4; cycle += 1) outcomes.push((await advance(scenario)).kind);
    expect(outcomes, outcomes.join(",")).not.toContain("awaiting-agent");
  }, 120_000);

  // A member that asks a question resumes on a fresh dispatch, and that dispatch
  // needs a phase attempt ordinal. Deriving it from the member's own ordinal
  // landed on a sibling's, which the dataflow refuses for holding different
  // content, and the run stopped with `Phase attempt ordinal is already assigned
  // to different content` on every cycle.
  it("resumes a member that asked without taking a sibling's ordinal", async () => {
    const scenario = await startScenario("fanout-ordinal", { fanOut: "complete" });
    await agentTurn(
      scenario,
      scenario.dispatchId,
      canonicalValue({ tasks: [{ id: "one" }, { id: "two" }] }),
    );
    await advance(scenario);
    await advance(scenario);
    const first = await advance(scenario);
    if (first.kind !== "dispatched") throw new Error(`first member: ${first.kind}`);
    const second = await advance(scenario);
    if (second.kind !== "dispatched") throw new Error(`second member: ${second.kind}`);

    await askThroughSink(scenario, first.dispatchId, "which board size?");
    expect(
      answerQuestion({
        ...scenario.paths,
        answer: "three by three",
        currentTime: NOW,
        dependencies,
        principal: runtimePrincipal,
        repositoryId: scenario.repositoryId,
        runId: scenario.runId,
      }),
    ).toMatchObject({ exitCode: 0 });

    const resumed = await advance(scenario);
    expect(resumed).toMatchObject({ kind: "dispatched", phaseKey: "implement" });
    if (resumed.kind !== "dispatched") throw new Error("expected a fresh dispatch");
    expect(resumed.dispatchId).not.toBe(first.dispatchId);
    expect(resumed.dispatchId).not.toBe(second.dispatchId);
  });

  // A member that asks a question reports, but it does not report work. That
  // report lands in the same outbox a finished member's does, so fan-in read it
  // as "this member is done" and closed the phase around a member that was
  // waiting to be told something. The answer then resumed that member into a
  // phase that already had a candidate, its completion was refused for that, and
  // the run waited for ever on an agent that had already done the work.
  it("does not close a phase around a member that is waiting for an answer", async () => {
    const scenario = await startScenario("fanout-asked", { fanOut: "complete" });
    await agentTurn(
      scenario,
      scenario.dispatchId,
      canonicalValue({ tasks: [{ id: "one" }, { id: "two" }] }),
    );
    await advance(scenario);
    await advance(scenario);
    const first = await advance(scenario);
    if (first.kind !== "dispatched") throw new Error(`first member: ${first.kind}`);
    const second = await advance(scenario);
    if (second.kind !== "dispatched") throw new Error(`second member: ${second.kind}`);

    await askThroughSink(scenario, first.dispatchId, "which board size?");
    await agentTurn(scenario, second.dispatchId, canonicalValue({ verified: true }));

    // Nobody has answered yet, so the phase is still owed a member's work and
    // must not produce the candidate that would lock that member out.
    const outcomes: string[] = [];
    for (let cycle = 0; cycle < 3; cycle += 1) outcomes.push((await advance(scenario)).kind);
    expect(outcomes, outcomes.join(",")).not.toContain("closed");
    expect(outcomes, outcomes.join(",")).not.toContain("awaiting-approval");
  }, 120_000);

  // Fan-in counts members, and a member is a task, not a dispatch. A member that
  // was resumed has two dispatches, and the abandoned one still carries the
  // finished completion it handed in before it asked. Reading the phase as a
  // list of dispatches therefore found that stale completion, decided the member
  // was done, and closed the phase while the member's live dispatch was still
  // working. The live dispatch then finished into a phase that already had a
  // candidate, was refused for it, and the run waited for ever on an agent that
  // had already done the work.
  it("waits for a resumed member rather than its abandoned dispatch", async () => {
    const scenario = await startScenario("fanout-resumed", { fanOut: "complete" });
    await agentTurn(
      scenario,
      scenario.dispatchId,
      canonicalValue({ tasks: [{ id: "one" }, { id: "two" }] }),
    );
    await advance(scenario);
    await advance(scenario);
    const first = await advance(scenario);
    if (first.kind !== "dispatched") throw new Error(`first member: ${first.kind}`);
    const second = await advance(scenario);
    if (second.kind !== "dispatched") throw new Error(`second member: ${second.kind}`);

    await askThroughSink(scenario, first.dispatchId, "which board size?");
    expect(
      answerQuestion({
        ...scenario.paths,
        answer: "three by three",
        currentTime: NOW,
        dependencies,
        principal: runtimePrincipal,
        repositoryId: scenario.repositoryId,
        runId: scenario.runId,
      }),
    ).toMatchObject({ exitCode: 0 });
    const resumed = await advance(scenario);
    if (resumed.kind !== "dispatched") throw new Error(`resumed: ${resumed.kind}`);

    // The sibling is done, so the only thing the phase is still owed is the
    // resumed member, which has not reported on its live dispatch.
    await agentTurn(scenario, second.dispatchId, canonicalValue({ verified: true }));
    for (let cycle = 0; cycle < 2; cycle += 1) {
      expect(await advance(scenario), `cycle ${String(cycle)}`).toMatchObject({
        kind: "awaiting-agent",
      });
    }

    // And once it does report, the phase is free to move.
    await agentTurn(scenario, resumed.dispatchId, canonicalValue({ verified: true }));
    const outcomes: string[] = [];
    for (let cycle = 0; cycle < 3; cycle += 1) outcomes.push((await advance(scenario)).kind);
    expect(outcomes, outcomes.join(",")).not.toContain("awaiting-agent");
  }, 120_000);

  // The attempt ceiling is a count of a task's own tries. Measuring it by the
  // member's ordinal meant the second member of a fan-out had spent two of its
  // two attempts before taking one, so it could never be retried at all.
  it("counts a member's own tries against the attempt ceiling", async () => {
    const scenario = await startScenario("fanout-ceiling", {
      fanOut: "complete",
      memberAttempts: 2,
    });
    await agentTurn(
      scenario,
      scenario.dispatchId,
      canonicalValue({ tasks: [{ id: "one" }, { id: "two" }] }),
    );
    await advance(scenario);
    await advance(scenario);
    const first = await advance(scenario);
    if (first.kind !== "dispatched") throw new Error(`first member: ${first.kind}`);
    const second = await advance(scenario);
    if (second.kind !== "dispatched") throw new Error(`second member: ${second.kind}`);

    // The first member is done, so the second is the one the phase is waiting
    // on, and the one a person redirecting the run reaches.
    await agentTurn(scenario, first.dispatchId, canonicalValue({ verified: true }));
    expect(
      steerAgent({
        assetDirectory: scenario.paths.assetDirectory,
        currentTime: NOW,
        databasePath: scenario.paths.databasePath,
        delivery: "abort-retry",
        dependencies,
        instruction: "start over and read the schema first",
        principal: runtimePrincipal,
        repositoryId: scenario.repositoryId,
        runId: scenario.runId,
      }),
    ).toMatchObject({ exitCode: 0 });

    expect(await advance(scenario)).toMatchObject({ kind: "retrying", phaseKey: "implement" });
  });

  // The dispatch driver takes `phaseTasks[memberIndex ?? 0]`, and every retry
  // path passed nothing, so a retry in a fan-out re-ran the first member
  // whatever had actually failed. When that member was already accepted the
  // retry became a dispatch for finished work, which is the shadow that
  // deadlocked two live runs -- both of them on member zero, which is the tell.
  it("retries the member that failed, not the phase's first one", async () => {
    const scenario = await startScenario("fanout-retry-member", {
      fanOut: "complete",
      memberAttempts: 2,
    });
    await agentTurn(
      scenario,
      scenario.dispatchId,
      canonicalValue({ tasks: [{ id: "one" }, { id: "two" }] }),
    );
    await advance(scenario);
    await advance(scenario);
    const first = await advance(scenario);
    if (first.kind !== "dispatched") throw new Error(`first member: ${first.kind}`);
    const second = await advance(scenario);
    if (second.kind !== "dispatched") throw new Error(`second member: ${second.kind}`);
    await agentTurn(scenario, first.dispatchId, canonicalValue({ verified: true }));

    expect(
      steerAgent({
        assetDirectory: scenario.paths.assetDirectory,
        currentTime: NOW,
        databasePath: scenario.paths.databasePath,
        delivery: "abort-retry",
        dependencies,
        instruction: "start over and read the schema first",
        principal: runtimePrincipal,
        repositoryId: scenario.repositoryId,
        runId: scenario.runId,
      }),
    ).toMatchObject({ exitCode: 0 });
    const retried = await advance(scenario);
    if (retried.kind !== "retrying") throw new Error(`expected a retry, got ${retried.kind}`);

    const taskOf = (dispatchId: string) => {
      const database = new DatabaseSync(scenario.paths.databasePath, { readOnly: true });
      try {
        const row = database
          .prepare(
            "SELECT canonical_dispatch AS json FROM context_dispatches WHERE dispatch_id = ?",
          )
          .get(dispatchId) as { readonly json: string } | undefined;
        return String(
          (JSON.parse(row?.json ?? "{}") as { readonly task?: { readonly taskId?: unknown } }).task
            ?.taskId,
        );
      } finally {
        database.close();
      }
    };

    expect(taskOf(retried.dispatchId)).toBe(taskOf(second.dispatchId));
    expect(taskOf(retried.dispatchId)).not.toBe(taskOf(first.dispatchId));
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

    // Ending a run is a person's decision, so the mode stays as it was. Without
    // this a run that had done everything asked of it reported exactly what a
    // run still working reports, and nobody could tell them apart.
    expect(
      runStatus({
        ...scenario.paths,
        currentTime: NOW,
        dependencies,
        repositoryId: scenario.repositoryId,
        runId: scenario.runId,
      }).output,
    ).toContain("every phase has closed");
  });

  it("says why the driver stopped, and stops saying it once the run moves", async () => {
    const scenario = await startScenario("stopped-status", { sensorCommand: "false", attempts: 1 });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));
    expect(await advance(scenario)).toMatchObject({ kind: "gate-refused" });

    const supervisor = new SqliteSupervisorAuthority({ ...scenario.paths, dependencies });
    const status = () =>
      runStatus({
        ...scenario.paths,
        currentTime: NOW,
        dependencies,
        repositoryId: scenario.repositoryId,
        runId: scenario.runId,
      }).output;
    try {
      // Before this, a run the driver had given up on reported "running",
      // "waiting on you: 0", and nothing else. The reason existed, in the
      // supervisor's log, which is not somewhere a person looks to find out
      // what their run is doing.
      expect(status()).not.toContain("stopped:");
      supervisor.appendLog({
        recordedAt: NOW,
        level: "error",
        event: "run.stopped",
        message: "gate-refused at define: measure /exitCode equals 0, and read 1",
        fields: { repositoryId: scenario.repositoryId, runId: scenario.runId },
      });
      expect(status()).toContain("stopped: gate-refused at define");

      supervisor.appendLog({
        recordedAt: NOW,
        level: "info",
        event: "run.resumed",
        message: "moved on with dispatched",
        fields: { repositoryId: scenario.repositoryId, runId: scenario.runId },
      });
      // A stop that was never cleared would leave a working run wearing a
      // refusal it had already recovered from.
      expect(status()).not.toContain("stopped:");
    } finally {
      supervisor.close();
    }
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
      // A dispatch lives in its own table; the authority snapshot leaves it
      // there rather than keeping a second copy it rewrites on every change.
      const rows = database
        .prepare(`SELECT canonical_effect AS json FROM context_dispatches`)
        .all() as unknown as readonly { readonly json: string | null }[];
      state = rows.map((row) => row.json ?? "").join("\n");
    } finally {
      database.close();
    }

    const found = state;

    // The authored route declares 7 turns, 3 submissions, and 250 spend. Those
    // have to be the limits carried into the dispatch rather than the defaults,
    // and the first route has to be the one selected.
    expect(found).toContain('"maxTurns":7');
    expect(found).toContain('"maxSubmissions":3');
    expect(found).toContain('"maxMillidollars":250');
    expect(found).toContain('"model":"gpt-5"');
    expect(found).not.toContain("gpt-5-mini");
  });

  it("spends the attempts the author wrote, not a fixed three", async () => {
    const snapshot = (await compileSnapshot({ attempts: 5 })) as {
      readonly phaseDataflow: readonly { readonly key: string; readonly value: unknown }[];
    };
    const define = snapshot.phaseDataflow.find((entry) => entry.key === "define")?.value as {
      readonly iteration: { readonly maximumAttempts: number };
      readonly executor: {
        readonly budgets: readonly { readonly unit: string; readonly limit: number }[];
      };
    };

    // The ceiling and the budget are two counters for one thing. A fixed budget
    // meant an authored `attempts: 5` raised the policy and nothing else, and
    // the phase escalated for budget on its fourth attempt.
    expect(define.iteration.maximumAttempts).toBe(5);
    expect(define.executor.budgets).toEqual([{ unit: "review-iteration", limit: 5 }]);
  });

  it("binds a declared phase input to the sources its property names", async () => {
    const loaded = await loadAuthoredWorkflow(process.cwd(), dependencies.sha256);
    const snapshot = loaded.snapshot;
    if (snapshot === undefined) throw new Error("the repository tree does not compile");

    const plan = snapshot.phaseDataflow
      .map((entry) => entry.value as unknown as SnapshotPhaseInput)
      .find((phase) => phase.key === "plan");
    if (plan === undefined) throw new Error("the repository declares no plan phase");

    // The repository's plan phase reads two upstreams and names them by their
    // output schemas. Lowering used to key the merge on the phase names, which
    // produced a value the declared schema refuses, and it refused it at
    // dispatch rather than at compile time.
    expect(plan.input.mappings.map(({ key }) => key).sort()).toEqual(["definition", "research"]);
    expect(plan.input.mappings.map(({ destinationPointer }) => destinationPointer).sort()).toEqual([
      "/definition",
      "/research",
    ]);
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

    expect(await advance(scenario)).toMatchObject({ kind: "awaiting-agent", phaseKey: "define" });
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

  it("refuses a completion that owes evidence, naming the kind and the count", async () => {
    const scenario = await startScenario("owed", { requireEvidence: 2 });

    const refused = await completeThroughSink(scenario, scenario.dispatchId, [
      { name: "define", value: canonicalValue({ definition: "x" }) },
    ]);

    expect(refused.status).toBe("refused");
    expect(refused.reason).toContain("2 of definition-note");
    expect(refused.reason).toContain("carries 0");
    // Nothing was published, so the phase is still waiting on the agent.
    expect(await advance(scenario)).toMatchObject({ kind: "awaiting-agent", phaseKey: "define" });
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

    expect(await advance(scenario)).toMatchObject({ kind: "awaiting-agent", phaseKey: "define" });
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

  it("binds the upstream output the phase closed on, not every one it published", async () => {
    const scenario = await startScenario("republished-upstream", {
      secondPhase: true,
      attempts: 3,
    });

    // What the live run did: produce the output, then ask before completing.
    // The turn is suspended and its publication stays in the outbox.
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "first" }), {
      omitCompletion: true,
    });
    await askThroughSink(scenario, scenario.dispatchId, "which endpoint?");
    expect(await advance(scenario)).toMatchObject({ kind: "awaiting-agent" });
    expect(
      answerQuestion({
        ...scenario.paths,
        answer: "the second one",
        currentTime: NOW,
        dependencies,
        principal: runtimePrincipal,
        repositoryId: scenario.repositoryId,
        runId: scenario.runId,
      }),
    ).toMatchObject({ exitCode: 0 });

    const resumed = await advance(scenario);
    if (resumed.kind !== "dispatched") throw new Error(`expected a dispatch, got ${resumed.kind}`);
    await agentTurn(scenario, resumed.dispatchId, canonicalValue({ definition: "second" }));
    expect(await advance(scenario)).toEqual({ kind: "closed", phaseKey: "define" });

    // Every attempt that produced output leaves a publication behind. Handing
    // both to the binder made two bindings for one source, and the phase
    // downstream could never be dispatched: a live run stopped here for good
    // with "Source phase-output:research:research has conflicting bindings".
    const next = await advance(scenario);
    expect(next).toMatchObject({ kind: "dispatched", phaseKey: "verify" });
    if (next.kind !== "dispatched") throw new Error("expected a dispatch");
    // And it is the accepted attempt's output that was bound, not the one the
    // question interrupted.
    expect(await boundUpstreamValue(scenario, next.dispatchId)).toEqual({
      definition: "second",
    });

    // A reader of the same run sees which try each output came from, and which
    // one the phase kept. Without it a retried phase reads as though it
    // produced one thing once.
    const portal = new SqlitePortalQueryAuthority({ ...scenario.paths, dependencies });
    try {
      const produced = portal
        .listArtifacts(scenario.repositoryId, scenario.runId)
        .artifacts.filter(({ attempt }) => attempt !== undefined);
      expect(produced.length).toBeGreaterThan(0);
      expect(produced.some(({ accepted }) => accepted === true)).toBe(true);
    } finally {
      portal.close();
    }
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
    expect(pack).toContain("measure/exitCode equals 0, and read 1");
  });

  // Retrying a refused gate is only half of a retry. The attempt it starts has
  // to be able to hand its work in, and a candidate was already recorded for the
  // attempt the gate refused, so the authority refused the new work for
  // belonging to a task that already had a candidate. The run then waited for an
  // agent that had already finished.
  it("lets the attempt after a refused gate hand its work in", async () => {
    const scenario = await startScenario("gate-retry-handin", {
      sensorCommand: "false",
      attempts: 3,
    });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));
    const retry = await advance(scenario);
    if (retry.kind !== "retrying") throw new Error(`expected a retry, got ${retry.kind}`);

    await agentTurn(scenario, retry.dispatchId, canonicalValue({ definition: "y" }));
    const outcome = await advance(scenario);

    expect(outcome.kind, JSON.stringify(outcome)).not.toBe("awaiting-agent");
  }, 120_000);

  it("stops at the authored attempt ceiling rather than retrying forever", async () => {
    const scenario = await startScenario("ceiling", { sensorCommand: "false", attempts: 1 });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));

    expect(await advance(scenario)).toMatchObject({ kind: "gate-refused", phaseKey: "define" });
  });

  // A live run stopped at its first phase after eight turns, every one of which
  // ended by asking a person, and was rejected for handing no work in. Whether
  // a turn had asked was read from whether its question was still outstanding,
  // so answering the question converted the suspended turn into a spent
  // attempt: the person unblocking the run was spending its attempts.
  it("does not spend an attempt on a turn that ended by asking", async () => {
    const scenario = await startScenario("asked-not-spent", { attempts: 2 });
    let dispatchId = scenario.dispatchId;
    const carried: number[] = [];

    // More rounds of ask-and-answer than the phase has attempts. None of them
    // is a try, so none of them may exhaust the ceiling. The advance between
    // the question and the answer is what a live driver does by polling, and
    // it is where the turn is recorded as over.
    for (const question of ["which endpoint?", "and which port?", "and which host?"]) {
      await askThroughSink(scenario, dispatchId, question);
      expect(await advance(scenario)).toMatchObject({ kind: "awaiting-agent" });
      expect(
        answerQuestion({
          ...scenario.paths,
          answer: "the first one",
          currentTime: NOW,
          dependencies,
          principal: runtimePrincipal,
          repositoryId: scenario.repositoryId,
          runId: scenario.runId,
        }),
      ).toMatchObject({ exitCode: 0 });
      const resumed = await advance(scenario);
      expect(resumed, JSON.stringify(resumed)).toMatchObject({ kind: "dispatched" });
      if (resumed.kind !== "dispatched") throw new Error("expected a fresh dispatch");
      expect(resumed.dispatchId).not.toBe(dispatchId);
      dispatchId = resumed.dispatchId;
      carried.push(answeredQuestionsCarried(scenario.paths.databasePath, dispatchId));
    }

    // An agent's context is the only memory it has. Built from the answers no
    // dispatch had carried yet, each fresh turn knew the newest answer and had
    // forgotten the rest, so it asked again in different words for what it had
    // already been told: a live researcher asked the same thing four times.
    expect(carried).toEqual([1, 2, 3]);

    // And the run is still able to finish: the attempts were never spent.
    await agentTurn(scenario, dispatchId, canonicalValue({ definition: "x" }));
    const outcome = await advance(scenario);
    expect(outcome.kind, JSON.stringify(outcome)).not.toBe("rejected");

    // The durable record is what the ceiling counts, and it says what each turn
    // did rather than whether its question is still outstanding. Three turns
    // ended by asking, and the run's own record says so after every one of them
    // was answered.
    const database = new DatabaseSync(scenario.paths.databasePath, { readOnly: true });
    try {
      const row = database.prepare("SELECT records_json AS json FROM runs").get() as
        | { readonly json: string }
        | undefined;
      const attempts = (
        JSON.parse(row?.json ?? "{}") as {
          readonly attempts?: readonly { readonly disposition: string }[];
        }
      ).attempts;
      expect(
        (attempts ?? []).filter(({ disposition }) => disposition === "suspended"),
      ).toHaveLength(3);
    } finally {
      database.close();
    }
  }, 120_000);

  it("closes a phase whose second attempt passes", async () => {
    const scenario = await startScenario("retry-then-close", { attempts: 3, secondPhase: true });
    expect(
      steerAgent({
        assetDirectory: scenario.paths.assetDirectory,
        currentTime: NOW,
        databasePath: scenario.paths.databasePath,
        delivery: "abort-retry",
        dependencies,
        instruction: "start over",
        principal: runtimePrincipal,
        repositoryId: scenario.repositoryId,
        runId: scenario.runId,
      }).exitCode,
    ).toBe(0);

    const retried = await advance(scenario);
    expect(retried).toMatchObject({ kind: "retrying", attempt: 2 });
    if (retried.kind !== "retrying") throw new Error("expected a retry");
    await agentTurn(scenario, retried.dispatchId, canonicalValue({ definition: "x" }));

    // Every retry leaves a dispatch for the same task, and the candidate selects
    // a set of tasks rather than a list of attempts at them. Counting the
    // dispatches instead made a phase that retried refuse its own candidate for
    // selecting one task twice, so no retried phase could ever close.
    expect(await advance(scenario)).toEqual({ kind: "closed", phaseKey: "define" });
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

  // The outbox keeps a fact after it has been delivered, and the driver read the
  // whole outbox every cycle, so it offered the authority the same completion
  // again on every pass. That is a command identity being re-submitted for as
  // long as the run lives, and the moment anything about the envelope moved the
  // authority refused it for conflicting with itself. The run then stopped
  // driving entirely, with the reason recorded nowhere a person could read it.
  it("offers a completion to the authority once, not on every cycle", async () => {
    const scenario = await startScenario("deliver-once", { secondPhase: true });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));

    const submissions = () => {
      const authority = new SqliteAuthority({ ...scenario.paths, dependencies });
      try {
        return authority
          .queryReceiptHistory(scenario.repositoryId, scenario.runId)
          .filter(({ commandId }) => commandId.startsWith("command_completion-")).length;
      } finally {
        authority.close();
      }
    };

    await advance(scenario);
    const once = submissions();
    expect(once).toBeGreaterThan(0);

    // Nothing has finished since, so nothing new should be offered.
    await advance(scenario);
    await advance(scenario);
    expect(submissions()).toBe(once);
  }, 120_000);

  // A run whose last phase has closed has nothing left to drive. The driver ran
  // it again anyway, rebuilding the same commands against a graph that had moved
  // under them, and the authority refused each one for conflicting with the
  // identical command it had already recorded. The run stopped for good and said
  // so nowhere a person could read it.
  it("stops driving a run whose last phase has closed", async () => {
    const scenario = await startScenario("finished-again", { fanOut: "complete" });
    await agentTurn(
      scenario,
      scenario.dispatchId,
      canonicalValue({ tasks: [{ id: "one" }, { id: "two" }] }),
    );
    await advance(scenario);
    await advance(scenario);
    for (let member = 0; member < 2; member += 1) {
      const dispatched = await advance(scenario);
      if (dispatched.kind !== "dispatched") throw new Error(`member ${member}: ${dispatched.kind}`);
      await agentTurn(scenario, dispatched.dispatchId, canonicalValue({ verified: true }));
    }
    expect(await advance(scenario)).toEqual({ kind: "finished" });

    const submitted = () => {
      const authority = new SqliteAuthority({ ...scenario.paths, dependencies });
      try {
        return authority.queryReceiptHistory(scenario.repositoryId, scenario.runId).length;
      } finally {
        authority.close();
      }
    };
    const settled = submitted();

    // Asked again, and again, it has to keep giving the same answer without
    // touching the authority. Re-running a phase it already closed rebuilds the
    // same commands against a graph the fan-out moved, and the authority refuses
    // each one for conflicting with the identical command it recorded first.
    expect(await advance(scenario)).toEqual({ kind: "finished" });
    expect(await advance(scenario)).toEqual({ kind: "finished" });
    expect(submitted()).toBe(settled);
  }, 120_000);

  // This is the message a person reads when a run has stopped advancing, and it
  // said "1 diagnostics". A count names neither what is wrong nor where.
  it("names what stops a workflow compiling, not how many things do", async () => {
    const scenario = await startScenario("broken-workflow", {});
    const workflow = join(scenario.project, ".senawa", "workflow.yaml");
    const authored = await readFile(workflow, "utf8");
    await writeFile(workflow, authored.replace("phases:", "phases:\n  - name: 9"), "utf8");

    await expect(advance(scenario)).rejects.toThrow(/workflow\.yaml.*[a-z]/u);
  }, 120_000);

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
    expect(await advance(scenario)).toMatchObject({ kind: "awaiting-agent", phaseKey: "define" });
  });

  it("tells the next attempt what the sensor said, not that a sensor failed", async () => {
    const scenario = await startScenario("refusal-detail", {
      // A sensor is argv, not a shell line, so the message it prints carries no
      // spaces of its own. The passing case is printed first, as a real test
      // run prints it, because the excerpt has to skip past what already works.
      sensorCommand:
        "node -e console.log('ok-1-board-accepts-a-move');console.error('FAIL-2-board-rejects-an-occupied-square');process.exit(3)",
      attempts: 2,
    });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));

    const outcome = await advance(scenario);
    expect(outcome).toMatchObject({ kind: "retrying", phaseKey: "define" });
    if (!("reasons" in outcome)) throw new Error("a retry carries reasons");
    // "measure did not pass" is true and useless: the attempt already knew it
    // failed. What it could not know is which assertion, and that is the only
    // thing that makes the next attempt different from the last.
    const reasons = outcome.reasons.join("\n");
    expect(reasons).toContain("FAIL-2-board-rejects-an-occupied-square");
    // And the excerpt starts at the failure. A run that passes plenty before it
    // fails once would otherwise spend the whole excerpt on what already works.
    expect(reasons).not.toContain("ok-1-board-accepts-a-move");
    // The rule states the comparison it made, so a person reading the run knows
    // what was expected without opening the gate definition.
    expect(reasons).toContain("/exitCode");
    expect(reasons).toContain("3");
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

    // A task the closed phase accepted is still accepted. The scheduler derives
    // its ready frontier over the whole graph, so reading only the open phase's
    // assessments made the finished task look unfinished and nothing that
    // depended on it could ever be scheduled: a live run held four dispatched
    // members that never started.
    const supervisor = new SqliteSupervisorAuthority({ ...scenario.paths, dependencies });
    try {
      const scheduling = supervisor.commandAuthority.queryRunScheduling(
        scenario.repositoryId,
        scenario.runId,
      );
      expect(scheduling?.acceptedTasks.length).toBeGreaterThan(0);
    } finally {
      supervisor.close();
    }
  });

  // Every other phase pair in this file is named in alphabetical order, so a
  // driver that read the order from the key-sorted registry looked correct
  // here and finished a real workflow after its first phase.
  it("follows the authored order when it disagrees with the alphabet", async () => {
    const scenario = await startScenario("advance-order", {
      secondPhase: true,
      secondPhaseName: "assemble",
    });
    await agentTurn(scenario, scenario.dispatchId, canonicalValue({ definition: "x" }));

    expect(await advance(scenario)).toEqual({ kind: "closed", phaseKey: "define" });
    expect(await advance(scenario)).toMatchObject({ kind: "dispatched", phaseKey: "assemble" });
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
        .prepare("SELECT canonical_effect AS json FROM context_dispatches")
        .all() as unknown as readonly { readonly json: string | null }[];
      command = rows.map((row) => row.json ?? "").join("\n");
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

  it("stays readable after a second question", async () => {
    const scenario = await startScenario("ask-twice", {});
    // The second identity sorts before the first, which is the case a table read
    // in key order and an authority read in the order things happened disagree on.
    await askThroughSink(scenario, scenario.dispatchId, "which endpoint is authoritative?", "b");
    await askThroughSink(scenario, scenario.dispatchId, "and which port does it listen on?", "a");

    // The integrity check read the table in key order and the authority in the
    // order things happened. One question cannot tell those apart; two can, and
    // the second made every process that opened the database fail to open it.
    const authority = new SqliteAuthority({ ...scenario.paths, dependencies });
    authority.close();

    const database = new DatabaseSync(scenario.paths.databasePath, { readOnly: true });
    try {
      const row = database.prepare("SELECT COUNT(*) AS total FROM context_questions").get() as {
        readonly total: number;
      };
      expect(row.total).toBe(2);
    } finally {
      database.close();
    }
  });

  it("takes the answer from the command line and binds it to the question asked", async () => {
    const scenario = await startScenario("answer", {});
    await askThroughSink(scenario, scenario.dispatchId, "which endpoint is authoritative?");

    // The command sent the submission id and nothing else, so the authority
    // refused every answer for wanting the digests that bind one to the exact
    // question. Only the live test exercised this path, and it is skipped
    // without credentials, so `senawa answer` had never once worked.
    const answered = answerQuestion({
      ...scenario.paths,
      answer: "the one already deployed",
      currentTime: NOW,
      dependencies,
      principal: runtimePrincipal,
      repositoryId: scenario.repositoryId,
      runId: scenario.runId,
    });
    expect(answered).toMatchObject({ exitCode: 0 });

    const database = new DatabaseSync(scenario.paths.databasePath, { readOnly: true });
    try {
      const row = database
        .prepare("SELECT canonical_answer AS json FROM context_question_answers")
        .get() as { readonly json: string } | undefined;
      expect(row?.json).toContain("the one already deployed");
    } finally {
      database.close();
    }
  });

  it("refuses an answer longer than the agent can be told", async () => {
    const scenario = await startScenario("answer-bound", {});
    await askThroughSink(scenario, scenario.dispatchId, "which endpoint is authoritative?");

    // The portal had no length bound, so a long answer was accepted, recorded
    // immutably, and then could never be delivered: the worker context refuses
    // to carry it. That stranded the run with a decision nobody could act on and
    // no way to replace it, because an answer cannot be changed once sent.
    const refused = answerQuestion({
      ...scenario.paths,
      answer: "x".repeat(9_000),
      currentTime: NOW,
      dependencies,
      principal: runtimePrincipal,
      repositoryId: scenario.repositoryId,
      runId: scenario.runId,
    });
    expect(refused.exitCode).not.toBe(0);

    const database = new DatabaseSync(scenario.paths.databasePath, { readOnly: true });
    try {
      const row = database
        .prepare("SELECT COUNT(*) AS total FROM context_question_answers")
        .get() as { readonly total: number };
      expect(row.total).toBe(0);
    } finally {
      database.close();
    }
  });

  it("carries the answer to the agent that asked, on a dispatch of its own", async () => {
    const scenario = await startScenario("answer-delivery", {});
    await askThroughSink(scenario, scenario.dispatchId, "which endpoint is authoritative?");

    // Answering wrote the answer down and nothing else. The agent cannot read
    // the database, the question left a fresh-dispatch requirement that stops
    // the scheduler, and no code satisfied it, so a run that asked anything was
    // stopped for good however many times a person answered.
    expect(
      answerQuestion({
        ...scenario.paths,
        answer: "the one already deployed",
        currentTime: NOW,
        dependencies,
        principal: runtimePrincipal,
        repositoryId: scenario.repositoryId,
        runId: scenario.runId,
      }),
    ).toMatchObject({ exitCode: 0 });

    const outcome = await advance(scenario);
    expect(outcome).toMatchObject({ kind: "dispatched", phaseKey: "define" });
    if (outcome.kind !== "dispatched") throw new Error("expected a fresh dispatch");
    expect(outcome.dispatchId).not.toBe(scenario.dispatchId);

    // The answer has to be in what the agent reads, in the words it was given.
    expect(await promptPackText(scenario, outcome.dispatchId)).toContain(
      "the one already deployed",
    );

    const database = new DatabaseSync(scenario.paths.databasePath, { readOnly: true });
    try {
      const row = database
        .prepare("SELECT satisfied_by_dispatch_id AS id FROM context_fresh_dispatch_requirements")
        .get() as { readonly id: string | null } | undefined;
      expect(row?.id).toBe(outcome.dispatchId);
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

describe("naming the pieces of work a phase runs", () => {
  it("lowers authored items to one task each", async () => {
    const snapshot = (await compileSnapshot({ items: true })) as {
      readonly phaseDataflow: readonly { readonly key: string; readonly value: unknown }[];
    };
    const phase = snapshot.phaseDataflow.find((entry) => entry.key === "define")?.value as {
      readonly executor: {
        readonly kind: string;
        readonly work: readonly { readonly key: string }[];
      };
    };

    // Two writers in one phase was expressible in the compiled document and not
    // in the authored one, so every acceptance that needed it wrote the compiled
    // document by hand.
    expect(phase.executor.kind).toBe("task-set");
    expect(phase.executor.work.map(({ key }) => key)).toEqual(["alpha", "beta"]);
  });

  it("refuses a phase that both names its work and computes it", async () => {
    const diagnostics = await compileScenario({ itemsAndForEach: true, fanOut: "complete" });
    expect(diagnostics.map(({ message }) => message).join(" ")).toContain("not both");
  });
});

/** How many answers a dispatch's context carries, read from the durable record. */
function answeredQuestionsCarried(databasePath: string, dispatchId: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT b.canonical_context AS context
         FROM context_dispatches d
         JOIN context_bases b ON b.context_id = d.context_id
         WHERE d.dispatch_id = ?`,
      )
      .get(dispatchId) as { readonly context: string } | undefined;
    if (row === undefined) throw new Error(`No context for dispatch ${dispatchId}`);
    const context = JSON.parse(row.context) as {
      readonly answeredQuestions?: readonly unknown[];
    };
    return context.answeredQuestions?.length ?? 0;
  } finally {
    database.close();
  }
}
