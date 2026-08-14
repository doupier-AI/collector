import { defineConfig, devices } from "@playwright/test";

// 临时并行轨道：主 e2e 端口（43211-43213）被另一工作区会话占用时，
// 用独立端口跑本工作区的定向用例，跑完即删，不入库。
const port = 43221;

export default defineConfig({
  testDir: "e2e",
  workers: 1,
  timeout: 30_000,
  outputDir: "test-results",
  reporter: [["list"]],
  snapshotPathTemplate: "{snapshotDir}/{testFilePath}-{arg}-{projectName}.png",
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, threshold: 0.2 },
  },
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node e2e/api-harness.mjs",
      url: `http://127.0.0.1:${port}/health`,
      reuseExistingServer: false,
      env: { E2E_API_PORT: String(port), E2E_MODEL: "fake" },
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port}` },
      testIgnore: /(?:no-model|z-acceptance-real|z-auto-fusion)\.spec\.ts/,
    },
  ],
});
