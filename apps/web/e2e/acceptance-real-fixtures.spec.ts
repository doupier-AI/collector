import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  assertPortAvailable,
  createAcceptanceRuntime,
  hasExited,
  markerEvidencePath,
  teardownAcceptanceRuntime,
  startupCleanupError,
  validateWeakMarkerEvidence,
  waitForReady,
  writeMarkerEvidence,
  type AcceptanceRuntime,
  type WeakMarkerEvidence,
} from "./acceptance-real-fixtures";

const passingEvidence = (): WeakMarkerEvidence[] => ["5", "6", "7", "8", "9"].map((scenario, index) => ({
  scenario,
  markers: index === 0 ? 1 : 0,
  notes: [],
  status: "passed",
}));

/** 默认门禁已有固定 webServer 占用 43211；基础设施契约应使用一次性的独立空闲端口。 */
async function emptyPort(): Promise<number> {
  const server = createTcpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("未获得临时测试端口");
  const { port } = address;
  server.close();
  await once(server, "close");
  return port;
}

test("真实验收基础设施：弱标记汇总要求五份最终证据且总数非零", () => {
  expect(() => validateWeakMarkerEvidence(passingEvidence())).not.toThrow();
  expect(() => validateWeakMarkerEvidence(passingEvidence().filter((entry) => entry.scenario !== "9"))).toThrow(/场景 9/);
  expect(() => validateWeakMarkerEvidence([...passingEvidence(), { ...passingEvidence()[0]!, status: "failed" }])).toThrow(/场景 5/);
  // 重试只保留同一场景最终覆盖后的那份 passed 证据，不能把失败重试另算一份。
  expect(() => validateWeakMarkerEvidence(passingEvidence().map((entry) => entry.scenario === "5" ? { ...entry, status: "passed" } : entry))).not.toThrow();
  expect(() => validateWeakMarkerEvidence(passingEvidence().map((entry) => ({ ...entry, markers: 0 })))).toThrow(/全部零/);
});

test("真实验收基础设施：占用端口可读失败，旧服务健康不能冒充自身 readiness", async () => {
  const server = createServer((_request, response) => response.end("old service"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("未获得测试端口");
  try {
    await expect(assertPortAvailable(address.port)).rejects.toThrow(/已被占用/);
    await expect(waitForReady({ pid: process.pid, exitCode: null, signalCode: null }, `http://127.0.0.1:${address.port}`, "不存在的就绪文件", 50)).rejects.toThrow(/自身 readiness/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("真实验收基础设施：证据写入失败仍关闭 runtime", async () => {
  let closeCalls = 0;
  const runtime = { close: async () => { closeCalls += 1; } } as AcceptanceRuntime;
  await expect(teardownAcceptanceRuntime(runtime, async () => { throw new Error("模拟证据磁盘失败"); })).rejects.toThrow("模拟证据磁盘失败");
  expect(closeCalls).toBe(1);
});

test("真实验收基础设施：Windows signalCode 也代表 harness 已退出，启动清理错误可观测", () => {
  expect(hasExited({ exitCode: null, signalCode: "SIGINT" })).toBe(true);
  const error = startupCleanupError(new Error("启动失败"), new Error("停止失败"));
  expect(error.errors).toHaveLength(2);
  expect(error.message).toContain("启动失败且清理子进程失败");
});

test("真实验收基础设施：目录清理失败不伪称 close 成功，重试可完成", async ({}, testInfo) => {
  let removals = 0;
  const runtime = await createAcceptanceRuntime(testInfo, "none", {
    port: await emptyPort(),
    removeDataDir: async (path, options) => {
      removals += 1;
      if (removals === 1) throw new Error("模拟删除失败");
      await rm(path, options);
    },
  });
  await expect(runtime.close()).rejects.toThrow(/临时目录清理失败/);
  await expect(runtime.close()).resolves.toBeUndefined();
  expect(removals).toBe(2);
});

test("真实验收基础设施：同场景重试原子覆盖为一份最终证据", async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), "collector-acceptance-evidence-"));
  try {
    await writeMarkerEvidence(evidenceDir, 1, { scenario: "5", markers: 0, notes: ["首次失败"], status: "failed" });
    await writeMarkerEvidence(evidenceDir, 1, { scenario: "5", markers: 2, notes: ["重试通过"], status: "passed" });
    expect(await readdir(evidenceDir)).toEqual(["scenario-5-worker-1.json"]);
    expect(markerEvidencePath(evidenceDir, "5", 1)).toBe(join(evidenceDir, "scenario-5-worker-1.json"));
    expect(JSON.parse(await readFile(markerEvidencePath(evidenceDir, "5", 1), "utf8"))).toMatchObject({ status: "passed", markers: 2 });
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
  }
});
