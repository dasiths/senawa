import {
  createPrivateKey,
  createPublicKey,
  type KeyLike,
  KeyObject,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";
import {
  type AuthenticatedPrincipal,
  canonicalBytes,
  canonicalStringify,
  decodeRemoteCommandEnvelope,
  decodeRemoteHelloResponse,
  decodeRemoteReportAcknowledgement,
  decodeRemoteRepositoryBinding,
  type EventStreamFrame,
  type JsonValue,
  PROTOCOL_LIMITS,
  type ProjectionEnvelope,
  REMOTE_CAPABILITIES,
  REMOTE_CLASSIFIED_REPORT_SIGNATURE_DOMAIN,
  REMOTE_COMMAND_ENVELOPE_SIGNATURE_DOMAIN,
  REMOTE_NEGOTIATION_VERSION,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_RECEIPT_ENTRY_DIGEST_DOMAIN,
  REMOTE_REPORT_ACKNOWLEDGEMENT_SIGNATURE_DOMAIN,
  type RemoteClassifiedReport,
  type RemoteCommandDelivery,
  type RemoteCommandEnvelope,
  type RemoteEventMetadata,
  type RemoteHelloOffer,
  type RemoteHelloResponse,
  type RemoteHelloSelection,
  type RemoteProjectionCounts,
  type RemoteReceiptChain,
  type RemoteReceiptChainEntry,
  type RemoteReportAcknowledgement,
  type RemoteRepositoryBinding,
  type SupervisorReceipt,
  validateOpaqueIdentity,
} from "@senawa/protocol";
import type {
  RemoteDeliveryPendingCounts,
  RemoteInboxRecord,
  RemoteRunEventAdvance,
  RemoteRunEventCheckpoint,
  SqliteRemoteAuthority,
} from "@senawa/storage-sqlite";
import type {
  AuthenticatedIngressContext,
  SupervisorAdmissionAllocator,
  SupervisorApi,
} from "./api.js";
import type {
  RemoteConnectorLifecycle,
  RemoteConnectorStatus,
  RemoteConnectorSyncLag,
  SupervisorClock,
} from "./contracts.js";

export {
  REMOTE_CLASSIFIED_REPORT_SIGNATURE_DOMAIN,
  REMOTE_COMMAND_ENVELOPE_SIGNATURE_DOMAIN,
  REMOTE_REPORT_ACKNOWLEDGEMENT_SIGNATURE_DOMAIN,
} from "@senawa/protocol";

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_NETWORK_DEADLINE_MS = 10_000;
const DEFAULT_REPORT_CLAIM_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export interface RemoteRoleMapping {
  readonly issuer: string;
  readonly tenant: string;
  readonly upstreamRole: string;
  readonly localRoles: readonly string[];
}

export interface RemoteConnectorPolicy {
  readonly policyDigest: string;
  readonly roleMappings: readonly RemoteRoleMapping[];
  readonly maximumRemoteAuthorizationLeaseSeconds: number;
  readonly synchronization: {
    readonly classificationCeiling: "public" | "internal";
    readonly receiptChain: boolean;
    readonly events: boolean;
    readonly projections: boolean;
    readonly synchronizationState: boolean;
  };
}

export interface RemoteTransportCallContext {
  readonly signal: AbortSignal;
  readonly deadlineAt: string;
}

export interface RemoteCommandBatch {
  readonly revocationEpoch: number;
  readonly deliveries: readonly RemoteCommandDelivery[];
}

export interface RemoteSignedClassifiedReport {
  readonly sessionId: string;
  readonly canonicalReport: string;
  readonly report: RemoteClassifiedReport;
  readonly signingKeyId: string;
  readonly signature: string;
}

export interface RemoteConnectorTransport {
  negotiate(
    input: Readonly<{
      repositoryKeyId: string;
      connectorId: string;
      offer: RemoteHelloOffer;
    }> &
      RemoteTransportCallContext,
  ): Promise<string | RemoteHelloResponse>;
  receiveCommands(
    input: Readonly<{
      bindingId: string;
      sessionId: string;
      afterSequence: number;
      limit: number;
    }> &
      RemoteTransportCallContext,
  ): Promise<RemoteCommandBatch>;
  sendReport(
    input: RemoteSignedClassifiedReport & RemoteTransportCallContext,
  ): Promise<string | RemoteReportAcknowledgement>;
}

export interface RemoteSignatureVerifier {
  verify(keyId: string, bytes: Uint8Array, signature: string): Promise<boolean> | boolean;
}

export interface RemoteSignatureSigner {
  sign(keyId: string, bytes: Uint8Array): Promise<string> | string;
}

export interface RemoteConnectorIdAllocator {
  allocate(kind: "report"): string;
}

export interface RemoteConnectorTimer {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface RemoteConnectorOptions {
  readonly authority: SqliteRemoteAuthority;
  readonly supervisorApi: SupervisorApi;
  readonly binding: RemoteRepositoryBinding;
  readonly policy: RemoteConnectorPolicy;
  readonly transport: RemoteConnectorTransport;
  readonly verifier: RemoteSignatureVerifier;
  readonly signer: RemoteSignatureSigner;
  readonly clock: SupervisorClock;
  readonly ids: RemoteConnectorIdAllocator;
  readonly admissionAllocator: SupervisorAdmissionAllocator;
  readonly ownerId: string;
  readonly batchSize?: number;
  readonly networkDeadlineMs?: number;
  readonly reportClaimMs?: number;
  readonly pollIntervalMs?: number;
  readonly timer?: RemoteConnectorTimer;
}

export interface RemoteConnectorPumpResult {
  readonly receivedCommands: number;
  readonly admittedCommands: number;
  readonly duplicateCommands: number;
  readonly refusedCommands: number;
  readonly localResults: number;
  readonly enqueuedReports: number;
  readonly acknowledgedReports: number;
  readonly partitioned: boolean;
}

interface EventReportPage {
  readonly events: readonly RemoteEventMetadata[];
  readonly advance: RemoteRunEventAdvance;
}

interface BuiltRemoteReport {
  readonly report: RemoteClassifiedReport;
  readonly eventAdvance: RemoteRunEventAdvance | undefined;
}

export class RemoteConnectorRefusalError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RemoteConnectorRefusalError";
    this.code = code;
  }
}

export class NodeEd25519RemoteCrypto implements RemoteSignatureVerifier, RemoteSignatureSigner {
  readonly #publicKeys: ReadonlyMap<string, KeyLike>;
  readonly #privateKeys: ReadonlyMap<string, KeyLike | KeyObject>;

  constructor(options: {
    readonly publicKeys?: ReadonlyMap<string, KeyLike>;
    readonly privateKeys?: ReadonlyMap<string, KeyLike | KeyObject>;
  }) {
    for (const key of options.publicKeys?.values() ?? []) assertEd25519PublicKey(key);
    for (const key of options.privateKeys?.values() ?? []) assertEd25519PrivateKey(key);
    this.#publicKeys = options.publicKeys ?? new Map();
    this.#privateKeys = options.privateKeys ?? new Map();
  }

  verify(keyId: string, bytes: Uint8Array, signature: string): boolean {
    const key = this.#publicKeys.get(keyId);
    if (key === undefined) return false;
    try {
      const decoded = Buffer.from(signature, "base64url");
      if (decoded.toString("base64url") !== signature) return false;
      return nodeVerify(null, bytes, key, decoded);
    } catch {
      return false;
    }
  }

  sign(keyId: string, bytes: Uint8Array): string {
    const key = this.#privateKeys.get(keyId);
    if (key === undefined)
      throw new RemoteConnectorRefusalError("signing-key-missing", "Signing key is unavailable");
    return nodeSign(null, bytes, key).toString("base64url");
  }
}

function assertEd25519PublicKey(key: KeyLike): void {
  const publicKey = key instanceof KeyObject ? key : createPublicKey(key);
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("Remote verification keys must be Ed25519 public keys");
  }
}

function assertEd25519PrivateKey(key: KeyLike | KeyObject): void {
  const privateKey = key instanceof KeyObject ? key : createPrivateKey(key);
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("Remote signing keys must be Ed25519 private keys");
  }
}

export class RemoteConnector {
  readonly authority: SqliteRemoteAuthority;
  readonly supervisorApi: SupervisorApi;
  readonly binding: RemoteRepositoryBinding;
  readonly policy: RemoteConnectorPolicy;
  readonly #transport: RemoteConnectorTransport;
  readonly #verifier: RemoteSignatureVerifier;
  readonly #signer: RemoteSignatureSigner;
  readonly #clock: SupervisorClock;
  readonly #ids: RemoteConnectorIdAllocator;
  readonly #admissionAllocator: SupervisorAdmissionAllocator;
  readonly #ownerId: string;
  readonly #batchSize: number;
  readonly #networkDeadlineMs: number;
  readonly #reportClaimMs: number;
  readonly #pollIntervalMs: number;
  readonly #timer: RemoteConnectorTimer;
  readonly #lifecycleAbort = new AbortController();
  #lifecycle: RemoteConnectorLifecycle = "stopped";
  #loop: Promise<void> | undefined;
  #pump: Promise<RemoteConnectorPumpResult> | undefined;
  #partitioned = false;
  #lastAttemptAt: string | null = null;
  #lastSuccessfulContactAt: string | null = null;
  #lastErrorCode: string | null = null;
  #session: RemoteHelloSelection | undefined;

  constructor(options: RemoteConnectorOptions) {
    this.authority = options.authority;
    this.supervisorApi = options.supervisorApi;
    this.binding = decodeRemoteRepositoryBinding(options.binding);
    this.policy = validatePolicy(options.policy, this.binding);
    this.#transport = options.transport;
    this.#verifier = options.verifier;
    this.#signer = options.signer;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#admissionAllocator = options.admissionAllocator;
    this.#ownerId = validateOpaqueIdentity(options.ownerId);
    this.#batchSize = positiveBound(
      options.batchSize ?? DEFAULT_BATCH_SIZE,
      PROTOCOL_LIMITS.maxPageItems,
      "batchSize",
    );
    this.#networkDeadlineMs = positiveBound(
      options.networkDeadlineMs ?? DEFAULT_NETWORK_DEADLINE_MS,
      300_000,
      "networkDeadlineMs",
    );
    this.#reportClaimMs = positiveBound(
      options.reportClaimMs ?? DEFAULT_REPORT_CLAIM_MS,
      300_000,
      "reportClaimMs",
    );
    this.#pollIntervalMs = positiveBound(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      300_000,
      "pollIntervalMs",
    );
    this.#timer = options.timer ?? systemTimer;
    this.authority.registerPeer(this.binding, this.#now());
  }

  get lifecycle(): RemoteConnectorLifecycle {
    return this.#lifecycle;
  }

  start(): void {
    if (this.#lifecycle !== "stopped")
      throw new Error("Remote connector can only start once from stopped");
    this.#lifecycle = "running";
    this.#loop = this.#runLoop();
  }

  async establishContact(signal?: AbortSignal): Promise<boolean> {
    this.#lastAttemptAt = this.#now();
    try {
      await this.#ensureNegotiated(signal);
      this.#recordContact();
      return true;
    } catch (error) {
      if (isAbortError(error)) throw error;
      this.#recordFailure(refusalCode(error, "transport-unavailable"));
      return false;
    }
  }

  pumpOnce(signal?: AbortSignal): Promise<RemoteConnectorPumpResult> {
    if (
      this.#lifecycle === "closed" ||
      this.#lifecycle === "draining" ||
      this.#lifecycle === "drained"
    ) {
      return Promise.reject(new Error("Remote connector is not accepting pump operations"));
    }
    if (this.#pump !== undefined) return this.#pump;
    this.#pump = this.#pumpBounded(signal).finally(() => {
      this.#pump = undefined;
    });
    return this.#pump;
  }

  async drain(): Promise<void> {
    if (this.#lifecycle === "drained" || this.#lifecycle === "closed") return;
    this.#lifecycle = "draining";
    this.#lifecycleAbort.abort(new DOMException("Remote connector is draining", "AbortError"));
    await Promise.allSettled([this.#pump, this.#loop].filter(isPromise));
    this.#lifecycle = "drained";
  }

  async close(): Promise<void> {
    if (this.#lifecycle === "closed") return;
    await this.drain();
    this.#lifecycle = "closed";
  }

  status(): RemoteConnectorStatus {
    const checkpoint = this.authority.queryCheckpoint(this.binding.bindingId, "inbound-command");
    const synchronization = this.authority.querySynchronization(this.binding.bindingId);
    const pending = this.authority.queryPendingCounts(this.binding.bindingId);
    return Object.freeze({
      connectorId: this.binding.connectorId,
      bindingId: this.binding.bindingId,
      repositoryId: this.binding.repositoryId,
      lifecycle: this.#lifecycle,
      health: this.#partitioned || this.#lastErrorCode !== null ? "degraded" : "healthy",
      partitioned: this.#partitioned,
      lastAttemptAt: this.#lastAttemptAt,
      lastSuccessfulContactAt: this.#lastSuccessfulContactAt,
      lastErrorCode: this.#lastErrorCode,
      synchronization: syncLag(
        checkpoint.contiguousSequence,
        synchronization,
        pending,
        this.#now(),
        this.#partitioned,
      ),
    });
  }

  async #runLoop(): Promise<void> {
    while (this.#lifecycle === "running") {
      try {
        await this.pumpOnce(this.#lifecycleAbort.signal);
      } catch (error) {
        if (isAbortError(error) || this.#lifecycle !== "running") return;
        this.#recordFailure("connector-pump-failed");
      }
      try {
        await cancellableDelay(this.#pollIntervalMs, this.#lifecycleAbort.signal, this.#timer);
      } catch (error) {
        if (isAbortError(error)) return;
        throw error;
      }
    }
  }

  async #pumpBounded(signal?: AbortSignal): Promise<RemoteConnectorPumpResult> {
    const result: MutablePumpResult = emptyPumpResult();
    const now = this.#now();
    this.#lastAttemptAt = now;
    try {
      await this.#ensureNegotiated(signal);
      const checkpoint = this.authority.queryCheckpoint(this.binding.bindingId, "inbound-command");
      const batch = await this.#networkCall(signal, (context) =>
        this.#transport.receiveCommands({
          bindingId: this.binding.bindingId,
          sessionId: requiredSession(this.#session).sessionId,
          afterSequence: checkpoint.contiguousSequence,
          limit: this.#batchSize,
          ...context,
        }),
      );
      if (!Number.isSafeInteger(batch.revocationEpoch) || batch.revocationEpoch < 0) {
        throw new RemoteConnectorRefusalError(
          "revocation-invalid",
          "Remote revocation epoch is invalid",
        );
      }
      if (batch.deliveries.length > this.#batchSize) {
        throw new RemoteConnectorRefusalError(
          "batch-limit",
          "Remote command batch exceeds the negotiated limit",
        );
      }
      this.authority.advanceRevocationEpoch(
        this.binding.bindingId,
        batch.revocationEpoch,
        this.#now(),
      );
      this.#recordContact();
      for (const delivery of batch.deliveries) {
        result.receivedCommands += 1;
        try {
          const envelope = await this.#verifyEnvelope(delivery.envelope);
          this.#verifyDeliveryEntry(envelope, delivery.receiptEntry);
          if (envelope.acceptedCommand.binding.revocationEpoch < batch.revocationEpoch) {
            throw new RemoteConnectorRefusalError(
              "revoked",
              "Remote command binding has been revoked",
            );
          }
          const current = this.authority.queryCheckpoint(this.binding.bindingId, "inbound-command");
          if (
            envelope.sequence === current.contiguousSequence + 1 &&
            envelope.previousEnvelopeDigest !== current.lastDigest
          ) {
            throw new RemoteConnectorRefusalError(
              "chain-mismatch",
              "Remote envelope does not extend the verified sequence chain",
            );
          }
          if (envelope.sequence > current.contiguousSequence + 1) {
            throw new RemoteConnectorRefusalError(
              "sequence-gap",
              "Remote envelope predecessor is not locally verified",
            );
          }
          const admission = this.authority.admitCommandEnvelope(
            envelope,
            delivery.receiptEntry,
            this.#now(),
            this.#batchSize,
          );
          if (admission.type === "duplicate") result.duplicateCommands += 1;
        } catch (error) {
          result.refusedCommands += 1;
          this.#recordFailure(refusalCode(error, "remote-envelope-refused"), false);
        }
      }
      const ready = this.authority
        .listReadyCommands(this.binding.bindingId, this.#now())
        .slice(0, this.#batchSize);
      for (const record of ready) {
        try {
          this.#admitLocally(record);
          result.admittedCommands += 1;
        } catch (error) {
          result.refusedCommands += 1;
          this.#recordFailure(refusalCode(error, "local-admission-refused"), false);
        }
      }
      const awaitingResults = this.authority
        .listPendingLocalResults(this.binding.bindingId)
        .slice(0, this.#batchSize);
      for (const record of awaitingResults) {
        if (this.#recordLocalResultAndReport(record)) {
          result.localResults += 1;
          result.enqueuedReports += 1;
        }
      }
      for (let index = 0; index < this.#batchSize; index += 1) {
        const acknowledged = await this.#sendNextReport(signal);
        if (acknowledged) {
          result.acknowledgedReports += 1;
          continue;
        }
        if (!this.#enqueueSynchronizationContinuation()) break;
        result.enqueuedReports += 1;
      }
      result.partitioned = this.#partitioned;
      return Object.freeze(result);
    } catch (error) {
      if (isAbortError(error)) throw error;
      this.#recordFailure(refusalCode(error, "transport-unavailable"));
      result.partitioned = true;
      return Object.freeze(result);
    }
  }

  async #verifyEnvelope(input: string | RemoteCommandEnvelope): Promise<RemoteCommandEnvelope> {
    const envelope = decodeRemoteCommandEnvelope(input);
    const accepted = envelope.acceptedCommand;
    if (envelope.signingKeyId !== this.binding.controlPlaneKeyId) {
      throw new RemoteConnectorRefusalError("key-mismatch", "Remote envelope key is not pinned");
    }
    if (canonicalStringify(accepted.binding) !== canonicalStringify(this.binding)) {
      throw new RemoteConnectorRefusalError(
        "binding-mismatch",
        "Remote envelope binding does not match local enrollment",
      );
    }
    if (accepted.binding.policyDigest !== this.policy.policyDigest) {
      throw new RemoteConnectorRefusalError(
        "policy-mismatch",
        "Remote envelope policy digest is stale",
      );
    }
    const acceptedDigest = this.#digest(accepted);
    if (
      acceptedDigest !== envelope.acceptedCommandDigest ||
      this.#digest(accepted.command) !== accepted.commandDigest
    ) {
      throw new RemoteConnectorRefusalError(
        "digest-mismatch",
        "Remote envelope digest binding is invalid",
      );
    }
    const currentTime = this.#clock.now();
    if (Date.parse(accepted.expiresAt) <= currentTime) {
      throw new RemoteConnectorRefusalError("expired", "Remote command authorization has expired");
    }
    const leaseMs = Date.parse(accepted.expiresAt) - Date.parse(accepted.acceptedAt);
    if (leaseMs > this.policy.maximumRemoteAuthorizationLeaseSeconds * 1_000) {
      throw new RemoteConnectorRefusalError(
        "lease-exceeded",
        "Remote command authorization lease exceeds the local maximum",
      );
    }
    const verified = await this.#verifier.verify(
      envelope.signingKeyId,
      remoteCommandEnvelopeSignatureBytes(envelope),
      envelope.signature,
    );
    if (!verified)
      throw new RemoteConnectorRefusalError(
        "signature-invalid",
        "Remote envelope signature is invalid",
      );
    return envelope;
  }

  #verifyDeliveryEntry(envelope: RemoteCommandEnvelope, input: RemoteReceiptChainEntry): void {
    const central = centralAcceptanceEntry(envelope, this.#digest.bind(this));
    const expected = chainEntry(
      envelope,
      "connector-delivered",
      input.recordedAt,
      central.entryDigest,
      {
        type: "connector-delivery",
        envelopeSequence: envelope.sequence,
        envelopeDigest: this.#digest(envelope),
      },
      this.#digest.bind(this),
    );
    if (canonicalStringify(input) !== canonicalStringify(expected)) {
      throw new RemoteConnectorRefusalError(
        "delivery-receipt-mismatch",
        "Remote delivery receipt does not bind the delivered envelope",
      );
    }
  }

  #admitLocally(record: RemoteInboxRecord): void {
    const accepted = record.envelope.acceptedCommand;
    const principal = intersectRemotePrincipal(
      accepted.attribution.principal,
      this.policy.roleMappings,
    );
    const context: AuthenticatedIngressContext = {
      principal,
      transportKind: "remote",
      requestId: accepted.attribution.transport.requestId,
      admission: {
        currentTime: this.#now(),
        facts: {
          source: "remote",
          acceptanceId: accepted.acceptanceId,
          bindingId: this.binding.bindingId,
        },
        allocator: this.#admissionAllocator,
      },
    };
    this.supervisorApi.submitCommand(accepted.command, context);
    const history = this.supervisorApi.authority
      .queryHistory(accepted.command.repositoryId, accepted.command.runId)
      .filter((receipt) => receipt.commandId === accepted.command.commandId);
    const chain = receiptChain(record, history, this.#digest.bind(this));
    const entry = chain.entries[2];
    if (entry === undefined || entry.stage !== "local-accepted") {
      throw new TypeError("Remote local acceptance chain is incomplete");
    }
    this.authority.recordLocalAcceptance(this.binding.bindingId, record.sequence, entry);
  }

  #recordLocalResultAndReport(record: RemoteInboxRecord): boolean {
    const command = record.envelope.acceptedCommand.command;
    const history = this.supervisorApi.authority
      .queryHistory(command.repositoryId, command.runId)
      .filter((receipt) => receipt.commandId === command.commandId);
    const terminal = history.find((receipt) => receipt.status === "terminal");
    if (terminal?.terminalReceipt === undefined || record.localAcceptance === undefined)
      return false;
    const chain = receiptChain(record, history, this.#digest.bind(this));
    const outcome = chain.entries.at(-1);
    if (outcome === undefined || outcome.stage !== "local-outcome") return false;
    const built = this.#buildReport(record, chain);
    return this.authority.recordLocalResultAndEnqueueReport(
      this.binding.bindingId,
      record.sequence,
      outcome,
      built.report,
      built.eventAdvance,
    );
  }

  #buildReport(
    record: RemoteInboxRecord,
    chain: RemoteReceiptChain,
    eventPage = this.#readEventReportPage(record),
  ): BuiltRemoteReport {
    const command = record.envelope.acceptedCommand.command;
    const synchronization = this.authority.querySynchronization(this.binding.bindingId);
    const checkpoint = this.authority.queryCheckpoint(this.binding.bindingId, "outbound-report");
    const events = eventPage?.events ?? [];
    const projection = this.policy.synchronization.projections
      ? this.supervisorApi.queryAuthority.queryProjection(command.repositoryId, command.runId)
      : undefined;
    const projections = projection === undefined ? [] : [projectionMetadata(projection)];
    const createdAt = this.#now();
    const eventSynchronization =
      eventPage === undefined
        ? undefined
        : aggregateRunEventCheckpoints(
            this.authority.listRunEventCheckpoints(this.binding.bindingId),
            eventPage.advance,
          );
    const synchronizationVector = this.policy.synchronization.synchronizationState
      ? {
          ...synchronization,
          localLatestCursor:
            eventSynchronization?.localLatestCursor ?? synchronization.localLatestCursor,
          durablyEnqueuedCursor:
            eventSynchronization?.durablyEnqueuedCursor ?? synchronization.localLatestCursor,
          centrallyAcknowledgedCursor:
            eventSynchronization?.centrallyAcknowledgedCursor ??
            synchronization.centrallyAcknowledgedCursor,
          localObservedAt: createdAt,
          lastEnqueuedAt: createdAt,
        }
      : {
          repositoryId: this.binding.repositoryId,
          localLatestCursor: 0,
          durablyEnqueuedCursor: 0,
          centrallyAcknowledgedCursor: 0,
          localObservedAt: this.binding.issuedAt,
          lastEnqueuedAt: null,
          lastAcknowledgedAt: null,
        };
    return Object.freeze({
      report: {
        apiVersion: REMOTE_PROTOCOL_VERSION,
        reportId: validateOpaqueIdentity(this.#ids.allocate("report")),
        binding: this.binding,
        classification: this.policy.synchronization.classificationCeiling,
        dataPolicyDigest: this.policy.policyDigest,
        reportSequence: checkpoint.contiguousSequence + 1,
        previousReportDigest: checkpoint.lastDigest,
        createdAt,
        receiptChains: [chain],
        events,
        projections,
        synchronization: synchronizationVector,
      },
      eventAdvance: eventPage?.advance,
    });
  }

  #enqueueSynchronizationContinuation(): boolean {
    if (!this.policy.synchronization.synchronizationState || !this.policy.synchronization.events)
      return false;
    const pending = this.authority.queryPendingCounts(this.binding.bindingId);
    if (pending.pendingReports > 0 || pending.claimedReports > 0) return false;
    const recordsByRun = new Map<string, RemoteInboxRecord>();
    for (const record of this.authority.listCompletedLocalResults(this.binding.bindingId)) {
      const command = record.envelope.acceptedCommand.command;
      recordsByRun.set(`${command.repositoryId}\u0000${command.runId}`, record);
    }
    const candidates = [...recordsByRun.values()].sort((left, right) => {
      const leftCommand = left.envelope.acceptedCommand.command;
      const rightCommand = right.envelope.acceptedCommand.command;
      const leftCheckpoint = this.authority.queryRunEventCheckpoint(
        this.binding.bindingId,
        leftCommand.repositoryId,
        leftCommand.runId,
      );
      const rightCheckpoint = this.authority.queryRunEventCheckpoint(
        this.binding.bindingId,
        rightCommand.repositoryId,
        rightCommand.runId,
      );
      return (
        leftCheckpoint.lastEnqueuedReportSequence - rightCheckpoint.lastEnqueuedReportSequence ||
        leftCommand.runId.localeCompare(rightCommand.runId)
      );
    });
    for (const record of candidates) {
      const eventPage = this.#readEventReportPage(record);
      if (eventPage === undefined) continue;
      const command = record.envelope.acceptedCommand.command;
      const history = this.supervisorApi.authority
        .queryHistory(command.repositoryId, command.runId)
        .filter((receipt) => receipt.commandId === command.commandId);
      const built = this.#buildReport(
        record,
        receiptChain(record, history, this.#digest.bind(this)),
        eventPage,
      );
      return this.authority.enqueueReport(built.report, built.eventAdvance);
    }
    return false;
  }

  #readEventReportPage(record: RemoteInboxRecord): EventReportPage | undefined {
    if (!this.policy.synchronization.events) return undefined;
    const command = record.envelope.acceptedCommand.command;
    const checkpoint = this.authority.queryRunEventCheckpoint(
      this.binding.bindingId,
      command.repositoryId,
      command.runId,
    );
    const page = this.supervisorApi.queryAuthority.queryEventPage(
      command.repositoryId,
      command.runId,
      checkpoint.durablyEnqueuedCursor,
      this.#batchSize,
    );
    const throughCursor = page.hasMore ? requiredLastEventCursor(page.events) : page.latestCursor;
    if (throughCursor === checkpoint.durablyEnqueuedCursor) return undefined;
    return Object.freeze({
      events: Object.freeze(
        page.events.map((event) => ({
          cursor: event.cursor,
          repositoryId: event.repositoryId,
          runId: event.runId,
          eventId: event.eventId,
          eventType: event.eventType,
          occurredAt: event.occurredAt,
          payloadDigest: event.payloadDigest,
          ...(event.commandId === undefined ? {} : { commandId: event.commandId }),
        })),
      ),
      advance: Object.freeze({
        repositoryId: command.repositoryId,
        runId: command.runId,
        fromCursor: checkpoint.durablyEnqueuedCursor,
        throughCursor,
        localLatestCursor: page.latestCursor,
      }),
    });
  }

  async #sendNextReport(signal?: AbortSignal): Promise<boolean> {
    const now = this.#now();
    const expiresAt = new Date(this.#clock.now() + this.#reportClaimMs).toISOString();
    const claim = this.authority.claimReport(this.binding.bindingId, this.#ownerId, now, expiresAt);
    if (claim === undefined) return false;
    const claimed = this.authority.readClaimedReport(claim, now);
    const signature = await this.#signer.sign(
      this.binding.repositoryKeyId,
      remoteClassifiedReportSignatureBytes(claimed.report),
    );
    const acknowledgementInput = await this.#networkCall(signal, (context) =>
      this.#transport.sendReport({
        sessionId: requiredSession(this.#session).sessionId,
        canonicalReport: claimed.canonicalReport,
        report: claimed.report,
        signingKeyId: this.binding.repositoryKeyId,
        signature,
        ...context,
      }),
    );
    const acknowledgement = decodeRemoteReportAcknowledgement(acknowledgementInput);
    if (acknowledgement.signingKeyId !== this.binding.controlPlaneKeyId) {
      throw new RemoteConnectorRefusalError(
        "acknowledgement-key-mismatch",
        "Remote acknowledgement key is not pinned",
      );
    }
    if (
      !(await this.#verifier.verify(
        acknowledgement.signingKeyId,
        remoteReportAcknowledgementSignatureBytes(acknowledgement),
        acknowledgement.signature,
      ))
    ) {
      throw new RemoteConnectorRefusalError(
        "acknowledgement-signature-invalid",
        "Remote acknowledgement signature is invalid",
      );
    }
    this.authority.acknowledgeReport(claim, acknowledgement, this.#now());
    this.#recordContact();
    return true;
  }

  async #ensureNegotiated(signal?: AbortSignal): Promise<void> {
    if (this.#session !== undefined) return;
    const offer: RemoteHelloOffer = Object.freeze({
      negotiationVersion: REMOTE_NEGOTIATION_VERSION,
      peerId: this.binding.connectorId,
      supportedVersions: Object.freeze([REMOTE_PROTOCOL_VERSION]),
      capabilities: REMOTE_CAPABILITIES,
    });
    const response = decodeRemoteHelloResponse(
      await this.#networkCall(signal, (context) =>
        this.#transport.negotiate({
          repositoryKeyId: this.binding.repositoryKeyId,
          connectorId: this.binding.connectorId,
          offer,
          ...context,
        }),
      ),
    );
    if (response.type === "refusal") {
      throw new RemoteConnectorRefusalError(response.code, response.message);
    }
    this.authority.recordNegotiatedSession(
      this.binding.bindingId,
      response.sessionId,
      response.selectedVersion,
      response.capabilities,
      this.#now(),
    );
    this.#session = response;
  }

  async #networkCall<T>(
    signal: AbortSignal | undefined,
    operation: (context: RemoteTransportCallContext) => Promise<T>,
  ): Promise<T> {
    const deadlineAtMs = this.#clock.now() + this.#networkDeadlineMs;
    const controller = new AbortController();
    const signals = [signal, this.#lifecycleAbort.signal].filter(isAbortSignal);
    const abort = () =>
      controller.abort(new DOMException("Remote operation cancelled", "AbortError"));
    for (const source of signals) {
      if (source.aborted) abort();
      else source.addEventListener("abort", abort, { once: true });
    }
    let handle: unknown;
    let rejectCancellation: ((reason: unknown) => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const cancelled = () => rejectCancellation?.(controller.signal.reason);
    controller.signal.addEventListener("abort", cancelled, { once: true });
    const timeout = new Promise<never>((_resolve, reject) => {
      handle = this.#timer.set(
        () => {
          const error = new RemoteConnectorRefusalError(
            "deadline-exceeded",
            "Remote operation exceeded its deadline",
          );
          controller.abort(error);
          reject(error);
        },
        Math.max(0, deadlineAtMs - this.#clock.now()),
      );
    });
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      return await Promise.race([
        operation({ signal: controller.signal, deadlineAt: new Date(deadlineAtMs).toISOString() }),
        timeout,
        cancellation,
      ]);
    } finally {
      if (handle !== undefined) this.#timer.clear(handle);
      controller.signal.removeEventListener("abort", cancelled);
      for (const source of signals) source.removeEventListener("abort", abort);
    }
  }

  #digest(value: JsonValue | object | Uint8Array): string {
    return this.supervisorApi.authority.dependencies.sha256.digest(
      value instanceof Uint8Array ? value : canonicalBytes(value),
    );
  }

  #now(): string {
    return new Date(this.#clock.now()).toISOString();
  }

  #recordContact(): void {
    this.#partitioned = false;
    this.#lastSuccessfulContactAt = this.#now();
    this.#lastErrorCode = null;
  }

  #recordFailure(code: string, partitioned = true): void {
    this.#partitioned = partitioned;
    this.#lastErrorCode = code;
  }
}

export function remoteCommandEnvelopeSignatureBytes(envelope: RemoteCommandEnvelope): Uint8Array {
  const { signature: _signature, ...unsigned } = decodeRemoteCommandEnvelope(envelope);
  return domainSeparatedBytes(REMOTE_COMMAND_ENVELOPE_SIGNATURE_DOMAIN, unsigned);
}

export function remoteClassifiedReportSignatureBytes(report: RemoteClassifiedReport): Uint8Array {
  return domainSeparatedBytes(REMOTE_CLASSIFIED_REPORT_SIGNATURE_DOMAIN, report);
}

export function remoteReportAcknowledgementSignatureBytes(
  acknowledgement: RemoteReportAcknowledgement,
): Uint8Array {
  const { signature: _signature, ...unsigned } = decodeRemoteReportAcknowledgement(acknowledgement);
  return domainSeparatedBytes(REMOTE_REPORT_ACKNOWLEDGEMENT_SIGNATURE_DOMAIN, unsigned);
}

export function intersectRemotePrincipal(
  principal: AuthenticatedPrincipal,
  mappings: readonly RemoteRoleMapping[],
): AuthenticatedPrincipal {
  const localRoles = new Set<string>();
  for (const upstreamRole of principal.roles) {
    const mapping = mappings.find(
      (candidate) =>
        candidate.issuer === principal.issuer &&
        candidate.tenant === principal.tenant &&
        candidate.upstreamRole === upstreamRole,
    );
    if (mapping === undefined) {
      throw new RemoteConnectorRefusalError(
        "role-unmapped",
        "Remote principal contains an unmapped role",
      );
    }
    for (const localRole of mapping.localRoles) localRoles.add(localRole);
  }
  if (localRoles.size === 0) {
    throw new RemoteConnectorRefusalError(
      "role-unmapped",
      "Remote principal has no locally mapped role",
    );
  }
  return Object.freeze({ ...principal, roles: Object.freeze([...localRoles].sort()) });
}

function receiptChain(
  record: RemoteInboxRecord,
  history: readonly SupervisorReceipt[],
  digest: (value: JsonValue | object | Uint8Array) => string,
): RemoteReceiptChain {
  const envelope = record.envelope;
  const commandId = envelope.acceptedCommand.command.commandId;
  const entries: RemoteReceiptChainEntry[] = [];
  entries.push(centralAcceptanceEntry(envelope, digest));
  entries.push(record.deliveryEntry);
  const queued = history.find((receipt) => receipt.status === "queued");
  if (queued !== undefined) {
    entries.push(
      localReceiptEntry(envelope, queued, "local-accepted", digest, entries[1]?.entryDigest),
    );
  }
  const claimed = history.find((receipt) => receipt.status === "claimed");
  if (claimed !== undefined && entries.length === 3) {
    entries.push(
      localReceiptEntry(envelope, claimed, "runner-claimed", digest, entries[2]?.entryDigest),
    );
  }
  const terminal = history.find((receipt) => receipt.status === "terminal");
  if (terminal?.terminalReceipt !== undefined && entries.length === 4) {
    entries.push(
      localReceiptEntry(envelope, terminal, "local-outcome", digest, entries[3]?.entryDigest),
    );
  }
  return Object.freeze({
    bindingId: envelope.acceptedCommand.binding.bindingId,
    commandId,
    entries: Object.freeze(entries),
  });
}

function centralAcceptanceEntry(
  envelope: RemoteCommandEnvelope,
  digest: (value: JsonValue | object | Uint8Array) => string,
): RemoteReceiptChainEntry {
  return chainEntry(
    envelope,
    "central-accepted",
    envelope.acceptedCommand.acceptedAt,
    null,
    {
      type: "central-acceptance",
      acceptanceId: envelope.acceptedCommand.acceptanceId,
      acceptanceDigest: envelope.acceptedCommandDigest,
    },
    digest,
  );
}

function localReceiptEntry(
  envelope: RemoteCommandEnvelope,
  receipt: SupervisorReceipt,
  stage: "local-accepted" | "runner-claimed" | "local-outcome",
  digest: (value: JsonValue | object | Uint8Array) => string,
  previousEntryDigest = "0".repeat(64),
): RemoteReceiptChainEntry {
  const terminal = receipt.terminalReceipt;
  const evidence =
    stage === "local-outcome"
      ? {
          type: "local-outcome" as const,
          localCommandId: receipt.commandId,
          receiptStatus: terminalOutcomeStatus(requiredTerminalReceipt(terminal).status),
          receiptCursor: receipt.sequence,
          receiptDigest: digest(requiredTerminalReceipt(terminal)),
        }
      : {
          type: "local-receipt" as const,
          localCommandId: receipt.commandId,
          receiptStatus: stage === "local-accepted" ? ("queued" as const) : ("claimed" as const),
          receiptCursor: receipt.sequence,
          receiptDigest: digest(receipt),
        };
  return chainEntry(envelope, stage, receipt.recordedAt, previousEntryDigest, evidence, digest);
}

function chainEntry(
  envelope: RemoteCommandEnvelope,
  stage: RemoteReceiptChainEntry["stage"],
  recordedAt: string,
  previousEntryDigest: string | null,
  evidence: RemoteReceiptChainEntry["evidence"],
  digest: (value: JsonValue | object | Uint8Array) => string,
): RemoteReceiptChainEntry {
  const stageSequence =
    [
      "central-accepted",
      "connector-delivered",
      "local-accepted",
      "runner-claimed",
      "local-outcome",
    ].indexOf(stage) + 1;
  const content = {
    apiVersion: REMOTE_PROTOCOL_VERSION,
    bindingId: envelope.acceptedCommand.binding.bindingId,
    commandId: envelope.acceptedCommand.command.commandId,
    stage,
    stageSequence,
    recordedAt,
    previousEntryDigest,
    evidence,
  } as const;
  return Object.freeze({
    ...content,
    entryDigest: digest(domainSeparatedBytes(REMOTE_RECEIPT_ENTRY_DIGEST_DOMAIN, content)),
  });
}

function projectionMetadata(projection: ProjectionEnvelope) {
  const payload = jsonObject(projection.payload);
  const accounting = jsonObject(payload?.taskAccounting);
  const humanNeeds = Array.isArray(payload?.humanNeeds) ? payload.humanNeeds.length : 0;
  const selected = nonNegativeNumber(accounting?.selectedCount);
  const accounted = nonNegativeNumber(accounting?.accountedCount);
  const counts: RemoteProjectionCounts = {
    tasks: selected,
    readyTasks: Math.max(0, selected - accounted),
    humanNeeds,
    activeEffects: 0,
    uncertainEffects: 0,
  };
  return Object.freeze({
    cursor: projection.cursor,
    repositoryId: projection.repositoryId,
    runId: projection.runId,
    projectionType: projection.projectionType,
    revision: projection.revision,
    generatedAt: projection.generatedAt,
    payloadDigest: projection.payloadDigest,
    lifecycleStatus: typeof payload?.status === "string" ? payload.status : "unknown",
    counts,
  });
}

function validatePolicy(
  policy: RemoteConnectorPolicy,
  binding: RemoteRepositoryBinding,
): RemoteConnectorPolicy {
  if (policy.policyDigest !== binding.policyDigest || !/^[0-9a-f]{64}$/.test(policy.policyDigest)) {
    throw new TypeError("Remote connector policy digest must equal the repository binding");
  }
  if (
    !Number.isSafeInteger(policy.maximumRemoteAuthorizationLeaseSeconds) ||
    policy.maximumRemoteAuthorizationLeaseSeconds < 1
  ) {
    throw new TypeError("Remote authorization lease must be a positive safe integer");
  }
  const seen = new Set<string>();
  if (
    !policy.synchronization.synchronizationState &&
    (policy.synchronization.receiptChain ||
      policy.synchronization.events ||
      policy.synchronization.projections)
  ) {
    throw new TypeError("Remote metadata streams require synchronization state");
  }
  const roleMappings = policy.roleMappings.map((mapping) => {
    const key = canonicalStringify([mapping.issuer, mapping.tenant, mapping.upstreamRole]);
    if (seen.has(key) || mapping.localRoles.length === 0)
      throw new TypeError("Remote role mappings must be unique and non-empty");
    seen.add(key);
    return Object.freeze({
      ...mapping,
      localRoles: Object.freeze([...new Set(mapping.localRoles)].sort()),
    });
  });
  return Object.freeze({ ...policy, roleMappings: Object.freeze(roleMappings) });
}

function syncLag(
  inboundSequence: number,
  synchronization: ReturnType<SqliteRemoteAuthority["querySynchronization"]>,
  pending: RemoteDeliveryPendingCounts,
  currentTime: string,
  partitioned: boolean,
): RemoteConnectorSyncLag {
  const localToEnqueued = synchronization.localLatestCursor - synchronization.durablyEnqueuedCursor;
  const enqueuedToAcknowledged =
    synchronization.durablyEnqueuedCursor - synchronization.centrallyAcknowledgedCursor;
  const stalenessMs =
    synchronization.lastAcknowledgedAt === null
      ? null
      : Math.max(0, Date.parse(currentTime) - Date.parse(synchronization.lastAcknowledgedAt));
  return Object.freeze({
    state:
      synchronization.lastAcknowledgedAt === null
        ? "never-synchronized"
        : partitioned || localToEnqueued > 0 || enqueuedToAcknowledged > 0
          ? "stale"
          : "current",
    stalenessMs,
    inboundSequence,
    ...pending,
    localToEnqueued,
    enqueuedToAcknowledged,
  });
}

function aggregateRunEventCheckpoints(
  checkpoints: readonly RemoteRunEventCheckpoint[],
  advance: RemoteRunEventAdvance,
): {
  readonly localLatestCursor: number;
  readonly durablyEnqueuedCursor: number;
  readonly centrallyAcknowledgedCursor: number;
} {
  let localLatestCursor = advance.localLatestCursor;
  let durablyEnqueuedCursor = advance.throughCursor;
  let centrallyAcknowledgedCursor = 0;
  let replaced = false;
  for (const checkpoint of checkpoints) {
    if (checkpoint.runId === advance.runId) {
      centrallyAcknowledgedCursor += checkpoint.centrallyAcknowledgedCursor;
      replaced = true;
      continue;
    }
    localLatestCursor += checkpoint.localLatestCursor;
    durablyEnqueuedCursor += checkpoint.durablyEnqueuedCursor;
    centrallyAcknowledgedCursor += checkpoint.centrallyAcknowledgedCursor;
  }
  if (!replaced && advance.fromCursor !== 0) {
    throw new TypeError("Remote event advance is missing its durable run checkpoint");
  }
  return Object.freeze({
    localLatestCursor,
    durablyEnqueuedCursor,
    centrallyAcknowledgedCursor,
  });
}

function requiredLastEventCursor(events: readonly EventStreamFrame[]): number {
  const cursor = events.at(-1)?.cursor;
  if (cursor === undefined) {
    throw new TypeError("A nonterminal event page must contain an event cursor");
  }
  return cursor;
}

function domainSeparatedBytes(domain: string, value: object): Uint8Array {
  const prefix = new TextEncoder().encode(domain);
  const content = canonicalBytes(value);
  const bytes = new Uint8Array(prefix.length + content.length);
  bytes.set(prefix);
  bytes.set(content, prefix.length);
  return bytes;
}

function requiredTerminalReceipt(receipt: SupervisorReceipt["terminalReceipt"]) {
  if (receipt === undefined)
    throw new TypeError("Terminal supervisor receipt is missing its durable receipt");
  return receipt;
}

function requiredSession(session: RemoteHelloSelection | undefined): RemoteHelloSelection {
  if (session === undefined) throw new Error("Remote connector session is not established");
  return session;
}

function terminalOutcomeStatus(
  status: NonNullable<SupervisorReceipt["terminalReceipt"]>["status"],
): "completed" | "refused" | "expired" | "cancelled" | "unknown-effect" {
  if (status === "queued" || status === "claimed") {
    throw new TypeError("Terminal supervisor receipt has a nonterminal durable status");
  }
  return status;
}

function jsonObject(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Readonly<Record<string, JsonValue>>;
}

function nonNegativeNumber(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function positiveBound(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

function emptyPumpResult(): MutablePumpResult {
  return {
    receivedCommands: 0,
    admittedCommands: 0,
    duplicateCommands: 0,
    refusedCommands: 0,
    localResults: 0,
    enqueuedReports: 0,
    acknowledgedReports: 0,
    partitioned: false,
  };
}

type MutablePumpResult = {
  -readonly [Key in keyof RemoteConnectorPumpResult]: RemoteConnectorPumpResult[Key];
};

function refusalCode(error: unknown, fallback: string): string {
  return error instanceof RemoteConnectorRefusalError ? error.code : fallback;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function isAbortSignal(value: AbortSignal | undefined): value is AbortSignal {
  return value !== undefined;
}

function isPromise(value: Promise<unknown> | undefined): value is Promise<unknown> {
  return value !== undefined;
}

function cancellableDelay(
  delayMs: number,
  signal: AbortSignal,
  timer: RemoteConnectorTimer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const handle = timer.set(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      timer.clear(handle);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

const systemTimer: RemoteConnectorTimer = {
  set(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
