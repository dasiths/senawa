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
    await page.getByRole("button", { name: /waiting on you/u }).click();
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

  // The question is reachable on the node it blocks, which is the surface that
  // survives a narrow viewport collapsing the rail.
  await page.getByRole("tab", { name: "Tree", exact: true }).click();
  await page.getByRole("button", { name: "Answer this question" }).first().click();
  const questionDialog = page.getByRole("dialog");
  // The consequence has to say what happens to the person answering. It used to
  // read "requires a fresh dispatch boundary", which describes the machinery and
  // not the outcome.
  await expect(questionDialog).toContainText("nobody can change it once sent");
  await expect(questionDialog).toContainText("<script>blocked()</script>");
  await captureState(page, "need-review", mobile);
  await questionDialog.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Focus returns to the control that opened it, which is now on the node.
  await expect(page.getByRole("button", { name: "Answer this question" }).first()).toBeFocused();

  const amendment = page.getByRole("button", { name: "Review this amendment-decision" }).first();
  await amendment.click();
  const amendmentDialog = page.getByRole("dialog");
  await expect(amendmentDialog).toContainText("affectedTaskScopes");
  await expect(amendmentDialog).toContainText("reviewedResultGraph");
  await captureState(page, "amendment", mobile);
  await amendmentDialog.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await navigate(page, "Record");
  await expect(page.getByRole("heading", { name: "What happened" })).toBeVisible();
  // Depth is one action away and absent until asked for, which is what
  // progressive disclosure has to mean to be worth anything.
  await expect(page.getByText("Active effects", { exact: true })).toBeHidden();
  await page.getByText("Counts, effects and revisions", { exact: true }).click();
  await expect(page.getByText("Active effects", { exact: true })).toBeVisible();
  await expect(page.getByText("Uncertain effects", { exact: true })).toBeVisible();
  await captureState(page, "delivery", mobile);

  // One entry per agent with its attempts under it, so the shape this view is
  // meant to have is checked by eye and not only by locator.
  await navigate(page, "Agents");
  await expect(page.locator(".agent-entry")).not.toHaveCount(0);
  await captureState(page, "agents", mobile);

  await selectRun(page, runs.workspace);
  await navigate(page, "Record");
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
  await page.evaluate(() =>
    sessionStorage.setItem("senawa.portal.answer-draft.v1", '{"stale":"draft"}'),
  );
  const advance = await fetch(`${controlOrigin}/advance-session`, { method: "POST" });
  expect(advance.ok).toBe(true);
  // Noticing an expired session takes a request, so the route has to change.
  await page.getByRole("tab", { name: "Workflow", exact: true }).click();
  await page.getByRole("tab", { name: "Record", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Session expired" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/Open a new portal bootstrap from the Senawa CLI/u)).toBeVisible();
  await expect(page.getByRole("region", { name: "Portal status" })).toContainText("Data loading");
  await expect(page.getByRole("region", { name: "Portal status" })).toContainText("0 human needs");
  await expect(page.locator(".run-controls button")).toHaveCount(0);
  await expect(page.locator(".need-row button:not([disabled])")).toHaveCount(0);
  expect(
    await page.evaluate(() => ({
      pending: sessionStorage.getItem("senawa.portal.pending.v1"),
      session: sessionStorage.getItem("senawa.portal.session.v1"),
      answerDraft: sessionStorage.getItem("senawa.portal.answer-draft.v1"),
    })),
  ).toEqual({ pending: "hostile", session: null, answerDraft: null });
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

  // Workflow leads the tabs, so the tab to its right is the one to arrow from.
  const overviewTab = page.getByRole("tab", { name: "Agents", exact: true });
  await overviewTab.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Workflow", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("tab", { name: "Workflow", exact: true })).toBeFocused();
  await page.getByRole("tab", { name: "Tree", exact: true }).click();
  const filter = page.getByRole("searchbox", { name: "Filter the workflow" });
  await filter.fill("verify");
  const row = page.locator(".workflow-tree .tree-item").first();
  await row.focus();
  await page.keyboard.press("Enter");
  const detail = page.locator(".detail-panel");
  // What a piece of work is sits under About; what it is doing leads.
  await detail.getByRole("tab", { name: "About", exact: true }).click();
  await expect(detail).toContainText("<script>blocked()</script>");
  await expect(detail).toContainText("prefix shown");
  // The only drawn things on this surface are the portal's own control marks.
  await expect(detail.locator("script, style, a, iframe, object, embed")).toHaveCount(0);
  expect(await detail.locator("svg").count()).toBe(
    await detail.locator(".mark-button svg").count(),
  );
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
  await expect(page.getByText("No preview for this kind of file", { exact: true })).toBeVisible();
  const jsonArtifact = page.locator(".artifact-row").filter({ hasText: "asset_json" });
  await jsonArtifact.click();
  const jsonDetail = page.locator(".detail-row");
  await expect(jsonDetail.getByText(/Display bounded at 500 nodes/u)).toBeVisible();
  await expect(jsonDetail.locator("script, style, svg, a, iframe, object, embed")).toHaveCount(0);
  const activeArtifact = page.locator(".artifact-row").filter({ hasText: "asset_active" });
  await expect(activeArtifact.getByRole("button", { name: /Preview|Download/u })).toHaveCount(0);

  await navigate(page, "Record");
  // Record answers "what happened, and when". It used to render every record
  // fully expanded, which put twenty-four thousand characters and a hundred and
  // sixty-eight digests in front of a reader who had not asked a question yet.
  // The record stays one disclosure away.
  await expect(page.locator(".timeline .moment")).not.toHaveCount(0);
  await expect(page.locator(".moment details[open]")).toHaveCount(0);
  // `textContent` reads through a closed disclosure, so this has to measure what
  // is rendered rather than what is present.
  const historyText = await page
    .locator(".timeline-view")
    .evaluate((node) => (node as HTMLElement).innerText);
  expect((historyText.match(/\b[0-9a-f]{64}\b/gu) ?? []).length).toBe(0);
  // Hiding a record is not the same as not building it.
  await expect(page.locator(".moment .json-viewer")).toHaveCount(0);

  const record = page.locator(".moment details").first();
  await record.locator("summary").click();
  await expect(record).toHaveAttribute("open", "");
  await expect(record.locator(".json-viewer")).toHaveCount(1);
  // Opening a record is a decision, so it survives the next render rather than
  // closing itself under the reader.
  await page.waitForTimeout(1_500);
  await expect(record).toHaveAttribute("open", "");
  await expect(record.locator(".json-viewer")).toHaveCount(1);

  // Commands this browser submitted are machinery, so they are folded away.
  const receiptsFold = page.getByText(/^Commands you submitted \(/u);
  await expect(receiptsFold).toBeVisible();
  await receiptsFold.click();
  const receiptSummaries = page.locator(".activity-summary");
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
  await expect(page.getByRole("tab", { name: "Artifacts", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
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
