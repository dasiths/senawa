import { canonicalValue } from "@senawa/kernel";
import type { JsonValue } from "@senawa/protocol";
import type { SqliteContextBroker } from "@senawa/storage-sqlite";
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
  readonly #repositoryId: string;
  readonly #runId: string;

  constructor(options: {
    readonly broker: SqliteContextBroker;
    readonly repositoryId: string;
    readonly runId: string;
  }) {
    this.#broker = options.broker;
    this.#repositoryId = options.repositoryId;
    this.#runId = options.runId;
  }

  find(dispatchId: string): WorkerDispatchRecord | undefined {
    const stored = this.#broker
      .listWorkerDispatches(this.#repositoryId, this.#runId)
      .find((entry) => entry.dispatch.dispatchId === dispatchId);
    if (stored === undefined) return undefined;
    const declaration = stored.context.phaseOutputDeclarations[0];
    if (declaration === undefined) return undefined;
    return {
      context: canonicalValue(stored.context as unknown as JsonValue),
      outputSchema: canonicalValue(declaration as unknown as JsonValue),
    };
  }
}
