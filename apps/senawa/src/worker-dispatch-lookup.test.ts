import { SqliteContextBroker } from "@senawa/storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { disposeScenarios, startScenario } from "./brief-scenarios.js";
import { runtimeDependencies } from "./daemon.js";
import { BrokerWorkerDispatchLookup } from "./worker-dispatch-lookup.js";

afterEach(disposeScenarios);

describe("finding a dispatch the serving process never registered", () => {
  it("reads back what the dispatching process wrote", async () => {
    const scenario = await startScenario("lookup");
    const broker = new SqliteContextBroker({
      databasePath: scenario.paths.databasePath,
      dependencies: {
        currentTime: () => 0,
        issueGrantToken: () => new Uint8Array(32),
        sha256: runtimeDependencies.sha256,
      },
    });
    try {
      const dispatches = broker.listWorkerDispatches(scenario.repositoryId, scenario.runId);
      const dispatchId = dispatches[0]?.dispatch.dispatchId;
      if (dispatchId === undefined) throw new Error("the scenario dispatched nothing");

      const lookup = new BrokerWorkerDispatchLookup({
        broker,
        repositoryId: scenario.repositoryId,
        runId: scenario.runId,
      });

      // Nothing registered this dispatch in this process, which is exactly the
      // daemon's situation when an agent calls the worker channel.
      const found = lookup.find(dispatchId);
      expect(found).toBeDefined();
      expect(JSON.stringify(found?.context)).toContain("worker-context");
      expect(JSON.stringify(found?.outputSchema)).toContain("schemaKey");

      expect(lookup.find("dispatch_absent")).toBeUndefined();
    } finally {
      broker.close();
    }
  }, 60_000);
});
