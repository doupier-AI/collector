import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  ensureInstanceControlToken,
  probeCollectorInstance,
  readInstanceControlToken,
  readInstanceState,
  removeInstanceState,
  requestBrowserBootstrap,
  type CollectorInstanceState,
} from "./instance.js";
import { defaultDataPaths } from "./store.js";

const LAUNCH_LOCK_FILE = "launch.lock";

export interface LaunchCollectorOptions {
  dataRoot?: string;
  serverEntry?: string;
  openBrowser?: boolean;
  fetchImpl?: typeof fetch;
  browserOpener?: (url: string) => Promise<void>;
  readyTimeoutMs?: number;
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
  const releaseLock = await acquireLaunchLock(dataRoot);
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    let state = await readInstanceState(dataRoot);
    let reused = Boolean(state && await probeCollectorInstance(state, fetchImpl));
    if (!reused) {
      if (state) await removeInstanceState(dataRoot, state.instanceId);
      const controlToken = await ensureInstanceControlToken(dataRoot);
      const expectedInstanceId = randomUUID();
      spawnCollectorService(dataRoot, expectedInstanceId, options.serverEntry);
      state = await waitForReadyInstance(dataRoot, expectedInstanceId, fetchImpl, options.readyTimeoutMs ?? 15_000);
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
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<CollectorInstanceState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readInstanceState(dataRoot);
    if (state?.instanceId === expectedInstanceId && await probeCollectorInstance(state, fetchImpl)) return state;
    await delay(100);
  }
  throw new Error(`Collector service did not become ready. See ${join(dataRoot, "collector-service.log")}`);
}

function spawnCollectorService(dataRoot: string, instanceId: string, serverEntry?: string): void {
  const entry = serverEntry ?? fileURLToPath(new URL("./server.js", import.meta.url));
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

async function acquireLaunchLock(dataRoot: string): Promise<() => Promise<void>> {
  await mkdir(dataRoot, { recursive: true });
  const path = join(dataRoot, LAUNCH_LOCK_FILE);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return async () => {
        await handle.close();
        await rm(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(path).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > 30_000) {
        await rm(path, { force: true });
        continue;
      }
      await delay(100);
    }
  }
  throw new Error("Collector launcher is already starting. Please wait a moment and try again.");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
