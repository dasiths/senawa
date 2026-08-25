import { expect, test } from "@playwright/test";
import { reportFixtureStateOnFailure } from "./fixture-state.js";
import { bootstrapPortal } from "./support.js";

reportFixtureStateOnFailure();

test("boots the built portal through a one-time authenticated URL", async ({ page }) => {
  const diagnostics = await bootstrapPortal(page);

  await expect(page).toHaveURL(/\/portal\/#\/runs\//u);
  // The workflow is what a reader opens the portal for, so it is where booting
  // lands. Counters and digests are reachable, not first.
  await expect(page.getByRole("tab", { name: "Workflow", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText("read-write", { exact: true })).toBeVisible();
  await expect(page.getByText("Connection live", { exact: true })).toBeVisible();
  expect(diagnostics.severe()).toEqual([]);
});
