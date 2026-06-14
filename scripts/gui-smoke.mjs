import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const electron = join(root, "node_modules", "electron", "dist", "electron.exe");
const main = join(root, "apps", "desktop-capture", "dist", "main.js");
const fixture = join(root, "tests", "fixtures", "desktop-upload-smoke.txt");
const dataDir = join(root, ".collector-data", "gui-smoke-data");
const profileDir = join(root, ".collector-data", "gui-smoke-profile");
const debugPort = 49333;
const apiPort = 49334;

await rm(dataDir, { recursive: true, force: true });
await rm(profileDir, { recursive: true, force: true });

const child = spawn(electron, [
  "--no-sandbox",
  "--disable-gpu",
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profileDir}`,
  main,
], {
  cwd: root,
  env: {
    ...process.env,
    COLLECTOR_PORT: String(apiPort),
    COLLECTOR_API_URL: `http://127.0.0.1:${apiPort}`,
    COLLECTOR_DATA_DIR: dataDir,
    COLLECTOR_INSTANCE_ID: "gui-smoke",
    COLLECTOR_GUI_NO_SANDBOX: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); process.stderr.write(chunk); });

try {
  console.log("GUI smoke: waiting for renderer target");
  const target = await waitForTarget(debugPort);
  console.log("GUI smoke: connecting to renderer");
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.call("Runtime.enable");
  console.log("GUI smoke: waiting for preload bridge");
  await waitFor(async () => await evaluate(cdp, "document.querySelector('#section-capture.active') !== null"), "renderer init");

  // Stage 1: Text capture
  await evaluate(cdp, `(() => {
    const input = document.querySelector('#content');
    input.value = 'Desktop GUI text smoke';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#capture-form').requestSubmit();
  })()`);
  console.log("GUI smoke: submitted text capture");
  await delay(600);
  await waitFor(async () => {
    const store = await readStore(dataDir);
    return Object.values(store.captures).some((item) => item.content === "Desktop GUI text smoke");
  }, "text capture persisted");

  // Stage 2: File capture
  const fileObject = await cdp.call("Runtime.evaluate", {
    expression: "document.querySelector('#file-input')",
  });
  const objectId = fileObject.result?.objectId;
  if (!objectId) throw new Error("File input not found");
  await cdp.call("DOM.setFileInputFiles", { files: [fixture], objectId });
  await evaluate(cdp, "document.querySelector('#file-input').dispatchEvent(new Event('change', { bubbles: true }))");
  await evaluate(cdp, "document.querySelector('#capture-form').requestSubmit()");
  console.log("GUI smoke: submitted file capture");
  await waitFor(async () => {
    const store = await readStore(dataDir);
    const artifact = Object.values(store.artifacts).some((item) => item.fileName === "desktop-upload-smoke.txt");
    const capture = Object.values(store.captures).some((item) => item.captureType === "local_file");
    return artifact && capture;
  }, "file capture persisted");

  // Stage 3: Navigate to workspace tab
  console.log("GUI smoke: switching to workspace tab");
  await evaluate(cdp, "document.querySelector('#nav-workspace').click()");
  await delay(500);
  await waitFor(async () => await evaluate(cdp, "document.querySelector('#section-workspace.active') !== null"), "workspace tab active");
  const wsBridge = await evaluate(cdp, "typeof window.collector?.workspace");
  console.log("Workspace bridge:", wsBridge);
  if (wsBridge !== "object") throw new Error("Workspace bridge not available");

  const wsData = await evaluate(cdp, `(async () => {
    const data = await window.collector.workspace.load();
    return { inboxCount: data.inbox.length, topicsCount: data.topics.length };
  })()`);
  console.log("Workspace data:", JSON.stringify(wsData));
  if (wsData.inboxCount < 2) throw new Error(`Expected at least 2 inbox items, got ${wsData.inboxCount}`);

  // Stage 4: Navigate to settings tab
  console.log("GUI smoke: switching to settings tab");
  await evaluate(cdp, "document.querySelector('#nav-settings').click()");
  await delay(500);
  await waitFor(async () => await evaluate(cdp, "document.querySelector('#section-settings.active') !== null"), "settings tab active");
  const settingsBridge = await evaluate(cdp, "typeof window.collector?.settings");
  console.log("Settings bridge:", settingsBridge);
  if (settingsBridge !== "object") throw new Error("Settings bridge not available");

  const aiConfig = await evaluate(cdp, `(async () => {
    const config = await window.collector.settings.get();
    return { consent: config.ai?.consent, configured: config.ai?.configured };
  })()`);
  console.log("AI config:", JSON.stringify(aiConfig));

  // Final report
  const store = await readStore(dataDir);
  console.log(JSON.stringify({
    textCapture: Object.values(store.captures).some((item) => item.content === "Desktop GUI text smoke"),
    fileCapture: Object.values(store.captures).some((item) => item.captureType === "local_file"),
    artifact: Object.values(store.artifacts).some((item) => item.fileName === "desktop-upload-smoke.txt"),
    workspaceBridge: wsBridge,
    settingsBridge: settingsBridge,
  }));
  cdp.close();
  console.log("GUI smoke: ALL STAGES PASSED");
} catch (error) {
  if (stderr) console.error(stderr);
  throw error;
} finally {
  child.kill();
}

async function waitForTarget(port) {
  let lastError;
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const target = targets.find((t) => t.type === "page" && t.url.includes("shell.html"));
      if (target) return target;
    } catch (e) { lastError = e; }
    await delay(150);
  }
  throw lastError ?? new Error("Electron renderer target not found");
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await withTimeout(new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  }), 5_000, "CDP connect");
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const req of pending.values()) req.reject(new Error("CDP closed"));
    pending.clear();
  });
  return {
    call(method, params = {}) {
      const requestId = ++id;
      socket.send(JSON.stringify({ id: requestId, method, params }));
      return withTimeout(new Promise((resolve, reject) => pending.set(requestId, { resolve, reject })), 5_000, `CDP ${method}`);
    },
    close() { socket.close(); },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Renderer eval failed");
  return result.result?.value;
}

async function readStore(directory) {
  const database = new DatabaseSync(join(directory, "collector.sqlite"), { readOnly: true });
  try {
    const captures = Object.fromEntries(database.prepare("SELECT id, record_json FROM captures").all()
      .map((row) => [row.id, JSON.parse(row.record_json)]));
    const artifacts = Object.fromEntries(database.prepare("SELECT id, record_json FROM artifacts").all()
      .map((row) => [row.id, JSON.parse(row.record_json)]));
    return { captures, artifacts };
  } finally { database.close(); }
}

async function waitFor(predicate, label) {
  for (let i = 0; i < 50; i += 1) {
    try { if (await predicate()) return; } catch { /* DB may not exist yet */ }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms)),
  ]);
}
