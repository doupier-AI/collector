import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

// 端口基准可被 E2E_PORT_BASE 覆盖：六个 harness 依次占用 base+0..base+5。
// 默认 43211 不变；真实模型验收长跑占用默认端口时，确定性套件可用另一组端口并行
// （如 E2E_PORT_BASE=43221 npx playwright test），验收与日常开发互不挡路（#86 复盘）。
const PORT_BASE = Number(process.env.E2E_PORT_BASE ?? "43211");
const SHUTDOWN_TOKEN = process.env.E2E_SHUTDOWN_TOKEN ?? randomBytes(32).toString("base64url");
process.env.E2E_SHUTDOWN_TOKEN = SHUTDOWN_TOKEN;

type ProjectName = "chromium" | "chromium-nomodel" | "chromium-autofusion" | "chromium-visual" | "chromium-hint-quiet" | "chromium-hint";
type SuiteName = "full" | "functional" | "special" | "visual";

const SUITES: Record<SuiteName, readonly ProjectName[]> = {
  full: ["chromium", "chromium-nomodel", "chromium-autofusion", "chromium-visual", "chromium-hint-quiet", "chromium-hint"],
  functional: ["chromium"],
  special: ["chromium-nomodel", "chromium-autofusion", "chromium-hint-quiet", "chromium-hint"],
  visual: ["chromium-visual"],
} as const;

const requestedSuite = process.env.E2E_SUITE ?? "full";
if (!(requestedSuite in SUITES)) throw new Error(`Unknown E2E_SUITE: ${requestedSuite}`);
const selectedProjects = new Set<ProjectName>(SUITES[requestedSuite as SuiteName]);

const harnesses = [
  // 页面、静态资源、/v1 与 SSE 均由 API 测试进程同源提供。
  {
    project: "chromium",
    command: "node e2e/api-harness.mjs",
    url: `http://127.0.0.1:${PORT_BASE}/health`,
    reuseExistingServer: false,
    env: { E2E_API_PORT: String(PORT_BASE), E2E_MODEL: "fake" },
    stdout: "ignore" as const,
    stderr: "pipe" as const,
  },
  {
    // 未配置模型的独立路径。
    project: "chromium-nomodel",
    command: "node e2e/api-harness.mjs",
    url: `http://127.0.0.1:${PORT_BASE + 1}/health`,
    reuseExistingServer: false,
    env: { E2E_API_PORT: String(PORT_BASE + 1), E2E_MODEL: "none" },
    stdout: "ignore" as const,
    stderr: "pipe" as const,
  },
  {
    // 自动融合高置信路径：相似性核验恒判为 identity。
    project: "chromium-autofusion",
    command: "node e2e/api-harness.mjs",
    url: `http://127.0.0.1:${PORT_BASE + 2}/health`,
    reuseExistingServer: false,
    env: { E2E_API_PORT: String(PORT_BASE + 2), E2E_MODEL: "fake", E2E_SIMILARITY_RELATION: "identity" },
    stdout: "ignore" as const,
    stderr: "pipe" as const,
  },
  {
    // 像素基线独享数据库，不受其他设置测试污染。
    project: "chromium-visual",
    command: "node e2e/api-harness.mjs",
    url: `http://127.0.0.1:${PORT_BASE + 3}/health`,
    reuseExistingServer: false,
    env: { E2E_API_PORT: String(PORT_BASE + 3), E2E_MODEL: "fake" },
    stdout: "ignore" as const,
    stderr: "pipe" as const,
  },
  {
    // 关联提示安静路径：产品价值评估恒判不足。
    project: "chromium-hint-quiet",
    command: "node e2e/api-harness.mjs",
    url: `http://127.0.0.1:${PORT_BASE + 4}/health`,
    reuseExistingServer: false,
    env: { E2E_API_PORT: String(PORT_BASE + 4), E2E_MODEL: "fake", E2E_SIMILARITY_RELATION: "unrelated", E2E_ASSOCIATION_HINT: "1" },
    stdout: "ignore" as const,
    stderr: "pipe" as const,
  },
  {
    // 关联提示正向路径：独享数据库并开启提示扫描。
    project: "chromium-hint",
    command: "node e2e/api-harness.mjs",
    url: `http://127.0.0.1:${PORT_BASE + 5}/health`,
    reuseExistingServer: false,
    env: { E2E_API_PORT: String(PORT_BASE + 5), E2E_MODEL: "fake", E2E_ASSOCIATION_HINT: "1" },
    stdout: "ignore" as const,
    stderr: "pipe" as const,
  },
];

const selectedHarnesses = harnesses.filter(({ project }) => selectedProjects.has(project as ProjectName));
process.env.E2E_SERVER_OFFSETS = selectedHarnesses
  .map(({ env }) => Number(env.E2E_API_PORT) - PORT_BASE)
  .join(",");

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  workers: 1,
  timeout: 30_000,
  outputDir: process.env.E2E_OUTPUT_DIR ?? "test-results",
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
    // 浏览器宿主区域设置会改变原生日期输入占位符与日期格式；固定为产品默认中文环境，
    // 避免本机 yyyy/mm/dd 与 GitHub Windows en-US mm/dd/yyyy 形成伪视觉回归。
    locale: "zh-CN",
    timezoneId: "Asia/Hong_Kong",
    // 快速失败（#86 复盘）：交互动作 15s 内不可达即报错并留取证快照，替代整测 30s 超时的模糊失败；
    // 个别确有需要的用例可用 test.use({ actionTimeout }) 或动作参数局部覆盖。真实验收侧见 playwright.acceptance.config.ts。
    actionTimeout: 15_000,
  },
  webServer: selectedHarnesses.map(({ project: _project, ...server }) => server),
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${PORT_BASE}` },
      // z-auto-fusion（identity 高置信）由 chromium-autofusion（43213）承担；-off 用例用 contrast，留在本 project。
      // z-visual-baseline 等像素基线由 chromium-visual（43214 独享库）承担，与共享库污染隔离。
      // z-association-hint-quiet 由 chromium-hint-quiet（43215 独享库 + 核验恒判无关）承担；
      // z-association-hint 由 chromium-hint（43216 独享库 + 接线提示扫描）承担。两条提示用例
      // 都移出本 project，使共享库不再触发常驻提示扫描（保持像素基线与计时敏感用例确定）。
      // 真实验收主场景及跨 worker 汇总只由 playwright.acceptance.config.ts 收集。
      // 基础设施契约仍留在默认门禁中，但它只启动无模型的临时 runtime。
      testIgnore: /(?:no-model|z-acceptance-real(?:-summary)?|z-auto-fusion|z-visual-baseline|z-association-hint(?:-quiet)?)\.spec\.ts/,
    },
    {
      name: "chromium-nomodel",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${PORT_BASE + 1}` },
      testMatch: /no-model\.spec\.ts/,
      // 配对码现铸端点已根治 TTL 过期抖动；retries 保留为一般基础设施防抖。
      retries: 1,
    },
    {
      name: "chromium-autofusion",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${PORT_BASE + 2}` },
      testMatch: /z-auto-fusion\.spec\.ts/,
      retries: 1,
    },
    {
      name: "chromium-visual",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${PORT_BASE + 3}` },
      testMatch: /z-visual-baseline\.spec\.ts/,
    },
    {
      name: "chromium-hint-quiet",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${PORT_BASE + 4}` },
      testMatch: /z-association-hint-quiet\.spec\.ts/,
    },
    {
      name: "chromium-hint",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${PORT_BASE + 5}` },
      testMatch: /z-association-hint\.spec\.ts/,
    },
  ].filter(({ name }) => selectedProjects.has(name as ProjectName)),
});
