import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  workers: 1,
  timeout: 30_000,
  outputDir: "test-results",
  reporter: [["list"]],
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node e2e/api-harness.mjs",
      url: "http://127.0.0.1:43211/health",
      reuseExistingServer: false,
      env: { E2E_API_PORT: "43211", E2E_MODEL: "fake" },
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "node e2e/api-harness.mjs",
      url: "http://127.0.0.1:43212/health",
      reuseExistingServer: false,
      env: { E2E_API_PORT: "43212", E2E_MODEL: "none" },
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "npx vite preview --port 4173 --strictPort",
      url: "http://127.0.0.1:4173/",
      reuseExistingServer: false,
      env: { COLLECTOR_API_ORIGIN: "http://127.0.0.1:43211" },
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "npx vite preview --port 4174 --strictPort",
      url: "http://127.0.0.1:4174/",
      reuseExistingServer: false,
      env: { COLLECTOR_API_ORIGIN: "http://127.0.0.1:43212" },
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:4173" },
      testIgnore: /no-model\.spec\.ts/,
    },
    {
      name: "chromium-nomodel",
      use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:4174" },
      testMatch: /no-model\.spec\.ts/,
    },
  ],
});
