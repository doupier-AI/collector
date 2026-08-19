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
  readonly weakMarkerNotes: string[];
  weakMarkersSeen: number;
  restart(): Promise<void>;
  close(): Promise<void>;
}

type FixtureOptions = { acceptanceMode: AcceptanceMode };
type Fixtures = { acceptance: AcceptanceRuntime };

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

async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    const fail = (error: Error) => reject(new Error(`验收端口 ${port} 已被占用，无法启动独立场景实例：${error.message}`));
    probe.once("error", fail);
    probe.listen(port, "127.0.0.1", () => {
      probe.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

function waitForExit(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => proc.once("exit", () => resolve()));
}

async function stopChild(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  const exited = waitForExit(proc);
  try { proc.kill("SIGINT"); } catch { /* process may have exited between checks */ }
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 6_000)),
  ]);
  if (!graceful && proc.exitCode === null) {
    try { proc.kill("SIGKILL"); } catch { /* process may have exited between checks */ }
    const forced = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 6_000)),
    ]);
    if (!forced && proc.exitCode === null) throw new Error(`验收 harness 进程 ${proc.pid ?? "未知"} 在强制停止后仍未退出`);
  }
}

async function waitForReady(proc: ChildProcess, baseURL: string, readyFile: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`验收 harness 启动期退出（码 ${proc.exitCode}）——具体原因见 [harness:err] 输出`);
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
  const env = { ...process.env, E2E_API_PORT: String(port), E2E_DATA_DIR: dataDir, E2E_READY_FILE: readyFile, COLLECTOR_MVP_DEMO: "" };
  if (mode === "none") {
    for (const name of CREDENTIAL_ENV_NAMES) delete env[name];
    env.E2E_REAL_MODEL = "none";
  } else {
    delete env.E2E_REAL_MODEL;
  }
  return env;
}

export async function createAcceptanceRuntime(testInfo: TestInfo, mode: AcceptanceMode): Promise<AcceptanceRuntime> {
  const port = portFor(testInfo);
  const baseURL = `http://127.0.0.1:${port}`;
  const dataDir = await mkdtemp(join(tmpdir(), `collector-acceptance-${testInfo.parallelIndex}-`));
  const readyFile = join(dataDir, "harness-ready.pid");
  let child: ChildProcess | undefined;
  let closed = false;
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
    proc.stdout?.on("data", (chunk) => process.stdout.write(`[harness:${port}] ${chunk}`));
    proc.stderr?.on("data", (chunk) => process.stderr.write(`[harness:${port}:err] ${chunk}`));
    try {
      await waitForReady(proc, baseURL, readyFile);
      child = proc;
    } catch (error) {
      await stopChild(proc).catch(() => undefined);
      throw error;
    }
  };

  const stop = async () => {
    const proc = child;
    child = undefined;
    if (proc) await stopChild(proc);
  };

  const runtime: AcceptanceRuntime = {
    baseURL,
    dataDir,
    port,
    mode,
    weakMarkerNotes: [],
    weakMarkersSeen: 0,
    restart: () => serial(async () => {
      if (closed) throw new Error("验收 runtime 已关闭，不能重启");
      await stop();
      await start();
    }),
    close: () => serial(async () => {
      if (closed) return;
      closed = true;
      await stop();
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    }),
  };
  try {
    await serial(start);
    return runtime;
  } catch (error) {
    await runtime.close().catch(() => undefined);
    throw error;
  }
}

function weakScenarioId(title: string): string | undefined {
  const match = title.match(/弱标记场景([五六七八九])/);
  return match ? ({ 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" } as const)[match[1] as "五" | "六" | "七" | "八" | "九"] : undefined;
}

async function writeWeakMarkerEvidence(testInfo: TestInfo, runtime: AcceptanceRuntime): Promise<void> {
  const scenario = weakScenarioId(testInfo.title);
  if (!scenario) return;
  const evidenceDir = join(testInfo.config.outputDir, "marker-evidence");
  await mkdir(evidenceDir, { recursive: true });
  const target = join(evidenceDir, `scenario-${scenario}-worker-${testInfo.parallelIndex}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ scenario, markers: runtime.weakMarkersSeen, notes: runtime.weakMarkerNotes, status: testInfo.status }, null, 2), "utf8");
  await rename(temporary, target);
}

export const test = base.extend<Fixtures, FixtureOptions>({
  acceptanceMode: ["real", { option: true }],
  acceptance: async ({ acceptanceMode }, use, testInfo) => {
    const runtime = await createAcceptanceRuntime(testInfo, acceptanceMode);
    try {
      await use(runtime);
    } finally {
      await writeWeakMarkerEvidence(testInfo, runtime);
      await runtime.close();
    }
  },
  // 只覆写 Playwright 的 baseURL option；内建 context/page 仍继承项目配置中的 Desktop Chrome、trace 等选项。
  baseURL: async ({ acceptance }, use) => use(acceptance.baseURL),
});

export { expect };
