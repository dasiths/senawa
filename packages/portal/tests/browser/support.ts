import { expect, type Page } from "@playwright/test";

export interface BrowserRuns {
  readonly journey: string;
  readonly workspace: string;
}

export const controlOrigin = requiredEnvironment("SENAWA_E2E_CONTROL_ORIGIN");
export const runs = JSON.parse(requiredEnvironment("SENAWA_E2E_RUNS")) as BrowserRuns;

export function repositoryForRun(runId: string): string {
  return `repository_${runId.slice("run_".length)}`;
}

export function portalHash(runId: string, route: string): string {
  return `#/runs/${repositoryForRun(runId)}/${runId}/${route}`;
}

export async function bootstrapPortal(page: Page, runId?: string) {
  const diagnostics = browserDiagnostics(page);
  const response = await fetch(`${controlOrigin}/bootstrap`);
  expect(response.ok).toBe(true);
  const body = (await response.json()) as { readonly url: string };
  await page.goto(body.url);
  await expect(page.getByText("read-write", { exact: true })).toBeVisible();
  if (runId !== undefined) await selectRun(page, runId);
  await expect(page.getByText("Connection live", { exact: true })).toBeVisible({ timeout: 15_000 });
  if (runId !== undefined) {
    await expect(page.locator(".nav-facts dd").first()).not.toHaveText("Unavailable");
  }
  return diagnostics;
}

export async function selectRun(page: Page, runId: string): Promise<void> {
  const label = `${repositoryForRun(runId)} / ${runId}`;
  await page.getByRole("combobox", { name: "Select repository and run" }).selectOption({ label });
  await expect(page).toHaveURL(new RegExp(`runs/${repositoryForRun(runId)}/${runId}`, "u"));
  await expect(page.getByRole("combobox", { name: "Select repository and run" })).toHaveValue(
    `${repositoryForRun(runId)}\u0000${runId}`,
  );
}

export async function navigate(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name, exact: true }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
}

export function browserDiagnostics(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    const current = page.url();
    if (
      current.startsWith("http") &&
      url.origin !== new URL(current).origin &&
      !url.protocol.startsWith("data")
    ) {
      errors.push(`external request: ${request.url()}`);
    }
  });
  return {
    observed: () => [...errors],
    severe: (allowed: readonly RegExp[] = []) =>
      errors.filter(
        (error) =>
          !error.includes("401 (Unauthorized)") && !allowed.some((pattern) => pattern.test(error)),
      ),
  };
}

export async function assertDocumentFits(page: Page): Promise<void> {
  const result = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    appWidth: document.querySelector<HTMLElement>("#app")?.getBoundingClientRect().width ?? 0,
    visibleText: document.body.innerText.trim().length,
  }));
  expect(result.scrollWidth).toBeLessThanOrEqual(result.clientWidth);
  expect(result.appWidth).toBeGreaterThan(300);
  expect(result.visibleText).toBeGreaterThan(40);
}

export async function assertNoMajorOverlap(page: Page): Promise<void> {
  const collisions = await page.evaluate(() => {
    const selectors = [".app-header", ".global-strip", ".primary-nav", ".main-workspace"];
    const values = selectors
      .map((selector) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (element === null) return undefined;
        const box = element.getBoundingClientRect();
        return { selector, left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      })
      .filter((value): value is NonNullable<typeof value> => value !== undefined);
    const result: string[] = [];
    for (let left = 0; left < values.length; left += 1) {
      for (let right = left + 1; right < values.length; right += 1) {
        const a = values[left];
        const b = values[right];
        if (a === undefined || b === undefined) continue;
        const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (width > 2 && height > 2) result.push(`${a.selector}:${b.selector}`);
      }
    }
    return result;
  });
  expect(collisions).toEqual([]);
}

export async function assertVisibleControlsNotClipped(page: Page): Promise<void> {
  const clipped = await page
    .locator("button:visible, select:visible, input:visible")
    .evaluateAll((elements) =>
      elements.flatMap((element) => {
        const value = element as HTMLElement;
        return value.scrollWidth > value.clientWidth + 1 ||
          value.scrollHeight > value.clientHeight + 1
          ? [value.textContent?.trim() || value.getAttribute("aria-label") || value.tagName]
          : [];
      }),
    );
  expect(clipped).toEqual([]);
}

export async function assertMobileTargets(page: Page): Promise<void> {
  const undersized = await page
    .locator("button:visible, select:visible, input[type=search]:visible")
    .evaluateAll((elements) =>
      elements.flatMap((element) => {
        if (!element.isConnected) return [];
        const box = element.getBoundingClientRect();
        return box.width < 44 || box.height < 44
          ? [
              `${element.textContent?.trim() || element.getAttribute("aria-label") || element.tagName} (${box.width}x${box.height})`,
            ]
          : [];
      }),
    );
  expect(undersized).toEqual([]);
}

export async function assertHeaderControlContrast(page: Page, runId: string): Promise<void> {
  const switcher = page.getByRole("combobox", { name: "Select repository and run" });
  await expect(switcher).toContainText(runId);
  const ratios = await page.locator("#run-switcher, .rail-toggle").evaluateAll((elements) => {
    const channels = (value: string) =>
      (value.match(/[0-9.]+/gu) ?? []).slice(0, 3).map((part) => Number(part) / 255);
    const luminance = (value: string) => {
      const [red = 0, green = 0, blue = 0] = channels(value).map((channel) =>
        channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
      );
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    };
    return elements.map((element) => {
      const style = getComputedStyle(element);
      const foreground = luminance(style.color);
      const background = luminance(style.backgroundColor);
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    });
  });
  expect(ratios).toHaveLength(2);
  for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
}

export async function captureState(page: Page, name: string, mobile: boolean): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await assertDocumentFits(page);
  await assertVisibleControlsNotClipped(page);
  const bytes = await page.screenshot({
    path: `packages/portal/tests/screenshots/${name}-${mobile ? "mobile" : "desktop"}.png`,
    fullPage: false,
  });
  expect(bytes.byteLength).toBeGreaterThan(10_000);
  expect(new Set(bytes).size).toBeGreaterThan(64);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
