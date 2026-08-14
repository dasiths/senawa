import { createHash, type KeyObject, sign as signBytes, verify as verifyBytes } from "node:crypto";
import {
  type AuthenticatedPrincipal,
  type CommandSubmission,
  canonicalStringify,
  decodeCommandSubmission,
  decodeRemoteClassifiedReport,
  decodeRemoteHelloOffer,
  decodeRemoteReceiptChain,
  decodeRemoteRepositoryBinding,
  encodeRemoteCentralAcceptedCommand,
  encodeRemoteClassifiedReport,
  encodeRemoteCommandEnvelope,
  REMOTE_CAPABILITIES,
  REMOTE_CLASSIFIED_REPORT_SIGNATURE_DOMAIN,
  REMOTE_COMMAND_ENVELOPE_SIGNATURE_DOMAIN,
  REMOTE_NEGOTIATION_VERSION,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_RECEIPT_ENTRY_DIGEST_DOMAIN,
  REMOTE_REPORT_ACKNOWLEDGEMENT_SIGNATURE_DOMAIN,
  type RemoteCentralAcceptedCommand,
  type RemoteClassifiedReport,
  type RemoteCommandEnvelope,
  type RemoteHelloOffer,
  type RemoteHelloResponse,
  type RemoteReceiptChain,
  type RemoteReceiptChainEntry,
  type RemoteReportAcknowledgement,
  type RemoteRepositoryBinding,
  type RemoteSynchronizationVector,
} from "@senawa/protocol";

const COMMAND_INGRESS_DOMAIN = "senawa.dev/remote-control/command-ingress/v1\n";
export interface ControlPlaneClock {
  readonly now: () => string;
}

export interface ControlPlaneRandom {
  readonly next: (kind: "acceptance" | "central-receipt" | "delivery" | "session") => string;
}

export interface ControlPlaneSha256 {
  readonly digest: (bytes: Uint8Array) => string;
}

export interface ControlPlaneSigningKey {
  readonly keyId: string;
  readonly privateKey: KeyObject;
}

export interface RegisteredRepositoryBinding {
  readonly binding: RemoteRepositoryBinding;
  readonly repositoryPublicKey: KeyObject;
}

export interface TrustedCommandIngress {
  readonly repositoryKeyId: string;
  readonly connectorId: string;
  readonly requestId: string;
  readonly command: unknown;
  readonly signature: string;
}

export interface ControlPlaneIngressContext {
  readonly principal: AuthenticatedPrincipal;
}

export interface SignedClassifiedReportIngress {
  readonly repositoryKeyId: string;
  readonly connectorId: string;
  readonly report: unknown;
  readonly signature: string;
}

export type AuthorityRefusalCode =
  | "unknown-key"
  | "binding-mismatch"
  | "connector-mismatch"
  | "tenant-mismatch"
  | "repository-mismatch"
  | "invalid-signature"
  | "expired"
  | "revoked"
  | "duplicate-conflict"
  | "sequence-conflict"
  | "chain-conflict"
  | "classification-refused";

export interface AuthorityRefusal {
  readonly type: "refusal";
  readonly code: AuthorityRefusalCode;
  readonly message: string;
}

export type CommandAcceptance =
  | Readonly<{ type: "accepted"; replay: boolean; envelope: RemoteCommandEnvelope }>
  | AuthorityRefusal;

export type ReportAcceptance =
  | Readonly<{
      type: "acknowledged";
      replay: boolean;
      acknowledgement: RemoteReportAcknowledgement;
    }>
  | AuthorityRefusal;

export interface SynchronizationStatus {
  readonly vector: RemoteSynchronizationVector;
  readonly state: "current" | "stale" | "never-synchronized";
  readonly cursorLag: number;
  readonly stalenessMs: number | null;
}

interface BindingState {
  readonly registration: RegisteredRepositoryBinding;
  revoked: boolean;
  envelopeSequence: number;
  previousEnvelopeDigest: string | null;
  readonly commands: Map<string, StoredCommand>;
  readonly envelopes: RemoteCommandEnvelope[];
  readonly receiptChains: Map<string, RemoteReceiptChain>;
  readonly reportsBySequence: Map<number, StoredReport>;
  previousReportDigest: string | null;
  synchronization: RemoteSynchronizationVector;
}

interface StoredCommand {
  readonly ingressDigest: string;
  readonly envelope: RemoteCommandEnvelope;
  readonly envelopeDigest: string;
}

interface StoredReport {
  readonly reportDigest: string;
  readonly acknowledgement: RemoteReportAcknowledgement;
}

export class ReferenceControlPlane {
  readonly #clock: ControlPlaneClock;
  readonly #random: ControlPlaneRandom;
  readonly #serverPeerId: string;
  readonly #signingKey: ControlPlaneSigningKey;
  readonly #sha256: ControlPlaneSha256;
  readonly #bindingsByRepositoryKey = new Map<string, BindingState>();
  readonly #bindingsById = new Map<string, BindingState>();

  constructor(input: {
    readonly clock: ControlPlaneClock;
    readonly random: ControlPlaneRandom;
    readonly serverPeerId: string;
    readonly signingKey: ControlPlaneSigningKey;
    readonly sha256?: ControlPlaneSha256;
  }) {
    if (
      input.signingKey.privateKey.type !== "private" ||
      input.signingKey.privateKey.asymmetricKeyType !== "ed25519"
    ) {
      throw new TypeError("control-plane signing key must be an Ed25519 private key");
    }
    this.#clock = input.clock;
    this.#random = input.random;
    this.#serverPeerId = input.serverPeerId;
    this.#signingKey = input.signingKey;
    this.#sha256 = input.sha256 ?? nodeSha256;
  }

  register(input: RegisteredRepositoryBinding): void {
    const binding = decodeRemoteRepositoryBinding(input.binding);
    if (binding.controlPlaneKeyId !== this.#signingKey.keyId) {
      throw new Error("binding control-plane key does not match the configured signing key");
    }
    if (
      input.repositoryPublicKey.type !== "public" ||
      input.repositoryPublicKey.asymmetricKeyType !== "ed25519"
    ) {
      throw new TypeError("repository verification key must be an Ed25519 public key");
    }
    if (
      this.#bindingsByRepositoryKey.has(binding.repositoryKeyId) ||
      this.#bindingsById.has(binding.bindingId)
    ) {
      throw new Error("repository key and binding identifiers must be unique");
    }
    const state: BindingState = {
      registration: Object.freeze({ ...input, binding }),
      revoked: false,
      envelopeSequence: 0,
      previousEnvelopeDigest: null,
      commands: new Map(),
      envelopes: [],
      receiptChains: new Map(),
      reportsBySequence: new Map(),
      previousReportDigest: null,
      synchronization: Object.freeze({
        repositoryId: binding.repositoryId,
        localLatestCursor: 0,
        durablyEnqueuedCursor: 0,
        centrallyAcknowledgedCursor: 0,
        localObservedAt: binding.issuedAt,
        lastEnqueuedAt: null,
        lastAcknowledgedAt: null,
      }),
    };
    this.#bindingsByRepositoryKey.set(binding.repositoryKeyId, state);
    this.#bindingsById.set(binding.bindingId, state);
  }

  negotiate(input: {
    readonly repositoryKeyId: string;
    readonly connectorId: string;
    readonly offer: string | RemoteHelloOffer;
  }): RemoteHelloResponse {
    const offer = decodeRemoteHelloOffer(input.offer);
    const state = this.#bindingsByRepositoryKey.get(input.repositoryKeyId);
    if (state === undefined || state.registration.binding.connectorId !== input.connectorId) {
      return helloRefusal("binding-refused", "repository key and connector binding refused");
    }
    if (state.revoked) return helloRefusal("revoked", "repository binding is revoked");
    if (!offer.supportedVersions.includes(REMOTE_PROTOCOL_VERSION)) {
      return helloRefusal("no-common-version", "no common remote protocol version");
    }
    if (REMOTE_CAPABILITIES.some((capability) => !offer.capabilities.includes(capability))) {
      return helloRefusal("missing-capability", "required remote capability is missing");
    }
    return Object.freeze({
      negotiationVersion: REMOTE_NEGOTIATION_VERSION,
      type: "selection",
      sessionId: this.#random.next("session"),
      serverPeerId: this.#serverPeerId,
      selectedVersion: REMOTE_PROTOCOL_VERSION,
      capabilities: REMOTE_CAPABILITIES,
    });
  }

  acceptCommand(
    input: TrustedCommandIngress,
    context: ControlPlaneIngressContext,
  ): CommandAcceptance {
    const state = this.#bindingsByRepositoryKey.get(input.repositoryKeyId);
    if (state === undefined) return refusal("unknown-key", "repository signing key is not bound");
    const denied = bindingRefusal(state, input.connectorId, context.principal.tenant);
    if (denied !== undefined) return denied;

    let command: CommandSubmission;
    try {
      command = decodeCommandSubmission(input.command);
    } catch {
      return refusal("binding-mismatch", "command is not a valid exact submission");
    }
    if (command.repositoryId !== state.registration.binding.repositoryId) {
      return refusal("repository-mismatch", "command repository is not bound to this key");
    }
    const canonicalCommand = canonicalStringify(command);
    const ingressDigest = digest(
      canonicalStringify({
        command,
        connectorId: input.connectorId,
        principal: context.principal,
        repositoryKeyId: input.repositoryKeyId,
      }),
      this.#sha256,
    );
    if (
      !verifyCanonical(
        state.registration.repositoryPublicKey,
        COMMAND_INGRESS_DOMAIN,
        canonicalCommand,
        input.signature,
      )
    ) {
      return refusal("invalid-signature", "command signature is invalid");
    }
    const existing = state.commands.get(command.commandId);
    if (existing !== undefined) {
      if (existing.ingressDigest !== ingressDigest) {
        return refusal("duplicate-conflict", "command identity was reused with different content");
      }
      return Object.freeze({ type: "accepted", replay: true, envelope: existing.envelope });
    }
    const now = this.#clock.now();
    if (command.expiresAt === undefined || Date.parse(command.expiresAt) <= Date.parse(now)) {
      return refusal("expired", "command authorization has expired");
    }

    const acceptedCommand: RemoteCentralAcceptedCommand = Object.freeze({
      apiVersion: REMOTE_PROTOCOL_VERSION,
      acceptanceId: this.#random.next("acceptance"),
      binding: state.registration.binding,
      attribution: Object.freeze({
        principal: context.principal,
        transport: Object.freeze({ kind: "remote", requestId: input.requestId }),
      }),
      command,
      commandDigest: digest(canonicalCommand, this.#sha256),
      acceptedAt: now,
      expiresAt: command.expiresAt,
    });
    const acceptedCommandDigest = digest(
      encodeRemoteCentralAcceptedCommand(acceptedCommand),
      this.#sha256,
    );
    const sequence = state.envelopeSequence + 1;
    const unsignedEnvelope = {
      apiVersion: REMOTE_PROTOCOL_VERSION,
      sequence,
      previousEnvelopeDigest: state.previousEnvelopeDigest,
      acceptedCommand,
      acceptedCommandDigest,
      issuedAt: now,
      signingKeyId: this.#signingKey.keyId,
    };
    const envelope: RemoteCommandEnvelope = Object.freeze({
      ...unsignedEnvelope,
      signature: signCanonical(
        this.#signingKey.privateKey,
        REMOTE_COMMAND_ENVELOPE_SIGNATURE_DOMAIN,
        canonicalStringify(unsignedEnvelope),
      ),
    });
    const canonicalEnvelope = encodeRemoteCommandEnvelope(envelope);
    const envelopeDigest = digest(canonicalEnvelope, this.#sha256);
    const centralEntry = createReceiptChainEntry(
      {
        bindingId: state.registration.binding.bindingId,
        commandId: command.commandId,
        stage: "central-accepted",
        stageSequence: 1,
        recordedAt: now,
        previousEntryDigest: null,
        evidence: {
          type: "central-acceptance",
          acceptanceId: acceptedCommand.acceptanceId,
          acceptanceDigest: acceptedCommandDigest,
        },
      },
      this.#sha256,
    );
    const chain = Object.freeze({
      bindingId: state.registration.binding.bindingId,
      commandId: command.commandId,
      entries: Object.freeze([centralEntry]),
    });
    state.envelopeSequence = sequence;
    state.previousEnvelopeDigest = envelopeDigest;
    state.envelopes.push(envelope);
    state.commands.set(command.commandId, { ingressDigest, envelope, envelopeDigest });
    state.receiptChains.set(command.commandId, chain);
    return Object.freeze({ type: "accepted", replay: false, envelope });
  }

  recordDelivery(bindingId: string, sequence: number): RemoteReceiptChain | AuthorityRefusal {
    const state = this.#bindingsById.get(bindingId);
    if (state === undefined) return refusal("binding-mismatch", "binding is not registered");
    if (state.revoked) return refusal("revoked", "repository binding is revoked");
    const envelope = state.envelopes[sequence - 1];
    if (envelope === undefined || envelope.sequence !== sequence) {
      return refusal("sequence-conflict", "delivery sequence is not canonical");
    }
    if (Date.parse(envelope.acceptedCommand.expiresAt) <= Date.parse(this.#clock.now())) {
      return refusal("expired", "command authorization has expired before delivery");
    }
    const current = state.receiptChains.get(envelope.acceptedCommand.command.commandId);
    if (current === undefined) throw new Error("accepted command is missing its receipt chain");
    if (current.entries.length >= 2) return current;
    const prior = current.entries[0];
    if (prior === undefined) throw new Error("accepted command is missing central evidence");
    const entry = createReceiptChainEntry(
      {
        bindingId,
        commandId: current.commandId,
        stage: "connector-delivered",
        stageSequence: 2,
        recordedAt: this.#clock.now(),
        previousEntryDigest: prior.entryDigest,
        evidence: {
          type: "connector-delivery",
          envelopeSequence: sequence,
          envelopeDigest: digest(encodeRemoteCommandEnvelope(envelope), this.#sha256),
        },
      },
      this.#sha256,
    );
    const chain = Object.freeze({
      ...current,
      entries: Object.freeze([...current.entries, entry]),
    });
    state.receiptChains.set(current.commandId, chain);
    return chain;
  }

  acceptReport(input: SignedClassifiedReportIngress): ReportAcceptance {
    const state = this.#bindingsByRepositoryKey.get(input.repositoryKeyId);
    if (state === undefined) return refusal("unknown-key", "repository signing key is not bound");
    const denied = bindingRefusal(state, input.connectorId);
    if (denied !== undefined) return denied;
    let report: RemoteClassifiedReport;
    try {
      report = decodeRemoteClassifiedReport(input.report);
    } catch {
      return refusal("binding-mismatch", "report is not a valid classified report");
    }
    const canonicalReport = encodeRemoteClassifiedReport(report);
    const reportDigest = digest(canonicalReport, this.#sha256);
    if (
      !verifyCanonical(
        state.registration.repositoryPublicKey,
        REMOTE_CLASSIFIED_REPORT_SIGNATURE_DOMAIN,
        canonicalReport,
        input.signature,
      )
    ) {
      return refusal("invalid-signature", "classified report signature is invalid");
    }
    if (canonicalStringify(report.binding) !== canonicalStringify(state.registration.binding)) {
      return refusal("binding-mismatch", "report binding is not registered for this key");
    }
    if (report.dataPolicyDigest !== state.registration.binding.policyDigest) {
      return refusal("classification-refused", "report data policy is stale or untrusted");
    }
    const existing = state.reportsBySequence.get(report.reportSequence);
    if (existing !== undefined) {
      if (existing.reportDigest !== reportDigest) {
        return refusal("duplicate-conflict", "report sequence was reused with different content");
      }
      return Object.freeze({
        type: "acknowledged",
        replay: true,
        acknowledgement: existing.acknowledgement,
      });
    }
    if (
      report.reportSequence !== state.reportsBySequence.size + 1 ||
      report.previousReportDigest !== state.previousReportDigest
    ) {
      return refusal("sequence-conflict", "report sequence or hash link is not canonical");
    }
    for (const candidate of report.receiptChains) {
      const current = state.receiptChains.get(candidate.commandId);
      if (current === undefined || !chainExtends(current, candidate, this.#sha256)) {
        return refusal("chain-conflict", "reported receipt chain does not extend central evidence");
      }
    }
    for (const candidate of report.receiptChains) {
      state.receiptChains.set(candidate.commandId, decodeRemoteReceiptChain(candidate));
    }
    const acknowledgedAt = this.#clock.now();
    const unsignedAcknowledgement = {
      apiVersion: REMOTE_PROTOCOL_VERSION,
      bindingId: report.binding.bindingId,
      repositoryId: report.binding.repositoryId,
      reportId: report.reportId,
      reportSequence: report.reportSequence,
      reportDigest,
      centralReceiptId: this.#random.next("central-receipt"),
      acknowledgedAt,
      signingKeyId: this.#signingKey.keyId,
    };
    const acknowledgement: RemoteReportAcknowledgement = Object.freeze({
      ...unsignedAcknowledgement,
      signature: signCanonical(
        this.#signingKey.privateKey,
        REMOTE_REPORT_ACKNOWLEDGEMENT_SIGNATURE_DOMAIN,
        canonicalStringify(unsignedAcknowledgement),
      ),
    });
    state.reportsBySequence.set(report.reportSequence, { reportDigest, acknowledgement });
    state.previousReportDigest = reportDigest;
    state.synchronization = Object.freeze({
      ...report.synchronization,
      centrallyAcknowledgedCursor: report.synchronization.durablyEnqueuedCursor,
      lastAcknowledgedAt:
        report.synchronization.durablyEnqueuedCursor === 0 ? null : acknowledgedAt,
    });
    return Object.freeze({ type: "acknowledged", replay: false, acknowledgement });
  }

  synchronization(bindingId: string): SynchronizationStatus | undefined {
    const state = this.#bindingsById.get(bindingId);
    if (state === undefined) return undefined;
    const vector = state.synchronization;
    const cursorLag = vector.localLatestCursor - vector.centrallyAcknowledgedCursor;
    if (vector.lastAcknowledgedAt === null) {
      return Object.freeze({
        vector,
        state: "never-synchronized",
        cursorLag,
        stalenessMs: null,
      });
    }
    const stalenessMs = Math.max(
      0,
      Date.parse(this.#clock.now()) - Date.parse(vector.lastAcknowledgedAt),
    );
    return Object.freeze({
      vector,
      state: cursorLag === 0 ? "current" : "stale",
      cursorLag,
      stalenessMs,
    });
  }

  receiptChain(bindingId: string, commandId: string): RemoteReceiptChain | undefined {
    return this.#bindingsById.get(bindingId)?.receiptChains.get(commandId);
  }

  envelopes(bindingId: string): readonly RemoteCommandEnvelope[] {
    return Object.freeze([...(this.#bindingsById.get(bindingId)?.envelopes ?? [])]);
  }

  revoke(bindingId: string): void {
    const state = this.#bindingsById.get(bindingId);
    if (state === undefined) throw new Error("binding is not registered");
    state.revoked = true;
  }
}

export function signCommandIngress(privateKey: KeyObject, command: unknown): string {
  return signCanonical(
    privateKey,
    COMMAND_INGRESS_DOMAIN,
    canonicalStringify(decodeCommandSubmission(command)),
  );
}

export function signClassifiedReport(privateKey: KeyObject, report: unknown): string {
  return signCanonical(
    privateKey,
    REMOTE_CLASSIFIED_REPORT_SIGNATURE_DOMAIN,
    encodeRemoteClassifiedReport(report),
  );
}

export function verifyCommandEnvelope(
  publicKey: KeyObject,
  envelope: RemoteCommandEnvelope,
): boolean {
  const { signature, ...unsigned } = envelope;
  return verifyCanonical(
    publicKey,
    REMOTE_COMMAND_ENVELOPE_SIGNATURE_DOMAIN,
    canonicalStringify(unsigned),
    signature,
  );
}

export function verifyReportAcknowledgement(
  publicKey: KeyObject,
  acknowledgement: RemoteReportAcknowledgement,
): boolean {
  const { signature, ...unsigned } = acknowledgement;
  return verifyCanonical(
    publicKey,
    REMOTE_REPORT_ACKNOWLEDGEMENT_SIGNATURE_DOMAIN,
    canonicalStringify(unsigned),
    signature,
  );
}

function bindingRefusal(
  state: BindingState,
  connectorId: string,
  tenantId?: string,
): AuthorityRefusal | undefined {
  if (state.revoked) return refusal("revoked", "repository binding is revoked");
  if (state.registration.binding.connectorId !== connectorId) {
    return refusal("connector-mismatch", "connector is not bound to this repository key");
  }
  if (tenantId !== undefined && state.registration.binding.tenantId !== tenantId) {
    return refusal(
      "tenant-mismatch",
      "trusted principal tenant is not bound to this repository key",
    );
  }
  return undefined;
}

function helloRefusal(
  code: "no-common-version" | "missing-capability" | "binding-refused" | "revoked",
  message: string,
): RemoteHelloResponse {
  return Object.freeze({
    negotiationVersion: REMOTE_NEGOTIATION_VERSION,
    type: "refusal",
    code,
    message,
    supportedVersions: Object.freeze([REMOTE_PROTOCOL_VERSION]),
    requiredCapabilities: REMOTE_CAPABILITIES,
  });
}

function refusal(code: AuthorityRefusalCode, message: string): AuthorityRefusal {
  return Object.freeze({ type: "refusal", code, message });
}

function chainExtends(
  current: RemoteReceiptChain,
  candidate: RemoteReceiptChain,
  sha256: ControlPlaneSha256,
): boolean {
  if (
    candidate.bindingId !== current.bindingId ||
    candidate.commandId !== current.commandId ||
    candidate.entries.length < current.entries.length
  ) {
    return false;
  }
  for (const [index, entry] of candidate.entries.entries()) {
    const unsigned = {
      apiVersion: entry.apiVersion,
      bindingId: entry.bindingId,
      commandId: entry.commandId,
      stage: entry.stage,
      stageSequence: entry.stageSequence,
      recordedAt: entry.recordedAt,
      previousEntryDigest: entry.previousEntryDigest,
      evidence: entry.evidence,
    };
    if (
      entry.entryDigest !==
      digestWithDomain(REMOTE_RECEIPT_ENTRY_DIGEST_DOMAIN, canonicalStringify(unsigned), sha256)
    ) {
      return false;
    }
    const existing = current.entries[index];
    if (existing !== undefined && canonicalStringify(existing) !== canonicalStringify(entry)) {
      return false;
    }
  }
  return true;
}

export function createReceiptChainEntry(
  input: Omit<RemoteReceiptChainEntry, "apiVersion" | "entryDigest">,
  sha256: ControlPlaneSha256 = nodeSha256,
): RemoteReceiptChainEntry {
  const unsigned = { apiVersion: REMOTE_PROTOCOL_VERSION, ...input };
  return Object.freeze({
    ...unsigned,
    entryDigest: digestWithDomain(
      REMOTE_RECEIPT_ENTRY_DIGEST_DOMAIN,
      canonicalStringify(unsigned),
      sha256,
    ),
  });
}

function signCanonical(privateKey: KeyObject, domain: string, canonical: string): string {
  return signBytes(null, Buffer.from(`${domain}${canonical}`, "utf8"), privateKey).toString(
    "base64url",
  );
}

function verifyCanonical(
  publicKey: KeyObject,
  domain: string,
  canonical: string,
  signature: string,
): boolean {
  try {
    const decoded = Buffer.from(signature, "base64url");
    if (decoded.toString("base64url") !== signature) return false;
    return verifyBytes(null, Buffer.from(`${domain}${canonical}`, "utf8"), publicKey, decoded);
  } catch {
    return false;
  }
}

const nodeSha256: ControlPlaneSha256 = Object.freeze({
  digest: (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex"),
});

function digest(canonical: string, sha256: ControlPlaneSha256 = nodeSha256): string {
  return sha256.digest(Buffer.from(canonical, "utf8"));
}

function digestWithDomain(
  domain: string,
  canonical: string,
  sha256: ControlPlaneSha256 = nodeSha256,
): string {
  return digest(`${domain}${canonical}`, sha256);
}
