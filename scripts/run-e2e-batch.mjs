/**
 * 本地全量 E2E：只构建一次，然后用独立端口和结果目录并行运行
 * 三个主功能分片、隔离场景和视觉基线。所有轨道都结束后一次性
 * 报告失败，避免修复一个晚暴露问题后才看到下一个。
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const npmExecPath = process.env.npm_execpath;
const basePort = Number(process.env.E2E_PORT_BASE ?? "43211");
const functionalShardCount = Number(process.env.E2E_FUNCTIONAL_SHARDS ?? "3");
const playwrightArgs = process.argv.slice(2);

if (!npmExecPath) {
  console.error("请通过 npm run test:e2e 运行全量 E2E，不直接调用内部启动器。");
  process.exit(2);
}

if (!Number.isInteger(functionalShardCount) || functionalShardCount < 1 || functionalShardCount > 6) {
  console.error(`E2E_FUNCTIONAL_SHARDS 必须在 1..6，当前为 ${process.env.E2E_FUNCTIONAL_SHARDS ?? "3"}`);
  process.exit(2);
}
const highestPort = basePort + functionalShardCount * 10 + 13;
if (!Number.isInteger(basePort) || basePort < 1024 || highestPort > 65_535) {
  console.error(`E2E_PORT_BASE 与分片组合超出可用端口范围，当前为 ${process.env.E2E_PORT_BASE ?? "43211"}`);
  process.exit(2);
}

const build = spawnSync(process.execPath, [npmExecPath, "run", "build"], {
  cwd: repositoryRoot,
  stdio: "inherit",
  windowsHide: true,
});
if (build.status !== 0) process.exit(build.status ?? 1);

const tracks = [
  ...Array.from({ length: functionalShardCount }, (_, index) => ({
    id: `functional-${index + 1}`,
    suite: "functional",
    args: [`--shard=${index + 1}/${functionalShardCount}`, ...playwrightArgs],
    portBase: basePort + index * 10,
  })),
  { id: "special", suite: "special", args: playwrightArgs, portBase: basePort + functionalShardCount * 10 },
  { id: "visual", suite: "visual", args: playwrightArgs, portBase: basePort + (functionalShardCount + 1) * 10 },
];

console.log(`\n── E2E 并行轨道：${tracks.map(({ id }) => id).join("、")}`);

const results = await Promise.all(tracks.map((track) => new Promise((resolve) => {
  const child = spawn(process.execPath, ["scripts/run-e2e.mjs", track.suite, ...track.args], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      E2E_PORT_BASE: String(track.portBase),
      E2E_OUTPUT_DIR: `test-results-gate-${track.id}`,
    },
    stdio: "inherit",
    windowsHide: true,
  });
  child.on("error", (error) => resolve({ id: track.id, code: 1, error }));
  child.on("exit", (code) => resolve({ id: track.id, code: code ?? 1 }));
})));

const failed = results.filter(({ code }) => code !== 0);
for (const result of results) {
  console.log(`${result.code === 0 ? "✓" : "✗"} ${result.id}: exit ${result.code}${result.error ? ` (${result.error.message})` : ""}`);
}
if (failed.length > 0) {
  console.error(`E2E 失败轨道：${failed.map(({ id }) => id).join("、")}`);
  process.exit(1);
}

console.log("E2E 并行全绿。");
