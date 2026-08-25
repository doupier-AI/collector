/**
 * 统一全量门禁入口（npm run gate）。
 *
 * 阶段定义全部复用现有 npm scripts，本文件只做编排与失败阶段报告，不重复枚举：
 *   1. check —— scripts/check-project.ps1（项目检查：密钥泄露扫描、Node 版本、退役依赖、CORS）
 *   2. test  —— 根 npm test（构建 + 单元/集成测试）
 *   3. e2e   —— 一次构建 + 主功能分片/隔离场景/视觉基线并行
 *
 * test 与 e2e 各自包含构建：单阶段重跑始终基于最新构建；
 * 全量连跑时 e2e 前的 tsc -b 为增量。fast 是 check + test 的组别名。
 *
 * 任一阶段失败即终止，打印失败阶段与原退出码并以该码退出；全部通过打印全绿摘要。
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const STAGES = [
  { id: "check", label: "项目检查", command: "npm run check" },
  { id: "test", label: "构建 + 单元/集成测试", command: "npm test" },
  { id: "e2e", label: "构建 + Playwright 并行全量", command: "npm run test:e2e" },
];

const GROUPS = new Map([
  ["fast", ["check", "test"]],
]);

const requested = process.argv.slice(2);
const knownStageIds = new Set(STAGES.map((stage) => stage.id));
const unknown = requested.filter((id) => !knownStageIds.has(id) && !GROUPS.has(id));
if (unknown.length > 0) {
  const choices = [...GROUPS.keys(), ...STAGES.map((stage) => stage.id)].join("|");
  console.error(`未知阶段：${unknown.join("、")}。用法：npm run gate（全部）或 npm run gate -- ${choices}`);
  process.exit(2);
}
const selectedIds = new Set(
  requested.flatMap((id) => GROUPS.get(id) ?? [id]),
);
const stages = requested.length > 0 ? STAGES.filter((stage) => selectedIds.has(stage.id)) : STAGES;

for (const [index, stage] of stages.entries()) {
  console.log(`\n── gate [${index + 1}/${stages.length}] ${stage.label}：${stage.command}`);
  const result = spawnSync(stage.command, { shell: true, stdio: "inherit", cwd: repositoryRoot, windowsHide: true });
  if (result.status !== 0) {
    console.error(`\ngate 失败于阶段「${stage.label}」（${stage.command}），退出码 ${result.status ?? "信号终止"}。`);
    process.exit(result.status ?? 1);
  }
}

console.log(`\ngate 全绿：${stages.map((stage) => stage.label).join(" + ")} 均通过。`);
