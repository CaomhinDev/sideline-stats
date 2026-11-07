import { defineConfig, devices } from "@playwright/test";

// Locally and in CI, tests run against the Firebase emulators (Auth + Firestore,
// using firestore.rules), never the real project. `npm run test:e2e` starts and
// stops the emulators around the run. Set BASE_URL to run only the
// smoke test against the deployed site, e.g. BASE_URL=https://caomhindev.github.io/sideline-stats/
const remote = process.env.BASE_URL;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: remote ? /smoke\.spec\.js/ : /(app|screenshots|smoke)\.spec\.js/,
  fullyParallel: true,
  // Some checks wait for a change to sync to a second "phone" through the emulator.
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: remote ?? "http://127.0.0.1:8124/",
    ...devices["Pixel 7"],
    browserName: "chromium",
  },
  webServer: remote ? undefined : [
    { command: "python3 -m http.server 8124 --bind 127.0.0.1", url: "http://127.0.0.1:8124", reuseExistingServer: true },
  ],
});
