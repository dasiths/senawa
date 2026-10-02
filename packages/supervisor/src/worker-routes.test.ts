import { describe, expect, it } from "vitest";
import { matchSupervisorHttpRoute, SupervisorHttpRouteError } from "./http-router.js";

describe("worker routes", () => {
  it("routes the three worker operations to their dispatch", () => {
    expect(matchSupervisorHttpRoute("GET", "/api/v1/worker/dispatch_abc/context")).toEqual({
      kind: "worker-context",
      dispatchId: "dispatch_abc",
    });
    expect(matchSupervisorHttpRoute("GET", "/api/v1/worker/dispatch_abc/output-schema")).toEqual({
      kind: "worker-output-schema",
      dispatchId: "dispatch_abc",
    });
    expect(matchSupervisorHttpRoute("POST", "/api/v1/worker/dispatch_abc/submissions")).toEqual({
      kind: "worker-submission",
      dispatchId: "dispatch_abc",
    });
  });

  it("refuses a submission sent as a read", () => {
    expect(() =>
      matchSupervisorHttpRoute("GET", "/api/v1/worker/dispatch_abc/submissions"),
    ).toThrowError(SupervisorHttpRouteError);
  });

  it("refuses an operation the worker surface does not offer", () => {
    // A worker must not reach human authority, so no route resolves to one.
    expect(() =>
      matchSupervisorHttpRoute("POST", "/api/v1/worker/dispatch_abc/approve"),
    ).toThrowError(SupervisorHttpRouteError);
  });

  it("refuses a malformed dispatch identity", () => {
    expect(() =>
      matchSupervisorHttpRoute("GET", "/api/v1/worker/not a dispatch/context"),
    ).toThrowError(SupervisorHttpRouteError);
  });
});
