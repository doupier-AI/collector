import { defineConfig, devices } from "@playwright/test";

/**
 * 收尾阶段【真实模型验收专用】配置。
 *
 * 与默认 playwright.config.ts 隔离：
 * - 不由 Playwright 托管 webServer——服务进程由 z-acceptance-real.spec.ts 自行启动 / 重启
 *   （服务重启恢复验收需要同一个数据目录在测试内重启进程）；
 * - 只匹配 z-acceptance-real.spec.ts；默认套件仍只用确定性假模型，永不访问真实云模型。
 *
 * 运行：先在仓库根 `npm run build`，再
 *   COLLECTOR_AI_API_KEY=… npx playwright test --config playwright.acceptance.config.ts
 * （Windows PowerShell 用 $env:COLLECTOR_AI_API_KEY="…" 前置）。
 */
// When no COLLECTOR_AI_* override is supplied, the real harness reuses the saved local model profile.
export default defineConfig({
  testDir: "e2e",
  workers: 1,
  // 真实云模型调用有网络延迟：单测整体放宽到 6 分钟
  timeout: 360_000,
  outputDir: "test-results-acceptance",
  reporter: [["list"]],
  use: {
    screenshot: "on",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium-acceptance",
      use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:43211" },
      testMatch: /z-acceptance-real\.spec\.ts/,
    },
  ],
});
