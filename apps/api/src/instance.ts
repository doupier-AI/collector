import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LocalAuth } from "./auth.js";

const INSTANCE_STATE_FILE = "instance.json";
const INSTANCE_CONTROL_FILE = "instance-control.token";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface CollectorInstanceState {
  version: 1;
  instanceId: string;
  pid: number;
  port: number;
  startedAt: string;
  runtimeVersion?: string;
}

export type CollectorInstanceProbe =
  | { kind: "compatible" }
  | { kind: "incompatible"; actualRuntimeVersion?: string }
  | { kind: "unreachable" };

export interface BrowserBootstrap {
  url: string;
  closed: Promise<void>;
  close(): Promise<void>;
}

export function instanceStatePath(dataRoot: string): string {
  return join(dataRoot, INSTANCE_STATE_FILE);
}

export function instanceControlPath(dataRoot: string): string {
  return join(dataRoot, INSTANCE_CONTROL_FILE);
}

export async function ensureInstanceControlToken(dataRoot: string): Promise<string> {
  await mkdir(dataRoot, { recursive: true });
  const path = instanceControlPath(dataRoot);
  const existing = await readInstanceControlToken(dataRoot);
  if (existing) return existing;

  const token = randomBytes(32).toString("base64url");
  try {
    await writeFile(path, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = await readInstanceControlToken(dataRoot);
    if (raced) return raced;
    throw new Error(`Collector instance control file is invalid: ${path}`);
  }
  await chmod(path, 0o600).catch(() => undefined);
  return token;
}

export async function readInstanceControlToken(dataRoot: string): Promise<string | undefined> {
  const value = await readFile(instanceControlPath(dataRoot), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (value === undefined) return undefined;
  const token = value.trim();
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}

export async function readInstanceState(dataRoot: string): Promise<CollectorInstanceState | undefined> {
  const text = await readFile(instanceStatePath(dataRoot), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (text === undefined) return undefined;
  try {
    const state = JSON.parse(text) as Partial<CollectorInstanceState>;
    if (
      state.version !== 1
      || typeof state.instanceId !== "string"
      || state.instanceId.length < 8
      || !Number.isSafeInteger(state.pid)
      || (state.pid ?? 0) <= 0
      || !Number.isSafeInteger(state.port)
      || (state.port ?? 0) < 1
      || (state.port ?? 0) > 65_535
      || typeof state.startedAt !== "string"
      || !Number.isFinite(Date.parse(state.startedAt))
      || (state.runtimeVersion !== undefined && (typeof state.runtimeVersion !== "string" || state.runtimeVersion.length < 8 || state.runtimeVersion.length > 200))
    ) return undefined;
    return state as CollectorInstanceState;
  } catch {
    return undefined;
  }
}

export async function writeInstanceState(dataRoot: string, state: CollectorInstanceState): Promise<void> {
  await mkdir(dataRoot, { recursive: true });
  const path = instanceStatePath(dataRoot);
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function removeInstanceState(dataRoot: string, expectedInstanceId?: string): Promise<boolean> {
  if (expectedInstanceId) {
    const current = await readInstanceState(dataRoot);
    if (!current || current.instanceId !== expectedInstanceId) return false;
  }
  await rm(instanceStatePath(dataRoot), { force: true });
  return true;
}

export async function inspectCollectorInstance(
  state: CollectorInstanceState,
  expectedRuntimeVersion: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 1_500,
): Promise<CollectorInstanceProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const response = await fetchImpl(`http://127.0.0.1:${state.port}/health`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return { kind: "unreachable" };
    const payload = await response.json() as { status?: unknown; instanceId?: unknown; runtimeVersion?: unknown };
    if (payload.status !== "ok" || payload.instanceId !== state.instanceId) return { kind: "unreachable" };
    if (payload.runtimeVersion !== expectedRuntimeVersion || state.runtimeVersion !== expectedRuntimeVersion) {
      return {
        kind: "incompatible",
        actualRuntimeVersion: typeof payload.runtimeVersion === "string" ? payload.runtimeVersion : undefined,
      };
    }
    return { kind: "compatible" };
  } catch {
    return { kind: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeCollectorInstance(
  state: CollectorInstanceState,
  expectedRuntimeVersion = state.runtimeVersion,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 1_500,
): Promise<boolean> {
  if (!expectedRuntimeVersion) return false;
  return (await inspectCollectorInstance(state, expectedRuntimeVersion, fetchImpl, timeoutMs)).kind === "compatible";
}

export async function requestInstanceShutdown(
  state: CollectorInstanceState,
  controlToken: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 1_500,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const response = await fetchImpl(`http://127.0.0.1:${state.port}/v1/launcher/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${controlToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ instanceId: state.instanceId }),
      signal: controller.signal,
    });
    return response.status === 202;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function requestBrowserBootstrap(
  state: CollectorInstanceState,
  controlToken: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 1_500,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const response = await fetchImpl(`http://127.0.0.1:${state.port}/v1/launcher/bootstrap`, {
      method: "POST",
      headers: { Authorization: `Bearer ${controlToken}`, "Content-Type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Collector launcher bootstrap failed with HTTP ${response.status}`);
    const payload = await response.json() as { url?: unknown };
    if (typeof payload.url !== "string") throw new Error("Collector launcher bootstrap returned an invalid response");
    const url = new URL(payload.url);
    if (
      url.protocol !== "http:"
      || url.hostname !== "127.0.0.1"
      || !url.port
      || url.username
      || url.password
      || url.search
      || url.hash
      || url.pathname !== "/"
    ) throw new Error("Collector launcher bootstrap returned an unsafe URL");
    return url.toString();
  } finally {
    clearTimeout(timer);
  }
}

export async function startBrowserBootstrap(
  auth: LocalAuth,
  targetPort: number,
  options: { ttlMs?: number } = {},
): Promise<BrowserBootstrap> {
  if (!Number.isSafeInteger(targetPort) || targetPort < 1 || targetPort > 65_535) {
    throw new Error("Collector target port is invalid");
  }
  const sessionToken = randomBytes(32).toString("base64url");
  await auth.registerTrustedToken(sessionToken, "Collector WebUI launcher");

  let bootstrapPort = 0;
  let consumed = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const server = createServer((request, response) => {
    const remote = request.socket.remoteAddress;
    const expectedHost = `127.0.0.1:${bootstrapPort}`;
    if (remote !== "127.0.0.1" && remote !== "::ffff:127.0.0.1") {
      response.writeHead(403, { "Cache-Control": "no-store", Connection: "close" }).end();
      return;
    }
    if (request.headers.host?.toLowerCase() !== expectedHost) {
      response.writeHead(403, { "Cache-Control": "no-store", Connection: "close" }).end();
      return;
    }
    if (request.method !== "GET" || request.url !== "/") {
      response.writeHead(404, { "Cache-Control": "no-store", Connection: "close" }).end();
      return;
    }
    if (consumed) {
      response.writeHead(410, { "Cache-Control": "no-store", Connection: "close" }).end();
      return;
    }
    consumed = true;
    response.writeHead(303, {
      "Cache-Control": "no-store",
      Connection: "close",
      Location: `http://127.0.0.1:${targetPort}/`,
      "Referrer-Policy": "no-referrer",
      "Set-Cookie": `collector_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
      "X-Content-Type-Options": "nosniff",
    });
    response.end();
    response.once("finish", () => server.close());
  });
  server.once("close", resolveClosed);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Collector browser bootstrap did not bind to a loopback port");
  }
  bootstrapPort = address.port;
  const timer = setTimeout(() => server.close(), options.ttlMs ?? 60_000);
  timer.unref();
  void closed.finally(() => clearTimeout(timer));

  return {
    url: `http://127.0.0.1:${bootstrapPort}/`,
    closed,
    async close() {
      if (server.listening) server.close();
      await closed;
    },
  };
}
