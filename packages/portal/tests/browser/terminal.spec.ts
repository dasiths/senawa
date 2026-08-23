import { expect, type Page, test } from "@playwright/test";
import {
  assertDocumentFits,
  bootstrapPortal,
  captureState,
  controlOrigin,
  journeyDispatchId,
  navigate,
  runs,
  selectRun,
} from "./support.js";

test("streams, follows, bounds, and exports the selected node agent output", async ({
  page,
}, testInfo) => {
  const diagnostics = await bootstrapPortal(page, runs.journey);
  await navigate(page, "Workflow");
  await page.getByRole("tab", { name: "Graph", exact: true }).click();
  await expect(page.locator(".gnode")).not.toHaveCount(0);

  // Nothing is selected yet, so the one detail surface says what to do rather
  // than showing an empty terminal.
  await expect(page.locator(".detail")).toContainText("Select a piece of work");

  // Repository mode records no workspace row, so the node's own current dispatch
  // is the only owner the writer and the pane can agree on. It is labelled by the
  // persona that wrote the lines, because a dispatch identity says who to a
  // machine and nobody to a reader. The exported file still carries the
  // identity, since a file has to name exactly one thing.
  await page.locator(".gnode", { hasText: "verify" }).first().click();
  const pane = page.getByRole("log", { name: /Agent output/u });
  // A line says who wrote it and what they were working on.
  await expect(page.locator(".agent-terminal-scope")).toHaveText("implementer \u00b7 verify");
  await expect(pane).toHaveAttribute("aria-label", "Agent output for implementer \u00b7 verify");
  await expect(pane).toHaveAttribute("tabindex", "0");
  await expect.poll(async () => (await snapshot(page)).lineCount).toBe(145);

  const first = page.locator(".agent-terminal-row").first();
  await expect(first.locator(".agent-terminal-time")).toHaveText(/^\d{1,2}:\d{2}:\d{2}$/u);
  await expect(first.locator(".agent-terminal-stream")).toHaveText("system");
  await expect(first.locator(".agent-terminal-text")).toHaveText("session started");
  await expect(page.locator(".agent-terminal-row.stderr .agent-terminal-text")).toHaveText(
    "tool call refused: capability worker.write is absent",
  );
  await expect(page.locator(".agent-terminal-log")).toHaveCSS("white-space", "normal");
  await expect(page.locator(".agent-terminal-text").first()).toHaveCSS("white-space", "pre-wrap");

  // The transcript and the reply are one pane. Rounded separately they curve
  // away from each other and the reply reads as a second box parked underneath.
  await expect(page.locator(".live-pane")).toHaveCSS("overflow", "hidden");
  for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
    await expect(page.locator(".agent-terminal")).toHaveCSS(`border-${corner}-radius`, "0px");
    await expect(page.locator(".reply")).toHaveCSS(`border-${corner}-radius`, "0px");
  }
  // Everything a reader answers with hangs off the transcript with no seam: the
  // pills that pick what is being answered, and the box that answers it.
  expect(
    await page.locator(".live-pane").evaluate((element) => {
      const terminal = element.querySelector(".agent-terminal")?.getBoundingClientRect();
      const holder = element.querySelector(".reply-holder")?.getBoundingClientRect();
      const reply = element.querySelector(".reply")?.getBoundingClientRect();
      return terminal === undefined || holder === undefined || reply === undefined
        ? undefined
        : [Math.round(holder.top - terminal.bottom), Math.round(holder.bottom - reply.bottom)];
    }),
  ).toEqual([0, 0]);

  // The diagram with a selected node and its live output is the parity feature
  // this branch restores, so it needs its own review evidence.
  const mobile = testInfo.project.name === "mobile-chromium";
  await captureState(page, "graph-diagram", mobile);
  await page.locator(".agent-terminal-log").scrollIntoViewIfNeeded();
  await captureState(page, "graph-terminal", mobile);

  const hostile = page.locator(".agent-terminal-row", {
    hasText: "hostile line <script>blocked()</script></div> stays inert",
  });
  await expect(hostile.locator(".agent-terminal-text")).toHaveText(
    "hostile line <script>blocked()</script></div> stays inert",
  );
  // Assistant prose is the newest untrusted text to reach the browser, and it
  // is the one a reader is most likely to be reading closely.
  const said = page.locator(".agent-terminal-row.assistant");
  await expect(said.locator(".agent-terminal-text")).toHaveText(
    "Reading the plan item <script>blocked()</script> before I write anything",
  );
  await expect(said.locator(".agent-terminal-stream")).toHaveText("assistant");
  await expect(page.locator(".agent-terminal script, .agent-terminal div div div")).toHaveCount(0);
  expect(await page.locator(".agent-terminal-row").count()).toBe(145);

  await expect(page.locator(".agent-terminal-row").last()).toContainText("session ended completed");
  await expect.poll(() => tailOffset(page)).toBeLessThanOrEqual(12);
  await expect(page.getByRole("button", { name: /Jump to latest/u })).toHaveCount(0);

  await page.locator(".agent-terminal-log").evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.getByRole("button", { name: /Jump to latest/u })).toHaveCount(1);
  await expect.poll(async () => (await snapshot(page)).pinned).toBe(false);
  await expect.poll(() => tailOffset(page)).toBeGreaterThan(12);

  await page.locator(".agent-terminal-log").focus();
  await page.keyboard.press("End");
  await expect.poll(async () => (await snapshot(page)).pinned).toBe(true);
  await expect.poll(() => tailOffset(page)).toBeLessThanOrEqual(12);
  await expect(page.getByRole("button", { name: /Jump to latest/u })).toHaveCount(0);

  const displayed = await page
    .locator(".agent-terminal-row")
    .evaluateAll((rows) =>
      rows
        .map((row) =>
          ["time", "stream", "text"]
            .map((part) => row.querySelector(`.agent-terminal-${part}`)?.textContent ?? "")
            .join("\t"),
        )
        .join("\n"),
    );
  const exported = (await snapshot(page)).plainText;
  expect(exported).toBe(displayed);
  expect(exported.split("\n")).toHaveLength(145);
  expect(exported).toContain("hostile line <script>blocked()</script></div> stays inert");

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(exported);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe(`senawa-transcript-dispatch-${journeyDispatchId}.txt`);
  expect(await readDownload(saved)).toBe(exported);

  // A durable append bumps only the transcript revision, so one poll delivers the
  // line while the bounded graph assembly stays fresh instead of going stale.
  // A phase is a band in the graph, so it is selected from the tree reading.
  await page.getByRole("tab", { name: "Tree", exact: true }).click();
  await page
    .locator(".workflow-node.kind-phase > .node")
    .filter({ hasText: "delivery" })
    .first()
    .click();
  await expect(page.locator(".agent-terminal-scope")).toHaveText("phase phase_delivery");
  await expect.poll(async () => (await snapshot(page)).lineCount).toBeGreaterThanOrEqual(2);
  await expect(page.locator(".agent-terminal-log")).not.toContainText("journey task output");
  await expect(page.locator(".agent-terminal-log")).toContainText("phase attempt 1 opened");
  await expect.poll(async () => (await snapshot(page)).pinned).toBe(true);

  const status = page.getByRole("region", { name: "Portal status" });
  await expect(status).toContainText("Data current");
  const beforeAppend = (await snapshot(page)).lineCount;
  const appended = await fetch(`${controlOrigin}/append-transcript`, { method: "POST" });
  expect(appended.ok).toBe(true);
  const { text: liveLine } = (await appended.json()) as { readonly text: string };
  await expect
    .poll(async () => (await snapshot(page)).lineCount, { timeout: 30_000 })
    .toBe(beforeAppend + 1);
  await expect(page.locator(".agent-terminal-row").last()).toContainText(liveLine);
  await expect.poll(() => tailOffset(page)).toBeLessThanOrEqual(12);
  await expect(status).toContainText("Data current");
  await expect(status).not.toContainText("Authority changed during bounded assembly");
  await expect(page.locator(".tree-item")).not.toHaveCount(0);

  // The explicit run-wide option merges every owner of the run in one scope and
  // still names the owner that produced each line.
  await page.getByRole("button", { name: "All agents", exact: true }).click();
  await expect(page.locator(".agent-terminal-scope")).toHaveText("every agent");
  await expect.poll(async () => (await snapshot(page)).lineCount).toBe(145 + beforeAppend + 1);
  await expect(page.locator(".agent-terminal-log")).toContainText("journey task output line 1");
  await expect(page.locator(".agent-terminal-log")).toContainText("phase attempt 1 opened");
  await expect(
    page.locator(".agent-terminal-row").first().locator(".agent-terminal-owner"),
  ).toHaveText("implementer \u00b7 verify");
  await expect(
    page.locator(".agent-terminal-row").last().locator(".agent-terminal-owner"),
  ).toHaveText("phase phase_delivery");
  expect(
    new Set(
      await page
        .locator(".agent-terminal-row")
        .evaluateAll((rows) => rows.map((row) => row.dataset.owner ?? "")),
    ).size,
  ).toBe(2);
  expect((await snapshot(page)).plainText).toContain(`\tphase phase_delivery\t`);
  await page.getByRole("button", { name: "This agent", exact: true }).click();
  await expect(page.locator(".agent-terminal-scope")).toHaveText("phase phase_delivery");
  await expect(page.locator(".agent-terminal-owner")).toHaveCount(0);
  await expect.poll(async () => (await snapshot(page)).lineCount).toBe(beforeAppend + 1);

  await assertDocumentFits(page);

  await selectRun(page, runs.workspace);
  await navigate(page, "Workflow");
  await page.getByRole("tab", { name: "Graph", exact: true }).click();
  // With nothing selected the pane carries the whole run, because what a reader
  // arrives wanting is what is happening, not an instruction to go and find it.
  await expect(page.locator(".detail-title")).toContainText("Every agent");
  await expect(page.locator(".agent-terminal-scope")).toHaveText("every agent");
  await page.locator('.gnode[data-node="task_verify"]').click();
  await expect(page.locator(".agent-terminal-scope")).toHaveText("dispatch dispatch-browser");
  await expect(page.locator(".agent-terminal-log")).toContainText("workspace dispatch output");
  await expect(page.locator(".agent-terminal-log")).not.toContainText("task-owned line");
  expect((await snapshot(page)).lineCount).toBe(2);

  if (testInfo.project.name === "desktop-chromium") {
    await expect(page.locator(".agent-terminal-log")).toBeVisible();
  }
  expect(diagnostics.severe()).toEqual([]);
});

async function snapshot(page: Page) {
  return await page.evaluate(
    () =>
      window.__senawaTranscriptPane ?? {
        ownerKind: undefined,
        ownerId: undefined,
        scope: "node" as const,
        lineCount: 0,
        pinned: true,
        unseen: 0,
        plainText: "",
      },
  );
}

function tailOffset(page: Page): Promise<number> {
  return page.locator(".agent-terminal-log").evaluate((element) => {
    return element.scrollHeight - element.scrollTop - element.clientHeight;
  });
}

async function readDownload(download: { createReadStream(): Promise<NodeJS.ReadableStream> }) {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

declare global {
  interface Window {
    __senawaTranscriptPane?: {
      readonly ownerKind: string | undefined;
      readonly ownerId: string | undefined;
      readonly scope: "node" | "run";
      readonly lineCount: number;
      readonly pinned: boolean;
      readonly unseen: number;
      readonly plainText: string;
    };
  }
}
