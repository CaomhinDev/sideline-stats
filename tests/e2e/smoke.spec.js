import { test, expect } from "@playwright/test";

// Safe to run against the live site: loads the app and Firebase, signs nobody in.
test("the app loads and asks visitors to sign in", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));
  await page.goto("./");
  // First load downloads Firebase and checks for a session, so allow a few seconds.
  await expect(page.locator("#sign-in")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#tabs")).toBeHidden();
  expect(errors).toEqual([]);
});
