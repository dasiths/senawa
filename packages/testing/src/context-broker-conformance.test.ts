import { canonicalStringify, PROTOCOL_VERSION } from "@senawa/protocol";
import { InMemoryContextAuthority } from "@senawa/runtime";
import { describe, expect, it } from "vitest";
import {
  contextBrokerSha256,
  createContextBrokerHarness,
  registerContextBrokerConformance,
} from "./context-broker-conformance.js";

registerContextBrokerConformance("in-memory");

describe("durable context authority hydration", () => {
  it("rejects canonical grant records containing bearer authority or changed budgets", () => {
    const harness = createContextBrokerHarness();
    const grant = harness.broker.grantAssetAccess({
      repositoryId: harness.dispatch.repositoryId,
      runId: harness.dispatch.runId,
      dispatchId: harness.dispatch.dispatchId,
      assetBindingId: harness.context.assets[0]?.assetBindingId ?? "",
      allowedPointer: "/work",
      readMode: "pointer-and-chunk",
      sensitivityCeiling: "confidential",
      expiresAt: "2026-08-13T11:00:00.000Z",
      maxOperations: 4,
      maxBytes: 512,
      maxChunkBytes: 64,
    });
    const snapshot = JSON.parse(harness.authority.toDurableCanonicalJson());
    snapshot.grants[0].envelope.grantToken = grant.grantToken;
    snapshot.grants[0].envelope.maxBytes = 513;

    expect(() =>
      InMemoryContextAuthority.fromDurableCanonicalJson(
        canonicalStringify(snapshot),
        contextBrokerSha256,
      ),
    ).toThrow();
  });

  it.each(["noncanonical", "grantToken"] as const)(
    "rejects %s persisted read replay keys",
    async (corruption) => {
      const harness = createContextBrokerHarness();
      const grant = harness.broker.grantAssetAccess({
        repositoryId: harness.dispatch.repositoryId,
        runId: harness.dispatch.runId,
        dispatchId: harness.dispatch.dispatchId,
        assetBindingId: harness.context.assets[0]?.assetBindingId ?? "",
        allowedPointer: "/work",
        readMode: "chunk",
        sensitivityCeiling: "confidential",
        expiresAt: "2026-08-13T11:00:00.000Z",
        maxOperations: 1,
        maxBytes: 4,
        maxChunkBytes: 4,
      });
      await harness.broker.readAsset({
        request: {
          apiVersion: PROTOCOL_VERSION,
          requestId: corruption === "noncanonical" ? "request_noncanonical" : "request_grant-token",
          grantToken: grant.grantToken,
          assetBindingId: harness.context.assets[0]?.assetBindingId ?? "",
          type: "chunk",
          offset: 0,
          length: 4,
        },
      });
      const snapshot = JSON.parse(harness.authority.toDurableCanonicalJson());
      const replay = JSON.parse(snapshot.reads[0].canonicalReplayKey);
      snapshot.reads[0].canonicalReplayKey =
        corruption === "noncanonical"
          ? JSON.stringify(replay, null, 2)
          : canonicalStringify({ ...replay, grantToken: grant.grantToken });

      expect(() =>
        InMemoryContextAuthority.fromDurableCanonicalJson(
          canonicalStringify(snapshot),
          contextBrokerSha256,
        ),
      ).toThrow();
    },
  );
});
