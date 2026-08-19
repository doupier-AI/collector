import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test as base, type TestInfo } from "@playwright/test";

const e2eDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 43211;
const CREDENTIAL_ENV_NAMES = [
  "COLLECTOR_AI_API_KEY",
  "DEEPSEEK_API_KEY",
  "COLLECTOR_AI_PROVIDER",
  "COLLECTOR_AI_MODEL",
  "COLLECTOR_AI_BASE_URL",
  "COLLECTOR_REAL_MODEL_DATABASE",
] as const;

export type AcceptanceMode = "real" | "none";

export interface AcceptanceRuntime {
  readonly baseURL: string;
  readonly dataDir: string;
  readonly port: number;
  readonly mode: AcceptanceMode;
  readonly startCount: number;
  readonly weakMarkerNotes: string[];
  weakMarkersSeen: number;
  restart(): Promise<void>;
  close(): Promise<void>;
}

type FixtureOptions = { acceptanceMode: AcceptanceMode };
type Fixtures = { acceptance: AcceptanceRuntime };
export type RuntimeDependencies = { removeDataDir?: typeof rm };
let activeAcceptanceRuntime: AcceptanceRuntime | undefined;

/** 当前 Playwright worker 正在执行的唯一验收 runtime，仅供同一测试文件读取其数据目录。 */
export function getActiveAcceptanceRuntime(): AcceptanceRuntime {
  if (!activeAcceptanceRuntime) throw new Error("验收 runtime 尚未就绪");
  return activeAcceptanceRuntime;
}

export interface WeakMarkerEvidence {
  scenario: string;
  markers: number;
  notes: string[];
  status: string;
}

export function markerEvidenceDirectory(projectOutputDir: string): string {
  return join(projectOutputDir, "marker-evidence");
}

export function markerEvidencePath(evidenceDir: string, scenario: string, parallelIndex: number): string {
  return join(evidenceDir, `scenario-${scenario}-worker-${parallelIndex}.json`);
}

/** 供独立 summary project 与纯基础设施测试共用，避免跨 worker 的内存状态。 */
export function validateWeakMarkerEvidence(evidence: readonly WeakMarkerEvidence[]): void {
  for (const scenario of ["5", "6", "7", "8", "9"]) {
    const matches = evidence.filter((entry) => entry.scenario === scenario);
    if (matches.length !== 1) throw new Error(`弱标记场景 ${scenario} 必须且只能产出一份运行证据，实际 ${matches.length} 份`);
    if (matches[0]?.status !== "passed") throw new Error(`弱标记场景 ${scenario} 必须完成，实际 ${matches[0]?.status ?? "缺失"}`);
  }
  if (evidence.reduce((total, entry) => total + entry.markers, 0) <= 0) {
    throw new Error("五个真实场景全部零弱标记＝真实模型下流内标记链路整体失效（阻断）");
  }
}

function basePort(): number {
  const raw = Number(process.env.E2E_API_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(raw) || raw < 1024 || raw > 65535) {
    throw new Error(`E2E_API_PORT 必须是 1024–65535 的整数，当前为 ${process.env.E2E_API_PORT ?? String(DEFAULT_PORT)}`);
  }
  return raw;
}

function portFor(testInfo: TestInfo): number {
  const port = basePort() + testInfo.parallelIndex;
  if (port > 65535) {
    throw new Error(`E2E_API_PORT ${basePort()} 加并行序号 ${testInfo.parallelIndex} 超出合法端口范围`);
  }
  return port;
}

export async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    const fail = (error: Error) => reject(new Error(`验收端口 ${port} 已被占用，无法启动独立场景实例：${error.message}`));
    probe.once("error", fail);
    probe.listen(port, "127.0.0.1", () => {
      probe.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

export function hasExited(proc: Pick<ChildProcess, "exitCode" | "signalCode">): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

function waitForExit(proc: ChildProcess): Promise<void> {
  if (hasExited(proc)) return Promise.resolve();
  return new Promise((resolve) => proc.once("exit", () => resolve()));
}

async function stopChild(proc: ChildProcess): Promise<void> {
  if (hasExited(proc)) return;
  const exited = waitForExit(proc);
  try { proc.kill("SIGINT"); } catch { /* process may have exited between checks */ }
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 6_000)),
  ]);
  if (!graceful && !hasExited(proc)) {
    try { proc.kill("SIGKILL"); } catch { /* process may have exited between checks */ }
    const forced = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 6_000)),
    ]);
    if (!forced && !hasExited(proc)) throw new Error(`验收 harness 进程 ${proc.pid ?? "未知"} 在强制停止后仍未退出`);
  }
}

export function startupCleanupError(startError: unknown, cleanupError: unknown): AggregateError {
  return new AggregateError([startError, cleanupError], "验收 harness 启动失败且清理子进程失败；两个错误均保留在 errors 中");
}

export async function waitForReady(proc: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">, baseURL: string, readyFile: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (hasExited(proc)) {
      throw new Error(`验收 harness 启动期退出（码 ${proc.exitCode ?? "无"}，信号 ${proc.signalCode ?? "无"}）——具体原因见 [harness:err] 输出`);
    }
    try {
      const readyPid = (await readFile(readyFile, "utf8")).trim();
      if (readyPid !== String(proc.pid)) throw new Error(`就绪信号 PID 不匹配（${readyPid}）`);
      const response = await fetch(`${baseURL}/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`验收服务未在时限内就绪（自身 readiness + /health）：${lastError}`);
}

function harnessEnvironment(port: number, dataDir: string, readyFile: string, mode: AcceptanceMode): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, E2E_API_PORT: String(port), E2E_DATA_DIR: dataDir, E2E_READY_FILE: readyFile, COLLECTOR_MVP_DEMO: "" };
  if (mode === "none") {
    for (const name of CREDENTIAL_ENV_NAMES) delete env[name];
    env.E2E_REAL_MODEL = "none";
  } else {
    delete env.E2E_REAL_MODEL;
  }
  return env;
}

export async function createAcceptanceRuntime(testInfo: TestInfo, mode: AcceptanceMode, dependencies: RuntimeDependencies = {}): Promise<AcceptanceRuntime> {
  const port = portFor(testInfo);
  const baseURL = `http://127.0.0.1:${port}`;
  const dataDir = await mkdtemp(join(tmpdir(), `collector-acceptance-${testInfo.parallelIndex}-`));
  const readyFile = join(dataDir, "harness-ready.pid");
  const removeDataDir = dependencies.removeDataDir ?? rm;
  let child: ChildProcess | undefined;
  let closed = false;
  let startCount = 0;
  let lifecycle = Promise.resolve();

  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = lifecycle.then(operation, operation);
    lifecycle = next.then(() => undefined, () => undefined);
    return next;
  };

  const start = async () => {
    await assertPortAvailable(port);
    await rm(readyFile, { force: true });
    const proc = spawn(process.execPath, [join(e2eDir, "acceptance-real-harness.mjs")], {
      env: harnessEnvironment(port, dataDir, readyFile, mode),
      stdio: ["ignore", "pipe", "pipe"],
      cwd: e2eDir,
    });
    // 先登记，保证 readiness 或清理失败时 runtime.close 仍能尝试回收同一个 child。
    child = proc;
    proc.stdout?.on("data", (chunk) => process.stdout.write(`[harness:${port}] ${chunk}`));
    proc.stderr?.on("data", (chunk) => process.stderr.write(`[harness:${port}:err] ${chunk}`));
    try {
      await waitForReady(proc, baseURL, readyFile);
      startCount += 1;
    } catch (error) {
      try {
        await stopChild(proc);
        if (child === proc) child = undefined;
      } catch (cleanupError) {
        throw startupCleanupError(error, cleanupError);
      }
      throw error;
    }
  };

  const stop = async () => {
    const proc = child;
    if (!proc) return;
    await stopChild(proc);
    if (child === proc) child = undefined;
  };

  const runtime: AcceptanceRuntime = {
    baseURL,
    dataDir,
    port,
    mode,
    get startCount() { return startCount; },
    weakMarkerNotes: [],
    weakMarkersSeen: 0,
    restart: () => serial(async () => {
      if (closed) throw new Error("验收 runtime 已关闭，不能重启");
      await stop();
      await start();
    }),
    close: () => serial(async () => {
      if (closed) return;
      // stop 失败时保留 child 与目录，供调用方或下一次 close 重试；不能伪称已关闭。
      await stop();
      try {
        await removeDataDir(dataDir, { recursive: true, force: true });
      } catch {
        // 目录未删就不能标记 closed：下次 close 会复用已停进程状态重试删除。
        throw new Error(`验收临时目录清理失败，可再次调用 close 重试：${dataDir}`);
      }
      closed = true;
    }),
  };
  try {
    await serial(start);
    return runtime;
  } catch (error) {
    try {
      await runtime.close();
    } catch (cleanupError) {
      throw startupCleanupError(error, cleanupError);
    }
    throw error;
  }
}

function weakScenarioId(title: string): string | undefined {
  const match = title.match(/弱标记场景([五六七八九])/);
  return match ? ({ 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" } as const)[match[1] as "五" | "六" | "七" | "八" | "九"] : undefined;
}

export async function writeMarkerEvidence(evidenceDir: string, parallelIndex: number, evidence: WeakMarkerEvidence): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  const target = markerEvidencePath(evidenceDir, evidence.scenario, parallelIndex);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(evidence, null, 2), "utf8");
  await rename(temporary, target);
}

async function writeWeakMarkerEvidence(testInfo: TestInfo, runtime: AcceptanceRuntime): Promise<void> {
  const scenario = weakScenarioId(testInfo.title);
  if (!scenario) return;
  const evidenceDir = markerEvidenceDirectory(testInfo.project.outputDir);
  await writeMarkerEvidence(evidenceDir, testInfo.parallelIndex, { scenario, markers: runtime.weakMarkersSeen, notes: runtime.weakMarkerNotes, status: testInfo.status || "failed" });
}

export async function teardownAcceptanceRuntime(runtime: AcceptanceRuntime, writeEvidence: () => Promise<void>): Promise<void> {
  try {
    await writeEvidence();
  } finally {
    await runtime.close();
  }
}

export const test = base.extend<FixtureOptions & Fixtures>({
  acceptanceMode: ["real", { option: true, scope: "test" }],
  acceptance: [async ({ acceptanceMode }, use, testInfo) => {
    const runtime = await createAcceptanceRuntime(testInfo, acceptanceMode);
    activeAcceptanceRuntime = runtime;
    try {
      await use(runtime);
    } finally {
      try {
        await teardownAcceptanceRuntime(runtime, () => writeWeakMarkerEvidence(testInfo, runtime));
      } finally {
        if (activeAcceptanceRuntime === runtime) activeAcceptanceRuntime = undefined;
      }
    }
  }, { auto: true }],
  // 保留内建 context/page 生命周期（trace、screenshot、video、设备配置），不再依赖 acceptance。
  // 自动 acceptance 会先启动同一 parallelIndex 的服务；此处只按同一规则给内建 page 提供地址。
  baseURL: async ({}, use, testInfo) => use(`http://127.0.0.1:${portFor(testInfo)}`),
});

export { expect };
