import { defineConfig, devices } from "@playwright/test";

const acceptanceWorkers = Number(process.env.E2E_ACCEPTANCE_WORKERS ?? "2");
const acceptancePort = Number(process.env.E2E_API_PORT ?? "43211");
if (!Number.isInteger(acceptanceWorkers) || acceptanceWorkers < 1 || acceptanceWorkers > 64) {
  throw new Error(`E2E_ACCEPTANCE_WORKERS 必须是 1–64 的整数，当前为 ${process.env.E2E_ACCEPTANCE_WORKERS ?? "2"}`);
}
if (!Number.isInteger(acceptancePort) || acceptancePort < 1024 || acceptancePort + acceptanceWorkers - 1 > 65535) {
  throw new Error(`E2E_API_PORT 与 E2E_ACCEPTANCE_WORKERS 组合没有足够的合法端口：${acceptancePort} + ${acceptanceWorkers - 1}`);
}

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
  // 每个测试由 fixture 启动自己的 API + 数据目录；默认并发 2，必要时可 E2E_ACCEPTANCE_WORKERS=1 降到串行。
  fullyParallel: true,
  workers: acceptanceWorkers,
  // 真实云模型调用有网络延迟，深入长文（plan-then-write 逐节扩写）分钟级：整体放宽到 20 分钟
  timeout: 1_200_000,
  outputDir: "test-results-acceptance",
  globalSetup: "./e2e/acceptance-real-global-setup.mjs",
  reporter: [["list"]],
  use: {
    screenshot: "on",
    trace: "retain-on-failure",
    // 快速失败（#86 复盘）：点击/填写等动作 2 分钟内不可达即报错并留 error-context 快照，
    // 不再无限重试到整测超时（曾出现"按钮在视口外"重试 3154 次挂 26 分钟的失败方式）。
    actionTimeout: 120_000,
    // baseURL 由场景 fixture 按 E2E_API_PORT + parallelIndex 注入，避免 worker 间串场。
  },
  projects: [
    {
      name: "chromium-acceptance",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /z-acceptance-real\.spec\.ts/,
    },
    {
      // 汇总项目在主验收项目完成后读取每个 worker 的原子弱标记证据，保留跨场景总闸口语义。
      name: "chromium-acceptance-summary",
      dependencies: ["chromium-acceptance"],
      use: { ...devices["Desktop Chrome"] },
      testMatch: /z-acceptance-real-summary\.spec\.ts/,
    },
  ],
});
