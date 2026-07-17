import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const electron = join(root, "node_modules", "electron", "dist", "electron.exe");
const main = join(root, "apps", "desktop-capture", "dist", "main.js");
const dataDir = join(root, ".collector-data", "gui-smoke-data");
const profileDir = join(root, ".collector-data", "gui-smoke-profile");
const debugPort = 49333;
const apiPort = 49334;

await rm(dataDir, { recursive: true, force: true });
await rm(profileDir, { recursive: true, force: true });

import { execSync } from "node:child_process";
try { execSync("taskkill /f /im electron.exe 2>nul", { timeout: 3000, windowsHide: true }); } catch {}
await delay(500);

const child = spawn(electron, [
  "--no-sandbox", "--disable-gpu",
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
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

try {
  // Wait for renderer + API
  console.log("GUI smoke: waiting for renderer target...");
  const target = await waitForTarget(debugPort);
  console.log("GUI smoke: connecting to renderer...");
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.call("Runtime.enable");
  await cdp.call("DOM.enable");

  console.log("GUI smoke: waiting for API health...");
  await waitFor(async () => {
    const resp = await fetch(`http://127.0.0.1:${apiPort}/health`);
    return resp.ok;
  }, "API health check");
  console.log("GUI smoke: API healthy");

  // Wait for renderer to fully init
  await waitFor(async () => await evaluate(cdp, "document.documentElement.dataset.collectorRenderer === 'ready'"), "renderer init");
  await delay(300);

  // Stage 1: Text capture via bridge
  console.log("GUI smoke: submitting text capture via bridge...");
  const submitResult = await evaluate(cdp, `(async () => {
    try {
      const result = await window.collector.capture.submit({
        captureType: "pasted_text",
        content: "Desktop GUI text smoke",
        locator: { kind: "user_supplied" },
        clientCaptureId: "gui-smoke-text-" + crypto.randomUUID(),
        capturedAt: new Date().toISOString(),
      });
      return { ok: true, id: result.id };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  })()`);
  console.log("GUI smoke: text submit result:", JSON.stringify(submitResult));
  if (!submitResult.ok) throw new Error("Text capture failed: " + submitResult.error);

  // Stage 2: Navigate to recent tab
  console.log("GUI smoke: navigating to recent tab...");
  await evaluate(cdp, "window.collectorShell.navigateTo('recent')");
  await delay(500);
  const recentActive = await evaluate(cdp, "document.querySelector('#section-recent.active') !== null");
  console.log("GUI smoke: recent section active:", recentActive);
  if (!recentActive) throw new Error("Recent tab navigation failed");

  // Stage 3: Navigate to topics tab
  console.log("GUI smoke: navigating to topics tab...");
  await evaluate(cdp, "window.collectorShell.navigateTo('topics')");
  await delay(500);
  const topicsActive = await evaluate(cdp, "document.querySelector('#section-topics.active') !== null");
  console.log("GUI smoke: topics section active:", topicsActive);
  if (!topicsActive) throw new Error("Topics tab navigation failed");

  // Stage 3a: Create a topic through the real renderer controls. Electron does
  // not support the browser-native prompt(), so this also guards the custom
  // in-app title dialog used by topic creation and cluster promotion.
  console.log("GUI smoke: creating topic through title dialog...");
  await evaluate(cdp, "document.querySelector('#topics-create')?.click()");
  await waitFor(async () => await evaluate(cdp, "document.querySelector('#topic-title-input') !== null"), "topic title dialog");
  const topicTitle = "GUI Smoke Topic";
  await evaluate(cdp, `(() => {
    const input = document.querySelector('#topic-title-input');
    if (!(input instanceof HTMLInputElement)) throw new Error('Topic title input missing');
    input.value = ${JSON.stringify(topicTitle)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#topic-title-submit')?.click();
  })()`);
  await waitFor(async () => await evaluate(cdp, `document.querySelector('#topics-list')?.textContent?.includes(${JSON.stringify(topicTitle)}) === true`), "created topic in list");
  console.log("GUI smoke: topic creation passed");

  // Stage 4: Navigate to materials tab
  console.log("GUI smoke: navigating to materials tab...");
  await evaluate(cdp, "window.collectorShell.navigateTo('materials')");
  await delay(500);
  const materialsActive = await evaluate(cdp, "document.querySelector('#section-materials.active') !== null");
  console.log("GUI smoke: materials section active:", materialsActive);
  if (!materialsActive) throw new Error("Materials tab navigation failed");

  // Stage 5: Navigate to settings tab
  console.log("GUI smoke: navigating to settings tab...");
  await evaluate(cdp, "window.collectorShell.navigateTo('settings')");
  await delay(500);
  const settingsActive = await evaluate(cdp, "document.querySelector('#section-settings.active') !== null");
  console.log("GUI smoke: settings section active:", settingsActive);
  if (!settingsActive) throw new Error("Settings tab navigation failed");

  // Stage 6: Configure a provider through the renderer form without making a real model request.
  console.log("GUI smoke: configuring an isolated external provider profile...");
  await waitFor(async () => await evaluate(cdp, "document.documentElement.dataset.collectorSettings === 'ready'"), "settings renderer init");
  const providerUiReady = await evaluate(cdp, `(() => {
    document.querySelector('[data-section="ai"]')?.click();
    const provider = document.querySelector('#provider-id');
    return provider instanceof HTMLSelectElement && ['deepseek', 'openai', 'anthropic', 'openrouter', 'dashscope', 'custom', 'custom-anthropic'].every((id) => [...provider.options].some((option) => option.value === id));
  })()`);
  if (!providerUiReady) throw new Error("Provider catalog was not rendered in settings");
  await evaluate(cdp, `(() => {
    const provider = document.querySelector('#provider-id');
    const name = document.querySelector('#provider-display-name');
    const model = document.querySelector('#provider-model');
    const key = document.querySelector('#provider-api-key');
    if (!(provider instanceof HTMLSelectElement) || !(name instanceof HTMLInputElement) || !(model instanceof HTMLInputElement) || !(key instanceof HTMLInputElement)) throw new Error('Provider editor is incomplete');
    provider.value = 'openai'; provider.dispatchEvent(new Event('change', { bubbles: true }));
    name.value = 'GUI Smoke OpenAI';
    model.value = 'gpt-4.1-mini';
    key.value = 'gui-smoke-secret-value'; key.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#save-provider')?.click();
  })()`);
  await waitFor(async () => await evaluate(cdp, "document.querySelector('#provider-list')?.textContent?.includes('GUI Smoke OpenAI') === true"), "provider profile save");
  const providerState = await evaluate(cdp, `(async () => {
    const settings = await window.collector.settings.get();
    const profile = settings.providerProfiles.find((item) => item.displayName === 'GUI Smoke OpenAI');
    const serialized = JSON.stringify({ settings, dom: document.querySelector('#section-settings')?.textContent });
    return { id: profile?.id, active: settings.activeProviderProfileId === profile?.id, configured: profile?.credentialConfigured, leaked: serialized.includes('gui-smoke-secret-value') };
  })()`);
  console.log("GUI smoke: provider state:", JSON.stringify(providerState));
  if (!providerState.id || !providerState.active || !providerState.configured || providerState.leaked) throw new Error("Provider settings round trip failed or exposed a credential");
  await evaluate(cdp, `(async () => { await window.collector.settings.deleteProvider(${JSON.stringify(providerState.id)}); })()`);

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
  for (let i = 0; i < 30; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const target = targets.find((t) => t.type === "page" && t.url.includes("shell.html"));
      if (target) return target;
    } catch (e) { lastError = e; }
    await delay(200);
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
    const msg = JSON.parse(event.data.toString());
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  return {
    call: (method, params) => {
      id += 1;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => socket.close(),
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Renderer eval failed");
  return result.result?.result?.value;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms)),
  ]);
}

async function waitFor(predicate, label) {
  for (let i = 0; i < 100; i += 1) {
    try { if (await predicate()) return; } catch {}
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
