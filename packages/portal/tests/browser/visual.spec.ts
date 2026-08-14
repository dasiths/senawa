import { expect, test } from "@playwright/test";
import {
  assertDocumentFits,
  assertHeaderControlContrast,
  assertMobileTargets,
  assertNoMajorOverlap,
  bootstrapPortal,
  captureState,
  controlOrigin,
  navigate,
  portalHash,
  repositoryForRun,
  runs,
  selectRun,
} from "./support.js";

test.describe.configure({ mode: "serial" });

test("captures deterministic overview, review, amendment, conflict, and expired states", async ({
  page,
}, testInfo) => {
  const mobile = testInfo.project.name === "mobile-chromium";
  const diagnostics = await bootstrapPortal(page, runs.journey);
  await assertHeaderControlContrast(page, runs.journey);
  if (mobile) {
    const rail = page.getByRole("complementary", {
      name: "Human needs and pending commands",
      includeHidden: true,
    });
    await expect(rail).toHaveAttribute("aria-hidden", "true");
    expect(await rail.evaluate((element) => element.inert)).toBe(true);
    await page.getByRole("button", { name: /Needs/u }).click();
    await expect(rail).not.toHaveAttribute("aria-hidden", "true");
    expect(await rail.evaluate((element) => element.inert)).toBe(false);
    await rail.getByRole("button", { name: "Close" }).click();
    await expect(rail).toHaveAttribute("aria-hidden", "true");
  }
  await expect(page.getByRole("region", { name: "Portal status" })).toContainText(
    "0 pending commands",
  );
  await expect(page.getByRole("region", { name: "Portal status" })).toContainText("human needs");
  await captureState(page, "overview", mobile);

  await navigate(page, "Human needs");
  const question = page.locator(".need-row").filter({ hasText: "question" }).first();
  await question.getByRole("button", { name: "Review exact record" }).click();
  const questionDialog = page.getByRole("dialog");
  await expect(questionDialog).toContainText("fresh dispatch boundary");
  await expect(questionDialog).toContainText("<script>blocked()</script>");
  await captureState(page, "need-review", mobile);
  await questionDialog.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(question.getByRole("button", { name: "Review exact record" })).toBeFocused();

  const amendment = page.locator(".need-row").filter({ hasText: "amendment-decision" }).first();
  await amendment.getByRole("button", { name: "Review exact record" }).click();
  const amendmentDialog = page.getByRole("dialog");
  await expect(amendmentDialog).toContainText("affectedTaskScopes");
  await expect(amendmentDialog).toContainText("reviewedResultGraph");
  await captureState(page, "amendment", mobile);
  await amendmentDialog.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await selectRun(page, runs.workspace);
  await navigate(page, "Workspaces");
  await expect(
    page.getByRole("heading", { name: "Integration, conflict, and rework" }),
  ).toBeVisible();
  await expect(page.getByText("integration-conflict", { exact: true })).toBeVisible();
  await expect(page.getByText("rework-required", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Semantic validation requested one bounded successor attempt."),
  ).toBeVisible();
  await expect(
    page.locator("main").locator("script, svg, a[href^='https://invalid.example']"),
  ).toHaveCount(0);
  await captureState(page, "conflict", mobile);

  await page.evaluate(() => sessionStorage.setItem("senawa.portal.pending.v1", "hostile"));
  const advance = await fetch(`${controlOrigin}/advance-session`, { method: "POST" });
  expect(advance.ok).toBe(true);
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Session expired" })).toBeVisible();
  await expect(page.getByText(/Open a new portal bootstrap from the Senawa CLI/u)).toBeVisible();
  await expect(page.getByRole("region", { name: "Portal status" })).toContainText("Data loading");
  await expect(page.getByRole("region", { name: "Portal status" })).toContainText("0 human needs");
  await expect(page.locator(".run-controls button")).toHaveCount(0);
  await expect(page.locator(".need-row button:not([disabled])")).toHaveCount(0);
  expect(
    await page.evaluate(() => ({
      pending: sessionStorage.getItem("senawa.portal.pending.v1"),
      session: sessionStorage.getItem("senawa.portal.session.v1"),
    })),
  ).toEqual({ pending: "hostile", session: null });
  await captureState(page, "expired", mobile);

  if (mobile) await assertMobileTargets(page);
  await assertNoMajorOverlap(page);
  expect(diagnostics.observed().some((error) => error.includes("401 (Unauthorized)"))).toBe(true);
  expect(diagnostics.severe()).toEqual([]);
});

test("supports keyboard graph inspection, hostile bounds, activity paging, and artifact policy", async ({
  page,
}, testInfo) => {
  const mobile = testInfo.project.name === "mobile-chromium";
  const diagnostics = await bootstrapPortal(page, runs.journey);

  const overviewTab = page.getByRole("tab", { name: "Overview", exact: true });
  await overviewTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("heading", { name: "Graph", level: 1 })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Graph", exact: true })).toBeFocused();
  const filter = page.getByRole("searchbox", { name: "Filter loaded graph nodes" });
  await filter.fill("verify");
  const row = page.locator(".graph-table tbody tr").first();
  await row.focus();
  await page.keyboard.press("Enter");
  const detail = page.locator(".detail-panel");
  await expect(detail).toContainText("<script>blocked()</script>");
  await expect(detail).toContainText("prefix shown");
  await expect(detail.locator("script, style, svg, a, iframe, object, embed")).toHaveCount(0);
  await filter.fill("");
  await page.getByRole("tab", { name: "Tree", exact: true }).click();
  const tree = page.getByRole("tree");
  await expect(tree).toBeVisible();
  const firstTreeItem = tree.getByRole("treeitem").first();
  await firstTreeItem.focus();
  await page.keyboard.press("ArrowDown");
  await expect(tree.getByRole("treeitem").nth(1)).toBeFocused();

  await navigate(page, "Artifacts");
  await expect(page.getByText("Verified bytes unavailable", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Active preview prohibited for this media type", { exact: true }),
  ).toBeVisible();
  const jsonArtifact = page.locator(".artifact-row").filter({ hasText: "asset_json" });
  await jsonArtifact.getByRole("button", { name: "Preview bounded content" }).click();
  await expect(jsonArtifact.getByText(/Display bounded at 500 nodes/u)).toBeVisible();
  await expect(jsonArtifact.locator("script, style, svg, a, iframe, object, embed")).toHaveCount(0);
  const activeArtifact = page.locator(".artifact-row").filter({ hasText: "asset_active" });
  await expect(activeArtifact.getByRole("button", { name: /Preview|Download/u })).toHaveCount(0);

  await navigate(page, "Activity");
  const receiptSummaries = page
    .locator(".activity-panel")
    .filter({ hasText: "Receipts" })
    .locator(".activity-summary");
  await expect(receiptSummaries).toHaveCount(100);
  const firstTail = await receiptSummaries.first().textContent();
  await page.getByRole("button", { name: "Earlier receipts" }).click();
  await expect(receiptSummaries.first()).not.toHaveText(firstTail ?? "");

  await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  await expect(page.getByRole("combobox", { name: "Select repository and run" })).toBeFocused();
  await assertDocumentFits(page);
  if (mobile) await assertMobileTargets(page);
  expect(diagnostics.severe()).toEqual([]);
});

test("serves strict static assets, hash reloads, and remains usable at 200 percent CSS scale", async ({
  page,
}, testInfo) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  const origin = new URL(page.url()).origin;
  const shell = await page.request.get(`${origin}/portal/`);
  expect(shell.status()).toBe(200);
  expect(shell.headers()["content-security-policy"]).toContain("script-src 'self'");
  expect(await shell.text()).not.toMatch(/<(script|style)[^>]*>[^<]/u);
  const resources = await page.evaluate(() =>
    performance.getEntriesByType("resource").map(({ name }) => new URL(name).origin),
  );
  expect(new Set(resources)).toEqual(new Set([origin]));

  await page.goto(`${origin}/portal/${portalHash(runs.journey, "artifacts")}`);
  await expect(page.getByRole("heading", { name: "Artifacts", level: 1 })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Artifacts", level: 1 })).toBeVisible();

  if (testInfo.project.name === "desktop-chromium") {
    await page.setViewportSize({ width: 720, height: 450 });
    await assertDocumentFits(page);
    await assertNoMajorOverlap(page);
  }
  expect(repositoryForRun(runs.journey)).toContain("repository_");
  expect(diagnostics.severe()).toEqual([]);
});
