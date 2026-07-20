import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  ensureInstanceControlToken,
  inspectCollectorInstance,
  probeCollectorInstance,
  readInstanceControlToken,
  readInstanceState,
  removeInstanceState,
  requestInstanceShutdown,
  requestBrowserBootstrap,
  type CollectorInstanceState,
} from "./instance.js";
import { defaultDataPaths } from "./store.js";
import { calculateRuntimeVersion, isRuntimeVersion } from "./runtime-version.js";
import { isProcessRunning, isServiceLockHeld } from "./service-lock.js";

const LAUNCH_LOCK_FILE = "launch.lock";
const LAUNCH_LOCK_DATABASE = "launch-lock.sqlite";

export interface LaunchCollectorOptions {
  dataRoot?: string;
  serverEntry?: string;
  openBrowser?: boolean;
  fetchImpl?: typeof fetch;
  browserOpener?: (url: string) => Promise<void>;
  readyTimeoutMs?: number;
  runtimeVersion?: string;
  stopInstance?: (
    state: CollectorInstanceState,
    controlToken: string | undefined,
    fetchImpl: typeof fetch,
    dataRoot: string,
  ) => Promise<void>;
}

export interface LaunchCollectorResult {
  reused: boolean;
  state: CollectorInstanceState;
  workspaceUrl: string;
  openedUrl: string;
  pairedByLauncher: boolean;
}

export async function launchCollector(options: LaunchCollectorOptions = {}): Promise<LaunchCollectorResult> {
  const dataRoot = resolve(options.dataRoot ?? defaultDataPaths(process.env.COLLECTOR_DATA_DIR).root);
  const serverEntry = resolve(options.serverEntry ?? fileURLToPath(new URL("./server.js", import.meta.url)));
  const webRoot = resolve(process.env.COLLECTOR_WEB_ROOT?.trim() || resolve(dirname(serverEntry), "../../web/dist"));
  const runtimeVersion = options.runtimeVersion ?? await calculateRuntimeVersion(
    dirname(serverEntry),
    webRoot,
  );
  if (!isRuntimeVersion(runtimeVersion)) {
    throw new Error("Collector runtime version must be a SHA-256 build fingerprint");
  }
  const releaseLock = await acquireLaunchLock(dataRoot);
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    let state = await readInstanceState(dataRoot);
    const probe = state
      ? await inspectCollectorInstance(state, runtimeVersion, fetchImpl)
      : { kind: "unreachable" } as const;
    let reused = probe.kind === "compatible";
    if (!reused) {
      if (state && probe.kind === "incompatible") {
        const controlToken = await readInstanceControlToken(dataRoot);
        await (options.stopInstance ?? stopIncompatibleInstance)(state, controlToken, fetchImpl, dataRoot);
      } else if (state && isServiceLockHeld(dataRoot)) {
        throw new Error("Collector 的现有服务暂时没有响应。为避免多个服务同时使用同一份数据，本次没有启动新服务；请稍后重试，或先关闭旧服务。");
      }
      if (state) await removeInstanceState(dataRoot, state.instanceId);
      const controlToken = await ensureInstanceControlToken(dataRoot);
      const expectedInstanceId = randomUUID();
      spawnCollectorService(dataRoot, expectedInstanceId, runtimeVersion, serverEntry);
      state = await waitForReadyInstance(dataRoot, expectedInstanceId, runtimeVersion, fetchImpl, options.readyTimeoutMs ?? 15_000);
      const openedUrl = await requestBrowserBootstrap(state, controlToken, fetchImpl);
      if (options.openBrowser !== false) await (options.browserOpener ?? openDefaultBrowser)(openedUrl);
      return {
        reused: false,
        state,
        workspaceUrl: `http://127.0.0.1:${state.port}/`,
        openedUrl,
        pairedByLauncher: true,
      };
    }

    const workspaceUrl = `http://127.0.0.1:${state!.port}/`;
    const controlToken = await readInstanceControlToken(dataRoot);
    let openedUrl = workspaceUrl;
    let pairedByLauncher = false;
    if (controlToken) {
      try {
        openedUrl = await requestBrowserBootstrap(state!, controlToken, fetchImpl);
        pairedByLauncher = true;
      } catch {
        // 已有浏览器 Cookie 仍可继续使用；控制凭据损坏时退回工作区入口。
      }
    }
    if (options.openBrowser !== false) await (options.browserOpener ?? openDefaultBrowser)(openedUrl);
    return { reused: true, state: state!, workspaceUrl, openedUrl, pairedByLauncher };
  } finally {
    await releaseLock();
  }
}

async function waitForReadyInstance(
  dataRoot: string,
  expectedInstanceId: string,
  expectedRuntimeVersion: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<CollectorInstanceState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readInstanceState(dataRoot);
    if (
      state?.instanceId === expectedInstanceId
      && await probeCollectorInstance(state, expectedRuntimeVersion, fetchImpl)
    ) return state;
    await delay(100);
  }
  throw new Error(`Collector service did not become ready. See ${join(dataRoot, "collector-service.log")}`);
}

function spawnCollectorService(dataRoot: string, instanceId: string, runtimeVersion: string, serverEntry: string): void {
  const entry = serverEntry;
  const logPath = join(dataRoot, "collector-service.log");
  const log = openSync(logPath, "a", 0o600);
  try {
    const child = spawn(process.execPath, [entry], {
      cwd: process.cwd(),
      detached: true,
      windowsHide: true,
      env: {
        ...process.env,
        COLLECTOR_DATA_DIR: dataRoot,
        COLLECTOR_INSTANCE_ID: instanceId,
        COLLECTOR_RUNTIME_VERSION: runtimeVersion,
        COLLECTOR_PORT: process.env.COLLECTOR_PORT?.trim() || "0",
      },
      stdio: ["ignore", log, log],
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}

export async function openDefaultBrowser(value: string): Promise<void> {
  const url = new URL(value);
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || !url.port
    || url.username
    || url.password
    || url.search
    || url.hash
  ) throw new Error("Collector refused to open an unsafe browser URL");

  const command = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "start", "", url.toString()] : [url.toString()];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolveSpawn, reject) => {
    child.once("spawn", resolveSpawn);
    child.once("error", reject);
  });
  child.unref();
}

async function stopIncompatibleInstance(
  state: CollectorInstanceState,
  controlToken: string | undefined,
  fetchImpl: typeof fetch,
  dataRoot: string,
): Promise<void> {
  const shutdownAccepted = controlToken
    ? await requestInstanceShutdown(state, controlToken, fetchImpl)
    : false;
  if (!shutdownAccepted) {
    throw new Error("检测到不支持安全自动更换的旧版 Collector 服务。为避免停止错误的进程或同时运行两个服务，请先关闭旧服务，再重新双击 Collector.cmd。");
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!isProcessRunning(state.pid)) return;
    await delay(100);
  }
  throw new Error("检测到旧版 Collector 服务，但它未能正常关闭。为避免多个服务同时使用同一份数据，本次没有启动新服务。请先关闭旧服务，再重新双击 Collector.cmd。");
}

async function acquireLaunchLock(dataRoot: string): Promise<() => Promise<void>> {
  await mkdir(dataRoot, { recursive: true });
  const database = new DatabaseSync(join(dataRoot, LAUNCH_LOCK_DATABASE));
  database.exec("PRAGMA busy_timeout = 15000;");
  try {
    database.exec("BEGIN EXCLUSIVE;");
  } catch (error) {
    database.close();
    throw new Error("Collector launcher is already starting. Please wait a moment and try again.", { cause: error });
  }

  const path = join(dataRoot, LAUNCH_LOCK_FILE);
  try {
    await writeFile(path, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      database.exec("COMMIT");
    } finally {
      database.close();
      await rm(path, { force: true });
    }
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
