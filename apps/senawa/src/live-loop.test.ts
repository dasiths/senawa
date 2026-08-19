import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotSerialWorkerAdapter, ProductionCopilotSdkPort } from "@senawa/execution-host";
import { canonicalValue, sha256Digest } from "@senawa/kernel";
import { SqliteAuthority, SqliteContextBroker } from "@senawa/storage-sqlite";
import { runtimePrincipal } from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type AdvanceOutcome, advanceRun } from "./advance-run.js";
import { BASE, dependencies, disposeScenarios, NOW, startScenario } from "./brief-scenarios.js";
import { configurationPhaseOutputSchemas } from "./dataflow-composition.js";

// Opt in, because this spends model credits. Everything about the loop is also
// proven without a model by the scripted scenarios. What this adds is that a
// real agent finds the handshake from the generated contract alone, with no
// senawa protocol text in the authored prompt.
const live = process.env.SENAWA_COPILOT_LIVE === "1";
const timeoutMs = live ? Number(process.env.SENAWA_COPILOT_TIMEOUT_MS ?? 120_000) : 1;

afterEach(disposeScenarios);

describe.skipIf(!live)("a real agent drives an authored phase", () => {
  it(
    "uses a protocol it was never told, from the contract alone",
    async () => {
      if (process.env.SENAWA_COPILOT_ACKNOWLEDGE_COST_AND_DATA !== "1") {
        throw new Error("Live Copilot probe requires explicit cost and data acknowledgement");
      }
      const isolated = await mkdtemp(join(tmpdir(), "senawa-live-loop-"));
      const workingDirectory = await mkdtemp(join(isolated, "work-"));
      const baseDirectory = await mkdtemp(join(isolated, "home-"));
      const scenario = await startScenario("live", {
        model: process.env.SENAWA_COPILOT_MODEL ?? "claude-haiku-4.5",
      });
      const broker = new SqliteContextBroker({
        databasePath: scenario.paths.databasePath,
        dependencies: {
          sha256: dependencies.sha256,
          currentTime: () => NOW,
          issueGrantToken: () => new Uint8Array(32),
        },
      });
      const authority = new SqliteAuthority({ ...scenario.paths, dependencies });
      let port: ProductionCopilotSdkPort | undefined;
      try {
        const stored = broker
          .listWorkerDispatches(scenario.repositoryId, scenario.runId)
          .find((entry) => entry.dispatch.dispatchId === scenario.dispatchId);
        if (stored === undefined) throw new Error("the scenario did not dispatch");

        port = await ProductionCopilotSdkPort.create({
          repositoryDirectory: workingDirectory,
          workingDirectory,
          baseDirectory,
          // The agent works in the throwaway checkout it was given, which is
          // both its repository and its working directory here.
          allowRepositoryWorkingDirectory: true,
        });
        const result = await new CopilotSerialWorkerAdapter(port, dependencies.sha256).run({
          broker,
          context: stored.context,
          dispatch: stored.dispatch,
          // Without these the agent is never offered the output the phase
          // declares, so it completes and the phase can never close.
          phaseOutputSchemas: configurationPhaseOutputSchemas(
            (digest) => authority.getConfigurationSnapshot(digest),
            dependencies.sha256,
          ).resolve(stored),
          grantTokens: new Map(),
          routeSelection: scenario.routeSelection,
          workingDirectory,
          sessionBaseDirectory: baseDirectory,
          timeoutMs,
        });

        // The claim is that a real agent finds the protocol from the generated
        // contract alone, with no senawa text in the authored prompt. Everything
        // it sent has to be well formed and accepted.
        expect(result.submissions).not.toEqual([]);
        expect(result.submissions.map(({ status }) => status)).toEqual(
          result.submissions.map(() => "accepted"),
        );

        // Whether it finishes or stops to ask is the model's call on an
        // assignment that is deliberately thin. Asserting it never asks would
        // make this test a coin toss; `live-run.test.ts` proves the finish on an
        // assignment that can actually be finished.
        expect(["completed", "missing-completion"]).toContain(result.status);
      } finally {
        if (port?.clientOwnership === "port-created") {
          try {
            await port.stopOwnedClient();
          } catch {}
        }
        broker.close();
        authority.close();
      }

      let outcome: AdvanceOutcome = { kind: "awaiting-agent", phaseKey: scenario.phaseKey };
      for (let step = 0; step < 8 && outcome.kind !== "finished"; step += 1) {
        outcome = await advance(scenario);
      }
      expect(outcome.kind).toBe("finished");
    },
    timeoutMs * 3,
  );
});

function advance(scenario: Awaited<ReturnType<typeof startScenario>>): Promise<AdvanceOutcome> {
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
