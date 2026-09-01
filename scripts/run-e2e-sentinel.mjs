/**
 * 完整 E2E 前的短时高风险哨兵。
 *
 * 首轮覆盖近期反复波动的动作/持久化/UI 对齐与视觉用例。若首轮失败，
 * 只重跑 Playwright 记录的失败测试做 flaky/persistent 分类；最终退出码始终
 * 保留首轮失败，且首轮与分类重跑的 trace/截图写入不同目录。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifySentinelRun } from "./e2e-sentinel-policy.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = join(repositoryRoot, "apps", "web");
const npmExecPath = process.env.npm_execpath;
const repeatEach = Number(process.env.E2E_SENTINEL_REPEAT_EACH ?? "2");

if (!npmExecPath) {
  console.error("请通过 npm run test:e2e:sentinel 运行哨兵，不直接调用内部启动器。");
  process.exit(2);
}
if (!Number.isInteger(repeatEach) || repeatEach < 1 || repeatEach > 5) {
  console.error(`E2E_SENTINEL_REPEAT_EACH 必须在 1..5，当前为 ${process.env.E2E_SENTINEL_REPEAT_EACH ?? "2"}`);
  process.exit(2);
}

const selectedSpecs = [
  "helpers-network.spec.ts",
  "selection-capsule.spec.ts",
  "z-message-actions.spec.ts",
  "z-research-import.spec.ts",
  "z-research-later.spec.ts",
  "z-map-visual.spec.ts",
];
const highRiskSignatures = [
  "fixture route forwarding retries one transient connection reset",
  "选区 → 引用 → 深入研究这段 → 创建子节点并导航 → 节点页呈现",
  "重新编辑：改写问题后新回答直接替换旧回答",
  "解析失败显示稳定原因，重试后仍失败保持可重试状态",
  "选区胶囊【标记】可展开笔记",
  "点击【标记】后 1 秒未输入笔记",
  "会话菜单打开居中标记弹窗",
  "研究图谱视觉基线",
];
const grep = highRiskSignatures.join("|");
const firstOutput = "test-results-gate-sentinel";
const rerunOutput = "test-results-gate-sentinel-rerun";
const commonArgs = [
  "run", "test:e2e", "-w", "@collector/web", "--",
  ...selectedSpecs,
  "--grep", grep,
  "--repeat-each", String(repeatEach),
];

function runNpm(args, env = {}) {
  return spawnSync(process.execPath, [npmExecPath, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    stdio: "inherit",
    windowsHide: true,
  });
}

const build = runNpm(["run", "build"]);
if (build.status !== 0) process.exit(build.status ?? 1);

console.log(`\n── E2E sentinel：${highRiskSignatures.length} 个高风险签名，每项 ${repeatEach} 轮`);
const first = runNpm(commonArgs, {
  E2E_SUITE: "full",
  E2E_OUTPUT_DIR: firstOutput,
});

let rerun;
if (first.status !== 0) {
  console.error("\nE2E sentinel 首次失败；以下重跑只分类 flaky，不会改变门禁红灯。");
  const lastFailedFile = join(webRoot, firstOutput, ".last-run.json");
  rerun = runNpm([
    ...commonArgs,
    "--last-failed",
    "--last-failed-file", lastFailedFile,
  ], {
    E2E_SUITE: "full",
    E2E_OUTPUT_DIR: rerunOutput,
  });
}

const verdict = classifySentinelRun(first.status, rerun?.status);
const summaryDir = join(webRoot, firstOutput);
mkdirSync(summaryDir, { recursive: true });
writeFileSync(
  join(summaryDir, "classification.json"),
  `${JSON.stringify({
    classification: verdict.classification,
    firstExitCode: first.status,
    rerunExitCode: rerun?.status,
    repeatEach,
    signatures: highRiskSignatures,
  }, null, 2)}\n`,
  "utf8",
);

if (verdict.classification === "stable") {
  console.log("E2E sentinel 全绿。");
} else {
  console.error(`E2E sentinel 分类：${verdict.classification}；保留首次退出码 ${verdict.exitCode}。`);
}
process.exit(verdict.exitCode);
