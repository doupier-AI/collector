/**
 * 按稳定运行边界选择 Playwright 项目。
 *
 * 各套件由 playwright.config.ts 只启动所需 harness；额外 Playwright
 * 参数原样透传，例如 --shard=1/3 或单个测试文件。
 */
import { spawnSync } from "node:child_process";

const suites = new Set(["full", "functional", "special", "visual"]);
const [suite, ...playwrightArgs] = process.argv.slice(2);

if (!suite || !suites.has(suite)) {
  console.error(`未知 E2E 套件：${suite ?? "未提供"}。用法：node scripts/run-e2e.mjs ${[...suites].join("|")}`);
  process.exit(2);
}

const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) {
  console.error("请通过 package.json 中的 test:e2e:* 脚本运行 E2E，不直接调用内部启动器。");
  process.exit(2);
}
const args = ["run", "test:e2e", "-w", "@collector/web"];
if (playwrightArgs.length > 0) args.push("--", ...playwrightArgs);

const result = spawnSync(process.execPath, [npmExecPath, ...args], {
  env: { ...process.env, E2E_SUITE: suite },
  stdio: "inherit",
  windowsHide: true,
});

process.exit(result.status ?? 1);
