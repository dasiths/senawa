import { canonicalStringify, PROTOCOL_VERSION } from "@senawa/protocol";
import { describe, expect, it, vi } from "vitest";
import { PortalHttpClient, type PortalTransportError } from "./transport.js";

describe("portal HTTP transport", () => {
  it("loads and validates the exact escalation allowance review", async () => {
    const review = allowanceReview();
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(review));
    const client = new PortalHttpClient({ fetch: fetcher });
    await expect(
      client.allowanceReview("repository_alpha", "run_alpha", "runner-command_alpha"),
    ).resolves.toEqual(review);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "/api/v1alpha1/repositories/repository_alpha/runs/run_alpha/allowances/runner-command_alpha",
    );

    const tampered = new PortalHttpClient({
      fetch: async () => jsonResponse({ ...review, maxIncrease: review.maxIncrease + 1 }),
    });
    await expect(
      tampered.allowanceReview("repository_alpha", "run_alpha", "runner-command_alpha"),
    ).rejects.toThrow(/ceiling minus currentLimit/);
  });

  it("uses same-origin credentials and exact portal decoders", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, _init) =>
      jsonResponse({
        apiVersion: PROTOCOL_VERSION,
        expiresAt: "2026-08-14T20:00:00.000Z",
        csrfMode: "read-only",
        capabilities: ["portal-read-discovery"],
      }),
    );
    const client = new PortalHttpClient({ fetch: fetcher });
    await expect(client.session()).resolves.toMatchObject({ csrfMode: "read-only" });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin" });
  });

  it("bounds response bytes before decoding", async () => {
    const client = new PortalHttpClient({
      fetch: async () =>
        new Response("{}", { status: 200, headers: { "Content-Length": "999999" } }),
    });
    await expect(client.session()).rejects.toMatchObject({ code: "oversized-response" });
  });

  it("adapts supervisor receipt states and unwraps the exact terminal receipt", async () => {
    const queued = {
      sequence: 4,
      commandId: "command_alpha",
      repositoryId: "repository_alpha",
      runId: "run_alpha",
      status: "queued",
      recordedAt: "2026-08-14T12:00:00.000Z",
    } as const;
    const terminalReceipt = {
      apiVersion: PROTOCOL_VERSION,
      commandId: queued.commandId,
      repositoryId: queued.repositoryId,
      runId: queued.runId,
      status: "completed",
      cursor: 7,
      priorRevision: "revision_1",
      resultRevision: "revision_2",
      result: { accepted: true },
    } as const;
    const responses = [queued, { ...queued, sequence: 6, status: "terminal", terminalReceipt }];
    const client = new PortalHttpClient({
      fetch: async () => jsonResponse(responses.shift()),
    });

    await expect(client.receipt(queued.commandId)).resolves.toMatchObject({
      status: "queued",
      cursor: queued.sequence,
    });
    await expect(client.receipt(queued.commandId)).resolves.toEqual(terminalReceipt);
  });

  it("makes every 401 terminal through one callback and exposes only a safe error", async () => {
    const unauthorized = vi.fn();
    const client = new PortalHttpClient({
      fetch: async () =>
        jsonResponse(
          {
            apiVersion: PROTOCOL_VERSION,
            code: "unauthorized",
            message: "Portal session is invalid",
            retryable: false,
          },
          401,
        ),
      onUnauthorized: unauthorized,
    });
    await expect(client.session()).rejects.toEqual(
      expect.objectContaining<Partial<PortalTransportError>>({ status: 401, code: "unauthorized" }),
    );
    expect(unauthorized).toHaveBeenCalledOnce();
  });
});

function allowanceReview() {
  return {
    apiVersion: PROTOCOL_VERSION,
    repositoryId: "repository_alpha",
    runId: "run_alpha",
    escalationCommandId: "runner-command_alpha",
    escalationDigest: "a".repeat(64),
    operationId: "operation_alpha",
    unit: "model-millidollars",
    requested: 5,
    available: 1,
    createdAt: "2026-08-14T12:00:00.000Z",
    currentLimit: 10,
    maxIncrease: 15,
    ceiling: 25,
    allowancePolicyDigest: "b".repeat(64),
    resultingMax: 25,
    expectedGraphRevision: "c".repeat(64),
    expectedRunMode: "running",
    expectedRunModeRevision: 2,
  } as const;
}

function jsonResponse(value: unknown, status = 200): Response {
  const body = canonicalStringify(value);
  return new Response(body, {
    status,
    headers: {
      "Content-Length": String(new TextEncoder().encode(body).byteLength),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
