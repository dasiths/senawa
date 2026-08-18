import { canonicalValue } from "@senawa/kernel";
import type { JsonValue } from "@senawa/protocol";
import type { SqliteContextBroker } from "@senawa/storage-sqlite";
import type { WorkerCredentialScope } from "@senawa/supervisor";
import type { WorkerDispatchLookup, WorkerDispatchRecord } from "./worker-service.js";

/**
 * Finds a dispatch's readable state in durable storage.
 *
 * The daemon serving the agent channel never ran the dispatch, so it cannot
 * have registered it. Everything an agent may read was already written by the
 * dispatching process, so reading it back is enough.
 */
export class BrokerWorkerDispatchLookup implements WorkerDispatchLookup {
  readonly #broker: SqliteContextBroker;

  constructor(options: { readonly broker: SqliteContextBroker }) {
    this.#broker = options.broker;
  }

  find(scope: WorkerCredentialScope): WorkerDispatchRecord | undefined {
    // The credential names the run, so one lookup serves every run the daemon
    // holds rather than being pinned to whichever run built it.
    const stored = this.#broker
      .listWorkerDispatches(scope.repositoryId, scope.runId)
      .find((entry) => entry.dispatch.dispatchId === scope.dispatchId);
    if (stored === undefined) return undefined;
    const declaration = stored.context.phaseOutputDeclarations[0];
    if (declaration === undefined) return undefined;
    return {
      context: canonicalValue(stored.context as unknown as JsonValue),
      outputSchema: canonicalValue(declaration as unknown as JsonValue),
    };
  }
}
