import { describe, expect, it } from "vitest";
import { matchSupervisorHttpRoute, SupervisorHttpRouteError } from "./http-router.js";

describe("supervisor HTTP route matching", () => {
  it("matches exact workflow, portal bootstrap, and session routes", () => {
    expect(matchSupervisorHttpRoute("GET", "/api/v1/capabilities")).toEqual({
      kind: "capabilities",
    });
    expect(
      matchSupervisorHttpRoute(
        "GET",
        "/api/v1/repositories/repository_a/runs/run_a/events?after=7&limit=32",
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
    expect(matchSupervisorHttpRoute("POST", "/api/v1/portal-sessions")).toEqual({
      kind: "portal-session-bootstrap",
    });
    expect(matchSupervisorHttpRoute("GET", "/api/v1/session")).toEqual({
      kind: "portal-session-descriptor",
    });
    expect(matchSupervisorHttpRoute("POST", "/api/v1/session")).toEqual({
      kind: "portal-session-csrf",
    });
    expect(matchSupervisorHttpRoute("GET", "/portal/")).toEqual({ kind: "portal-shell" });
    expect(matchSupervisorHttpRoute("GET", "/portal/assets/app.abc123.js")).toEqual({
      kind: "portal-asset",
      name: "app.abc123.js",
    });
  });

  it("matches bounded portal discovery, graph, activity, and artifact routes", () => {
    expect(
      matchSupervisorHttpRoute(
        "GET",
        "/api/v1/repositories/repository_a/runs/run_a/delivery?after=2&limit=256",
      ),
    ).toMatchObject({ kind: "portal-delivery-list", afterCursor: 2, limit: 256 });
    expect(
      matchSupervisorHttpRoute("GET", "/api/v1/repositories?after=repository_a&limit=10"),
    ).toEqual({ kind: "portal-repository-list", after: "repository_a", limit: 10 });
    expect(
      matchSupervisorHttpRoute(
        "GET",
        `/api/v1/repositories/repository_a/runs/run_a/graph/nodes?revision=${"a".repeat(64)}&after=2&limit=200`,
      ),
    ).toMatchObject({
      kind: "portal-graph-nodes",
      graphRevision: "a".repeat(64),
      afterCursor: 2,
      limit: 200,
    });
    expect(
      matchSupervisorHttpRoute(
        "GET",
        "/api/v1/repositories/repository_a/runs/run_a/activity/events?before=10&limit=100",
      ),
    ).toMatchObject({ kind: "portal-event-window", beforeCursor: 10, limit: 100 });
    expect(
      matchSupervisorHttpRoute(
        "GET",
        "/api/v1/repositories/repository_a/runs/run_a/artifacts/asset_a/content?offset=0&length=65536",
      ),
    ).toMatchObject({ kind: "portal-artifact-content", offset: 0, length: 65_536 });
    expect(
      matchSupervisorHttpRoute(
        "GET",
        "/api/v1/repositories/repository_a/runs/run_a/allowances/runner-command_a",
      ),
    ).toEqual({
      kind: "portal-allowance-review",
      repositoryId: "repository_a",
      runId: "run_a",
      resourceId: "runner-command_a",
    });
  });

  it("bounds owner-scoped transcript routes and refuses unknown owner kinds", () => {
    expect(
      matchSupervisorHttpRoute(
        "GET",
        "/api/v1/repositories/repository_a/runs/run_a/transcript/dispatch/dispatch_a?after=12&limit=200",
      ),
    ).toEqual({
      kind: "portal-transcript",
      repositoryId: "repository_a",
      runId: "run_a",
      ownerKind: "dispatch",
      ownerId: "dispatch_a",
      afterCursor: 12,
      limit: 200,
    });
    expect(
      matchSupervisorHttpRoute(
        "GET",
        "/api/v1/repositories/repository_a/runs/run_a/transcript/phase/phase_a",
      ),
    ).toEqual({
      kind: "portal-transcript",
      repositoryId: "repository_a",
      runId: "run_a",
      ownerKind: "phase",
      ownerId: "phase_a",
    });
    expectRouteError(400, () =>
      matchSupervisorHttpRoute(
        "GET",
        "/api/v1/repositories/repository_a/runs/run_a/transcript/task/task_a?limit=201",
      ),
    );
    expectRouteError(400, () =>
      matchSupervisorHttpRoute(
        "GET",
        "/api/v1/repositories/repository_a/runs/run_a/transcript/task/task_a?limit=0",
      ),
    );
    expectRouteError(400, () =>
      matchSupervisorHttpRoute(
        "GET",
        "/api/v1/repositories/repository_a/runs/run_a/transcript/task/task_a?cursor=1",
      ),
    );
    for (const cursor of ["-1", "abc", "01", "9007199254740992"]) {
      expectRouteError(400, () =>
        matchSupervisorHttpRoute(
          "GET",
          `/api/v1/repositories/repository_a/runs/run_a/transcript/task/task_a?after=${cursor}`,
        ),
      );
    }
    expectRouteError(404, () =>
      matchSupervisorHttpRoute(
        "GET",
        "/api/v1/repositories/repository_a/runs/run_a/transcript/criterion/criterion_a",
      ),
    );
    expectRouteError(400, () =>
      matchSupervisorHttpRoute(
        "GET",
        "/api/v1/repositories/repository_a/runs/run_a/transcript/dispatch/Dispatch%20A",
      ),
    );
    expectRouteError(405, () =>
      matchSupervisorHttpRoute(
        "POST",
        "/api/v1/repositories/repository_a/runs/run_a/transcript/dispatch/dispatch_a",
      ),
    );
  });

  it("matches exact supervisor operational routes and bounds log paging", () => {
    expect(matchSupervisorHttpRoute("GET", "/supervisor/v1/status")).toEqual({
      kind: "supervisor-status",
    });
    expect(matchSupervisorHttpRoute("POST", "/supervisor/v1/drain")).toEqual({
      kind: "supervisor-drain",
    });
    expect(matchSupervisorHttpRoute("POST", "/supervisor/v1/stop")).toEqual({
      kind: "supervisor-stop",
    });
    expect(matchSupervisorHttpRoute("POST", "/supervisor/v1/recoveries")).toEqual({
      kind: "supervisor-recovery",
    });
    expect(matchSupervisorHttpRoute("GET", "/supervisor/v1/logs?after=7&limit=32")).toEqual({
      kind: "supervisor-logs",
      afterCursor: 7,
      limit: 32,
    });
    expectRouteError(405, () => matchSupervisorHttpRoute("GET", "/supervisor/v1/recoveries"));
    expectRouteError(400, () => matchSupervisorHttpRoute("GET", "/supervisor/v1/logs?limit=1025"));
  });

  it.each([
    "http://127.0.0.1/api/v1/capabilities",
    "//api/v1/capabilities",
    "/api//v1/capabilities",
    "/api/./v1/capabilities",
    "/api/../v1/capabilities",
    "/api/%2e/v1/capabilities",
    "/api%2fv1/capabilities",
    "/api%5cv1/capabilities",
    "/api\\v1/capabilities",
    "/api/v1/capabilities%",
    "/api/v1/capabilities\0",
    "/api/v1/capabilities%00",
    "/api/v1/capabilities%1f",
    "/api/v1/capabilities%7F",
    "/portal/bootstrap?token=value%00",
    "/portal/bootstrap?token%1f=value",
  ])("rejects hostile raw target %s", (target) => {
    expectRouteError(400, () => matchSupervisorHttpRoute("GET", target));
  });

  it.each([
    "/api/v1/capabilities?unknown=1",
    "/api/v1/repositories/repository_a/runs/run_a/events?after=1&after=2",
    "/api/v1/repositories/repository_a/runs/run_a/events?after=-1",
    "/api/v1/repositories/repository_a/runs/run_a/events?limit=1025",
    "/portal/bootstrap",
    "/portal/bootstrap?token=a&token=b",
    "/api/v1/repositories/repository_a/runs/run_a/activity/events?after=1&before=2",
    "/api/v1/repositories/repository_a/runs/run_a/activity/events?limit=101",
    `/api/v1/repositories/repository_a/runs/run_a/graph/nodes?revision=${"a".repeat(64)}&limit=201`,
    "/api/v1/repositories/repository_a/runs/run_a/delivery?limit=257",
    "/api/v1/repositories/repository_a/runs/run_a/artifacts/asset_a/content?offset=0&length=65537",
  ])("rejects ambiguous or unknown query %s", (target) => {
    expectRouteError(400, () => matchSupervisorHttpRoute("GET", target));
  });

  it("returns exact not-found and method errors", () => {
    expectRouteError(404, () => matchSupervisorHttpRoute("GET", "/api/v1/missing"));
    expectRouteError(405, () => matchSupervisorHttpRoute("POST", "/api/v1/capabilities"));
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
