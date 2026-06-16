import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, Tray, nativeImage, safeStorage } from "electron";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CaptureService, LocalAuth, SqliteStore, createApiServer, defaultDataPaths, type CollectorStore } from "@collector/api";
import { CaptureClient } from "@collector/capture-client";
import { MAX_ARTIFACT_BYTES, type CaptureInput} from "@collector/capture-contracts";
import { DeepSeekProvider, ModelGateway } from "@collector/model-gateway";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const apiBaseUrl = process.env.COLLECTOR_API_URL ?? "http://127.0.0.1:43110";
const instanceId = process.env.COLLECTOR_INSTANCE_ID ?? "default";
const defaultShortcut = "CommandOrControl+Shift+Space";
if (process.env.COLLECTOR_DISABLE_GPU === "1") app.disableHardwareAcceleration();
if (process.env.COLLECTOR_INSTANCE_ID) app.setPath("userData", join(app.getPath("userData"), instanceId.replace(/[^a-zA-Z0-9_-]/g, "_")));

let client: CaptureClient;
let shellWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let embeddedApi: Server | undefined;
let embeddedService: CaptureService | undefined;
let embeddedStore: CollectorStore | undefined;
let shortcut = defaultShortcut;
let compactMode = false;
let quitting = false;
let preCompactTab = "workspace";

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else app.on("second-instance", showShellWindow);

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  const preferences = await loadDesktopPreferences();
  shortcut = preferences.shortcut || defaultShortcut;
  const masterToken = await loadMasterToken();
  embeddedApi = await ensureLocalApi(masterToken, await loadDeepSeekKey());
  client = new CaptureClient({ baseUrl: apiBaseUrl, token: masterToken });
  shellWindow = createShellWindow();
  const shortcutRegistered = registerShortcut(shortcut);
  tray = new Tray(createTrayIcon());
  tray.setToolTip("Collector");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "快速采集", click: () => enterCompactMode() },
    { label: "知识工作台", click: () => showShellNormal("workspace") },
    { label: "设置", click: () => showShellNormal("settings") },
    { label: "浏览器扩展配对", click: () => void showExtensionPairingCode() },
    { type: "separator" },
    { label: "退出", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", () => enterCompactMode());
  if (!shortcutRegistered) {
    showShellNormal("capture");
    shellWindow.webContents.once("did-finish-load", () => shellWindow?.webContents.send("capture:shortcut-error", shortcut));
  }
}).catch((error) => {
  console.error("Collector failed to start", error);
  app.exit(1);
});

app.on("window-all-closed", () => { /* Tray owns the application lifecycle. */ });
app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => { globalShortcut.unregisterAll(); embeddedApi?.close(); embeddedStore?.close?.(); });

function createShellWindow(): BrowserWindow {
  const browserWindow = new BrowserWindow({
    width: 1240, height: 820, show: false, backgroundColor: "#0d0d0d", autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false,
      sandbox: process.env.COLLECTOR_GUI_NO_SANDBOX !== "1",
    },
  });
  browserWindow.webContents.on("preload-error", (_event, preloadPath, error) => { console.error(`Collector preload failed: ${preloadPath}`, error); browserWindow.show(); });
  browserWindow.webContents.on("console-message", (details) => {
    if (details.level === "warning" || details.level === "error") console.error(`Collector renderer: ${details.message}`);
  });
  void browserWindow.loadFile(join(__dirname, "shell.html")); setTimeout(() => { if (!browserWindow.isDestroyed() && !browserWindow.isVisible()) browserWindow.show(); }, 5000);
  browserWindow.on("close", (event) => { if (!quitting) { event.preventDefault(); browserWindow.hide(); } });
  return browserWindow;
}

function enterCompactMode(): void {
  if (!shellWindow) return;
  preCompactTab = "workspace"; // will be restored on exit
  compactMode = true;
  shellWindow.setSize(560, 420);
  shellWindow.center();
  shellWindow.webContents.send("shell:mode", "compact");
  showShellWindow();
}

function exitCompactMode(): void {
  if (!shellWindow) return;
  compactMode = false;
  shellWindow.setSize(1240, 820);
  shellWindow.center();
  shellWindow.webContents.send("shell:mode", "normal");
}

function showShellWindow(): void {
  shellWindow?.show();
  shellWindow?.focus();
  shellWindow?.webContents.send("capture:focus");
}

function showShellNormal(tab: string): void {
  if (compactMode) exitCompactMode();
  shellWindow?.webContents.send("shell:navigate", tab);
  showShellWindow();
}

function registerShortcut(accelerator: string): boolean {
  globalShortcut.unregister(shortcut);
  const registered = globalShortcut.register(accelerator, () => {
    if (compactMode) {
      exitCompactMode();
      shellWindow?.hide();
    } else {
      enterCompactMode();
    }
  });
  if (registered) shortcut = accelerator;
  return registered;
}

function assertTrustedRenderer(senderId: number): void {
  if (shellWindow?.webContents.id !== senderId) throw new Error("Untrusted IPC sender");
}

ipcMain.handle("capture:submit", async (event, input: CaptureInput) => { assertTrustedRenderer(event.sender.id); console.log("[main] capture:submit received"); try { const result = await client.createCapture(input); console.log("[main] capture:submit success, id:", result.id); return result; } catch (e) { console.error("[main] capture:submit FAILED:", e instanceof Error ? e.message : e); throw e; } });
ipcMain.handle("capture:upload", async (event, file: { path: string; name: string; type: string; size: number }) => {
  assertTrustedRenderer(event.sender.id);
  if (file.size > MAX_ARTIFACT_BYTES) throw new Error("文件超过 20 MiB 限制");
  const bytes = await readFile(file.path);
  return client.uploadArtifact(new Blob([bytes], { type: file.type }), file.name);
});
ipcMain.on("shell:hide", () => { shellWindow?.hide(); });
ipcMain.on("shell:navigate", (_event, tab: string) => { showShellNormal(tab); });

ipcMain.handle("workspace:load", async (event) => {
  assertTrustedRenderer(event.sender.id);
  const [inboxResult, topicsResult, relationsResult] = await Promise.allSettled([
    client.listInbox(), client.listTopics(), client.listRelations(),
  ]);
  const topics = topicsResult.status === "fulfilled" ? topicsResult.value : [];
  const relations = relationsResult.status === "fulfilled" ? relationsResult.value : [];
  const rawInbox = inboxResult.status === "fulfilled" ? inboxResult.value : [];
  if (inboxResult.status === "rejected") console.error("workspace:load inbox failed:", inboxResult.reason);
  if (topicsResult.status === "rejected") console.error("workspace:load topics failed:", topicsResult.reason);
  if (relationsResult.status === "rejected") console.error("workspace:load relations failed:", relationsResult.reason);
  const inbox = rawInbox.map((item: any) => ({ ...item.capture, fragments: item.fragments, knowledgeItems: item.knowledgeItems, reviewProposals: item.reviewProposals, agentRuns: item.agentRuns }));
  return { inbox, topics, relations };
});
ipcMain.handle("workspace:create-topic", async (event, title: string) => { assertTrustedRenderer(event.sender.id); return client.createTopic(title); });
ipcMain.handle("workspace:create-suggested-topic", async (event, input: Parameters<CaptureClient["createSuggestedTopic"]>[0]) => { assertTrustedRenderer(event.sender.id); return client.createSuggestedTopic(input); });
ipcMain.handle("workspace:update-topic", async (event, id: string, patch: Parameters<CaptureClient["updateTopic"]>[1]) => { assertTrustedRenderer(event.sender.id); return client.updateTopic(id, patch); });
ipcMain.handle("workspace:get-topic", async (event, id: string) => { assertTrustedRenderer(event.sender.id); return client.getTopicWorkspace(id); });
ipcMain.handle("workspace:add-topic-member", async (event, topicId: string, captureId: string) => { assertTrustedRenderer(event.sender.id); return client.addTopicMember(topicId, captureId); });
ipcMain.handle("workspace:remove-topic-member", async (event, topicId: string, captureId: string) => { assertTrustedRenderer(event.sender.id); return client.removeTopicMember(topicId, captureId); });
ipcMain.handle("workspace:deep-analysis", async (event, captureId: string) => { assertTrustedRenderer(event.sender.id); return client.requestDeepAnalysis(captureId); });

  // ── Materials CRUD ──
  ipcMain.handle("material:list", async (event, params?: { q?: string; page?: number; limit?: number; trash?: boolean }) => { assertTrustedRenderer(event.sender.id); return client.listMaterials(params); });
  ipcMain.handle("material:get", async (event, id: string) => { assertTrustedRenderer(event.sender.id); return client.getMaterial(id); });
  ipcMain.handle("material:revisions", async (event, id: string) => { assertTrustedRenderer(event.sender.id); return client.listRevisions(id); });
  ipcMain.handle("material:edit", async (event, id: string, content: string) => { assertTrustedRenderer(event.sender.id); return client.editRevision(id, content); });
  ipcMain.handle("material:trash", async (event, id: string) => { assertTrustedRenderer(event.sender.id); return client.trashMaterial(id); });
  ipcMain.handle("material:restore", async (event, id: string) => { assertTrustedRenderer(event.sender.id); return client.restoreMaterial(id); });
  ipcMain.handle("material:delete-impact", async (event, id: string) => { assertTrustedRenderer(event.sender.id); return client.getDeleteImpact(id); });
  ipcMain.handle("material:permanent-delete", async (event, id: string, acknowledge?: boolean) => { assertTrustedRenderer(event.sender.id); return client.permanentDelete(id, acknowledge); });
ipcMain.handle("recent:organize", async (event, idempotencyKey?: string) => { assertTrustedRenderer(event.sender.id); return client.organizeRecent(idempotencyKey); });
ipcMain.handle("recent:snapshot", async (event) => { assertTrustedRenderer(event.sender.id); return client.getLatestRecentSnapshot(); });
ipcMain.handle("recent:run", async (event, id: string) => { assertTrustedRenderer(event.sender.id); return client.getRecentOrganizationRun(id); });
ipcMain.handle("recent:cancel", async (event, id: string) => { assertTrustedRenderer(event.sender.id); return client.cancelRecentOrganizationRun(id); });

ipcMain.handle("settings:get", async (event) => {
  assertTrustedRenderer(event.sender.id);
  return { shortcut, ai: embeddedService?.getAiConfiguration() ?? { consent: false, configured: false, unavailable: true } };
});
ipcMain.handle("settings:save-shortcut", async (event, value: string) => {
  assertTrustedRenderer(event.sender.id);
  const accelerator = value.trim();
  if (!accelerator) throw new Error("快捷键不能为空");
  if (!registerShortcut(accelerator)) throw new Error("快捷键冲突，请更换组合");
  await saveDesktopPreferences({ shortcut });
  return { shortcut };
});
ipcMain.handle("settings:save-ai", async (event, value: { consent: boolean; apiKey?: string }) => {
  assertTrustedRenderer(event.sender.id);
  if (!embeddedService || !embeddedStore) throw new Error("AI 设置仅在 Collector 内置服务中可用");
  const key = value.apiKey?.trim() || await loadDeepSeekKey();
  if (value.consent && !key) throw new Error("启用云端 AI 前必须提供新的 DeepSeek Key");
  if (value.apiKey?.trim()) await saveDeepSeekKey(value.apiKey.trim());
  await embeddedService.setAiConfiguration(value.consent, Boolean(key));
  embeddedService.setModelGateway(value.consent && key ? new ModelGateway(new DeepSeekProvider({ apiKey: () => key })) : undefined);
  return embeddedService.getAiConfiguration();
});

async function ensureLocalApi(masterToken: string, deepSeekKey?: string): Promise<Server | undefined> {
  try {
    const response = await fetch(`${apiBaseUrl}/health`, { signal: AbortSignal.timeout(800) });
    if (response.ok && (await response.json() as { instanceId?: string }).instanceId === instanceId) return undefined;
  } catch { /* Start the embedded API below. */ }
  const url = new URL(apiBaseUrl);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error(`Collector API unavailable: ${apiBaseUrl}`);
  const paths = defaultDataPaths(process.env.COLLECTOR_DATA_DIR);
  const store = new SqliteStore(paths.database, paths.legacyJson);
  await store.init(); embeddedStore = store;
  const auth = new LocalAuth(store);
  await auth.registerTrustedToken(masterToken);
  const consent = store.getSetting("ai_consent") === "true";
  embeddedService = new CaptureService(store, paths.artifacts, undefined, consent && deepSeekKey ? new ModelGateway(new DeepSeekProvider({ apiKey: () => deepSeekKey })) : undefined);
  await embeddedService.setAiConfiguration(consent, Boolean(deepSeekKey));
  await embeddedService.resumePendingModelRuns();
  const server = createApiServer(embeddedService, auth, { instanceId });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(Number(url.port || 80), "127.0.0.1", resolve); });
  return server;
}

async function showExtensionPairingCode(): Promise<void> {
  const pairing = await client.createPairingCode("Collector Browser Extension");
  await dialog.showMessageBox({ type: "info", title: "浏览器扩展配对", message: `配对码：${pairing.code}`, detail: "请在五分钟内输入扩展。配对码只能使用一次。" });
}

async function loadMasterToken(): Promise<string> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Electron safeStorage is unavailable");
  const path = join(app.getPath("userData"), "collector-master-token.bin");
  try { return safeStorage.decryptString(await readFile(path)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const token = randomBytes(32).toString("base64url");
    await mkdir(app.getPath("userData"), { recursive: true }); await writeFile(path, safeStorage.encryptString(token)); return token;
  }
}
async function loadDeepSeekKey(): Promise<string | undefined> {
  try { return safeStorage.decryptString(await readFile(join(app.getPath("userData"), "deepseek-key.bin"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function saveDeepSeekKey(value: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Electron safeStorage is unavailable");
  await mkdir(app.getPath("userData"), { recursive: true }); await writeFile(join(app.getPath("userData"), "deepseek-key.bin"), safeStorage.encryptString(value));
}
async function loadDesktopPreferences(): Promise<{ shortcut?: string }> {
  try { return JSON.parse(await readFile(join(app.getPath("userData"), "desktop-preferences.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}
async function saveDesktopPreferences(value: { shortcut: string }): Promise<void> {
  await mkdir(app.getPath("userData"), { recursive: true }); await writeFile(join(app.getPath("userData"), "desktop-preferences.json"), JSON.stringify(value), "utf8");
}

function createTrayIcon(): Electron.NativeImage {
  const icon = nativeImage.createEmpty();
  const size = 32;
  const canvas = Buffer.alloc(size * size * 4, 0);
  const radius = 10; const cx = 12; const cy = 13;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      const dx = Math.abs(x - cx); const dy = Math.abs(y - cy);
      const inside = (dx * dx + dy * dy) <= (radius * radius);
      if (inside) {
        canvas[offset] = 0x3b; canvas[offset + 1] = 0x82; canvas[offset + 2] = 0xf6; canvas[offset + 3] = 255;
      }
    }
  }
  icon.addRepresentation({ width: size, height: size, buffer: canvas, scaleFactor: 1.0 });
  return icon;
}
