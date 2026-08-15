import { expect, type Page, test } from "@playwright/test";
import { assertDocumentFits, bootstrapPortal, navigate, runs, selectRun } from "./support.js";

test("renders, selects, traverses, and zooms the workflow diagram", async ({ page }, testInfo) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  await navigate(page, "Graph");
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
  await navigate(page, "Graph");
  await page.getByRole("tab", { name: "Diagram", exact: true }).click();
  await expect(page.locator(".diagram-state-running")).not.toHaveCount(0);
  await expect(page.locator(".diagram-state-not-started")).not.toHaveCount(0);
  expect(diagnostics.severe()).toEqual([]);
});

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
