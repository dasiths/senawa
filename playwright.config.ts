import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const localBrowserDependencies = join(homedir(), ".cache", "ms-playwright", "deps");
if (existsSync(localBrowserDependencies)) {
  process.env.LD_LIBRARY_PATH = [
    join(localBrowserDependencies, "lib", "x86_64-linux-gnu"),
    join(localBrowserDependencies, "usr", "lib", "x86_64-linux-gnu"),
    process.env.LD_LIBRARY_PATH,
  ]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(delimiter);
}

export default defineConfig({
  testDir: "./packages/portal/tests/browser",
  // A comparison capture is a tool for looking at the redesign, not a test.
  testIgnore: process.env.SENAWA_MOCK_COMPARE === "1" ? [] : [/compare\.spec\.ts/u],
  globalSetup: "./packages/portal/tests/browser/global-setup.ts",
  outputDir: "./packages/portal/test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    reducedMotion: "reduce",
  },
  projects: [
    {
      name: "compare-desktop",
      testMatch: /compare\.spec\.ts/u,
      // Tall enough that a full-page capture never resizes the viewport, which
      // is what repaints sticky chrome over the content it covers.
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1800 } },
    },
    {
      name: "compare-mobile",
      testMatch: /compare\.spec\.ts/u,
      use: { ...devices["Pixel 5"], viewport: { width: 390, height: 1800 } },
    },
    {
      name: "desktop-chromium",
      testMatch: /(?:diagram|panels|portal|terminal|visual)\.spec\.ts/u,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile-chromium",
      testMatch: /(?:diagram|panels|portal|terminal|visual)\.spec\.ts/u,
      use: { ...devices["Pixel 5"], viewport: { width: 390, height: 844 } },
    },
    {
      name: "journey-chromium",
      testMatch: /journey\.spec\.ts/u,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
