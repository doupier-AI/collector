import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  workers: 1,
  timeout: 30_000,
  outputDir: "test-results",
  reporter: [["list"]],
  // #44 视觉基线：snapshot 去掉平台后缀（本仓库固定 win32+chromium），
  // 像素比较 1% 容差（系统字体渲染小抖动）与 0.2 阈值（防噪声误报）。
  snapshotPathTemplate: "{snapshotDir}/{testFilePath}-{arg}-{projectName}.png",
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, threshold: 0.2 },
  },
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    // 页面、静态资源、/v1 与 SSE 均由 API 测试进程同源提供，不再启动 Vite preview
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
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:43211" },
      testIgnore: /(?:no-model|z-acceptance-real)\.spec\.ts/,
    },
    {
      name: "chromium-nomodel",
      use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:43212" },
      testMatch: /no-model\.spec\.ts/,
    },
  ],
});
