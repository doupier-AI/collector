#!/usr/bin/env node
/**
 * e2e 失败诊断：解析最新失败的 Playwright test-results 目录，
 * 输出错误摘要 + 网络请求时序 + 控制台错误 + 页面快照关键元素，
 * 把每次失败排查从"手动解压 trace + 翻 JSONL"压缩到一条命令。
 *
 * 用法：node e2e/debug-last-failure.mjs [失败目录名可选]
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const e2eDir = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(e2eDir, "..", "test-results");

/** 取最新失败目录：优先显式传入，否则取 error-context.md 存在且最新者。 */
function latestFailureDir(override) {
  if (override && existsSync(join(resultsDir, override))) return join(resultsDir, override);
  const dirs = readdirSync(resultsDir)
    .filter((name) => existsSync(join(resultsDir, name, "error-context.md")))
    .map((name) => {
      const stat = existsSync(join(resultsDir, name, "trace.zip"))
        ? readFileSync(join(resultsDir, name, "trace.zip")).length
        : 0;
      return { name, stat };
    })
    .sort((a, b) => b.stat - a.stat);
  if (dirs.length === 0) {
    console.error(`未找到失败目录（${resultsDir} 为空或均为通过）`);
    process.exit(1);
  }
  return join(resultsDir, dirs[0].name);
}

const dir = latestFailureDir(process.argv[2]);
console.log(`\n=== 失败目录: ${dir}\n`);

// 1. 错误摘要（error-context.md）
const ctxPath = join(dir, "error-context.md");
if (existsSync(ctxPath)) {
  const ctx = readFileSync(ctxPath, "utf8");
  const nameMatch = ctx.match(/- Name: (.+)/);
  if (nameMatch) console.log(`【测试】${nameMatch[1]}`);
  const errBlock = ctx.match(/```\n([\s\S]*?)```/);
  if (errBlock) console.log(`【错误】\n${errBlock[1].trim()}`);
}

// 2. 解压 trace 并分析网络请求与控制台错误
const traceZip = join(dir, "trace.zip");
if (existsSync(traceZip)) {
  const traceDir = join(dir, "tracex");
  try {
    // Git Bash 环境有 unzip；Windows 原生 fallback 用 PowerShell。
    try {
      execFileSync("unzip", ["-o", "-q", traceZip, "-d", traceDir], { stdio: "ignore" });
    } catch {
      execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -Force '${traceZip}' '${traceDir}'`], { stdio: "ignore" });
    }

    // 网络请求（0-trace.network）
    const netPath = join(traceDir, "0-trace.network");
    if (existsSync(netPath)) {
      const requests = [];
      for (const line of readFileSync(netPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e.snapshot?.request?.url) {
            requests.push({
              method: e.snapshot.request.method ?? "GET",
              url: e.snapshot.request.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, ""),
              status: e.snapshot.response?.status,
            });
          }
        } catch { /* 非 JSON 行跳过 */ }
      }
      const api = requests.filter((r) => r.url.startsWith("/v1/") || r.url.includes("fusion") || r.url.includes("settings"));
      console.log(`\n【网络请求 ${requests.length} 条（API ${api.length} 条）】`);
      if (api.length > 0) {
        for (const r of api) console.log(`  ${r.method.padEnd(4)} ${String(r.status ?? "---").padEnd(3)} ${r.url}`);
      } else {
        console.log("  (无 API 请求，失败发生在页面加载/配对前)");
      }
    }

    // 控制台错误（0-trace.trace）
    const tracePath = join(traceDir, "0-trace.trace");
    if (existsSync(tracePath)) {
      const errors = [];
      for (const line of readFileSync(tracePath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e.type === "console" && e.messageType === "error") errors.push(e.text ?? JSON.stringify(e));
        } catch { /* 跳过 */ }
      }
      if (errors.length > 0) {
        console.log(`\n【控制台错误 ${errors.length} 条】`);
        for (const err of errors.slice(0, 8)) console.log(`  ${err}`);
      }
    }
  } catch (error) {
    console.log(`(trace 解析失败: ${error instanceof Error ? error.message : String(error)})`);
  }
} else {
  console.log("(无 trace.zip)");
}

// 3. 页面快照关键元素（error-context.md 的 yaml 部分）
if (existsSync(ctxPath)) {
  const ctx = readFileSync(ctxPath, "utf8");
  const yamlMatch = ctx.match(/```yaml\n([\s\S]*?)```/);
  if (yamlMatch) {
    const keyLines = yamlMatch[1]
      .split("\n")
      .filter((line) => line.includes("heading") || line.includes("fusion") || line.includes("配对"))
      .slice(0, 10);
    if (keyLines.length > 0) {
      console.log(`\n【页面快照关键元素】`);
      for (const line of keyLines) console.log(`  ${line.trim()}`);
    }
  }
}
console.log("");
