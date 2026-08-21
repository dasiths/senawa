import { createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { bootstrapPortal, navigate, runs } from "./support.js";

// Every tab of the mock beside the same tab of the portal, driven by one browser
// at one viewport, so the difference is looked at rather than recalled.
const MOCKS = resolve(import.meta.dirname, "../../../../docs/design/WIP/portal-redesign-mocks");
const CAPTURES = resolve(import.meta.dirname, "../../test-results/compare");

const TABS = [
  { name: "Workflow", mock: "index.html" },
  { name: "Agents", mock: "agents.html" },
  { name: "Artifacts", mock: "artifacts.html" },
  { name: "Record", mock: "record.html" },
] as const;

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function serveMocks(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://mocks").pathname;
    const file = join(MOCKS, normalize(path === "/" ? "/index.html" : path));
    if (!file.startsWith(MOCKS)) {
      response.writeHead(403).end();
      return;
    }
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file)
      .on("error", () => response.writeHead(404).end())
      .pipe(response);
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolvePromise({
        origin: `http://127.0.0.1:${String(port)}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function capture(page: Page, file: string): Promise<void> {
  await page.screenshot({ path: join(CAPTURES, file), fullPage: true });
}

test("captures every mock tab beside the same portal tab", async ({ page }, testInfo) => {
  await mkdir(CAPTURES, { recursive: true });
  const width = testInfo.project.use.viewport?.width ?? 0;
  const size = width <= 500 ? "mobile" : "desktop";
  const mocks = await serveMocks();
  try {
    for (const tab of TABS) {
      await page.goto(`${mocks.origin}/${tab.mock}`);
      // The mock draws its graph edges after layout settles.
      await page.waitForTimeout(400);
      await capture(page, `${tab.name.toLowerCase()}-${size}-mock.png`);
    }
  } finally {
    await mocks.close();
  }

  await bootstrapPortal(page, runs.journey);

  for (const tab of TABS) {
    await navigate(page, tab.name);
    await expect(page.getByRole("tab", { name: tab.name, exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // The mocks all show a selection, because one detail surface is the point.
    const selectable = page.locator(".gnode, .agent-entry, tbody tr").first();
    if ((await selectable.count()) > 0)
      await selectable.click({ trial: false }).catch(() => undefined);
    await capture(page, `${tab.name.toLowerCase()}-${size}-portal.png`);
  }
});
