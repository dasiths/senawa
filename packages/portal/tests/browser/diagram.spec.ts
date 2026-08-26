import { expect, type Page, test } from "@playwright/test";
import { PHASE_EXECUTION_ORDER } from "./global-setup.js";
import { isolateSharedFixture } from "./shared-fixture.js";
import { assertDocumentFits, bootstrapPortal, navigate, runs, selectRun } from "./support.js";

isolateSharedFixture();

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

  // What crossed between two phases is named on the line, not by the phase it
  // came from, whose name is already on the band above.
  const chip = page.locator(".chip").first();
  if ((await page.locator(".chip").count()) > 0) {
    await expect(chip.locator("b")).not.toHaveText("");
    await expect(chip.locator(".fan")).toHaveText(/\d/u);
  }

  await assertDocumentFits(page);
  expect(diagnostics.severe()).toEqual([]);
});

test("scopes the detail view to the run, a phase, and one piece of work", async ({ page }) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  await navigate(page, "Workflow");
  await page.getByRole("tab", { name: "Graph", exact: true }).click();

  // Nothing selected is the run, not a prompt to select something. The old
  // placeholder said "Select an agent to narrow this to one agent".
  const trail = page.locator(".scope-trail");
  await expect(trail).toBeVisible();
  await expect(trail.locator(".scope-step")).toHaveCount(1);
  await expect(trail.locator('.scope-step[aria-current="true"]')).toHaveText(/run_/u);

  // A phase can be read. Its summary folds, so before this the only way to
  // reach one was the artifact chip on the connector.
  await page.locator(".band-read").first().click();
  await expect(trail.locator(".scope-step")).toHaveCount(2);

  // And one piece of work narrows again, with the phase left behind it.
  await page.locator(".gnode .g-open").first().click();
  await expect(trail.locator(".scope-step")).toHaveCount(3);

  // Clicking the run step widens back out.
  await trail.locator(".scope-step").first().click();
  await expect(trail.locator(".scope-step")).toHaveCount(1);

  expect(diagnostics.severe()).toEqual([]);
});

test("reads what a phase produced inside the phase", async ({ page }) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  await navigate(page, "Workflow");
  await page.getByRole("tab", { name: "Graph", exact: true }).click();

  // The chip on the connector showed the first artifact of the first member
  // that had one, so a phase of three read as though it produced one file.
  await expect(page.locator(".chip")).toHaveCount(0);
  const produced = page.locator(".band-produced").first();
  if ((await page.locator(".band-produced").count()) > 0) {
    await expect(produced.locator(".band-produced-item b").first()).not.toHaveText("");
  }

  expect(diagnostics.severe()).toEqual([]);
});

test("reads a criterion through the work that had to satisfy it", async ({ page }) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  await navigate(page, "Workflow");
  await page.getByRole("tab", { name: "Graph", exact: true }).click();

  // A criterion is something a task had to produce, not something that ran, so
  // reading one on its own left the pane with nothing in it at all. It is a
  // mark on the card of the node that owed it.
  const mark = page.locator(".g-mark").first();
  await expect(mark).toHaveCount(1);
  // The mark sits inside the card of the node that had to satisfy it.
  await expect(page.locator(".gnode:not(.kind-criterion) .g-mark")).not.toHaveCount(0);
  await mark.click();

  // Clicking it opens what the node it sits on produced. A pane scoped to the
  // criterion could only ever say the criterion had produced nothing, which is
  // true of every criterion and tells a reader nothing about their run.
  await expect(page.getByRole("tab", { name: "Produced", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".pane")).not.toContainText("has produced nothing yet");

  // Nothing claims a criterion ran, and nothing counts it as a piece of work.
  await expect(page.locator(".g-mark .state-pill")).toHaveCount(0);

  expect(diagnostics.severe()).toEqual([]);
});

// Nodes carry both `lifecycle` and `runState`. The first is the literal
// `defined` on every node ever projected, so a view that reads it says
// "not started" about a run that has finished, and nothing ever changes.
test("says what each node is actually doing, not what every node always is", async ({ page }) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  await navigate(page, "Workflow");
  await page.getByRole("tab", { name: "Graph", exact: true }).click();
  await expect(page.locator(".gnode")).not.toHaveCount(0);

  const words = new Set(
    await page
      .locator(".graph-flow .state")
      .evaluateAll((elements) => elements.map((element) => (element.textContent ?? "").trim())),
  );
  // This fixture has work that is done and work that is not, so one word for
  // all of them means the view is reading a constant.
  expect(words.size).toBeGreaterThan(1);
  expect(words).toContain("done");
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
