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
    // #32 自动融合高置信路径：相似性核验恒判为 identity（同一实体）→ 自动融合。
    {
      command: "node e2e/api-harness.mjs",
      url: "http://127.0.0.1:43213/health",
      reuseExistingServer: false,
      env: { E2E_API_PORT: "43213", E2E_MODEL: "fake", E2E_SIMILARITY_RELATION: "identity" },
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:43211" },
      // z-auto-fusion（identity 高置信）由 chromium-autofusion（43213）承担；-off 用例用 contrast，留在本 project。
      testIgnore: /(?:no-model|z-acceptance-real|z-auto-fusion)\.spec\.ts/,
    },
    {
      name: "chromium-nomodel",
      use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:43212" },
      testMatch: /no-model\.spec\.ts/,
      // 低消耗端口的配对码在套件末尾可能过期（5 分钟 TTL）：基础设施抖动自动重试一次。
      retries: 1,
    },
    {
      name: "chromium-autofusion",
      use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:43213" },
      testMatch: /z-auto-fusion\.spec\.ts/,
      retries: 1,
    },
  ],
});
