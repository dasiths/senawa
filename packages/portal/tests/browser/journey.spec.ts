import { type Browser, expect, type Page, test } from "@playwright/test";
import {
  bootstrapPortal,
  controlOrigin,
  navigate,
  portalHash,
  repositoryForRun,
  runs,
  selectRun,
} from "./support.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

test("reconnects from the last cursor, deduplicates replay, and resynchronizes a typed gap", async ({
  browser,
  page,
}) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  const before = await visibleCursor(page);
  // The portal opens on the graph. Run controls live on the overview.
  await navigate(page, "Overview");
  await page.getByRole("button", { name: "Pause" }).click();
  await page.getByRole("button", { name: "Confirm pause" }).click();
  await expect.poll(() => visibleCursor(page)).toBeGreaterThan(before);
  await page.getByRole("button", { name: "Resume" }).click();
  await page.getByRole("button", { name: "Confirm resume" }).click();
  await expect(page.getByText("Run running", { exact: true })).toBeVisible();
  const event = await latestEvent(page, runs.journey);

  const simulated = await simulatedEventPortal(browser);
  const simulatedCursor = await visibleCursor(simulated.page);
  await simulated.page.evaluate((frame) => {
    window.__senawaEventSources?.at(-1)?.emit("message", JSON.stringify(frame));
  }, event);
  expect(await visibleCursor(simulated.page)).toBe(simulatedCursor);

  const sourceCount = await simulated.page.evaluate(() => window.__senawaEventSources?.length ?? 0);
  let reconnectPreflights = 0;
  await simulated.page.route("**/api/v1/session", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    reconnectPreflights += 1;
    if (reconnectPreflights === 1) return route.abort("failed");
    return route.continue();
  });
  await simulated.page.evaluate(() => window.__senawaEventSources?.at(-1)?.fail());
  await expect
    .poll(() => simulated.page.evaluate(() => window.__senawaEventSources?.length ?? 0), {
      timeout: 10_000,
    })
    .toBeGreaterThan(sourceCount);
  expect(reconnectPreflights).toBeGreaterThanOrEqual(2);
  const reconnectUrl = await simulated.page.evaluate(
    () => window.__senawaEventSources?.at(-1)?.url ?? "",
  );
  expect(
    Number(new URL(reconnectUrl, "http://portal.test").searchParams.get("after")),
  ).toBeGreaterThanOrEqual(simulatedCursor);

  let releaseOverview: (() => void) | undefined;
  const overviewGate = new Promise<void>((resolvePromise) => {
    releaseOverview = resolvePromise;
  });
  await simulated.page.route("**/overview", async (route) => {
    if (!route.request().url().includes(runs.journey)) return route.continue();
    await overviewGate;
    await route.continue();
  });
  await simulated.page.evaluate(
    (gap) => {
      window.__senawaEventSources?.at(-1)?.emit("gap", JSON.stringify(gap));
    },
    {
      apiVersion: "senawa.dev/protocol/v1",
      code: "replay-gap",
      message: "Deterministic browser replay gap",
      retryable: true,
    },
  );
  await expect(simulated.page.getByText("Connection resyncing", { exact: true })).toBeVisible();
  await expect(simulated.page.locator(".run-controls button")).toHaveCount(0);
  await expect(simulated.page.locator(".need-row button:not([disabled])")).toHaveCount(0);
  releaseOverview?.();
  await expect(simulated.page.getByText("Connection live", { exact: true })).toBeVisible();
  await simulated.page.unroute("**/overview");
  await simulated.context.close();
  expect(diagnostics.severe([/net::ERR_FAILED/u])).toEqual([]);
});

test("reloads authority after an event races the final overview read", async ({ browser }) => {
  const main = await simulatedEventPortal(browser, runs.workspace);
  const { page, diagnostics } = main;
  // This test is about the overview read, so the main page has to be on it.
  await navigate(page, "Overview");
  let overviewRequests = 0;
  let staleOverviewReady = false;
  let releaseStaleOverview: (() => void) | undefined;
  const staleOverviewGate = new Promise<void>((resolvePromise) => {
    releaseStaleOverview = resolvePromise;
  });
  await page.route("**/overview", async (route) => {
    if (!route.request().url().includes(runs.workspace)) return route.continue();
    overviewRequests += 1;
    if (overviewRequests !== 2) return route.continue();
    const response = await route.fetch();
    staleOverviewReady = true;
    await staleOverviewGate;
    await route.fulfill({ response });
  });

  const initialCursor = await visibleCursor(page);
  const initialEvent = (await latestEvent(page, runs.workspace)) as Record<string, unknown>;
  await page.evaluate(
    (frame) => {
      window.__senawaEventSources?.at(-1)?.emit("message", JSON.stringify(frame));
    },
    {
      ...initialEvent,
      cursor: initialCursor + 1,
      eventId: "event_trigger-active-load",
    },
  );
  await expect.poll(() => staleOverviewReady).toBe(true);

  const controller = await simulatedEventPortal(browser, runs.workspace);
  await navigate(controller.page, "Overview");
  await controller.page.getByRole("button", { name: "Pause" }).click();
  await controller.page.getByRole("button", { name: "Confirm pause" }).click();
  await expect(controller.page.getByText("Run paused", { exact: true })).toBeVisible();
  const pauseEvent = await latestEvent(controller.page, runs.workspace);
  await page.evaluate((frame) => {
    window.__senawaEventSources?.at(-1)?.emit("message", JSON.stringify(frame));
  }, pauseEvent);
  releaseStaleOverview?.();
  await expect(page.getByText("Run paused", { exact: true })).toBeVisible();

  await controller.page.getByRole("button", { name: "Resume" }).click();
  await controller.page.getByRole("button", { name: "Confirm resume" }).click();
  await expect(controller.page.getByText("Run running", { exact: true })).toBeVisible();
  const resumeEvent = await latestEvent(controller.page, runs.workspace);
  await page.evaluate((frame) => {
    window.__senawaEventSources?.at(-1)?.emit("message", JSON.stringify(frame));
  }, resumeEvent);
  await expect(page.getByText("Run running", { exact: true })).toBeVisible();
  expect(diagnostics.severe()).toEqual([]);
  await page.unroute("**/overview");
  await controller.context.close();
  await main.context.close();
});

test("grants the exact maximum allowance through a reviewed command", async ({ browser }) => {
  const portal = await simulatedEventPortal(browser);
  await reviewNeed(portal.page, "escalation");
  const dialog = portal.page.getByRole("dialog");
  const maximum = Number(await dialog.getByLabel("Allowance increase").getAttribute("max"));
  expect(maximum).toBeGreaterThan(0);
  await dialog.getByLabel("Allowance increase").fill(String(maximum));
  await expect(dialog).toContainText(`Resulting limit: ${maximum + 1}`);
  await dialog.getByRole("button", { name: "Grant bounded allowance" }).click();
  await expectPendingClear(portal.page);
  await expect(portal.page.locator(".need-row").filter({ hasText: "escalation" })).toHaveCount(0);
  await portal.context.close();
});

test("preserves reviewed values across rerenders and closes authority on run changes", async ({
  browser,
}) => {
  const portal = await simulatedEventPortal(browser);
  const { page } = portal;
  await reviewNeed(page, "amendment-decision");
  const amendmentDialog = page.getByRole("dialog");
  const decision = amendmentDialog.getByLabel("Decision");
  await decision.selectOption("reject");
  await decision.focus();
  const event = await latestEvent(page, runs.journey);
  await page.evaluate((frame) => {
    window.__senawaEventSources?.at(-1)?.emit("message", JSON.stringify(frame));
  }, event);
  await expect(decision).toHaveValue("reject");
  await expect(decision).toBeFocused();
  await amendmentDialog.press("Escape");

  await selectRun(page, runs.workspace);
  await navigate(page, "Overview");
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("dialog")).toContainText("runModeRevision");
  const commandRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/v1/commands")) {
      commandRequests.push(request.postData() ?? "");
    }
  });
  await page.evaluate(
    (hash) => {
      location.hash = hash;
    },
    portalHash(runs.journey, "overview"),
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Select repository and run" })).toHaveValue(
    `${repositoryForRun(runs.journey)}\u0000${runs.journey}`,
  );
  expect(commandRequests).toEqual([]);
  await portal.context.close();
});

test("publishes only the selected run when authority loads overlap", async ({ browser }) => {
  const portal = await simulatedEventPortal(browser);
  const { page, diagnostics } = portal;
  await selectRun(page, runs.workspace);
  await expect(page.locator(".nav-facts dd").first()).toHaveText("running");
  await selectRun(page, runs.journey);
  await expect(page.locator(".nav-facts dd").first()).toHaveText("running");
  const staleEvent = {
    ...((await latestEvent(page, runs.journey)) as Record<string, unknown>),
    cursor: 999_999,
    eventId: "event_stale-run-after-selection",
  };
  const sourceCount = await page.evaluate(() => window.__senawaEventSources?.length ?? 0);

  let releaseJourneyOverview: (() => void) | undefined;
  const journeyOverviewGate = new Promise<void>((resolvePromise) => {
    releaseJourneyOverview = resolvePromise;
  });
  let gatedRequests = 0;
  await page.route("**/overview", async (route) => {
    if (!route.request().url().includes(runs.journey)) return route.continue();
    gatedRequests += 1;
    await journeyOverviewGate;
    await route.continue();
  });
  await navigate(page, "Workflow");
  await expect.poll(() => gatedRequests).toBeGreaterThan(0);
  await selectRun(page, runs.workspace);
  await page.evaluate((frame) => {
    const source = window.__senawaEventSources?.at(-1);
    source?.emit("message", JSON.stringify(frame));
    source?.fail();
  }, staleEvent);
  releaseJourneyOverview?.();

  await expect(page.locator(".nav-facts dd").first()).toHaveText("running");
  await expect(page.getByRole("region", { name: "Portal status" })).toContainText("Data current");
  await expect(page.getByRole("region", { name: "Portal status" })).toContainText("2 human needs");
  await expect(page.getByRole("heading", { name: "Workflow", level: 1 })).toBeVisible();
  await expect(page.locator(".workflow-tree .tree-item")).not.toHaveCount(0);
  expect(await visibleCursor(page)).toBeLessThan(999_999);
  await expect
    .poll(() => page.evaluate(() => window.__senawaEventSources?.length ?? 0))
    .toBe(sourceCount + 1);
  expect(diagnostics.severe()).toEqual([]);
  await page.unroute("**/overview");
  await portal.context.close();
});

test("records exact human decisions with pending recovery", async ({ page }) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);

  const secondTab = await page.context().newPage();
  await secondTab.goto(`${new URL(page.url()).origin}/portal/`);
  await expect(secondTab.getByText("read-only", { exact: true })).toBeVisible();
  await selectRun(secondTab, runs.journey);
  await expect(secondTab.locator(".need-row button:not([disabled])")).toHaveCount(0);
  await secondTab.close();

  const questionBodies: string[] = [];
  const questionPersistedBeforeEffect: boolean[] = [];
  let observeQuestionRoute: (() => void) | undefined;
  const questionRouteObserved = new Promise<void>((resolvePromise) => {
    observeQuestionRoute = resolvePromise;
  });
  await page.route("**/api/v1/commands", async (route) => {
    const body = route.request().postData();
    if (body === null) return route.continue();
    questionBodies.push(body);
    const persisted = await page.evaluate(() => sessionStorage.getItem("senawa.portal.pending.v1"));
    questionPersistedBeforeEffect.push(
      persisted !== null &&
        (JSON.parse(persisted) as { readonly canonicalSubmission?: string }[]).some(
          ({ canonicalSubmission }) => canonicalSubmission === body,
        ),
    );
    observeQuestionRoute?.();
    await route.fetch();
    const advance = await fetch(`${controlOrigin}/advance-session`, { method: "POST" });
    expect(advance.ok).toBe(true);
    await route.fulfill({
      status: 504,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: "senawa.dev/protocol/v1",
        code: "response-lost",
        message: "Accepted response was not observable",
        retryable: true,
      }),
    });
  });
  await reviewNeed(page, "question");
  const answer = JSON.stringify({ target: "production", exact: true });
  await page.getByRole("textbox", { name: "Answer" }).fill(answer);
  await page.getByRole("button", { name: "Submit exact answer" }).click();
  await questionRouteObserved;
  await expect(page.getByRole("heading", { name: "Session expired" })).toBeVisible();
  await expect(page.getByText("1 pending commands", { exact: true })).toBeVisible();
  const bootstrap = await fetch(`${controlOrigin}/bootstrap`);
  expect(bootstrap.ok).toBe(true);
  const bootstrapBody = (await bootstrap.json()) as { readonly url: string };
  await page.goto(bootstrapBody.url);
  await expect(page.getByText("read-write", { exact: true })).toBeVisible();
  await expectPendingClear(page);
  await expect(page.getByText("Connection live", { exact: true })).toBeVisible();
  await page.unroute("**/api/v1/commands");
  expect(questionBodies).toHaveLength(1);
  expect(questionPersistedBeforeEffect).toEqual([true]);
  const question = await portalJson(
    page,
    runs.journey,
    "/questions/submission_question-portal-journey",
  );
  expect(question).toMatchObject({
    answer: { answer: { target: "production", exact: true } },
    freshDispatch: { status: "pending" },
  });
  expect(await runDiscoveryStatus(page, runs.journey)).toBe(200);

  const amendmentBodies: string[] = [];
  let amendmentAttempt = 0;
  await page.route("**/api/v1/commands", async (route) => {
    const body = route.request().postData();
    if (body === null) return route.continue();
    amendmentBodies.push(body);
    amendmentAttempt += 1;
    if (amendmentAttempt === 1) return route.abort("failed");
    await route.continue();
    await page.unroute("**/api/v1/commands");
  });
  await reviewNeed(page, "amendment-decision");
  const amendmentDialog = page.getByRole("dialog");
  await expect(amendmentDialog).toContainText("affectedTaskScopes");
  await amendmentDialog.getByLabel("Decision").selectOption("reject");
  await amendmentDialog.getByRole("button", { name: "Record amendment decision" }).click();
  await expect.poll(() => amendmentBodies.length).toBe(2);
  await expectPendingClear(page);
  expect(amendmentBodies).toHaveLength(2);
  expect(amendmentBodies[1]).toBe(amendmentBodies[0]);
  expect(JSON.parse(amendmentBodies[1] ?? "{}").commandId).toBe(
    JSON.parse(amendmentBodies[0] ?? "{}").commandId,
  );
  expect(await runDiscoveryStatus(page, runs.journey)).toBe(200);

  await reviewNeed(page, "candidate-approval");
  const approvalDialog = page.getByRole("dialog");
  await expect(approvalDialog).toContainText("candidateDigest");
  await expect(approvalDialog).toContainText("gateEvidenceDigest");
  await approvalDialog.getByLabel("Decision").selectOption("approve");
  const approvalRequest = page.waitForRequest(
    (request) => request.url().includes("/api/v1/commands") && request.method() === "POST",
  );
  await approvalDialog.getByRole("button", { name: "Record exact decision" }).click();
  await approvalRequest;
  await expectPendingClear(page);
  expect(await runDiscoveryStatus(page, runs.journey)).toBe(200);

  expect(
    diagnostics.severe([/504 \(Gateway Timeout\)/u, /net::ERR_FAILED/u, /404 \(Not Found\)/u]),
  ).toEqual([]);
});

test("reviews pause, resume, and permanent end, then exposes ending and ended modes", async ({
  browser,
}) => {
  const main = await simulatedEventPortal(browser, runs.workspace);
  const { page, diagnostics } = main;
  await navigate(page, "Overview");
  await expect(page.getByText("Run running", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Pause" }).click();
  const stalePause = page.getByRole("dialog");
  await expect(stalePause).toContainText("does not cancel active effects");
  const controller = await simulatedEventPortal(browser, runs.workspace);
  await navigate(controller.page, "Overview");
  await controller.page.getByRole("button", { name: "Pause" }).click();
  await controller.page.getByRole("button", { name: "Confirm pause" }).click();
  await expect(controller.page.getByText("Run paused", { exact: true })).toBeVisible();
  const pauseEvent = await latestEvent(controller.page, runs.workspace);
  await page.evaluate((frame) => {
    window.__senawaEventSources?.at(-1)?.emit("message", JSON.stringify(frame));
  }, pauseEvent);
  await expect(page.locator(".nav-facts dd").first()).toHaveText("paused");
  await stalePause.getByRole("button", { name: "Confirm pause" }).click();
  await expectPendingClear(page);
  await expect(page.getByText("Run paused", { exact: true })).toBeVisible();
  await controller.context.close();

  await page.getByRole("button", { name: "Resume" }).click();
  const resumeDialog = page.getByRole("dialog");
  await expect(resumeDialog).toContainText("displayed run mode revision");
  await resumeDialog.getByRole("button", { name: "Confirm resume" }).click();
  await expect(page.getByText("Run running", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "End run" }).click();
  const endDialog = page.getByRole("dialog");
  await expect(endDialog).toContainText("fences current task scopes");
  await endDialog.getByRole("checkbox").check();
  await endDialog.getByRole("button", { name: "Confirm permanent end" }).click();
  await expect(page.getByText("Run ended", { exact: true })).toBeVisible();
  await expect(page.locator(".run-controls button")).toHaveCount(0);
  expect(diagnostics.severe()).toEqual([]);
  await main.context.close();
});

async function reviewNeed(page: Page, kind: string): Promise<void> {
  const need = page.locator(".need-row").filter({ hasText: kind }).first();
  await expect(need).toBeVisible();
  await need.getByRole("button", { name: "Review exact record" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

async function expectPendingClear(page: Page): Promise<void> {
  await expect(page.getByText("0 pending commands", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
}

async function visibleCursor(page: Page): Promise<number> {
  const value = await page.locator(".nav-facts dd").nth(2).textContent();
  return Number(value);
}

async function latestEvent(page: Page, runId: string): Promise<unknown> {
  const value = (await portalJson(page, runId, "/activity/events?limit=1")) as {
    readonly events: readonly unknown[];
  };
  const event = value.events[0];
  if (event === undefined) throw new Error("Fixture event is absent");
  return event;
}

async function portalJson(page: Page, runId: string, suffix: string): Promise<unknown> {
  const path = `/api/v1/repositories/${repositoryForRun(runId)}/runs/${runId}${suffix}`;
  return page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`Portal fixture read failed with ${response.status}`);
    return response.json();
  }, path);
}

async function runDiscoveryStatus(page: Page, runId: string): Promise<number> {
  const repositoryId = repositoryForRun(runId);
  const status = await page.evaluate(
    async (path) => (await fetch(path, { credentials: "same-origin" })).status,
    `/api/v1/repositories/${repositoryId}/runs?limit=100`,
  );
  return status;
}

async function simulatedEventPortal(browser: Browser, runId = runs.journey) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    class SimulatedEventSource {
      readonly url: string;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: { readonly data: string }) => void) | null = null;
      readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

      constructor(url: string) {
        this.url = url;
        window.__senawaEventSources ??= [];
        window.__senawaEventSources.push(this);
        setTimeout(() => this.onopen?.(), 0);
      }

      addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      emit(type: string, data: string): void {
        if (type === "message") this.onmessage?.({ data });
        const event = new MessageEvent(type, { data });
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }

      fail(): void {
        this.onerror?.();
      }

      close(): void {}
    }

    Object.defineProperty(window, "EventSource", { value: SimulatedEventSource });
  });
  const page = await context.newPage();
  const diagnostics = await bootstrapPortal(page, runId);
  return { context, page, diagnostics };
}

declare global {
  interface Window {
    __senawaEventSources?: {
      readonly url: string;
      emit(type: string, data: string): void;
      fail(): void;
    }[];
    __senawaMutationOrder?: string[];
  }
}
