import {
  canonicalBytes,
  decodeAuthenticatedPrincipal,
  decodeCommandEnvelope,
  PROTOCOL_VERSION,
  type SupervisorAllocationFact,
} from "@senawa/protocol";
import type {
  CompletionFact,
  CompletionFactAdmission,
  CompletionFactPort,
  ContextBrokerClient,
} from "@senawa/runtime";
import type { SqliteSupervisorAuthority } from "./command-queue.js";

export interface CompletionFactCommandBridgeOptions {
  readonly authority: SqliteSupervisorAuthority;
  readonly broker: () => ContextBrokerClient;
  readonly completionEligibility?: {
    completionAdmission(submissionId: string, fact?: CompletionFact): CompletionFactAdmission;
  };
  currentTime(): string;
  readonly afterAccept?: (fact: CompletionFact) => void;
}

export class CompletionFactCommandBridge implements CompletionFactPort {
  readonly authority: SqliteSupervisorAuthority;
  readonly #broker: () => ContextBrokerClient;
  readonly #completionEligibility:
    | {
        completionAdmission(submissionId: string, fact?: CompletionFact): CompletionFactAdmission;
      }
    | undefined;
  readonly #currentTime: () => string;
  readonly #afterAccept: ((fact: CompletionFact) => void) | undefined;

  constructor(options: CompletionFactCommandBridgeOptions) {
    this.authority = options.authority;
    this.#broker = options.broker;
    this.#completionEligibility = options.completionEligibility;
    this.#currentTime = options.currentTime;
    this.#afterAccept = options.afterAccept;
  }

  admitCompletionFact(fact: CompletionFact): CompletionFactAdmission {
    if (this.#completionEligibility?.completionAdmission(fact.submissionId, fact) === "deferred") {
      return "deferred";
    }
    const stored = this.#broker().loadWorkerDispatch(fact.dispatchId);
    if (stored === undefined) throw new TypeError("Completion fact dispatch is not registered");
    if (
      stored.dispatch.repositoryId !== fact.repositoryId ||
      stored.dispatch.runId !== fact.runId
    ) {
      throw new TypeError("Completion fact run identity does not match its dispatch");
    }
    const payload = { submission: fact.assessment.submission } as const;
    const factDigest = this.authority.dependencies.sha256.digest(canonicalBytes(fact));
    const commandId = `command_worker-completion-${factDigest.slice(0, 32)}`;
    const envelope = decodeCommandEnvelope({
      apiVersion: PROTOCOL_VERSION,
      commandId,
      principal: enginePrincipal,
      transport: { kind: "runner", requestId: `request_${commandId}` },
      repositoryId: fact.repositoryId,
      runId: fact.runId,
      intent: { type: "submit-completion" },
      payload,
      payloadDigest: this.authority.dependencies.sha256.digest(canonicalBytes(payload)),
      expectedDefinitionRevision: fact.assessment.submission.task.contextRevisionDigest,
      expectedGraphRevision: stored.context.graphRevisionDigest,
    });
    this.authority.accept({
      envelope,
      createAdmission: () => ({
        currentTime: this.#currentTime(),
        facts: {
          source: "worker-completion-bridge",
          submissionId: fact.submissionId,
          dispatchId: fact.dispatchId,
          factDigest,
        },
        allocations: completionAllocations(commandId, factDigest),
      }),
    });
    this.#afterAccept?.(fact);
    return "accepted";
  }
}

const enginePrincipal = decodeAuthenticatedPrincipal({
  issuer: "senawa.local",
  subject: "completion-bridge",
  tenant: "local",
  assurance: "hardware-backed",
  roles: ["engine"],
});

function completionAllocations(
  commandId: string,
  factDigest: string,
): readonly SupervisorAllocationFact[] {
  return [1, 2, 3].map((ordinal) => ({
    kind: "stream-event" as const,
    id: `stream-event-${factDigest.slice(0, 24)}-${ordinal}-${commandId.length}`,
  }));
}
