import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthenticatedPrincipal,
  type CommandEnvelope,
  type CommandSubmission,
  decodeCommandEnvelope,
  decodeEventReplayPage,
  decodeReceiptPage,
  type EventReplayPage,
  encodeEventReplayPage,
  encodeReceiptPage,
  type ProjectionEnvelope,
  type ReceiptPage,
  type SupervisorReceipt,
} from "@senawa/protocol";
import {
  createRuntimeGraph,
  deterministicSha256,
  runtimeCommand,
  runtimeFixture,
  runtimePrincipal,
} from "@senawa/testing";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  type AuthenticatedIngressContext,
  decodeSupervisorCommandAcceptance,
  encodeSupervisorCommandAcceptance,
  SupervisorApi,
  SupervisorApiError,
  type SupervisorCommandAcceptance,
} from "./api.js";
import {
  SqliteSupervisorAuthority,
  type SqliteSupervisorAuthorityOptions,
} from "./command-queue.js";
import { type AmendmentReviewRecord, decodeAmendmentReviewRecords } from "./contracts.js";
import { HttpSupervisorClient } from "./http-client.js";
import { SupervisorHttpHandler } from "./http-handler.js";
import { startLoopbackSupervisorServer, startUnixSupervisorServer } from "./http-server.js";
import { loadOrCreateLocalCredential } from "./local-security.js";
import { InMemoryRunEventNotifier } from "./run-event-notifier.js";
import { PortalSessionSecurity } from "./session-security.js";
import { SseEventSource } from "./sse.js";

interface TransportClient {
  capabilities(): Promise<ReturnType<SupervisorApi["capabilities"]>>;
  submitCommand(input: string | unknown): Promise<SupervisorCommandAcceptance>;
  getReceipt(input: string | unknown): Promise<SupervisorReceipt>;
  listReceipts(input: string | unknown): Promise<ReceiptPage>;
  listEvents(input: string | unknown): Promise<EventReplayPage>;
  getProjection(input: string | unknown): Promise<ProjectionEnvelope>;
  listAmendments(input: string | unknown): Promise<readonly AmendmentReviewRecord[]>;
  getAmendment(input: string | unknown): Promise<AmendmentReviewRecord>;
}

export interface SupervisorTransportConformanceHarness {
  readonly client: TransportClient;
  readonly expectedTransportKind: "cli" | "http";
  drain(repositoryId: string, runId: string): SupervisorReceipt | undefined;
  acceptedEnvelope(commandId: string): CommandEnvelope | undefined;
  pendingWakeCount(): number;
  loseNextSubmitResponse(): void;
  setAllocatorAvailable(available: boolean): void;
  setPrincipal(principal: AuthenticatedPrincipal): void;
  setRequestId(requestId: string): void;
  createEventReplayGap(): void;
  setMode(mode: "running" | "draining" | "drained" | "stopped"): void;
  dispose(): void | Promise<void>;
}

export type SupervisorTransportConformanceFactory = () =>
  | SupervisorTransportConformanceHarness
  | Promise<SupervisorTransportConformanceHarness>;

export function registerSupervisorTransportConformance(
  name: string,
  createHarness: SupervisorTransportConformanceFactory,
): void {
  describe(`${name} supervisor transport conformance`, () => {
    it("submits exactly, retries, reports conflicts, and preserves server attribution", async () => {
      const harness = await createHarness();
      try {
        const submission = instantiateSubmission("command_transport-exact");
        const accepted = await harness.client.submitCommand(submission);
        expect(accepted.receipt.status).toBe("queued");
        expect(await harness.client.submitCommand(submission)).toEqual(accepted);
        expect(harness.pendingWakeCount()).toBe(1);
        expect(harness.acceptedEnvelope(submission.commandId)).toMatchObject({
          principal: runtimePrincipal,
          transport: { kind: harness.expectedTransportKind, requestId: "request_transport" },
        });

        await expectApiError("command-conflict", 409, () =>
          harness.client.submitCommand({ ...submission, payload: { conflicting: true } }),
        );
        expect(await harness.client.getReceipt({ commandId: submission.commandId })).toEqual(
          accepted.receipt,
        );
      } finally {
        await harness.dispose();
      }
    });

    it("drains to bounded receipts, events, and projection queries", async () => {
      const harness = await createHarness();
      try {
        const submission = instantiateSubmission("command_transport-query");
        await harness.client.submitCommand(submission);
        const terminal = harness.drain(submission.repositoryId, submission.runId);
        expect(terminal?.status).toBe("terminal");
        expect(await harness.client.getReceipt({ commandId: submission.commandId })).toEqual(
          terminal,
        );

        const receipts = await harness.client.listReceipts({
          repositoryId: submission.repositoryId,
          runId: submission.runId,
          afterCursor: 0,
          limit: 2,
        });
        expect(receipts.receipts.map(({ cursor }) => cursor)).toEqual([1, 2]);
        expect(receipts).toMatchObject({ latestCursor: 3, hasMore: true });
        expect(
          await harness.client.listReceipts({
            repositoryId: submission.repositoryId,
            runId: submission.runId,
            afterCursor: 2,
            limit: 1,
          }),
        ).toMatchObject({ latestCursor: 3, hasMore: false, receipts: [{ cursor: 3 }] });

        const events = await harness.client.listEvents({
          repositoryId: submission.repositoryId,
          runId: submission.runId,
          afterCursor: 1,
          limit: 1,
        });
        expect(events).toMatchObject({
          earliestAvailableCursor: 1,
          latestCursor: 3,
          hasMore: true,
          events: [{ cursor: 2 }],
        });
        expect(
          (
            await harness.client.getProjection({
              repositoryId: submission.repositoryId,
              runId: submission.runId,
            })
          ).payload,
        ).toMatchObject({ status: "awaiting-completion" });
        await expectApiError(
          "invalid-request",
          400,
          () =>
            harness.client.listReceipts({
              repositoryId: submission.repositoryId,
              runId: submission.runId,
              afterCursor: 4,
            }),
          "Page cursor exceeds the latest authority cursor",
        );
        await expectApiError(
          "invalid-request",
          400,
          () =>
            harness.client.listEvents({
              repositoryId: submission.repositoryId,
              runId: submission.runId,
              afterCursor: 4,
            }),
          "Page cursor exceeds the latest authority cursor",
        );
        harness.createEventReplayGap();
        await expectApiError(
          "event-replay-gap",
          409,
          () =>
            harness.client.listEvents({
              repositoryId: submission.repositoryId,
              runId: submission.runId,
              afterCursor: 0,
            }),
          "Event cursor precedes the available replay range",
        );
      } finally {
        await harness.dispose();
      }
    });

    it("returns typed missing and limit errors and rejects hostile request fields", async () => {
      const harness = await createHarness();
      try {
        await expectApiError("not-found", 404, () =>
          harness.client.getReceipt({ commandId: "command_transport-missing" }),
        );
        expect(
          await harness.client.listAmendments({
            repositoryId: runtimeFixture.repositoryId,
            runId: runtimeFixture.runId,
          }),
        ).toEqual([]);
        await expectApiError("not-found", 404, () =>
          harness.client.getAmendment({
            repositoryId: runtimeFixture.repositoryId,
            runId: runtimeFixture.runId,
            amendmentId: "amendment-missing",
          }),
        );
        await expectApiError("not-found", 404, () =>
          harness.client.getProjection({
            repositoryId: "repository_missing",
            runId: "run_missing",
          }),
        );
        await expectApiError("invalid-request", 400, () =>
          harness.client.listEvents({
            repositoryId: runtimeFixture.repositoryId,
            runId: runtimeFixture.runId,
            limit: 1_025,
          }),
        );
        await expectApiError("invalid-request", 400, () =>
          harness.client.listReceipts({
            repositoryId: runtimeFixture.repositoryId,
            runId: runtimeFixture.runId,
            limit: 1,
            principal: runtimePrincipal,
          }),
        );
        await expectApiError("invalid-request", 400, () =>
          harness.client.submitCommand({
            ...instantiateSubmission("command_transport-hostile"),
            principal: runtimePrincipal,
            transport: { kind: "http", requestId: "client_override" },
          }),
        );
      } finally {
        await harness.dispose();
      }
    });

    it("recovers an accepted command after a lost response and retries exactly", async () => {
      const harness = await createHarness();
      try {
        const submission = instantiateSubmission("command_transport-lost-response");
        harness.loseNextSubmitResponse();
        await expect(harness.client.submitCommand(submission)).rejects.toThrow(
          "simulated lost response",
        );

        harness.setAllocatorAvailable(false);
        const replay = await harness.client.submitCommand(submission);
        expect(replay.receipt.status).toBe("queued");
        expect(harness.pendingWakeCount()).toBe(1);
        harness.setRequestId("request_transport_changed");
        await expectApiError("command-conflict", 409, () =>
          harness.client.submitCommand(submission),
        );
        harness.setRequestId("request_transport");
        harness.setPrincipal({ ...runtimePrincipal, subject: "user_changed" });
        await expectApiError("command-conflict", 409, () =>
          harness.client.submitCommand(submission),
        );
        const fresh = instantiateSubmission("command_transport-allocation-failure");
        await expectApiError(
          "internal-error",
          500,
          () => harness.client.submitCommand(fresh),
          "Supervisor request failed",
        );
        expect(harness.acceptedEnvelope(fresh.commandId)).toBeUndefined();
        expect(harness.drain(submission.repositoryId, submission.runId)?.status).toBe("terminal");
      } finally {
        await harness.dispose();
      }
    });

    it("accepts while draining and refuses drained or stopped admissions without mutation", async () => {
      const harness = await createHarness();
      try {
        harness.setMode("draining");
        expect(
          (await harness.client.submitCommand(instantiateSubmission("command_transport-draining")))
            .receipt.status,
        ).toBe("queued");
        const pendingWakeCount = harness.pendingWakeCount();
        const drained = instantiateSubmission("command_transport-drained");
        harness.setMode("drained");
        await expectApiError("service-unavailable", 503, () =>
          harness.client.submitCommand(drained),
        );
        expect(harness.pendingWakeCount()).toBe(pendingWakeCount);
        expect(harness.acceptedEnvelope(drained.commandId)).toBeUndefined();

        const stopped = instantiateSubmission("command_transport-stopped");
        harness.setMode("stopped");
        await expectApiError("service-unavailable", 503, () =>
          harness.client.submitCommand(stopped),
        );
        expect(harness.pendingWakeCount()).toBe(pendingWakeCount);
        expect(harness.acceptedEnvelope(stopped.commandId)).toBeUndefined();
      } finally {
        await harness.dispose();
      }
    });

    it("advertises the bounded transport-neutral capabilities", async () => {
      const harness = await createHarness();
      try {
        expect((await harness.client.capabilities()).capabilities).toEqual([
          "amendment-review",
          "command-submit",
          "event-replay",
          "projection-read",
          "receipt-read",
        ]);
      } finally {
        await harness.dispose();
      }
    });
  });
}

registerSupervisorTransportConformance("in-process", createInProcessHarness);
registerSupervisorTransportConformance("authenticated UDS", () => createHttpHarness("ipc"));
registerSupervisorTransportConformance("loopback session", () => createHttpHarness("loopback"));

describe("concurrent supervisor HTTP acceptance", () => {
  it("allocates once for exact simultaneous submissions from independent clients", async () => {
    const harness = await createConcurrentClientHarness("request_concurrent", "request_concurrent");
    try {
      const submission = instantiateSubmission("command_transport-concurrent-exact");
      const [first, second] = await Promise.all([
        harness.clients[0].submitCommand(submission),
        harness.clients[1].submitCommand(submission),
      ]);
      expect(second).toEqual(first);
      expect(harness.allocationInvocations()).toBe(1);
      expect(harness.pendingWakeCount()).toBe(1);
    } finally {
      await harness.dispose();
    }
  });

  it("accepts one and conflicts one when server attribution differs", async () => {
    const harness = await createConcurrentClientHarness(
      "request_concurrent_a",
      "request_concurrent_b",
    );
    try {
      const submission = instantiateSubmission("command_transport-concurrent-conflict");
      const results = await Promise.allSettled([
        harness.clients[0].submitCommand(submission),
        harness.clients[1].submitCommand(submission),
      ]);
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      const rejected = results.find(({ status }) => status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: { code: "command-conflict", status: 409 },
      });
      expect(harness.allocationInvocations()).toBe(1);
      expect(harness.pendingWakeCount()).toBe(1);
    } finally {
      await harness.dispose();
    }
  });
});

function createInProcessHarness(): SupervisorTransportConformanceHarness {
  const root = mkdtempSync(join(tmpdir(), "senawa-supervisor-api-"));
  const options: SqliteSupervisorAuthorityOptions = {
    databasePath: join(root, "authority.db"),
    assetDirectory: join(root, "assets"),
    dependencies: {
      sha256: deterministicSha256,
      authorization: { authorize: () => true },
    },
  };
  const authority = new SqliteSupervisorAuthority(options);
  const api = new SupervisorApi(authority);
  let principal: AuthenticatedPrincipal = runtimePrincipal;
  let requestId = "request_transport";
  let allocatorAvailable = true;
  const context: Omit<AuthenticatedIngressContext, "principal" | "requestId"> = {
    transportKind: "cli",
    admission: {
      currentTime: runtimeFixture.currentTime,
      facts: { source: "transport-conformance" },
      allocator: {
        allocationsFor(submission) {
          if (!allocatorAvailable) throw new Error("private allocator failure detail");
          return [1, 2, 3].map((ordinal) => ({
            kind: "stream-event" as const,
            id: `stream-event-${submission.commandId}-${ordinal}`,
          }));
        },
      },
    },
  };
  let loseSubmitResponse = false;
  const client: TransportClient = {
    capabilities: async () => api.capabilities(),
    async submitCommand(input) {
      const acceptance = decodeSupervisorCommandAcceptance(
        encodeSupervisorCommandAcceptance(
          api.submitCommand(input, { ...context, principal, requestId }),
        ),
      );
      if (loseSubmitResponse) {
        loseSubmitResponse = false;
        throw new Error("simulated lost response");
      }
      return acceptance;
    },
    getReceipt: async (input) => api.getReceipt(input),
    async listReceipts(input) {
      return decodeReceiptPage(encodeReceiptPage(api.listReceipts(input)));
    },
    async listEvents(input) {
      return decodeEventReplayPage(encodeEventReplayPage(api.listEvents(input)));
    },
    getProjection: async (input) => api.getProjection(input),
    async listAmendments(input) {
      return decodeAmendmentReviewRecords(api.listAmendments(input));
    },
    getAmendment: async (input) => api.getAmendment(input),
  };
  return {
    client,
    expectedTransportKind: "cli",
    drain(repositoryId, runId) {
      const lease = authority.acquireRunLease(
        repositoryId,
        runId,
        "owner_transport",
        runtimeFixture.currentTime,
        "2026-08-12T12:01:00.000Z",
      );
      return authority.drainRunOnce({
        repositoryId,
        runId,
        lease,
        currentTime: runtimeFixture.currentTime,
      });
    },
    acceptedEnvelope(commandId) {
      const database = new Database(options.databasePath, { readonly: true });
      try {
        const row = database
          .prepare<[string], { canonical_envelope: string }>(
            "SELECT canonical_envelope FROM supervisor_commands WHERE command_id = ?",
          )
          .get(commandId);
        return row === undefined ? undefined : decodeCommandEnvelope(row.canonical_envelope);
      } finally {
        database.close();
      }
    },
    pendingWakeCount: () => authority.listPendingWakes().length,
    loseNextSubmitResponse() {
      loseSubmitResponse = true;
    },
    setAllocatorAvailable(available) {
      allocatorAvailable = available;
    },
    setPrincipal(nextPrincipal) {
      principal = nextPrincipal;
    },
    setRequestId(nextRequestId) {
      requestId = nextRequestId;
    },
    createEventReplayGap() {
      const database = new Database(options.databasePath);
      try {
        database.exec(
          "DELETE FROM event_frames WHERE cursor = (SELECT MIN(cursor) FROM event_frames)",
        );
      } finally {
        database.close();
      }
    },
    setMode(mode) {
      authority.setMode(mode, runtimeFixture.currentTime);
    },
    dispose() {
      authority.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function createHttpHarness(
  transport: "ipc" | "loopback",
): Promise<SupervisorTransportConformanceHarness> {
  const root = mkdtempSync(join(tmpdir(), `senawa-supervisor-${transport}-`));
  const runtimeDirectory = join(root, "runtime");
  const options: SqliteSupervisorAuthorityOptions = {
    databasePath: join(root, "authority.db"),
    assetDirectory: join(root, "assets"),
    dependencies: {
      sha256: deterministicSha256,
      authorization: { authorize: () => true },
    },
  };
  const notifier = new InMemoryRunEventNotifier();
  const authority = new SqliteSupervisorAuthority({ ...options, eventNotifier: notifier });
  const api = new SupervisorApi(authority);
  const credential = loadOrCreateLocalCredential(runtimeDirectory, {
    bytes: (length) => randomBytes(length),
  });
  const sessions = new PortalSessionSecurity({
    clock: { now: () => Date.now() },
    random: { bytes: (length) => randomBytes(length) },
  });
  let principal: AuthenticatedPrincipal = runtimePrincipal;
  let requestId = "request_transport";
  let allocatorAvailable = true;
  const contextFactory = (_request: unknown, transportKind: "cli" | "http") => ({
    principal,
    transportKind,
    requestId,
    admission: {
      currentTime: runtimeFixture.currentTime,
      facts: { source: "transport-conformance" },
      allocator: {
        allocationsFor(submission: CommandSubmission) {
          if (!allocatorAvailable) throw new Error("private allocator failure detail");
          return [1, 2, 3].map((ordinal) => ({
            kind: "stream-event" as const,
            id: `stream-event-${submission.commandId}-${ordinal}`,
          }));
        },
      },
    },
  });
  const sse = new SseEventSource({ api, notifier, stopped: () => authority.mode() === "stopped" });
  const ipcHandler = new SupervisorHttpHandler({
    api,
    transport: "ipc",
    credential,
    sessions,
    contextFactory,
    sse,
  });
  const ipcServer = await startUnixSupervisorServer(
    join(runtimeDirectory, "supervisor.sock"),
    ipcHandler,
  );
  const ipcClient = new HttpSupervisorClient({
    socketPath: requiredString(ipcServer.socketPath),
    credential: credential.token,
  });
  let loopbackServer: Awaited<ReturnType<typeof startLoopbackSupervisorServer>> | undefined;
  let baseClient: HttpSupervisorClient;
  if (transport === "ipc") {
    baseClient = ipcClient;
  } else {
    loopbackServer = await startLoopbackSupervisorServer(
      0,
      (origin) =>
        new SupervisorHttpHandler({
          api,
          transport: "loopback",
          sessions,
          loopbackOrigin: origin,
          contextFactory,
          sse,
        }),
    );
    baseClient = new HttpSupervisorClient({ baseUrl: requiredString(loopbackServer.origin) });
    const bootstrap = await ipcClient.createPortalSession();
    await baseClient.consumePortalBootstrap(bootstrap.path);
  }
  let loseSubmitResponse = false;
  const client: TransportClient = {
    capabilities: () => baseClient.capabilities(),
    async submitCommand(input) {
      const acceptance = await baseClient.submitCommand(input);
      if (loseSubmitResponse) {
        loseSubmitResponse = false;
        throw new Error("simulated lost response");
      }
      return acceptance;
    },
    getReceipt: (input) => baseClient.getReceipt(input),
    listReceipts: (input) => baseClient.listReceipts(input),
    listEvents: (input) => baseClient.listEvents(input),
    getProjection: (input) => baseClient.getProjection(input),
    listAmendments: (input) => baseClient.listAmendments(input),
    getAmendment: (input) => baseClient.getAmendment(input),
  };
  return {
    client,
    expectedTransportKind: transport === "ipc" ? "cli" : "http",
    drain(repositoryId, runId) {
      const lease = authority.acquireRunLease(
        repositoryId,
        runId,
        "owner_transport",
        runtimeFixture.currentTime,
        "2026-08-12T12:01:00.000Z",
      );
      return authority.drainRunOnce({
        repositoryId,
        runId,
        lease,
        currentTime: runtimeFixture.currentTime,
      });
    },
    acceptedEnvelope(commandId) {
      const database = new Database(options.databasePath, { readonly: true });
      try {
        const row = database
          .prepare<[string], { canonical_envelope: string }>(
            "SELECT canonical_envelope FROM supervisor_commands WHERE command_id = ?",
          )
          .get(commandId);
        return row === undefined ? undefined : decodeCommandEnvelope(row.canonical_envelope);
      } finally {
        database.close();
      }
    },
    pendingWakeCount: () => authority.listPendingWakes().length,
    loseNextSubmitResponse() {
      loseSubmitResponse = true;
    },
    setAllocatorAvailable(available) {
      allocatorAvailable = available;
    },
    setPrincipal(nextPrincipal) {
      principal = nextPrincipal;
    },
    setRequestId(nextRequestId) {
      requestId = nextRequestId;
    },
    createEventReplayGap() {
      const database = new Database(options.databasePath);
      try {
        database.exec(
          "DELETE FROM event_frames WHERE cursor = (SELECT MIN(cursor) FROM event_frames)",
        );
      } finally {
        database.close();
      }
    },
    setMode(mode) {
      authority.setMode(mode, runtimeFixture.currentTime);
    },
    async dispose() {
      await loopbackServer?.close();
      await ipcServer.close();
      authority.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function createConcurrentClientHarness(
  firstRequestId: string,
  secondRequestId: string,
): Promise<{
  readonly clients: readonly [HttpSupervisorClient, HttpSupervisorClient];
  allocationInvocations(): number;
  pendingWakeCount(): number;
  dispose(): Promise<void>;
}> {
  const root = mkdtempSync(join(tmpdir(), "senawa-supervisor-concurrent-"));
  const runtimeDirectory = join(root, "runtime");
  const authority = new SqliteSupervisorAuthority({
    databasePath: join(root, "authority.db"),
    assetDirectory: join(root, "assets"),
    dependencies: {
      sha256: deterministicSha256,
      authorization: { authorize: () => true },
    },
  });
  const api = new SupervisorApi(authority);
  const credential = loadOrCreateLocalCredential(runtimeDirectory, {
    bytes: (length) => randomBytes(length),
  });
  let allocationInvocations = 0;
  const handler = (requestId: string) =>
    new SupervisorHttpHandler({
      api,
      transport: "ipc",
      credential,
      contextFactory: (_request, transportKind) => ({
        principal: runtimePrincipal,
        transportKind,
        requestId,
        admission: {
          currentTime: runtimeFixture.currentTime,
          facts: { source: "concurrent-transport-conformance" },
          allocator: {
            allocationsFor(submission) {
              allocationInvocations += 1;
              return [1, 2, 3].map((ordinal) => ({
                kind: "stream-event" as const,
                id: `stream-event-${submission.commandId}-${ordinal}`,
              }));
            },
          },
        },
      }),
    });
  const servers = await Promise.all([
    startUnixSupervisorServer(join(runtimeDirectory, "first.sock"), handler(firstRequestId)),
    startUnixSupervisorServer(join(runtimeDirectory, "second.sock"), handler(secondRequestId)),
  ]);
  const clients = servers.map(
    (server) =>
      new HttpSupervisorClient({
        socketPath: requiredString(server.socketPath),
        credential: credential.token,
      }),
  ) as [HttpSupervisorClient, HttpSupervisorClient];
  return {
    clients,
    allocationInvocations: () => allocationInvocations,
    pendingWakeCount: () => authority.listPendingWakes().length,
    async dispose() {
      await Promise.all(servers.map((server) => server.close()));
      authority.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function instantiateSubmission(commandId: string): CommandSubmission {
  const envelope = runtimeCommand({
    commandId,
    intent: "instantiate-run",
    payload: {
      workflowId: runtimeFixture.workflowId,
      configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
      execution: runtimeFixture.execution,
      graph: createRuntimeGraph(),
      phase: runtimeFixture.phase,
      approvalPolicy: { policy: "approval-required", authority: runtimePrincipal },
      escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
      allowancePolicy: runtimeFixture.allowancePolicy,
    },
  });
  const { principal: _principal, transport: _transport, ...submission } = envelope;
  return submission;
}

async function expectApiError(
  code: string,
  status: number,
  operation: () => unknown | Promise<unknown>,
  message?: string,
): Promise<void> {
  try {
    await operation();
    expect.fail("Expected supervisor API operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(SupervisorApiError);
    expect(error).toMatchObject({ code, status, safe: true });
    if (message !== undefined) expect(error).toMatchObject({ message });
  }
}

function requiredString(value: string | undefined): string {
  if (value === undefined) throw new Error("Expected supervisor server address is missing");
  return value;
}
