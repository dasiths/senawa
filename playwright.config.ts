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
      name: "desktop-chromium",
      testMatch: /(?:diagram|portal|visual)\.spec\.ts/u,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile-chromium",
      testMatch: /(?:diagram|portal|visual)\.spec\.ts/u,
      use: { ...devices["Pixel 5"], viewport: { width: 390, height: 844 } },
    },
    {
      name: "journey-chromium",
      testMatch: /journey\.spec\.ts/u,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
