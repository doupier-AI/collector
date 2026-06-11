import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

try {
  const target = await waitForTarget(debugPort);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.call("Runtime.enable");
  await waitFor(async () => await evaluate(cdp, `document.documentElement.dataset.collectorRenderer === 'ready'`), "renderer initialization");

  await evaluate(cdp, `(() => {
    const input = document.querySelector('#content');
    input.value = 'Desktop GUI text smoke';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#capture-form').requestSubmit();
  })()`);
  await delay(600);
  const textState = await evaluate(cdp, `({
    bridge: typeof window.collector,
    content: document.querySelector('#content').value,
    status: document.querySelector('#status').textContent,
    statusKind: document.querySelector('#status').dataset.kind,
    rendererReady: document.documentElement.dataset.collectorRenderer,
    href: location.href
  })`);
  console.log("Text submission state:", JSON.stringify(textState));
  await waitFor(async () => {
    const store = await readStore(dataDir);
    return Object.values(store.captures).some((item) => item.content === "Desktop GUI text smoke");
  }, "text capture");

  const fileObject = await cdp.call("Runtime.evaluate", {
    expression: "document.querySelector('#file-input')",
  });
  const objectId = fileObject.result?.objectId;
  if (!objectId) throw new Error("File input object was not found");
  await cdp.call("DOM.setFileInputFiles", { files: [fixture], objectId });
  await evaluate(cdp, `document.querySelector('#file-input').dispatchEvent(new Event('change', { bubbles: true }))`);
  await evaluate(cdp, `document.querySelector('#capture-form').requestSubmit()`);
  await waitFor(async () => {
    const store = await readStore(dataDir);
    const artifact = Object.values(store.artifacts).some((item) => item.fileName === "desktop-upload-smoke.txt");
    const capture = Object.values(store.captures).some((item) => item.captureType === "local_file");
    return artifact && capture;
  }, "file capture");

  const store = await readStore(dataDir);
  console.log(JSON.stringify({
    textCapture: Object.values(store.captures).some((item) => item.content === "Desktop GUI text smoke"),
    fileCapture: Object.values(store.captures).some((item) => item.captureType === "local_file"),
    artifact: Object.values(store.artifacts).some((item) => item.fileName === "desktop-upload-smoke.txt"),
  }));
  cdp.close();
} catch (error) {
  if (stderr) console.error(stderr);
  throw error;
} finally {
  child.kill();
}

async function waitForTarget(port) {
  let lastError;
  for (let index = 0; index < 50; index += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const target = targets.find((item) => item.type === "page" && item.url.includes("index.html"));
      if (target) return target;
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw lastError ?? new Error("Electron renderer target was not found");
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
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
  return {
    call(method, params = {}) {
      const requestId = ++id;
      socket.send(JSON.stringify({ id: requestId, method, params }));
      return new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
    },
    close() { socket.close(); },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Renderer evaluation failed");
  return result.result?.value;
}

async function readStore(directory) {
  return JSON.parse(await readFile(join(directory, "store.json"), "utf8"));
}

async function waitFor(predicate, label) {
  for (let index = 0; index < 50; index += 1) {
    try { if (await predicate()) return; } catch { /* Store may not exist yet. */ }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
