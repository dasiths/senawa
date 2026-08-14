import { expect, test } from "@playwright/test";
import { bootstrapPortal } from "./support.js";

test("boots the built portal through a one-time authenticated URL", async ({ page }) => {
  const diagnostics = await bootstrapPortal(page);

  await expect(page).toHaveURL(/\/portal\/#\/runs\//u);
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  await expect(page.getByText("read-write", { exact: true })).toBeVisible();
  await expect(page.getByText("Connection live", { exact: true })).toBeVisible();
  expect(diagnostics.severe()).toEqual([]);
});
