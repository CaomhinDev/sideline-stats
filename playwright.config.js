import { defineConfig, devices } from "@playwright/test";

// Set BASE_URL to test a deployed copy, e.g. BASE_URL=https://caomhindev.github.io/sideline-stats/
const remote = process.env.BASE_URL;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: remote ?? "http://127.0.0.1:8124/",
    ...devices["Pixel 7"],
    browserName: "chromium",
  },
  webServer: remote ? undefined : {
    command: "python3 -m http.server 8124 --bind 127.0.0.1",
    url: "http://127.0.0.1:8124",
    reuseExistingServer: true,
  },
});
