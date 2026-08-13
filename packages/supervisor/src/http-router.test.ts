import { describe, expect, it } from "vitest";
import { matchSupervisorHttpRoute, SupervisorHttpRouteError } from "./http-router.js";

describe("supervisor HTTP route matching", () => {
  it("matches exact workflow, portal bootstrap, and session routes", () => {
    expect(matchSupervisorHttpRoute("GET", "/api/v1alpha1/capabilities")).toEqual({
      kind: "capabilities",
    });
    expect(
      matchSupervisorHttpRoute(
        "GET",
        "/api/v1alpha1/repositories/repository_a/runs/run_a/events?after=7&limit=32",
      ),
    ).toEqual({
      kind: "event-page",
      repositoryId: "repository_a",
      runId: "run_a",
      afterCursor: 7,
      limit: 32,
    });
    expect(matchSupervisorHttpRoute("GET", "/portal/bootstrap?token=secret-value")).toEqual({
      kind: "portal-bootstrap",
      token: "secret-value",
    });
    expect(matchSupervisorHttpRoute("POST", "/api/v1alpha1/portal-sessions")).toEqual({
      kind: "portal-session-bootstrap",
    });
  });

  it("matches exact supervisor operational routes and bounds log paging", () => {
    expect(matchSupervisorHttpRoute("GET", "/supervisor/v1alpha1/status")).toEqual({
      kind: "supervisor-status",
    });
    expect(matchSupervisorHttpRoute("POST", "/supervisor/v1alpha1/drain")).toEqual({
      kind: "supervisor-drain",
    });
    expect(matchSupervisorHttpRoute("POST", "/supervisor/v1alpha1/stop")).toEqual({
      kind: "supervisor-stop",
    });
    expect(matchSupervisorHttpRoute("POST", "/supervisor/v1alpha1/recoveries")).toEqual({
      kind: "supervisor-recovery",
    });
    expect(matchSupervisorHttpRoute("GET", "/supervisor/v1alpha1/logs?after=7&limit=32")).toEqual({
      kind: "supervisor-logs",
      afterCursor: 7,
      limit: 32,
    });
    expectRouteError(405, () => matchSupervisorHttpRoute("GET", "/supervisor/v1alpha1/recoveries"));
    expectRouteError(400, () =>
      matchSupervisorHttpRoute("GET", "/supervisor/v1alpha1/logs?limit=1025"),
    );
  });

  it.each([
    "http://127.0.0.1/api/v1alpha1/capabilities",
    "//api/v1alpha1/capabilities",
    "/api//v1alpha1/capabilities",
    "/api/./v1alpha1/capabilities",
    "/api/../v1alpha1/capabilities",
    "/api/%2e/v1alpha1/capabilities",
    "/api%2fv1alpha1/capabilities",
    "/api%5cv1alpha1/capabilities",
    "/api\\v1alpha1/capabilities",
    "/api/v1alpha1/capabilities%",
    "/api/v1alpha1/capabilities\0",
    "/api/v1alpha1/capabilities%00",
    "/api/v1alpha1/capabilities%1f",
    "/api/v1alpha1/capabilities%7F",
    "/portal/bootstrap?token=value%00",
    "/portal/bootstrap?token%1f=value",
  ])("rejects hostile raw target %s", (target) => {
    expectRouteError(400, () => matchSupervisorHttpRoute("GET", target));
  });

  it.each([
    "/api/v1alpha1/capabilities?unknown=1",
    "/api/v1alpha1/repositories/repository_a/runs/run_a/events?after=1&after=2",
    "/api/v1alpha1/repositories/repository_a/runs/run_a/events?after=-1",
    "/api/v1alpha1/repositories/repository_a/runs/run_a/events?limit=1025",
    "/portal/bootstrap",
    "/portal/bootstrap?token=a&token=b",
  ])("rejects ambiguous or unknown query %s", (target) => {
    expectRouteError(400, () => matchSupervisorHttpRoute("GET", target));
  });

  it("returns exact not-found and method errors", () => {
    expectRouteError(404, () => matchSupervisorHttpRoute("GET", "/api/v1alpha1/missing"));
    expectRouteError(405, () => matchSupervisorHttpRoute("POST", "/api/v1alpha1/capabilities"));
  });
});

function expectRouteError(status: number, operation: () => unknown): void {
  try {
    operation();
    expect.fail("Expected route matching to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(SupervisorHttpRouteError);
    expect(error).toMatchObject({ status });
  }
}
