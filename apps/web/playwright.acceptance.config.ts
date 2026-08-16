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
  // 真实云模型调用有网络延迟，深入长文（plan-then-write 逐节扩写）分钟级：整体放宽到 20 分钟
  timeout: 1_200_000,
  outputDir: "test-results-acceptance",
  reporter: [["list"]],
  use: {
    screenshot: "on",
    trace: "retain-on-failure",
    // 快速失败（#86 复盘）：点击/填写等动作 2 分钟内不可达即报错并留 error-context 快照，
    // 不再无限重试到整测超时（曾出现"按钮在视口外"重试 3154 次挂 26 分钟的失败方式）。
    actionTimeout: 120_000,
    // 端口可被 E2E_API_PORT 覆盖：验收长跑时另一端口可并行跑确定性套件或实验（默认不变）。
    baseURL: `http://127.0.0.1:${process.env.E2E_API_PORT ?? "43211"}`,
  },
  projects: [
    {
      name: "chromium-acceptance",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /z-acceptance-real\.spec\.ts/,
    },
  ],
});
