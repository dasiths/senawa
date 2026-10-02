import { createPrivateKey, createPublicKey, type KeyObject, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import type { ConfigurationSnapshot, RemoteDisconnectedMode } from "@senawa/configuration";
import {
  canonicalStringify,
  decodeCanonicalJsonValue,
  decodeRemoteCommandEnvelope,
  decodeRemoteHelloResponse,
  decodeRemoteReceiptChainEntry,
  decodeRemoteReportAcknowledgement,
  decodeRemoteRepositoryBinding,
  PROTOCOL_LIMITS,
  type RemoteRepositoryBinding,
} from "@senawa/protocol";
import type { RuntimeDependencies } from "@senawa/runtime";
import { SqliteRemoteAuthority } from "@senawa/storage-sqlite";
import {
  NodeEd25519RemoteCrypto,
  RemoteConnector,
  type RemoteConnectorStatus,
  type RemoteConnectorTransport,
  type SupervisorAdmissionAllocator,
  type SupervisorApi,
} from "@senawa/supervisor";

const ENROLLMENT_VERSION = "senawa.dev/remote-connector-enrollment/v1";
const MAX_ENROLLMENT_BYTES = 64 * 1024;
const MAX_REMOTE_RESPONSE_BYTES = PROTOCOL_LIMITS.maxWireBytes;
const REMOTE_NETWORK_LIMITS = Object.freeze({
  maxEndpointCharacters: 2_048,
  defaultResponseTimeoutMs: 10_000,
  maxResponseTimeoutMs: 300_000,
});

export interface DaemonRemoteConnector {
  readonly disconnectedMode: RemoteDisconnectedMode;
  establishContact(): Promise<boolean>;
  start(): void;
  drain(): Promise<void>;
  close(): Promise<void>;
  status(): RemoteConnectorStatus;
}

export interface DaemonRemoteConnectorFactoryInput {
  readonly environment: NodeJS.ProcessEnv;
  readonly databasePath: string;
  readonly dependencies: RuntimeDependencies;
  readonly supervisorApi: SupervisorApi;
  readonly admissionAllocator: SupervisorAdmissionAllocator;
  readonly fetch?: typeof globalThis.fetch;
}

interface RemoteEnrollment {
  readonly binding: RemoteRepositoryBinding;
  readonly configurationSnapshotDigest: string;
  readonly repositoryPrivateKey: KeyObject;
  readonly controlPlanePublicKey: KeyObject;
}

export async function createOptionalDaemonRemoteConnector(
  input: DaemonRemoteConnectorFactoryInput,
): Promise<DaemonRemoteConnector | undefined> {
  const endpointInput = input.environment.SENAWA_REMOTE_ENDPOINT;
  const keyFile = input.environment.SENAWA_REMOTE_KEY_FILE;
  if (endpointInput === undefined && keyFile === undefined) return undefined;
  if (endpointInput === undefined || keyFile === undefined) {
    throw new Error("Remote connector requires both endpoint and key file inputs");
  }
  const endpoint = parseRemoteEndpoint(endpointInput);
  const enrollment = loadRemoteEnrollment(keyFile);
  const snapshotInput = input.supervisorApi.authority.commandAuthority.getConfigurationSnapshot(
    enrollment.configurationSnapshotDigest,
  );
  const snapshot = requireRemoteConfigurationSnapshot(snapshotInput, enrollment.binding);
  const remoteAuthority = new SqliteRemoteAuthority({
    databasePath: input.databasePath,
    dependencies: input.dependencies,
  });
  try {
    const crypto = new NodeEd25519RemoteCrypto({
      publicKeys: new Map([
        [enrollment.binding.controlPlaneKeyId, enrollment.controlPlanePublicKey],
      ]),
      privateKeys: new Map([[enrollment.binding.repositoryKeyId, enrollment.repositoryPrivateKey]]),
    });
    const connector = new RemoteConnector({
      authority: remoteAuthority,
      supervisorApi: input.supervisorApi,
      binding: enrollment.binding,
      policy: {
        policyDigest: requiredDigest(snapshot.componentDigests.remote, "remote policy digest"),
        roleMappings: snapshot.remote.roleMappings,
        maximumRemoteAuthorizationLeaseSeconds:
          snapshot.remote.maximumRemoteAuthorizationLeaseSeconds,
        synchronization: snapshot.remote.synchronization,
      },
      transport: new HttpRemoteConnectorTransport({
        endpoint,
        binding: enrollment.binding,
        fetch: input.fetch ?? globalThis.fetch,
      }),
      verifier: crypto,
      signer: crypto,
      clock: { now: () => Date.now() },
      ids: { allocate: () => `report_${randomBytes(16).toString("hex")}` },
      admissionAllocator: input.admissionAllocator,
      ownerId: `remote-connector-${process.pid}`,
    });
    return new OwnedDaemonRemoteConnector(
      connector,
      remoteAuthority,
      snapshot.remote.disconnectedMode,
    );
  } catch (error) {
    remoteAuthority.close();
    throw error;
  }
}

export class HttpRemoteConnectorTransport implements RemoteConnectorTransport {
  readonly #endpoint: URL;
  readonly #binding: RemoteRepositoryBinding;
  readonly #fetch: typeof globalThis.fetch;
  readonly #responseTimeoutMs: number;

  constructor(input: {
    readonly endpoint: URL;
    readonly binding: RemoteRepositoryBinding;
    readonly fetch: typeof globalThis.fetch;
    readonly responseTimeoutMs?: number;
  }) {
    this.#endpoint = input.endpoint;
    this.#binding = input.binding;
    this.#fetch = input.fetch;
    this.#responseTimeoutMs =
      input.responseTimeoutMs ?? REMOTE_NETWORK_LIMITS.defaultResponseTimeoutMs;
    if (
      !Number.isSafeInteger(this.#responseTimeoutMs) ||
      this.#responseTimeoutMs < 1 ||
      this.#responseTimeoutMs > REMOTE_NETWORK_LIMITS.maxResponseTimeoutMs
    ) {
      throw new TypeError("Remote response timeout is outside its security ceiling");
    }
  }

  async negotiate(input: Parameters<RemoteConnectorTransport["negotiate"]>[0]) {
    if (
      input.connectorId !== this.#binding.connectorId ||
      input.repositoryKeyId !== this.#binding.repositoryKeyId ||
      input.offer.peerId !== this.#binding.connectorId
    ) {
      throw new Error("Remote hello does not match enrollment");
    }
    return decodeRemoteHelloResponse(
      await this.#post(
        "hello",
        {
          connectorId: input.connectorId,
          repositoryKeyId: input.repositoryKeyId,
          offer: input.offer,
        },
        input.signal,
      ),
    );
  }

  async receiveCommands(input: Parameters<RemoteConnectorTransport["receiveCommands"]>[0]) {
    if (input.bindingId !== this.#binding.bindingId) {
      throw new Error("Remote command poll binding does not match enrollment");
    }
    const response = requiredRecord(
      await this.#post(
        "commands/poll",
        {
          bindingId: input.bindingId,
          sessionId: input.sessionId,
          afterSequence: input.afterSequence,
          limit: input.limit,
        },
        input.signal,
      ),
      "remote command batch",
    );
    exactKeys(response, ["deliveries", "revocationEpoch"], "remote command batch");
    if (
      !Number.isSafeInteger(response.revocationEpoch) ||
      (response.revocationEpoch as number) < 0
    ) {
      throw new Error("Remote command batch revocation epoch is invalid");
    }
    if (
      !Array.isArray(response.deliveries) ||
      response.deliveries.length > PROTOCOL_LIMITS.maxPageItems
    ) {
      throw new Error("Remote command batch deliveries are invalid");
    }
    return Object.freeze({
      revocationEpoch: response.revocationEpoch as number,
      deliveries: Object.freeze(
        response.deliveries.map((value, index) => {
          const delivery = requiredRecord(value, `remote command delivery ${index}`);
          exactKeys(delivery, ["envelope", "receiptEntry"], "remote command delivery");
          return Object.freeze({
            envelope: decodeRemoteCommandEnvelope(delivery.envelope),
            receiptEntry: decodeRemoteReceiptChainEntry(delivery.receiptEntry),
          });
        }),
      ),
    });
  }

  async sendReport(input: Parameters<RemoteConnectorTransport["sendReport"]>[0]) {
    if (input.canonicalReport !== canonicalStringify(input.report)) {
      throw new Error("Remote report bytes do not match the report");
    }
    return decodeRemoteReportAcknowledgement(
      await this.#post(
        "reports",
        {
          connectorId: this.#binding.connectorId,
          sessionId: input.sessionId,
          repositoryKeyId: input.signingKeyId,
          report: input.report,
          signature: input.signature,
        },
        input.signal,
      ),
    );
  }

  async #post(path: string, body: object, signal: AbortSignal): Promise<unknown> {
    const requestUrl = new URL(path, this.#endpoint);
    const bodyText = canonicalStringify(body);
    if (Buffer.byteLength(bodyText, "utf8") > PROTOCOL_LIMITS.maxWireBytes) {
      throw new Error("Remote control plane request exceeds the byte limit");
    }
    const response = await this.#fetch(requestUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "accept-encoding": "identity",
        "content-type": "application/json; charset=utf-8",
      },
      body: bodyText,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.#responseTimeoutMs)]),
    });
    if (response.redirected) throw new Error("Remote control plane redirects are forbidden");
    if (!response.ok) throw new Error("Remote control plane refused the request");
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== "application/json") {
      throw new Error("Remote control plane response content type is invalid");
    }
    const contentEncoding = response.headers.get("content-encoding");
    if (contentEncoding !== null && contentEncoding.toLowerCase() !== "identity") {
      throw new Error("Remote control plane response content encoding is invalid");
    }
    return decodeCanonicalJsonValue(await readBoundedResponse(response));
  }
}

class OwnedDaemonRemoteConnector implements DaemonRemoteConnector {
  #closed = false;

  constructor(
    readonly connector: RemoteConnector,
    readonly authority: SqliteRemoteAuthority,
    readonly disconnectedMode: RemoteDisconnectedMode,
  ) {}

  start(): void {
    this.connector.start();
  }

  establishContact(): Promise<boolean> {
    return this.connector.establishContact();
  }

  drain(): Promise<void> {
    return this.connector.drain();
  }

  status(): RemoteConnectorStatus {
    return this.connector.status();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.connector.close();
    } finally {
      this.authority.close();
      this.#closed = true;
    }
  }
}

function loadRemoteEnrollment(path: string): RemoteEnrollment {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.uid !== currentUid() ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.size < 1 ||
      metadata.size > MAX_ENROLLMENT_BYTES
    ) {
      throw new Error(
        "Remote connector key file must be a bounded private file owned by the current user",
      );
    }
    const value = requiredRecord(
      decodeCanonicalJsonValue(readFileSync(descriptor, "utf8")),
      "remote connector enrollment",
    );
    exactKeys(
      value,
      [
        "apiVersion",
        "binding",
        "configurationSnapshotDigest",
        "controlPlanePublicKeyPem",
        "repositoryPrivateKeyPem",
        "repositoryPublicKeyPem",
      ],
      "remote connector enrollment",
    );
    if (value.apiVersion !== ENROLLMENT_VERSION) {
      throw new Error("Remote connector enrollment version is unsupported");
    }
    const binding = decodeRemoteRepositoryBinding(value.binding);
    const repositoryPrivateKey = parseEd25519PrivateKey(value.repositoryPrivateKeyPem);
    const repositoryPublicKey = parseEd25519PublicKey(value.repositoryPublicKeyPem);
    if (!createPublicKey(repositoryPrivateKey).equals(repositoryPublicKey)) {
      throw new Error("Remote connector repository key pair does not match");
    }
    return Object.freeze({
      binding,
      configurationSnapshotDigest: requiredDigest(
        value.configurationSnapshotDigest,
        "configuration snapshot digest",
      ),
      repositoryPrivateKey,
      controlPlanePublicKey: parseEd25519PublicKey(value.controlPlanePublicKeyPem),
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Remote connector")) throw error;
    throw new Error("Remote connector key file could not be read or decoded");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function requireRemoteConfigurationSnapshot(
  value: unknown,
  binding: RemoteRepositoryBinding,
): ConfigurationSnapshot & { readonly remote: NonNullable<ConfigurationSnapshot["remote"]> } {
  const snapshot = value as ConfigurationSnapshot | undefined;
  if (
    snapshot === undefined ||
    snapshot.remote === undefined ||
    snapshot.snapshotDigest === undefined ||
    snapshot.componentDigests.remote !== binding.policyDigest
  ) {
    throw new Error(
      "Remote connector configuration snapshot is missing or does not match enrollment",
    );
  }
  return snapshot as ConfigurationSnapshot & {
    readonly remote: NonNullable<ConfigurationSnapshot["remote"]>;
  };
}

export function parseRemoteEndpoint(input: string): URL {
  if (
    input.length < 1 ||
    input.length > REMOTE_NETWORK_LIMITS.maxEndpointCharacters ||
    input.includes("\\") ||
    [...input].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new Error("Remote connector endpoint is invalid");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(input);
  } catch {
    throw new Error("Remote connector endpoint is invalid");
  }
  const loopbackHttp =
    endpoint.protocol === "http:" &&
    (endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost");
  if (
    (endpoint.protocol !== "https:" && !loopbackHttp) ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error("Remote connector endpoint is invalid");
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/*$/u, "")}/remote/v1/`;
  return endpoint;
}

function parseEd25519PrivateKey(value: unknown): KeyObject {
  const key = createPrivateKey(requiredPem(value, "repository private key"));
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Remote connector private key is invalid");
  }
  return key;
}

function parseEd25519PublicKey(value: unknown): KeyObject {
  const key = createPublicKey(requiredPem(value, "public key"));
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Remote connector public key is invalid");
  }
  return key;
}

function requiredPem(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 8_192 ||
    value.includes("\0")
  ) {
    throw new Error(`Remote connector ${label} is invalid`);
  }
  return value;
}

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new Error("Remote connector key ownership verification is unavailable");
  }
  return process.getuid();
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  let declaredLength: number | undefined;
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > MAX_REMOTE_RESPONSE_BYTES)
  ) {
    throw new Error("Remote control plane response exceeds the byte limit");
  }
  if (declared !== null) declaredLength = Number(declared);
  if (response.body === null) throw new Error("Remote control plane response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > MAX_REMOTE_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Remote control plane response exceeds the byte limit");
    }
    chunks.push(result.value);
  }
  if (declaredLength !== undefined && length !== declaredLength) {
    throw new Error("Remote control plane response length does not match its declaration");
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function requiredRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (canonicalStringify(actual) !== canonicalStringify(sortedExpected)) {
    throw new Error(`${label} fields are invalid`);
  }
}

function requiredDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`Remote connector ${label} is invalid`);
  }
  return value;
}
