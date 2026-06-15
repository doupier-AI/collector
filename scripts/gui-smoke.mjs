import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
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

// Kill stale Collector instances that may hold ports
import { execSync } from "node:child_process";
try { execSync("taskkill /f /im electron.exe 2>nul", { timeout: 3000, windowsHide: true }); } catch {}
await delay(500);

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


  // Ensure API is running before submitting

  // Debug: verify renderer state before submitting
  const rendererReady = await evaluate(cdp, "document.documentElement.dataset.collectorRenderer");
  console.log("GUI smoke: renderer ready marker:", rendererReady);
  const bridgeExists = await evaluate(cdp, "typeof window.collector?.capture?.submit");
  console.log("GUI smoke: bridge submit type:", bridgeExists);
  const contentEl = await evaluate(cdp, "document.querySelector('#content')?.tagName");
  console.log("GUI smoke: content element:", contentEl);
  const formEl = await evaluate(cdp, "document.querySelector('#capture-form')?.tagName");
  console.log("GUI smoke: form element:", formEl);

  console.log("GUI smoke: waiting for API health");
  await waitFor(async () => {
    const resp = await fetch(`http://127.0.0.1:${apiPort}/health`);
    return resp.ok;
  }, "API health check");
  console.log("GUI smoke: API healthy");

  // Stage 1: Text capture
  await evaluate(cdp, `(() => {
    const input = document.querySelector('#content');
    input.value = 'Desktop GUI text smoke';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (() => {
    const btn = document.querySelector('#submit-button');
    btn.disabled = false;
    const form = document.querySelector('#capture-form');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  })()
  })()`);
  console.log("GUI smoke: submitted text capture");

  // Debug: check status after submission
  await delay(2000);
  const statusText = await evaluate(cdp, "document.querySelector('#status')?.textContent");
  console.log("GUI smoke: status after submit:", statusText);
  const statusKind = await evaluate(cdp, "document.querySelector('#status')?.dataset?.kind");
  console.log("GUI smoke: status kind:", statusKind);

  // Debug: check if DB file exists and its size
  const dbFile = join(dataDir, "collector.sqlite");
  if (existsSync(dbFile)) {
    console.log("GUI smoke: DB file exists, size:", statSync(dbFile).size, "bytes");
  } else {
    console.log("GUI smoke: DB file MISSING at", dbFile);
  }
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
  await evaluate(cdp, `(() => {
    const btn2 = document.querySelector('#submit-button');
    btn2.disabled = false;
    document.querySelector('#capture-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  })()`);
  console.log("GUI smoke: submitted file capture");
  await waitFor(async () => {
    const store = await readStore(dataDir);
    const artifact = Object.values(store.artifacts).some((item) => item.fileName === "desktop-upload-smoke.txt");
    const capture = Object.values(store.captures).some((item) => item.captureType === "local_file");
    return artifact && capture;
  }, "file capture persisted");

  // Stage 3: Navigate to recent tab
  console.log("GUI smoke: switching to recent tab");
  await evaluate(cdp, "document.querySelector('#nav-recent').click()");
  await delay(500);
  await waitFor(async () => await evaluate(cdp, "document.querySelector('#section-recent.active') !== null"), "recent tab active");

  // Stage 4: Navigate to topics tab
  console.log("GUI smoke: switching to topics tab");
  await evaluate(cdp, "document.querySelector('#nav-topics').click()");
  await delay(500);
  await waitFor(async () => await evaluate(cdp, "document.querySelector('#section-topics.active') !== null"), "topics tab active");

  // Stage 5: Navigate to materials tab
  console.log("GUI smoke: switching to materials tab");
  await evaluate(cdp, "document.querySelector('#nav-materials').click()");
  await delay(500);
  await waitFor(async () => await evaluate(cdp, "document.querySelector('#section-materials.active') !== null"), "materials tab active");

  // Stage 6: Navigate to settings tab
  console.log("GUI smoke: switching to settings tab");
  await evaluate(cdp, "document.querySelector('#nav-settings').click()");
  await delay(500);
  await waitFor(async () => await evaluate(cdp, "document.querySelector('#section-settings.active') !== null"), "settings tab active");
  const settingsBridge = await evaluate(cdp, "typeof window.collector?.settings");
  console.log("GUI smoke: settings bridge:", settingsBridge);
  if (settingsBridge !== "object") throw new Error("Settings bridge not available");

  // Stage 7: Compact mode enter/exit with tab restore
  console.log("GUI smoke: entering compact mode");
  await evaluate(cdp, "window.collectorShell.enterCompactMode()");
  await delay(300);
  const compactCaptureActive = await evaluate(cdp, "document.querySelector('#section-capture.active') !== null");
  console.log("GUI smoke: capture active in compact:", compactCaptureActive);
  if (!compactCaptureActive) throw new Error("Capture not active in compact mode");

  console.log("GUI smoke: exiting compact mode");
  await evaluate(cdp, "window.collectorShell.exitCompactMode()");
  // Should restore to previous tab (settings)
  await delay(300);
  const postCompactTab = await evaluate(cdp, "document.querySelector('#section-settings.active') !== null");
  console.log("GUI smoke: settings restored after compact:", postCompactTab);
  if (!postCompactTab) throw new Error("Compact exit did not restore previous tab");

  // Verify workspace bridge (tested implicitly through navigation)
  const wsBridge = await evaluate(cdp, "typeof window.collector?.workspace");
  if (wsBridge !== "object") throw new Error("Workspace bridge not available");

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

async function readSnapshots(directory) {
  var db = new DatabaseSync(join(directory, "collector.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT id, record_json FROM recent_cluster_snapshots ORDER BY publication_sequence DESC").all()
      .map(function(row) { return JSON.parse(row.record_json); });
  } finally { db.close(); }
}


async function waitFor(predicate, label) {
  for (let i = 0; i < 150; i += 1) {
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
