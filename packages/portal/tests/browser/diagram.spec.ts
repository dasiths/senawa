import { expect, type Page, test } from "@playwright/test";
import { PHASE_EXECUTION_ORDER } from "./global-setup.js";
import { assertDocumentFits, bootstrapPortal, navigate, runs, selectRun } from "./support.js";

test("reads the workflow as bands of phases carrying cards of work", async ({ page }) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  await navigate(page, "Workflow");
  await page.getByRole("tab", { name: "Graph", exact: true }).click();

  // A phase is a band; what it holds are cards inside it.
  await expect(page.locator(".band")).not.toHaveCount(0);
  await expect(page.locator(".graph-flow > .finish")).toHaveCount(2);
  await expect(page.locator(".graph-legend")).toBeVisible();

  for (const title of PHASE_EXECUTION_ORDER) {
    await expect(page.locator(".band > summary", { hasText: title })).not.toHaveCount(0);
  }

  // The lines are measured from the laid-out flow, not authored as coordinates.
  await expect.poll(async () => page.locator(".graph-edges .edge").count()).toBeGreaterThan(0);
  await expect(
    page.locator(".graph-edges script, .graph-edges image, .graph-edges foreignObject"),
  ).toHaveCount(0);

  await assertDocumentFits(page);
  expect(diagnostics.severe()).toEqual([]);
});

test("selects a card, opens one detail surface, and keeps the selection across readings", async ({
  page,
}) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  await navigate(page, "Workflow");
  await page.getByRole("tab", { name: "Graph", exact: true }).click();
  await expect(page.locator(".gnode")).not.toHaveCount(0);

  const card = page.locator(".gnode").first();
  const name = ((await card.locator(".g-name").textContent()) ?? "").trim();
  await card.click();
  await expect(page.locator(".gnode[aria-current='true']")).toHaveCount(1);
  const detail = page.locator(".detail");
  await expect(detail.locator("h2").first()).toHaveText(name);
  await expect(detail.getByRole("tab", { name: "Live", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // The tree is the same work read another way, so the selection survives.
  await page.getByRole("tab", { name: "Tree", exact: true }).click();
  await expect(page.locator(".tree-item[aria-selected='true'] > .node > .node-name")).toHaveText(
    name,
  );
  expect(diagnostics.severe()).toEqual([]);
});

test("carries a need as a badge on the card and its named action on the detail surface", async ({
  page,
}) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  await navigate(page, "Workflow");
  await page.getByRole("tab", { name: "Graph", exact: true }).click();

  const waiting = page.locator(".gnode:has(.asks)").first();
  await waiting.click();
  // The badge counts; the control that acts on it is named for the decision.
  const toolbar = page.locator(".detail .node-toolbar");
  await expect(toolbar.getByRole("button", { name: "Answer this question" })).toBeEnabled();
  expect(diagnostics.severe()).toEqual([]);
});

test("orders phases by execution order in every graph view", async ({ page }) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  await navigate(page, "Workflow");

  // The authority pages nodes in digest order, so a view that echoes arrival
  // order renders the workflow in an order unrelated to how it runs.
  await page.getByRole("tab", { name: "Graph", exact: true }).click();
  await expect(page.locator(".band")).not.toHaveCount(0);
  expect(await bandOrder(page)).toEqual(PHASE_EXECUTION_ORDER);

  await page.getByRole("tab", { name: "Tree", exact: true }).click();
  await expect(page.locator(".tree-item")).not.toHaveCount(0);
  expect(await treePhaseOrder(page)).toEqual(PHASE_EXECUTION_ORDER);
  expect(diagnostics.severe()).toEqual([]);
});

test("reads a run whose work has not started as the same flow", async ({ page }) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  await selectRun(page, runs.workspace);
  await navigate(page, "Workflow");
  await page.getByRole("tab", { name: "Graph", exact: true }).click();
  await expect(page.locator(".gnode")).not.toHaveCount(0);
  await assertDocumentFits(page);
  expect(diagnostics.severe()).toEqual([]);
});

/** The phase names the graph renders, in the order it renders them. */
async function bandOrder(page: Page): Promise<readonly string[]> {
  return page
    .locator(".band > summary > .band-name")
    .evaluateAll((elements) => elements.map((element) => (element.textContent ?? "").trim()));
}

/** The phase names the tree renders, in the order it renders them. */
async function treePhaseOrder(page: Page): Promise<readonly string[]> {
  return page
    .locator(".tree-item.kind-phase > .node > .node-name")
    .evaluateAll((elements) => elements.map((element) => (element.textContent ?? "").trim()));
}
