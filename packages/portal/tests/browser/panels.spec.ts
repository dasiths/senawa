import { expect, type Page, test } from "@playwright/test";
import { reportFixtureStateOnFailure } from "./fixture-state.js";
import {
  assertDocumentFits,
  bootstrapPortal,
  navigate,
  portalHash,
  runs,
  selectRun,
} from "./support.js";

reportFixtureStateOnFailure();

test.describe.configure({ mode: "serial" });

test("narrates one submitted command from submission through its receipt", async ({ page }) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  const narrator = page.locator(".command-narrator");
  await expect(narrator).toHaveText("No command has been submitted from this browser.");
  await expect(narrator).toHaveAttribute("aria-busy", "false");

  let delayFirstCommand = true;
  await page.route("**/api/v1/commands", async (route) => {
    if (route.request().method() !== "POST" || !delayFirstCommand) return route.continue();
    delayFirstCommand = false;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    return route.continue();
  });
  // The portal opens on the graph. Run controls live on the overview.
  await navigate(page, "Timeline");
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
  await expect(page.locator(".run-head .state", { hasText: /^running$/u })).toBeVisible();
  expect(diagnostics.severe()).toEqual([]);
});

test("marks an unanswered question overdue, titles the tab, and clears both", async ({ page }) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  const banner = page.locator(".question-attention");
  await expect(banner).toHaveClass(/need-row/u);
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

  // An answer leaves the queue the moment it is given, so the rail carries what
  // was decided as well as what is still waiting.
  const answered = page.locator(".right-rail .rail-section", { hasText: "Recently answered" });
  await expect(answered).toBeVisible();
  await expect(answered.locator(".empty-state")).toHaveText("You have not answered anything yet.");

  await selectRun(page, runs.workspace);
  await expect(page.locator(".question-attention")).toHaveCount(0);
  await expect(page).toHaveTitle("Senawa Portal");
  expect(diagnostics.severe()).toEqual([]);
});

test("restores an in-progress answer draft across a reload and clears it per question", async ({
  page,
}) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
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

  await page.goto(`${new URL(page.url()).origin}/portal/${portalHash(runs.journey, "workflow")}`);
  await expect(page.getByText("read-write", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Workflow", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await openQuestion(page);
  await expect(page.getByRole("dialog").getByLabel("Answer")).toHaveValue(
    "staging, with a bounded rationale",
  );
  await page.getByRole("dialog").press("Escape");

  // Another run's draft must survive leaving the run that owns this one.
  await page.evaluate((identity) => {
    const drafts = JSON.parse(
      sessionStorage.getItem("senawa.portal.answer-draft.v1") ?? "{}",
    ) as Record<string, string>;
    drafts[identity] = "other run draft";
    sessionStorage.setItem("senawa.portal.answer-draft.v1", JSON.stringify(drafts));
  }, `repository_other\u0000run_other\u0000submission_other\u0000digest_other`);

  await selectRun(page, runs.workspace);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(
          JSON.parse(sessionStorage.getItem("senawa.portal.answer-draft.v1") ?? "{}") as Record<
            string,
            string
          >,
        ),
      ),
    )
    .toEqual([`repository_other\u0000run_other\u0000submission_other\u0000digest_other`]);
  expect(diagnostics.severe()).toEqual([]);
});

// Four fixed destinations do not need a resizable rail, so navigation moved to
// tabs across the top and the left rail went with it. What the right rail holds
// grows with the run, so it keeps its handle.
test("resizes, collapses, and persists the attention rail from the keyboard", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Rails render in the desktop layout");
  const diagnostics = await bootstrapPortal(page, runs.journey);
  const body = page.locator(".portal-body");
  const right = page.locator("#rail-handle-right");
  await expect(page.locator("#rail-handle-left")).toHaveCount(0);
  await expect(right).toHaveAttribute("aria-valuemin", "192");
  await expect(right).toHaveAttribute("aria-valuemax", "576");
  await expect(right).toHaveAttribute("aria-valuenow", "320");
  await expect(right).toHaveAttribute("aria-orientation", "vertical");

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

  const collapse = page.locator("#rail-collapse-right");
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await collapse.click();
  await expect(body).toHaveAttribute("data-rail-right", "collapsed");
  await expect(page.locator("#rail-collapse-right")).toHaveAttribute("aria-expanded", "false");
  await assertDocumentFits(page);

  await page.goto(`${new URL(page.url()).origin}/portal/${portalHash(runs.journey, "timeline")}`);
  await expect(page.locator(".portal-body")).toHaveAttribute("data-rail-right", "collapsed");
  await page.locator("#rail-collapse-right").click();
  await expect(page.locator(".portal-body")).toHaveAttribute("data-rail-right", "352");

  // Navigation is always reachable now, because it is not in a rail that folds.
  await expect(page.getByRole("tab", { name: "Timeline", exact: true })).toBeVisible();

  const grip = await page.locator("#rail-handle-right").boundingBox();
  const gripX = (grip?.x ?? 0) + (grip?.width ?? 0) / 2;
  const gripY = (grip?.y ?? 0) + 40;
  await page.mouse.move(gripX, gripY);
  await page.mouse.down();
  await page.mouse.move(gripX - 100, gripY, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator("#rail-handle-right")).toHaveAttribute("aria-valuenow", "448");
  expect((await railLayout(page))?.right).toBe(448);
  expect(diagnostics.severe()).toEqual([]);
});

test("offers one node toolbar tab stop with arrow movement and bounded actions", async ({
  page,
}) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  await navigate(page, "Workflow");
  await page.getByRole("tab", { name: "Graph", exact: true }).click();
  await page.locator('.gnode[data-node="task_verify"]').click();

  const toolbar = page.getByRole("toolbar", { name: "Selected node actions" });
  const buttons = toolbar.getByRole("button");
  // Copy, focus, fold, and one control per need this node is waiting on.
  await expect(buttons).toHaveCount(5);
  await expect(toolbar.locator('button[tabindex="0"]')).toHaveCount(1);
  // The three constant actions are marks; what they mean is their name.
  await expect(buttons.nth(0)).toHaveAttribute("aria-label", "Copy identity");
  await expect(buttons.nth(3)).toBeEnabled();
  // A node waiting on an answer and stopped for budget is two decisions, and
  // offering only the first hides the second behind a badge that counts both.
  await expect(buttons.nth(4)).toBeEnabled();
  await expect(buttons.nth(3)).not.toHaveText(await buttons.nth(4).innerText());
  // Folding is a decision about a phase, so a task cannot make it.
  await expect(buttons.nth(2)).toBeDisabled();

  await buttons.nth(0).focus();
  await page.keyboard.press("ArrowRight");
  await expect(buttons.nth(1)).toBeFocused();
  await expect(toolbar.locator('button[tabindex="0"]')).toHaveCount(1);
  await expect(buttons.nth(1)).toHaveAttribute("tabindex", "0");
  await page.keyboard.press("End");
  await expect(buttons.nth(4)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(buttons.nth(0)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(buttons.nth(0)).toBeFocused();

  await page.keyboard.press("Tab");
  expect(await focusedInside(page, ".node-toolbar")).toBe(false);

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await buttons.nth(0).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("task_verify");

  await page.getByRole("tab", { name: "Tree", exact: true }).click();
  await expect(page.locator(".graph-flow")).toHaveCount(0);
  await expect(toolbar).toHaveCount(1);
  await buttons.nth(1).click();
  await expect(page.locator(".graph-flow")).toHaveCount(1);
  await expect.poll(() => selectedNode(page)).toBe("task_verify");

  await page.getByRole("tab", { name: "Tree", exact: true }).click();
  // A row's own line, not its box: a phase's box is mostly its children.
  await page
    .locator(".workflow-node.kind-phase > .node")
    .filter({ hasText: "delivery" })
    .first()
    .click();
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
  await navigate(page, "Timeline");
  // Opening the row is what fetches the content; there is no separate control.
  const row = page.locator(".artifact-row").filter({ hasText: "asset_json" });
  await row.click();
  const detail = page.locator(".detail-row");
  const expand = detail.getByRole("button", { name: "Expand full screen" });
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
  // The question is reachable where it blocks. The rail carries the same queue,
  // but it is collapsed on a narrow viewport, so the node is the surface that is
  // always there.
  const onNode = page.getByRole("button", { name: "Answer this question" }).first();
  if ((await onNode.count()) > 0) {
    await onNode.click();
  } else {
    // The rail is closed on a narrow viewport, so it has to be opened first.
    await page.getByRole("button", { name: /waiting on you/u }).click();
    const need = page.locator(".need-row").filter({ hasText: "question" }).first();
    // The control is named for the decision now, not for the machinery.
    await need.getByRole("button").first().click();
  }
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

/** The graph marks its selection on the card, so the DOM is the source. */
function selectedNode(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector(".gnode[aria-current='true']")?.getAttribute("data-node") ?? "",
  );
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

test("shows who is working, on what, and on which model", async ({ page }) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  await navigate(page, "Agents");

  // The graph says which phases are open. It cannot say which persona is on its
  // third attempt or which model it is running on, and that is what this view
  // exists to answer. One entry per agent with its attempts under it: a table of
  // dispatches showed the same persona four times over, and two of those rows
  // differed only in a state cell.
  const roster = page.locator(".agent-roster");
  await expect(roster).toBeVisible();
  const entries = roster.locator(".agent-entry");
  await expect(entries).not.toHaveCount(0);
  const first = entries.first();
  await expect(first.locator(".node-name")).not.toBeEmpty();
  // This fixture runs deterministic writers and chooses no model, so the model
  // is absent rather than reading `unknown`. A run that picks one is covered
  // where the picking happens.
  await expect(first.locator(".model")).toHaveCount(0);
  await expect(first.locator(".state")).not.toBeEmpty();
  // A digest identifies a row to a machine and nothing to a person, so none may
  // be read here. The identity it stands for is kept for hovering.
  const shown = await roster.allTextContents();
  expect(shown.filter((text) => /(?:task|phase|dispatch)_[0-9a-f]{64}/u.test(text))).toEqual([]);
  await expect(first.locator(".agent-work")).toHaveAttribute("title", /^task_/u);
  expect(diagnostics.severe()).toEqual([]);
});

// A need used to be a number on a row and a button on another tab. Reading a
// phase told a person the run had stopped but not why, and acting on it meant
// leaving the view that said so.
test("offers the action for a need on the node the need is about", async ({ page }) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  await navigate(page, "Workflow");
  await page.getByRole("tab", { name: "Tree", exact: true }).click();
  const tree = page.getByRole("tree");
  await expect(tree).toBeVisible();

  const action = tree.locator(".workflow-need").first();
  await expect(action).toBeVisible();
  const owner = tree.locator(".workflow-node", { has: page.locator(".workflow-need") }).first();
  // The action sits inside the row it belongs to, not in a list beside it.
  await expect(owner.locator("> .node > .node-name")).not.toHaveText("");

  await action.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(diagnostics.severe()).toEqual([]);
});

// The graph leads, so it has to carry what the tree carries. A count badge says
// a node is waiting; it does not say what the decision is or let a person make
// it, and a view that only counts is a view that sends people elsewhere to act.
test("names and offers a node's need from the graph, not only a count", async ({ page }) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  await navigate(page, "Workflow");
  await expect(page.locator(".graph-flow")).toHaveCount(1);

  await page.locator('[data-node="task_verify"]').click();
  const toolbar = page.getByRole("toolbar", { name: "Selected node actions" });
  await expect(toolbar).toHaveCount(1);
  // Named for the decision, so the graph reads without opening the need first.
  const action = toolbar.getByRole("button", { name: "Answer this question" });
  await expect(action).toBeEnabled();

  await action.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(diagnostics.severe()).toEqual([]);
});

// Redirecting an agent was a control on a list of agents that named the work by
// identity, so acting on the right one meant matching a digest by eye against
// the workflow. It belongs beside the work it redirects.
test("offers to redirect an agent from the work it is doing", async ({ page }) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  await navigate(page, "Workflow");
  await page.getByRole("tab", { name: "Tree", exact: true }).click();
  // The row says who is on it; the control that redirects them is on the one
  // detail surface, so a reader acts where they are already reading.
  // The row's name, not its box: the box also holds the controls for its needs.
  await page
    .locator(".node", { has: page.locator(".who") })
    .first()
    .locator(".node-name")
    .click();
  const steer = page.locator(".detail .agent-action-steer").first();
  await expect(steer).toBeVisible();
  await steer.scrollIntoViewIfNeeded();

  await steer.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(diagnostics.severe()).toEqual([]);
});

// Where a task's work is happening, and whether that work can be accepted, was
// a table of its own keyed by a task identity a reader had to match by eye
// against the workflow. It is a fact about the task, so it belongs on the task.
test("says where a task's work is happening inside the task", async ({ page }) => {
  const diagnostics = await bootstrapPortal(page, runs.workspace);
  await navigate(page, "Workflow");
  await page.getByRole("tab", { name: "Tree", exact: true }).click();
  const tree = page.getByRole("tree");
  await expect(tree).toBeVisible();

  const where = tree.locator(".workspace").first();
  await expect(where).toBeVisible();
  await expect(where.locator(".workspace-mode")).not.toBeEmpty();
  await expect(where.locator(".workspace-state")).not.toBeEmpty();
  expect(diagnostics.severe()).toEqual([]);
});

// The workflow said which phases were open and a separate tab said who was on
// them, so answering "who is doing this, and how is it going" meant holding two
// views in your head and matching a task identity between them.
test("names who is on a piece of work inside the work itself", async ({ page }) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  await navigate(page, "Workflow");
  await page.getByRole("tab", { name: "Tree", exact: true }).click();
  const tree = page.getByRole("tree");
  await expect(tree).toBeVisible();

  // Who is on it, and how the work itself is going, read as one line.
  const working = tree.locator(".node", { has: page.locator(".who") }).first();
  await expect(working).toBeVisible();
  await expect(working.locator(".who-persona")).not.toBeEmpty();
  await expect(working.locator(".state")).not.toBeEmpty();
  expect(diagnostics.severe()).toEqual([]);
});
