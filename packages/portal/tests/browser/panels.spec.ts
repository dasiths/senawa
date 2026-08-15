import { expect, type Page, test } from "@playwright/test";
import {
  assertDocumentFits,
  bootstrapPortal,
  navigate,
  portalHash,
  runs,
  selectRun,
} from "./support.js";

test.describe.configure({ mode: "serial" });

test("narrates one submitted command from submission through its receipt", async ({ page }) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  const narrator = page.locator(".command-narrator");
  await expect(narrator).toHaveText("No command has been submitted from this browser.");
  await expect(narrator).toHaveAttribute("aria-busy", "false");

  let delayFirstCommand = true;
  await page.route("**/api/v1alpha1/commands", async (route) => {
    if (route.request().method() !== "POST" || !delayFirstCommand) return route.continue();
    delayFirstCommand = false;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    return route.continue();
  });
  await page.getByRole("button", { name: "Pause" }).click();
  await page.getByRole("button", { name: "Confirm pause" }).click();
  await expect(narrator).toHaveText("pause-run is submitting");
  await expect(narrator).toHaveAttribute("aria-busy", "true");

  await expect(narrator).toHaveText("pause-run completed", { timeout: 15_000 });
  await expect(narrator).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("region", { name: "Portal status" })).toContainText(
    "0 pending commands",
  );

  await page.getByRole("button", { name: "Resume" }).click();
  await page.getByRole("button", { name: "Confirm resume" }).click();
  await expect(narrator).toHaveText("resume-run completed", { timeout: 15_000 });
  await expect(page.getByText("Run running", { exact: true })).toBeVisible();
  expect(diagnostics.severe()).toEqual([]);
});

test("marks an unanswered question overdue, titles the tab, and clears both", async ({ page }) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  const banner = page.locator(".question-attention");
  await expect(banner).toHaveAttribute("role", "alert");
  await expect(banner).toContainText("Choose the exact deployment target");
  await expect(banner.locator(".question-attention-elapsed")).toHaveText(/^Waiting \d+s$/u);
  await expect(banner.locator(".question-attention-overdue")).toBeHidden();
  await expect(banner).not.toHaveClass(/overdue/u);
  await expect(page).toHaveTitle("\u25cf Answer needed \u2014 Senawa Portal");

  const first = await elapsedLabel(page);
  await expect.poll(() => elapsedLabel(page), { timeout: 5_000 }).not.toBe(first);

  await page.clock.setSystemTime(new Date(Date.now() + 120_000));
  await expect(banner.locator(".question-attention-overdue")).toBeVisible();
  await expect(banner).toHaveClass(/overdue/u);
  await expect(banner.locator(".question-attention-elapsed")).toHaveText(/^Waiting 2m/u);
  await expect(banner.locator("script, svg, iframe")).toHaveCount(0);
  await assertDocumentFits(page);

  await selectRun(page, runs.workspace);
  await expect(page.locator(".question-attention")).toHaveCount(0);
  await expect(page).toHaveTitle("Senawa Portal");
  expect(diagnostics.severe()).toEqual([]);
});

test("restores an in-progress answer draft across a reload and clears it per question", async ({
  page,
}) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  await navigate(page, "Human needs");
  await openQuestion(page);
  await page.getByRole("dialog").getByLabel("Answer").fill("staging, with a bounded rationale");
  await page.getByRole("dialog").press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const stored = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("senawa.portal.answer-draft.v1") ?? "{}"),
  );
  const identities = Object.keys(stored as Record<string, string>);
  expect(identities).toHaveLength(1);
  expect(identities[0]).toContain(runs.journey);

  await page.goto(`${new URL(page.url()).origin}/portal/${portalHash(runs.journey, "needs")}`);
  await expect(page.getByText("read-write", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Human needs", level: 1 })).toBeVisible();
  await openQuestion(page);
  await expect(page.getByRole("dialog").getByLabel("Answer")).toHaveValue(
    "staging, with a bounded rationale",
  );
  await page.getByRole("dialog").press("Escape");

  await selectRun(page, runs.workspace);
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem("senawa.portal.answer-draft.v1") ?? "cleared"),
    )
    .toBe("cleared");
  expect(diagnostics.severe()).toEqual([]);
});

test("resizes, collapses, and persists both rails from the keyboard", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Rails render in the desktop layout");
  const diagnostics = await bootstrapPortal(page, runs.journey);
  const body = page.locator(".portal-body");
  const left = page.locator("#rail-handle-left");
  const right = page.locator("#rail-handle-right");
  await expect(left).toHaveAttribute("aria-valuemin", "192");
  await expect(left).toHaveAttribute("aria-valuemax", "576");
  await expect(left).toHaveAttribute("aria-valuenow", "224");
  await expect(left).toHaveAttribute("aria-orientation", "vertical");
  expect(Math.round((await page.locator(".primary-nav").boundingBox())?.width ?? 0)).toBe(224);

  await left.focus();
  await page.keyboard.press("ArrowRight");
  await expect(left).toHaveAttribute("aria-valuenow", "256");
  await expect(body).toHaveAttribute("data-rail-left", "256");
  expect(Math.round((await page.locator(".primary-nav").boundingBox())?.width ?? 0)).toBe(256);
  await page.keyboard.press("End");
  await expect(left).toHaveAttribute("aria-valuenow", "576");
  await page.keyboard.press("Home");
  await expect(left).toHaveAttribute("aria-valuenow", "192");
  await page.keyboard.press("ArrowRight");
  await expect(left).toHaveAttribute("aria-valuenow", "224");

  await right.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(right).toHaveAttribute("aria-valuenow", "352");
  await expect(body).toHaveAttribute("data-rail-right", "352");
  expect(await railLayout(page)).toEqual({
    left: 224,
    right: 352,
    leftCollapsed: false,
    rightCollapsed: false,
  });

  const collapse = page.locator("#rail-collapse-left");
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await collapse.click();
  await expect(body).toHaveAttribute("data-rail-left", "collapsed");
  await expect(page.locator("#rail-collapse-left")).toHaveAttribute("aria-expanded", "false");
  expect(Math.round((await page.locator(".primary-nav").boundingBox())?.width ?? 0)).toBe(44);
  await expect(page.getByRole("tab", { name: "Overview", exact: true })).toBeHidden();
  await assertDocumentFits(page);

  await page.goto(`${new URL(page.url()).origin}/portal/${portalHash(runs.journey, "overview")}`);
  await expect(page.locator(".portal-body")).toHaveAttribute("data-rail-left", "collapsed");
  await expect(page.locator(".portal-body")).toHaveAttribute("data-rail-right", "352");
  await page.locator("#rail-collapse-left").click();
  await expect(page.locator(".portal-body")).toHaveAttribute("data-rail-left", "224");
  await expect(page.getByRole("tab", { name: "Overview", exact: true })).toBeVisible();

  const grip = await page.locator("#rail-handle-left").boundingBox();
  const gripX = (grip?.x ?? 0) + (grip?.width ?? 0) / 2;
  const gripY = (grip?.y ?? 0) + 40;
  await page.mouse.move(gripX, gripY);
  await page.mouse.down();
  await page.mouse.move(gripX + 100, gripY, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".portal-body")).toHaveAttribute("data-rail-left", "320");
  await expect(page.locator("#rail-handle-left")).toHaveAttribute("aria-valuenow", "320");
  expect((await railLayout(page))?.left).toBe(320);
  expect(diagnostics.severe()).toEqual([]);
});

test("offers one node toolbar tab stop with arrow movement and bounded actions", async ({
  page,
}) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  await navigate(page, "Graph");
  await page.getByRole("tab", { name: "Diagram", exact: true }).click();
  await page.getByRole("button", { name: /^task verify,/u }).click();

  const toolbar = page.getByRole("toolbar", { name: "Selected node actions" });
  const buttons = toolbar.getByRole("button");
  await expect(buttons).toHaveCount(3);
  await expect(toolbar.locator('button[tabindex="0"]')).toHaveCount(1);
  await expect(buttons.nth(0)).toHaveText("Copy identity");
  await expect(buttons.nth(2)).toBeEnabled();

  await buttons.nth(0).focus();
  await page.keyboard.press("ArrowRight");
  await expect(buttons.nth(1)).toBeFocused();
  await expect(toolbar.locator('button[tabindex="0"]')).toHaveCount(1);
  await expect(buttons.nth(1)).toHaveAttribute("tabindex", "0");
  await page.keyboard.press("End");
  await expect(buttons.nth(2)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(buttons.nth(0)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(buttons.nth(0)).toBeFocused();

  await page.keyboard.press("Tab");
  expect(await focusedInside(page, ".node-toolbar")).toBe(false);

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await buttons.nth(0).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("task_verify");

  await page.getByRole("tab", { name: "Table", exact: true }).click();
  await expect(page.locator(".diagram-canvas")).toHaveCount(0);
  await expect(toolbar).toHaveCount(1);
  await buttons.nth(1).click();
  await expect(page.locator(".diagram-canvas")).toHaveCount(1);
  await expect.poll(() => selectedNode(page)).toBe("task_verify");

  await page.getByRole("button", { name: /^phase delivery,/u }).press("Enter");
  await expect(page.getByRole("toolbar", { name: "Selected node actions" })).toHaveCount(1);
  await expect(
    page.getByRole("toolbar").getByRole("button", { name: "Review linked human need" }),
  ).toBeDisabled();
  expect(diagnostics.severe()).toEqual([]);
});

test("expands a bounded artifact into a full-screen overlay that traps and restores focus", async ({
  page,
}) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  await navigate(page, "Artifacts");
  const row = page.locator(".artifact-row").filter({ hasText: "asset_json" });
  await row.getByRole("button", { name: "Preview bounded content" }).click();
  const expand = row.getByRole("button", { name: "Expand full screen" });
  await expand.click();

  const overlay = page.locator(".asset-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText(/Display bounded at 500 nodes/u);
  await expect(overlay.locator("script, style, svg, iframe, object, embed")).toHaveCount(0);
  expect(await page.evaluate(() => document.querySelectorAll("dialog[open]").length)).toBe(1);

  const path: string[] = [];
  for (let press = 0; press < 6; press += 1) {
    await page.keyboard.press("Tab");
    path.push(await focusDescriptor(page));
  }
  expect(path.filter((entry) => entry.startsWith("shell:"))).toEqual([]);
  expect(path.some((entry) => entry.startsWith("overlay:"))).toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.locator(".asset-overlay")).toHaveCount(0);
  await expect(expand).toBeFocused();

  await expand.click();
  await expect(page.locator(".asset-overlay")).toBeVisible();
  await page.getByRole("button", { name: "Close full screen" }).click();
  await expect(page.locator(".asset-overlay")).toHaveCount(0);
  await expect(expand).toBeFocused();
  await assertDocumentFits(page);
  expect(diagnostics.severe()).toEqual([]);
});

async function openQuestion(page: Page): Promise<void> {
  const need = page.locator(".need-row").filter({ hasText: "question" }).first();
  await need.getByRole("button", { name: "Review exact record" }).click();
  await expect(page.getByRole("dialog").getByLabel("Answer")).toBeEnabled();
}

function elapsedLabel(page: Page): Promise<string> {
  return page
    .locator(".question-attention-elapsed")
    .textContent()
    .then((value) => value ?? "");
}

function focusedInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((value) => document.activeElement?.closest(value) !== null, selector);
}

function focusDescriptor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active === null) return "none";
    if (active.closest(".asset-overlay") !== null) return `overlay:${active.tagName}`;
    return active.closest(".portal-shell") === null
      ? `document:${active.tagName}`
      : `shell:${active.tagName}`;
  });
}

function selectedNode(page: Page): Promise<string> {
  return page.evaluate(() => window.__senawaGraphDiagram?.selectedNodeId ?? "");
}

function railLayout(page: Page) {
  return page.evaluate(() => window.__senawaRailLayout);
}

declare global {
  interface Window {
    __senawaRailLayout?: {
      readonly left: number;
      readonly right: number;
      readonly leftCollapsed: boolean;
      readonly rightCollapsed: boolean;
    };
    __senawaGraphDiagram?: { readonly selectedNodeId: string | undefined };
  }
}
