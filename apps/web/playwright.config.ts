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
    // 视觉基线独立 harness：z-visual-baseline 等顺序敏感的像素基线必须跑在
    // 独享数据库上，避免 settings-ai-model 等共享库配置测试改变服务端状态
    // （modelError 置位→页头文案变化→整页像素偏移）导致基线失配（#61 复盘）。
    {
      command: "node e2e/api-harness.mjs",
      url: "http://127.0.0.1:43214/health",
      reuseExistingServer: false,
      env: { E2E_API_PORT: "43214", E2E_MODEL: "fake" },
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:43211" },
      // z-auto-fusion（identity 高置信）由 chromium-autofusion（43213）承担；-off 用例用 contrast，留在本 project。
      // z-visual-baseline 等像素基线由 chromium-visual（43214 独享库）承担，与共享库污染隔离。
      testIgnore: /(?:no-model|z-acceptance-real|z-auto-fusion|z-visual-baseline)\.spec\.ts/,
    },
    {
      name: "chromium-nomodel",
      use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:43212" },
      testMatch: /no-model\.spec\.ts/,
      // 配对码现铸端点已根治 TTL 过期抖动；retries 保留为一般基础设施防抖。
      retries: 1,
    },
    {
      name: "chromium-autofusion",
      use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:43213" },
      testMatch: /z-auto-fusion\.spec\.ts/,
      retries: 1,
    },
    {
      name: "chromium-visual",
      use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:43214" },
      testMatch: /z-visual-baseline\.spec\.ts/,
    },
  ],
});
