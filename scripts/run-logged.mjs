/**
 * 后台/长时间命令的统一日志包装（npm run run:logged -- <命令>）。
 *
 * 解决的问题：后台任务命令尾部追加 echo、或经 tee/tail 管道时，复合命令的退出码被
 * 尾部操作覆盖——外层任务通知显示 exit 0 而实际失败（已实际发生）。本 wrapper 保证：
 *   - 子进程完整 stdout/stderr 同时写入控制台与日志文件，不截断；
 *   - 日志末行 `EXIT=<n>` 记录真实子进程退出码；
 *   - wrapper 自身以同一退出码退出，不依赖任何尾部 echo；
 *   - 开始/结束打印命令、日志位置、起止时间与耗时。
 *
 * 用法：node scripts/run-logged.mjs [--log <路径>] <命令...>
 *   - 未指定 --log 时写入 logs/<时间戳>-<命令摘要>.log（*.log 已被 .gitignore 覆盖）；
 *   - 首个非选项 token 起全部为命令，`--` 等参数原样透传（如 npm run gate -- e2e）；
 *   - 含复杂引号的命令，把整个命令作为单个带引号字符串传入最稳妥。
 *
 * 普通前台短命令不需要本工具。
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function usage(message) {
  if (message) console.error(message);
  console.error("用法：npm run run:logged -- [--log <路径>] <命令...>");
  process.exit(2);
}

const argv = process.argv.slice(2);
let logPath;
let command;
for (let i = 0; i < argv.length; i += 1) {
  const token = argv[i];
  if (token === "--") {
    command = argv.slice(i + 1);
    break;
  }
  if (token === "--log") {
    logPath = argv[i + 1];
    if (!logPath) usage("--log 缺少路径。");
    i += 1;
    continue;
  }
  if (token.startsWith("--")) usage(`未知选项：${token}`);
  command = argv.slice(i);
  break;
}
if (!command || command.length === 0) usage("缺少要执行的命令。");
const commandString = command.join(" ");

function pad(value) {
  return String(value).padStart(2, "0");
}
function timestampForFile(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
function timestampForLog(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function slugify(text) {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug || "command";
}

const startedAt = new Date();
if (!logPath) logPath = join("logs", `${timestampForFile(startedAt)}-${slugify(commandString)}.log`);
const absoluteLogPath = resolve(repositoryRoot, logPath);
mkdirSync(dirname(absoluteLogPath), { recursive: true });
const log = createWriteStream(absoluteLogPath, { encoding: "utf8" });

function emit(line) {
  console.log(line);
  log.write(`${line}\n`);
}

emit(`── run-logged 开始：${commandString}`);
emit(`   目录：${repositoryRoot}`);
emit(`   日志：${absoluteLogPath}`);
emit(`   开始：${timestampForLog(startedAt)}`);

const child = spawn(commandString, { shell: true, cwd: repositoryRoot });
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  log.write(chunk);
});
child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  log.write(chunk);
});

const outcome = await new Promise((resolveOutcome) => {
  child.on("error", (error) => {
    emit(`   启动失败：${error.message}`);
    resolveOutcome({ code: 1, signal: null });
  });
  child.on("close", (code, signal) => {
    resolveOutcome({ code: code ?? 1, signal });
  });
});

const endedAt = new Date();
const elapsedSeconds = Math.round((endedAt - startedAt) / 1000);
const elapsed = `${Math.floor(elapsedSeconds / 60)}m${pad(elapsedSeconds % 60)}s`;
const signalNote = outcome.signal ? `（信号 ${outcome.signal} 终止）` : "";
emit(`── run-logged 结束：退出码 ${outcome.code}${signalNote}（耗时 ${elapsed}，结束于 ${timestampForLog(endedAt)}）`);
emit(`   日志：${absoluteLogPath}`);

await new Promise((resolveFinish) => log.end(`EXIT=${outcome.code}\n`, resolveFinish));
process.exit(outcome.code);
