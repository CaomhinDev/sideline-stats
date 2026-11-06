import { test, expect } from "@playwright/test";

// Safe to run against the live site: loads the app and Firebase, signs nobody in.
test("the app loads and asks visitors to sign in", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));
  await page.goto("./");
  await expect(page.locator("#sign-in")).toBeVisible();
  await expect(page.locator("#tabs")).toBeHidden();
  expect(errors).toEqual([]);
});
