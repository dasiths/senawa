import { expect, test } from "@playwright/test";
import { bootstrapPortal } from "./support.js";

test("boots the built portal through a one-time authenticated URL", async ({ page }) => {
  const diagnostics = await bootstrapPortal(page);

  await expect(page).toHaveURL(/\/portal\/#\/runs\//u);
  // The workflow is what a reader opens the portal for, so it is where booting
  // lands. Counters and digests are reachable, not first.
  await expect(page.getByRole("heading", { name: "Workflow", level: 1 })).toBeVisible();
  await expect(page.getByText("read-write", { exact: true })).toBeVisible();
  await expect(page.getByText("Connection live", { exact: true })).toBeVisible();
  expect(diagnostics.severe()).toEqual([]);
});
