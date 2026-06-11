import { app, BrowserWindow, globalShortcut, ipcMain, Menu, Tray, nativeImage, shell } from "electron";
import type { Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CaptureService, JsonStore, createApiServer, defaultDataPaths } from "@collector/api";
import { CaptureClient } from "@collector/capture-client";
import { MAX_ARTIFACT_BYTES, type CaptureInput } from "@collector/capture-contracts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const apiBaseUrl = process.env.COLLECTOR_API_URL ?? "http://127.0.0.1:43110";
const client = new CaptureClient({ baseUrl: apiBaseUrl });
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let embeddedApi: Server | undefined;
let shortcut = "CommandOrControl+Shift+Space";
let quitting = false;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  embeddedApi = await ensureLocalApi();
  window = createWindow();
  const shortcutRegistered = registerShortcut(shortcut);
  tray = new Tray(createTrayIcon());
  tray.setToolTip("Collector Capture");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开采集框", click: showWindow },
    { label: "打开知识收件箱", click: () => void shell.openExternal(apiBaseUrl) },
    { type: "separator" },
    { label: "退出", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", showWindow);
  if (!shortcutRegistered) {
    showWindow();
    window.webContents.once("did-finish-load", () => {
      window?.webContents.send("capture:shortcut-error", shortcut);
    });
  }
});

app.on("window-all-closed", () => { /* Keep the tray process running. */ });
app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  embeddedApi?.close();
});

function createWindow(): BrowserWindow {
  const captureWindow = new BrowserWindow({
    width: 560,
    height: 650,
    show: false,
    alwaysOnTop: true,
    resizable: true,
    title: "Collector Capture",
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  captureWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`Collector preload failed: ${preloadPath}`, error);
  });
  captureWindow.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) console.error(`Collector renderer: ${message}`);
  });
  captureWindow.loadFile(join(__dirname, "index.html"));
  captureWindow.on("close", (event) => {
    if (!quitting) { event.preventDefault(); captureWindow.hide(); }
  });
  return captureWindow;
}

function showWindow() {
  window?.show();
  window?.focus();
  window?.webContents.send("capture:focus");
}

function registerShortcut(accelerator: string): boolean {
  globalShortcut.unregister(shortcut);
  const registered = globalShortcut.register(accelerator, showWindow);
  if (registered) shortcut = accelerator;
  return registered;
}

ipcMain.handle("capture:submit", async (_event, input: CaptureInput) => client.createCapture(input));
ipcMain.handle("capture:upload", async (_event, file: { path: string; name: string; type: string; size: number }) => {
  if (file.size > MAX_ARTIFACT_BYTES) throw new Error("文件超过 20 MiB 限制");
  const bytes = await readFile(file.path);
  return client.uploadArtifact(new Blob([bytes], { type: file.type }), file.name);
});
ipcMain.handle("capture:set-shortcut", (_event, accelerator: string) => registerShortcut(accelerator));
ipcMain.on("capture:hide", () => window?.hide());

async function ensureLocalApi(): Promise<Server | undefined> {
  try {
    const response = await fetch(`${apiBaseUrl}/health`, { signal: AbortSignal.timeout(800) });
    if (response.ok) return undefined;
  } catch {
    // Start the embedded API below.
  }
  const url = new URL(apiBaseUrl);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error(`Collector API unavailable: ${apiBaseUrl}`);
  }
  const paths = defaultDataPaths(process.env.COLLECTOR_DATA_DIR);
  const store = new JsonStore(paths.database);
  await store.init();
  const server = createApiServer(new CaptureService(store, paths.artifacts));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(url.port || 80), "127.0.0.1", resolve);
  });
  return server;
}

function createTrayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="6" fill="#1d4ed8"/><path d="M9 7h14v18H9z" fill="white"/><path d="M12 12h8M12 16h8M12 20h5" stroke="#1d4ed8" stroke-width="2"/></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
}
