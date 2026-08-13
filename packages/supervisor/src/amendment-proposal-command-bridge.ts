import {
  canonicalBytes,
  decodeAuthenticatedPrincipal,
  decodeCanonicalJsonValue,
  decodeCommandEnvelope,
  type JsonValue,
  PROTOCOL_VERSION,
  type SupervisorAllocationFact,
} from "@senawa/protocol";
import type {
  SqliteContextBroker,
  WorkerAmendmentOutboxClaim,
  WorkerAmendmentProposalSource,
} from "@senawa/storage-sqlite";
import type { SqliteSupervisorAuthority } from "./command-queue.js";

const DEFAULT_CLAIM_DURATION_MS = 30_000;

export interface AmendmentCompilerDiagnostic {
  readonly code: string;
  readonly locator: string;
  readonly pointer: string;
  readonly message: string;
}

export type AmendmentCompilerResult =
  | {
      readonly status: "compiled";
      readonly proposal: JsonValue;
      readonly resultConfigurationSnapshot: unknown;
    }
  | {
      readonly status: "diagnostics";
      readonly diagnostics: readonly AmendmentCompilerDiagnostic[];
    };

export interface AmendmentCompilerPort {
  compile(input: {
    readonly source: WorkerAmendmentProposalSource;
    readonly baseConfigurationSnapshot: unknown;
    readonly phaseCandidateHistory: readonly unknown[];
  }): AmendmentCompilerResult;
}

export interface AmendmentProposalCommandBridgeOptions {
  readonly authority: SqliteSupervisorAuthority;
  readonly broker: () => SqliteContextBroker;
  readonly compiler: AmendmentCompilerPort;
  readonly ownerId: string;
  currentTime(): string;
  readonly claimDurationMs?: number;
  readonly afterQueueAccept?: (claim: WorkerAmendmentOutboxClaim) => void;
  readonly afterTerminalBeforeAcknowledge?: (claim: WorkerAmendmentOutboxClaim) => void;
}

export class AmendmentProposalCommandBridge {
  readonly authority: SqliteSupervisorAuthority;
  readonly #broker: () => SqliteContextBroker;
  readonly #compiler: AmendmentCompilerPort;
  readonly #ownerId: string;
  readonly #currentTime: () => string;
  readonly #claimDurationMs: number;
  readonly #afterQueueAccept: ((claim: WorkerAmendmentOutboxClaim) => void) | undefined;
  readonly #afterTerminalBeforeAcknowledge:
    | ((claim: WorkerAmendmentOutboxClaim) => void)
    | undefined;

  constructor(options: AmendmentProposalCommandBridgeOptions) {
    this.authority = options.authority;
    this.#broker = options.broker;
    this.#compiler = options.compiler;
    this.#ownerId = options.ownerId;
    this.#currentTime = options.currentTime;
    this.#claimDurationMs = options.claimDurationMs ?? DEFAULT_CLAIM_DURATION_MS;
    if (!Number.isSafeInteger(this.#claimDurationMs) || this.#claimDurationMs < 1) {
      throw new TypeError("Amendment bridge claim duration must be a positive safe integer");
    }
    this.#afterQueueAccept = options.afterQueueAccept;
    this.#afterTerminalBeforeAcknowledge = options.afterTerminalBeforeAcknowledge;
  }

  deliverOnce(): boolean {
    const claimedAt = this.#currentTime();
    const claim = this.#broker().claimAmendmentProposalOutbox(
      this.#ownerId,
      claimedAt,
      addMilliseconds(claimedAt, this.#claimDurationMs),
    );
    if (claim === undefined) return false;
    const source = this.#broker().readClaimedAmendmentProposal(claim, this.#currentTime());
    const binding = sourceBinding(source);
    const baseConfigurationSnapshot = this.authority.commandAuthority.getConfigurationSnapshot(
      binding.configurationSnapshotDigest,
    );
    if (baseConfigurationSnapshot === undefined) {
      throw new TypeError("Worker amendment base configuration snapshot is not registered");
    }
    const compilation = this.#compiler.compile({
      source,
      baseConfigurationSnapshot,
      phaseCandidateHistory: this.authority.commandAuthority.queryPhaseCandidateHistory(
        binding.repositoryId,
        binding.runId,
      ),
    });
    if (compilation.status === "diagnostics") {
      this.authority.appendLog({
        recordedAt: this.#currentTime(),
        level: "warn",
        event: "amendment.compilation-refused",
        message: "Worker amendment source produced compiler diagnostics",
        fields: {
          submissionId: claim.submissionId,
          sourceDigest: claim.sourceDigest,
          diagnostics: compilation.diagnostics.map(sanitizeDiagnostic),
        },
      });
      this.#broker().completeAmendmentProposalOutbox(claim, this.#currentTime(), {
        kind: "diagnostics",
        submissionId: claim.submissionId,
        sourceDigest: claim.sourceDigest,
        diagnostics: compilation.diagnostics.map(sanitizeDiagnostic),
      });
      return true;
    }

    const proposal = proposalBinding(compilation.proposal);
    if (proposal.baseContextDigest !== binding.baseContextDigest) {
      throw new TypeError("Compiled amendment does not bind the exact worker context");
    }
    this.authority.commandAuthority.putConfigurationSnapshot(
      compilation.resultConfigurationSnapshot,
    );
    const payload = { proposal: compilation.proposal } as const;
    const commandId = `command_worker-amendment-${proposal.proposalDigest.slice(0, 32)}`;
    const envelope = decodeCommandEnvelope({
      apiVersion: PROTOCOL_VERSION,
      commandId,
      principal: enginePrincipal,
      transport: { kind: "runner", requestId: `request_${commandId}` },
      repositoryId: binding.repositoryId,
      runId: binding.runId,
      intent: { type: "submit-amendment-proposal" },
      payload,
      payloadDigest: this.authority.dependencies.sha256.digest(canonicalBytes(payload)),
      expectedGraphRevision: proposal.baseGraphRevisionDigest,
      exactObjectDigest: proposal.proposalDigest,
    });
    const receipt = this.authority.accept({
      envelope,
      createAdmission: () => ({
        currentTime: this.#currentTime(),
        facts: {
          source: "worker-amendment-bridge",
          submissionId: claim.submissionId,
          sourceDigest: claim.sourceDigest,
        },
        allocations: amendmentAllocations(commandId, proposal.proposalDigest),
      }),
    });
    this.#afterQueueAccept?.(claim);
    if (receipt.status !== "terminal") return true;
    this.#afterTerminalBeforeAcknowledge?.(claim);
    this.#broker().completeAmendmentProposalOutbox(claim, this.#currentTime(), {
      kind: "compiled",
      submissionId: claim.submissionId,
      sourceDigest: claim.sourceDigest,
      amendmentId: requiredText(
        localObject(compilation.proposal, "Compiled amendment proposal").amendmentId,
        "amendmentId",
      ),
      commandId,
      terminalReceipt: receipt.terminalReceipt,
    });
    return true;
  }
}

const enginePrincipal = decodeAuthenticatedPrincipal({
  issuer: "senawa.local",
  subject: "amendment-bridge",
  tenant: "local",
  assurance: "hardware-backed",
  roles: ["engine"],
});

function amendmentAllocations(
  commandId: string,
  proposalDigest: string,
): readonly SupervisorAllocationFact[] {
  return [1, 2, 3].map((ordinal) => ({
    kind: "stream-event" as const,
    id: `stream-event-amendment-${proposalDigest.slice(0, 20)}-${ordinal}-${commandId.length}`,
  }));
}

function sourceBinding(source: WorkerAmendmentProposalSource): {
  readonly repositoryId: string;
  readonly runId: string;
  readonly baseContextDigest: string;
  readonly configurationSnapshotDigest: string;
} {
  const submission = localObject(source.submission, "Worker amendment submission");
  const amendment = localObject(submission.amendment, "Worker amendment payload");
  const context = localObject(source.context, "Worker amendment context");
  const repositoryId = requiredText(submission.repositoryId, "submission repositoryId");
  const runId = requiredText(submission.runId, "submission runId");
  const baseContextDigest = requiredDigest(amendment.baseContextDigest, "baseContextDigest");
  if (
    requiredDigest(context.contextDigest, "contextDigest") !== baseContextDigest ||
    requiredDigest(context.graphRevisionDigest, "graphRevisionDigest") !==
      requiredDigest(amendment.baseGraphRevisionDigest, "baseGraphRevisionDigest")
  ) {
    throw new TypeError("Worker amendment source does not bind its exact historical context");
  }
  return {
    repositoryId,
    runId,
    baseContextDigest,
    configurationSnapshotDigest: requiredDigest(
      context.configurationSnapshotDigest,
      "configurationSnapshotDigest",
    ),
  };
}

function proposalBinding(value: JsonValue): {
  readonly proposalDigest: string;
  readonly baseContextDigest: string;
  readonly baseGraphRevisionDigest: string;
} {
  const proposal = localObject(value, "Compiled amendment proposal");
  const baseGraph = localObject(proposal.baseGraph, "Compiled amendment base graph");
  return {
    proposalDigest: requiredDigest(proposal.proposalDigest, "proposalDigest"),
    baseContextDigest: requiredDigest(proposal.baseContextDigest, "baseContextDigest"),
    baseGraphRevisionDigest: requiredDigest(baseGraph.revisionDigest, "base graph revision"),
  };
}

function sanitizeDiagnostic(diagnostic: AmendmentCompilerDiagnostic): JsonValue {
  return decodeCanonicalJsonValue({
    code: boundedText(diagnostic.code, 128),
    locator: boundedText(diagnostic.locator, 512),
    pointer: boundedText(diagnostic.pointer, 512),
    message: boundedText(diagnostic.message, 2_048),
  });
}

function boundedText(value: string, maximum: number): string {
  if (typeof value !== "string") return "invalid diagnostic value";
  let sanitized = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f) sanitized += character;
    if (sanitized.length >= maximum) break;
  }
  return sanitized.length === 0 ? "unspecified" : sanitized;
}

function localObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  const canonical = decodeCanonicalJsonValue(value);
  if (canonical === null || typeof canonical !== "object" || Array.isArray(canonical)) {
    throw new TypeError(`${label} must be an object`);
  }
  return canonical as Readonly<Record<string, unknown>>;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} is invalid`);
  return value;
}

function requiredDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  const epoch = Date.parse(timestamp);
  if (!Number.isFinite(epoch)) throw new TypeError("Amendment bridge time must be a timestamp");
  return new Date(epoch + milliseconds).toISOString();
}
