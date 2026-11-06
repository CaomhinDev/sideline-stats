// Shared test setup: every page talks to the local Firebase emulators, and by
// default each test signs in as its own fresh, allowlisted Google account.
import { test as base, expect } from "@playwright/test";

export const FIRESTORE = "http://127.0.0.1:8085/v1/projects/demo-sideline/databases/(default)/documents";

/** Adds an email to the family allowlist (as the console would, bypassing rules). */
export async function allow(email) {
  const res = await fetch(`${FIRESTORE}/allow/${encodeURIComponent(email.toLowerCase())}`, {
    method: "PATCH", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" }, body: JSON.stringify({ fields: {} }),
  });
  if (!res.ok) throw new Error(`allowlist seed failed: ${res.status} ${await res.text()}`);
}

export const freshEmail = (tag = "coach") => `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

/** Signs the page in as email (emulator Google sign-in) and waits for the app to open. */
export async function signInAs(page, email, { expectAccess = true } = {}) {
  await page.waitForFunction(() => window.__sideline?.signInAs);
  await page.evaluate((e) => window.__sideline.signInAs(e), email);
  if (expectAccess) {
    await expect(page.locator("#tabs")).toBeVisible();
    await expect(page.locator("body")).toHaveAttribute("data-sync", "ready"); // first sync with the account done
  }
}

export const test = base.extend({
  signIn: [true, { option: true }],
  email: async ({}, use) => use(freshEmail()),
  page: async ({ page, signIn, email }, use) => {
    await page.addInitScript(() => { window.__SIDELINE_EMULATOR = true; });
    page.on("pageerror", (e) => { throw e; });
    if (signIn) {
      await allow(email);
      await page.goto("./");
      await signInAs(page, email);
    }
    await use(page);
  },
});

export { expect };
