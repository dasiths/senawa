import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileWorkflowConfiguration,
  createExampleWorkflowConfiguration,
} from "@senawa/configuration";
import {
  canonicalStringify,
  REMOTE_CAPABILITIES,
  REMOTE_NEGOTIATION_VERSION,
  REMOTE_PROTOCOL_VERSION,
  type RemoteRepositoryBinding,
} from "@senawa/protocol";
import { SqliteSupervisorAuthority, SupervisorApi } from "@senawa/supervisor";
import { deterministicSha256 } from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeDependencies } from "./daemon.js";
import {
  createOptionalDaemonRemoteConnector,
  HttpRemoteConnectorTransport,
  parseRemoteEndpoint,
} from "./remote-composition.js";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("production remote connector composition", () => {
  it("accepts only strict HTTPS or explicit loopback endpoints", () => {
    expect(parseRemoteEndpoint("https://control.example.test/base").href).toBe(
      "https://control.example.test/base/remote/v1alpha1/",
    );
    expect(parseRemoteEndpoint("http://127.0.0.1:8080").href).toBe(
      "http://127.0.0.1:8080/remote/v1alpha1/",
    );
    for (const endpoint of [
      "http://control.example.test",
      "https://user@control.example.test",
      "https://control.example.test?tenant=secret",
      "https://control.example.test#fragment",
      "https:\\control.example.test\\alias",
    ]) {
      expect(() => parseRemoteEndpoint(endpoint)).toThrow("endpoint is invalid");
    }
  });

  it("requires paired daemon-local inputs and a private bounded key file", async () => {
    const fixture = createFixture();
    await expect(
      createOptionalDaemonRemoteConnector({
        ...fixture.factoryInput,
        environment: { SENAWA_REMOTE_ENDPOINT: "https://control.example.test" },
      }),
    ).rejects.toThrow("requires both endpoint and key file");

    const missingKeyFile = join(fixture.root, "secret-enrollment.json");
    const missing = createOptionalDaemonRemoteConnector({
      ...fixture.factoryInput,
      environment: {
        SENAWA_REMOTE_ENDPOINT: "https://control.example.test",
        SENAWA_REMOTE_KEY_FILE: missingKeyFile,
      },
    });
    await expect(missing).rejects.toThrow("key file could not be read or decoded");
    await expect(missing).rejects.not.toThrow(missingKeyFile);

    chmodSync(fixture.keyFile, 0o644);
    await expect(
      createOptionalDaemonRemoteConnector({
        ...fixture.factoryInput,
        environment: {
          SENAWA_REMOTE_ENDPOINT: "https://control.example.test",
          SENAWA_REMOTE_KEY_FILE: fixture.keyFile,
        },
      }),
    ).rejects.toThrow("bounded private file owned by the current user");

    chmodSync(fixture.keyFile, 0o600);
    writeFileSync(fixture.keyFile, "x".repeat(64 * 1024 + 1), { mode: 0o600 });
    await expect(
      createOptionalDaemonRemoteConnector({
        ...fixture.factoryInput,
        environment: {
          SENAWA_REMOTE_ENDPOINT: "https://control.example.test",
          SENAWA_REMOTE_KEY_FILE: fixture.keyFile,
        },
      }),
    ).rejects.toThrow("bounded private file owned by the current user");
    fixture.authority.close();
  });

  it("derives policy from the persisted snapshot and exposes only sanitized status", async () => {
    const fixture = createFixture();
    const connector = await createOptionalDaemonRemoteConnector({
      ...fixture.factoryInput,
      environment: {
        SENAWA_REMOTE_ENDPOINT: "https://control.example.test/tenant-alpha",
        SENAWA_REMOTE_KEY_FILE: fixture.keyFile,
      },
    });
    expect(connector).toBeDefined();
    const serialized = canonicalStringify(connector?.status());
    expect(serialized).not.toContain("control.example.test");
    expect(serialized).not.toContain(fixture.keyFile);
    expect(serialized).not.toContain("PRIVATE KEY");
    expect(connector?.disconnectedMode).toBe("continue-authorized-local");
    await connector?.close();
    fixture.authority.close();
  });

  it("rejects symlink, non-regular, and non-Ed25519 enrollment inputs", async () => {
    const fixture = createFixture();
    const environment = (keyFile: string) => ({
      SENAWA_REMOTE_ENDPOINT: "https://control.example.test",
      SENAWA_REMOTE_KEY_FILE: keyFile,
    });
    const symlink = join(fixture.root, "enrollment-link.json");
    symlinkSync(fixture.keyFile, symlink);
    await expect(
      createOptionalDaemonRemoteConnector({
        ...fixture.factoryInput,
        environment: environment(symlink),
      }),
    ).rejects.toThrow("key file could not be read or decoded");

    const directory = join(fixture.root, "enrollment-directory");
    mkdirSync(directory, { mode: 0o600 });
    await expect(
      createOptionalDaemonRemoteConnector({
        ...fixture.factoryInput,
        environment: environment(directory),
      }),
    ).rejects.toThrow("bounded private file owned by the current user");

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const enrollment = JSON.parse(readFileSync(fixture.keyFile, "utf8")) as Record<string, unknown>;
    enrollment.repositoryPrivateKeyPem = rsa.privateKey.export({ format: "pem", type: "pkcs8" });
    enrollment.repositoryPublicKeyPem = rsa.publicKey.export({ format: "pem", type: "spki" });
    writeFileSync(fixture.keyFile, canonicalStringify(enrollment), { mode: 0o600 });
    await expect(
      createOptionalDaemonRemoteConnector({
        ...fixture.factoryInput,
        environment: environment(fixture.keyFile),
      }),
    ).rejects.toThrow("private key is invalid");
    fixture.authority.close();
  });

  it("performs production hello before polling and sends the selected session", async () => {
    const fixture = createFixture();
    const enrollment = JSON.parse(readFileSync(fixture.keyFile, "utf8")) as {
      binding: RemoteRepositoryBinding;
    };
    const requests: { readonly path: string; readonly body: Record<string, unknown> }[] = [];
    const transport = new HttpRemoteConnectorTransport({
      endpoint: new URL("https://control.example.test/remote/v1alpha1/"),
      binding: enrollment.binding,
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({ path, body });
        const payload = path.endsWith("/hello")
          ? {
              negotiationVersion: REMOTE_NEGOTIATION_VERSION,
              type: "selection",
              sessionId: "session_http-production",
              serverPeerId: "control-plane_http",
              selectedVersion: REMOTE_PROTOCOL_VERSION,
              capabilities: REMOTE_CAPABILITIES,
            }
          : { revocationEpoch: enrollment.binding.revocationEpoch, deliveries: [] };
        return new Response(canonicalStringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const controller = new AbortController();
    const context = {
      signal: controller.signal,
      deadlineAt: "2026-08-14T10:01:00.000Z",
    };
    const selection = await transport.negotiate({
      repositoryKeyId: enrollment.binding.repositoryKeyId,
      connectorId: enrollment.binding.connectorId,
      offer: {
        negotiationVersion: REMOTE_NEGOTIATION_VERSION,
        peerId: enrollment.binding.connectorId,
        supportedVersions: [REMOTE_PROTOCOL_VERSION],
        capabilities: REMOTE_CAPABILITIES,
      },
      ...context,
    });
    if (selection.type !== "selection") throw new Error("expected hello selection");
    await transport.receiveCommands({
      bindingId: enrollment.binding.bindingId,
      sessionId: selection.sessionId,
      afterSequence: 0,
      limit: 8,
      ...context,
    });
    expect(requests.map((request) => request.path)).toEqual([
      "/remote/v1alpha1/hello",
      "/remote/v1alpha1/commands/poll",
    ]);
    expect(requests[0]?.body).toMatchObject({
      connectorId: enrollment.binding.connectorId,
      offer: { peerId: enrollment.binding.connectorId },
    });
    expect(requests[1]?.body).toMatchObject({ sessionId: selection.sessionId });
    fixture.authority.close();
  });

  it("refuses redirects, content encoding, length mismatch, oversize, drip, and cancellation", async () => {
    const fixture = createFixture();
    const enrollment = JSON.parse(readFileSync(fixture.keyFile, "utf8")) as {
      binding: RemoteRepositoryBinding;
    };
    const hello = canonicalStringify({
      negotiationVersion: REMOTE_NEGOTIATION_VERSION,
      type: "selection",
      sessionId: "session_http-hostile",
      serverPeerId: "control-plane_http",
      selectedVersion: REMOTE_PROTOCOL_VERSION,
      capabilities: REMOTE_CAPABILITIES,
    });
    const request = {
      repositoryKeyId: enrollment.binding.repositoryKeyId,
      connectorId: enrollment.binding.connectorId,
      offer: {
        negotiationVersion: REMOTE_NEGOTIATION_VERSION,
        peerId: enrollment.binding.connectorId,
        supportedVersions: [REMOTE_PROTOCOL_VERSION],
        capabilities: REMOTE_CAPABILITIES,
      },
      deadlineAt: "2026-08-14T10:01:00.000Z",
    } as const;
    const transport = (fetch: typeof globalThis.fetch, responseTimeoutMs = 50) =>
      new HttpRemoteConnectorTransport({
        endpoint: new URL("https://control.example.test/remote/v1alpha1/"),
        binding: enrollment.binding,
        fetch,
        responseTimeoutMs,
      });

    await expect(
      transport(async () => {
        const response = new Response(hello, {
          headers: { "content-type": "application/json" },
        });
        Object.defineProperty(response, "redirected", { value: true });
        return response;
      }).negotiate({ ...request, signal: new AbortController().signal }),
    ).rejects.toThrow("redirects are forbidden");
    await expect(
      transport(
        async () =>
          new Response(hello, {
            headers: { "content-type": "application/json", "content-encoding": "gzip" },
          }),
      ).negotiate({ ...request, signal: new AbortController().signal }),
    ).rejects.toThrow("content encoding");
    await expect(
      transport(
        async () =>
          new Response(hello, {
            headers: { "content-type": "application/json", "content-length": "1" },
          }),
      ).negotiate({ ...request, signal: new AbortController().signal }),
    ).rejects.toThrow("does not match");
    await expect(
      transport(
        async () =>
          new Response("x".repeat(256 * 1024 + 1), {
            headers: { "content-type": "application/json" },
          }),
      ).negotiate({ ...request, signal: new AbortController().signal }),
    ).rejects.toThrow("exceeds the byte limit");

    const stalledFetch: typeof globalThis.fetch = async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    await expect(
      transport(stalledFetch, 10).negotiate({
        ...request,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeDefined();
    const cancelled = new AbortController();
    const pending = transport(stalledFetch, 1_000).negotiate({
      ...request,
      signal: cancelled.signal,
    });
    cancelled.abort();
    await expect(pending).rejects.toBeDefined();
    fixture.authority.close();
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "senawa-remote-composition-"));
  roots.add(root);
  const databasePath = join(root, "authority.db");
  const dependencies = { ...runtimeDependencies, sha256: deterministicSha256 };
  const authority = new SqliteSupervisorAuthority({
    databasePath,
    assetDirectory: join(root, "assets"),
    dependencies,
  });
  const document = createExampleWorkflowConfiguration();
  const snapshot = compileWorkflowConfiguration(
    {
      ...document,
      remote: {
        roleMappings: [
          {
            issuer: "https://identity.example.test",
            tenant: "tenant-alpha",
            upstreamRole: "operator",
            localRoles: ["worker"],
          },
        ],
        maximumRemoteAuthorizationLeaseSeconds: 900,
        synchronization: {
          classificationCeiling: "internal",
          receiptChain: true,
          events: true,
          projections: true,
          synchronizationState: true,
        },
      },
    },
    "fixture://remote-composition",
    deterministicSha256,
  );
  authority.commandAuthority.putConfigurationSnapshot(snapshot);
  const repositoryKey = generateKeyPairSync("ed25519");
  const controlPlaneKey = generateKeyPairSync("ed25519");
  const keyFile = join(root, "remote-key.json");
  writeFileSync(
    keyFile,
    canonicalStringify({
      apiVersion: "senawa.dev/remote-connector-enrollment/v1alpha1",
      binding: {
        apiVersion: REMOTE_PROTOCOL_VERSION,
        bindingId: "binding-composition",
        tenantId: "tenant-alpha",
        repositoryId: "repository-composition",
        connectorId: "connector-composition",
        repositoryKeyId: "key-repository-composition",
        controlPlaneKeyId: "key-control-plane-composition",
        revocationEpoch: 0,
        policyDigest: snapshot.componentDigests.remote,
        issuedAt: "2026-08-14T10:00:00.000Z",
      },
      configurationSnapshotDigest: snapshot.snapshotDigest,
      repositoryPrivateKeyPem: repositoryKey.privateKey.export({
        format: "pem",
        type: "pkcs8",
      }),
      repositoryPublicKeyPem: repositoryKey.publicKey.export({
        format: "pem",
        type: "spki",
      }),
      controlPlanePublicKeyPem: controlPlaneKey.publicKey.export({
        format: "pem",
        type: "spki",
      }),
    }),
    { mode: 0o600 },
  );
  return {
    root,
    authority,
    keyFile,
    factoryInput: {
      environment: {},
      databasePath,
      dependencies,
      supervisorApi: new SupervisorApi(authority),
      admissionAllocator: { allocationsFor: () => [] },
      fetch: async () => {
        throw new Error("network must remain lazy during composition");
      },
    },
  };
}
