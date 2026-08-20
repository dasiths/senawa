import { expect, type Page, test } from "@playwright/test";
import { PHASE_EXECUTION_ORDER } from "./global-setup.js";
import { assertDocumentFits, bootstrapPortal, navigate, runs, selectRun } from "./support.js";

test("renders, selects, traverses, and zooms the workflow diagram", async ({ page }, testInfo) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  await navigate(page, "Workflow");
  await page.getByRole("tab", { name: "Diagram", exact: true }).click();
  await expect(page.locator(".diagram-node")).not.toHaveCount(0);

  const summary = await page.locator(".result-count").textContent();
  const total = Number(/of (\d+) nodes/u.exec(summary ?? "")?.[1] ?? "0");
  expect(total).toBeGreaterThan(0);
  const rendered = await snapshot(page);
  expect(rendered.nodeIds).toHaveLength(total);
  await expect(page.locator(".diagram-node")).toHaveCount(total);
  for (const title of ["portal", "delivery", "verify", "verified"]) {
    await expect(page.getByRole("button", { name: new RegExp(`\\b${title}\\b`, "u") })).toHaveCount(
      1,
    );
  }
  await expect(page.locator(".diagram-state-awaiting-human")).not.toHaveCount(0);
  await expect(page.locator(".diagram-state-accepted")).not.toHaveCount(0);
  await expect(page.locator(".diagram-canvas text")).not.toHaveCount(0);
  await expect(
    page.locator(".diagram-canvas script, .diagram-canvas img, .diagram-canvas iframe"),
  ).toHaveCount(0);
  await expect(page.locator(".diagram-canvas foreignObject, .diagram-canvas a")).toHaveCount(0);

  const first = page.locator(".diagram-node").first();
  await first.click();
  await expect(page.locator(".diagram-selected")).toHaveCount(1);
  const selected = (await snapshot(page)).selectedNodeId;
  expect(selected).toBe(rendered.nodeIds[0]);
  await expect(page.locator(".detail-panel")).toBeVisible();

  await first.focus();
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-node-id") ?? ""))
    .toBe(rendered.rows[1]?.[0] ?? "");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await snapshot(page)).selectedNodeId)
    .toBe(rendered.rows[1]?.[0] ?? "");

  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  const zoomed = await snapshot(page);
  expect(zoomed.scale).toBe(1.5);
  expect(zoomed.viewBox).not.toBe(rendered.viewBox);
  await expect(page.getByText("150%", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Focus selected", exact: true }).click();
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).viewBox).toBe(rendered.viewBox);

  if (testInfo.project.name === "desktop-chromium") {
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    const before = await snapshot(page);
    const box = await page.locator(".diagram-canvas").boundingBox();
    expect(box).not.toBeNull();
    const originX = (box?.x ?? 0) + 8;
    const originY = (box?.y ?? 0) + (box?.height ?? 0) - 8;
    await page.mouse.move(originX, originY);
    await page.mouse.down();
    await page.mouse.move(originX - 120, originY - 90, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await snapshot(page)).viewBox).not.toBe(before.viewBox);
  }

  await assertDocumentFits(page);

  await selectRun(page, runs.workspace);
  await navigate(page, "Workflow");
  await page.getByRole("tab", { name: "Diagram", exact: true }).click();
  await expect(page.locator(".diagram-state-running")).not.toHaveCount(0);
  await expect(page.locator(".diagram-state-not-started")).not.toHaveCount(0);
  expect(diagnostics.severe()).toEqual([]);
});

test("orders phases by execution order in every graph view", async ({ page }) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  await navigate(page, "Workflow");

  // The authority pages nodes in digest order, so a view that echoes arrival
  // order renders the workflow in an order unrelated to how it runs.
  await page.getByRole("tab", { name: "Diagram", exact: true }).click();
  await expect(page.locator(".diagram-node")).not.toHaveCount(0);
  expect(await phaseOrder(page, ".diagram-node")).toEqual(PHASE_EXECUTION_ORDER);

  await page.getByRole("tab", { name: "Outline", exact: true }).click();
  await expect(page.locator(".tree-item")).not.toHaveCount(0);
  expect(await phaseOrder(page, ".tree-item")).toEqual(PHASE_EXECUTION_ORDER);
  expect(diagnostics.severe()).toEqual([]);
});

/** Reads the phase titles a view renders, in the order it renders them. */
async function phaseOrder(page: Page, selector: string): Promise<readonly string[]> {
  const texts = await page.locator(selector).evaluateAll((elements) =>
    elements.map((element) => {
      const label = element.getAttribute("aria-label");
      if (label !== null) return label.replace(/\s+/gu, " ");
      // Tree items nest their children, so descendant text would report an
      // ancestor once per descendant.
      const own = [...element.childNodes]
        .filter((node) => node.nodeType === 3)
        .map((node) => node.textContent ?? "")
        .join(" ")
        .trim();
      if (own.length > 0) return own.replace(/\s+/gu, " ");
      // A workflow row carries its role, title and state in spans of their own,
      // and its children in a nested list. Only the row's own line describes it,
      // and its spans are adjacent, so joining without a separator would run the
      // words together.
      const line = element.querySelector(":scope > .workflow-line");
      if (line !== null)
        return [...line.children]
          .map((child) => child.textContent ?? "")
          .join(" ")
          .replace(/\s+/gu, " ")
          .trim();
      // Table cells carry no separator of their own, so join them.
      return [...element.children]
        .map((child) => child.textContent ?? "")
        .join(" ")
        .replace(/\s+/gu, " ")
        .trim();
    }),
  );
  return texts
    .filter((text) => /\bphase\b/u.test(text))
    .map((text) => PHASE_EXECUTION_ORDER.find((key) => new RegExp(`\\b${key}\\b`, "u").test(text)))
    .filter((key): key is string => key !== undefined);
}

async function snapshot(page: Page) {
  return await page.evaluate(
    () =>
      window.__senawaGraphDiagram ?? {
        nodeIds: [],
        rows: [],
        viewBox: "",
        scale: 0,
        selectedNodeId: undefined,
      },
  );
}

declare global {
  interface Window {
    __senawaGraphDiagram?: {
      readonly nodeIds: readonly string[];
      readonly rows: readonly (readonly string[])[];
      readonly viewBox: string;
      readonly scale: number;
      readonly selectedNodeId: string | undefined;
    };
  }
}
