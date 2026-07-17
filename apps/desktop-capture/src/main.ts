import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, Tray, nativeImage, safeStorage } from "electron";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CaptureService, LocalAuth, SqliteStore, createApiServer, defaultDataPaths, type CollectorStore, WorkflowScheduler } from "@collector/api";
import { CaptureClient } from "@collector/capture-client";
import { LEGACY_DEEPSEEK_PROFILE_ID, MAX_ARTIFACT_BYTES, type CaptureInput, type ProviderProfile, type ProviderProfileInput } from "@collector/capture-contracts";
import { createProvider, DEFAULT_PROVIDER_REGISTRY, fingerprintBaseUrl, ModelGateway, ProviderRuntimeResolver, validateExternalProviderBaseUrl, type ResolvedProviderRuntime } from "@collector/model-gateway";
import { FileCredentialStore } from "./credential-store.js";

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
let embeddedScheduler: WorkflowScheduler | undefined;
let embeddedProviderResolver: ProviderRuntimeResolver | undefined;
let shortcut = defaultShortcut;
let compactMode = false;
let quitting = false;
let preCompactTab = "capture";

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else app.on("second-instance", showShellWindow);

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  const preferences = await loadDesktopPreferences();
  shortcut = preferences.shortcut || defaultShortcut;
  const masterToken = await loadMasterToken();
  embeddedApi = await ensureLocalApi(masterToken, await loadLegacyProviderCredential());
  client = new CaptureClient({ baseUrl: apiBaseUrl, token: masterToken });
  shellWindow = createShellWindow();
  const shortcutRegistered = registerShortcut(shortcut);
  tray = new Tray(createTrayIcon());
  tray.setToolTip("Collector");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "快速采集", click: () => enterCompactMode() },
    { label: "知识工作台", click: () => showShellNormal("recent") },
    { label: "设置", click: () => showShellNormal("settings") },
    { label: "浏览器扩展配对", click: () => void showExtensionPairingCode() },
    { type: "separator" },
    { label: "退出", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", () => showShellNormal("recent"));
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
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  embeddedScheduler?.stop();
  embeddedApi?.close();
  embeddedStore?.close?.();
});

function createShellWindow(): BrowserWindow {
  const browserWindow = new BrowserWindow({
    width: 1240, height: 820, minWidth: 900, minHeight: 600, show: false, backgroundColor: "#0d0d0d", autoHideMenuBar: true,
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
  preCompactTab = "capture"; // will be restored on exit
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
  const topicsResult = await Promise.allSettled([client.listTopics()]);
  const topics = topicsResult[0].status === "fulfilled" ? topicsResult[0].value : [];
  if (topicsResult[0].status === "rejected") console.error("workspace:load topics failed:", topicsResult[0].reason);
  return { topics };
});
ipcMain.handle("workspace:create-topic", async (event, title: string, materialIds?: string[]) => { assertTrustedRenderer(event.sender.id); return client.createTopic(title, materialIds); });
ipcMain.handle("workspace:update-topic", async (event, id: string, patch: Parameters<CaptureClient["updateTopic"]>[1]) => { assertTrustedRenderer(event.sender.id); return client.updateTopic(id, patch); });
ipcMain.handle("workspace:add-topic-member", async (event, topicId: string, captureId: string) => { assertTrustedRenderer(event.sender.id); return client.addTopicMember(topicId, captureId); });
ipcMain.handle("workspace:remove-topic-member", async (event, topicId: string, captureId: string) => { assertTrustedRenderer(event.sender.id); return client.removeTopicMember(topicId, captureId); });
ipcMain.handle("workspace:generate-document", async (event, topicId: string, idempotencyKey?: string) => { assertTrustedRenderer(event.sender.id); return client.generateTopicDocument(topicId, idempotencyKey); });
ipcMain.handle("workspace:list-documents", async (event, topicId: string) => { assertTrustedRenderer(event.sender.id); return client.listTopicDocumentVersions(topicId); });
ipcMain.handle("workspace:get-latest-document", async (event, topicId: string) => { assertTrustedRenderer(event.sender.id); return client.getLatestTopicDocument(topicId); });
ipcMain.handle("workspace:get-document-version", async (event, documentId: string) => { assertTrustedRenderer(event.sender.id); return client.getTopicDocumentVersion(documentId); });
ipcMain.handle("workspace:rollback-document", async (event, topicId: string, documentId: string) => { assertTrustedRenderer(event.sender.id); return client.rollbackTopicDocument(topicId, documentId); });
ipcMain.handle("workspace:get-topic", async (event, topicId: string) => { assertTrustedRenderer(event.sender.id); return client.getTopic(topicId); });
ipcMain.handle("workspace:promote-cluster", async (event, snapshotId: string, clusterIndex: number, title: string) => { assertTrustedRenderer(event.sender.id); return client.promoteCluster(snapshotId, clusterIndex, title); });
ipcMain.handle("workspace:topic-suggestions", async (event, topicId: string) => { assertTrustedRenderer(event.sender.id); return client.getTopicSuggestions(topicId); });
ipcMain.handle("workspace:workflow-run", async (event, runId: string) => { assertTrustedRenderer(event.sender.id); return client.getWorkflowRun(runId); });
ipcMain.handle("workspace:preview-document-update", async (event, topicId: string) => { assertTrustedRenderer(event.sender.id); return client.previewDocumentUpdate(topicId); });
ipcMain.handle("workspace:confirm-document-update", async (event, topicId: string, previewId: string, accepted: boolean) => { assertTrustedRenderer(event.sender.id); return client.confirmDocumentUpdate(topicId, previewId, accepted); });
ipcMain.handle("workspace:verification-claims", async (event, documentId: string) => { assertTrustedRenderer(event.sender.id); return client.getVerificationClaims(documentId); });

  // ── Materials CRUD ──
  ipcMain.handle("material:list", async (event, params?: { q?: string; page?: number; limit?: number; trash?: boolean }) => { assertTrustedRenderer(event.sender.id); return client.listMaterials(params); });
  ipcMain.handle("material:get", async (event, id: string) => { assertTrustedRenderer(event.sender.id); return client.getMaterial(id); });
  ipcMain.handle("material:revisions", async (event, id: string) => { assertTrustedRenderer(event.sender.id); return client.listRevisions(id); });
  ipcMain.handle("material:edit", async (event, id: string, content: string) => { assertTrustedRenderer(event.sender.id); return client.editRevision(id, content); });
  ipcMain.handle("material:set-ai-processing", async (event, id: string, disabled: boolean) => { assertTrustedRenderer(event.sender.id); return client.setMaterialAiProcessing(id, disabled); });
  ipcMain.handle("material:extract-text", async (event, id: string) => { assertTrustedRenderer(event.sender.id); return client.extractMaterialText(id); });
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
  const ai = embeddedService?.getAiConfiguration() ?? { consent: false, configured: false, unavailable: true };
  return { shortcut, ai, providerCatalog: embeddedService?.getProviderCatalog() ?? [], providerProfiles: embeddedService?.listProviderProfiles() ?? [], activeProviderProfileId: embeddedService?.getActiveProviderProfile()?.id };
});
ipcMain.handle("settings:save-provider", async (event, value: { profile: ProviderProfileInput; apiKey?: string; consent?: boolean; activate?: boolean }) => {
  assertTrustedRenderer(event.sender.id);
  if (!embeddedService || !embeddedProviderResolver) throw new Error("Provider settings are only available in the embedded Collector service");
  const existing = value.profile.id ? embeddedService.listProviderProfiles().find((profile) => profile.id === value.profile.id) : undefined;
  const nextCredentialConfigured = value.apiKey === undefined ? (existing?.credentialConfigured ?? false) : Boolean(value.apiKey.trim());
  if (value.activate && !nextCredentialConfigured) throw new Error("Please provide an API key before activating the provider");
  let credentialConfigured = existing?.credentialConfigured ?? false;
  const validated = await embeddedService.saveProviderProfile(value.profile, credentialConfigured);
  const id = validated.id;
  if (value.apiKey !== undefined) {
    if (value.apiKey.trim()) {
      await providerCredentialStore().set(id, value.apiKey.trim());
      credentialConfigured = true;
    } else {
      await providerCredentialStore().delete(id);
      credentialConfigured = false;
    }
  }
  const profile = await embeddedService.saveProviderProfile({ ...value.profile, id: validated.id }, credentialConfigured);
  if (value.consent !== undefined) await embeddedService.setAiConfiguration(value.consent, credentialConfigured);
  if (value.activate) await embeddedService.activateProviderProfile(profile.id);
  if (embeddedService.getActiveProviderProfile()?.id === profile.id) await refreshEmbeddedProviderRuntime();
  return { profile, ai: embeddedService.getAiConfiguration(), activeProviderProfileId: embeddedService.getActiveProviderProfile()?.id };
});
ipcMain.handle("settings:test-provider", async (event, value: { profile: ProviderProfileInput; apiKey?: string }) => {
  assertTrustedRenderer(event.sender.id);
  const definition = DEFAULT_PROVIDER_REGISTRY.get(value.profile.providerId);
  const baseUrl = definition.id.startsWith("custom") ? await validateExternalProviderBaseUrl(value.profile.baseUrl ?? "") : definition.defaultBaseUrl;
  const apiKey = value.apiKey?.trim() || (value.profile.id ? await providerCredentialStore().get(value.profile.id) : undefined);
  if (!apiKey) throw new Error("Please provide an API key before testing the provider");
  const gateway = new ModelGateway(createProvider(definition, { apiKey: () => apiKey, baseUrl }), { model: value.profile.model.trim() || definition.defaultModel });
  return gateway.testConnection({ timeoutMs: 15000 });
});
ipcMain.handle("settings:activate-provider", async (event, id: string) => {
  assertTrustedRenderer(event.sender.id);
  if (!embeddedService) throw new Error("Provider settings are unavailable");
  await embeddedService.activateProviderProfile(id);
  await refreshEmbeddedProviderRuntime();
  return { profile: embeddedService.getActiveProviderProfile(), ai: embeddedService.getAiConfiguration() };
});
ipcMain.handle("settings:delete-provider", async (event, id: string) => {
  assertTrustedRenderer(event.sender.id);
  if (!embeddedService) throw new Error("Provider settings are unavailable");
  const wasActive = embeddedService.getActiveProviderProfile()?.id === id;
  const deleted = await embeddedService.deleteProviderProfile(id);
  if (deleted) await providerCredentialStore().delete(id);
  if (wasActive) {
    await embeddedService.setAiConfiguration(embeddedService.getAiConfiguration().consent, false);
    embeddedService.setModelGateway(undefined);
  }
  return { deleted, ai: embeddedService.getAiConfiguration() };
});
ipcMain.handle("settings:set-ai-consent", async (event, consent: boolean) => {
  assertTrustedRenderer(event.sender.id);
  if (!embeddedService) throw new Error("Provider settings are unavailable");
  await embeddedService.setAiConfiguration(consent, Boolean(embeddedService.getActiveProviderProfile()?.credentialConfigured));
  await refreshEmbeddedProviderRuntime();
  return embeddedService.getAiConfiguration();
});
ipcMain.handle("settings:save-shortcut", async (event, value: string) => {
  assertTrustedRenderer(event.sender.id);
  const accelerator = value.trim();
  if (!accelerator) throw new Error("快捷键不能为空");
  if (!registerShortcut(accelerator)) throw new Error("快捷键冲突，请更换组合");
  await saveDesktopPreferences({ shortcut });
  return { shortcut };
});
ipcMain.handle("settings:clear-all-data", async (event) => {
  assertTrustedRenderer(event.sender.id);
  const result = await dialog.showMessageBox({
    type: "warning",
    title: "清除所有数据",
    message: "此操作将永久删除所有已收集的材料、专题、工作流记录和生成的文档。",
    detail: "以下内容将被保留：\n• 浏览器扩展配对凭证\n• 外部供应商凭证及 AI 配置\n• 快捷键设置\n\n此操作不可撤销。",
    buttons: ["取消", "确认清除"],
    defaultId: 0,
    cancelId: 0,
  });
  if (result.response === 0) return { cleared: false };

  embeddedScheduler?.stop();
  try {
    if (embeddedService) {
      await embeddedService.clearAllData();
    }
    console.log("[Main] All user data cleared successfully");
    shellWindow?.webContents.send("data:cleared");
    return { cleared: true };
  } finally {
    embeddedScheduler?.start();
  }
});

ipcMain.handle("settings:data-control", async (event) => {
  assertTrustedRenderer(event.sender.id);
  const [usage, budget, backups] = await Promise.all([client.getAiUsage(), client.getAiBudget(), client.listBackups()]);
  return { usage, budget, backups, paths: embeddedService?.getDataPaths() };
});
ipcMain.handle("settings:save-ai-budget", async (event, value: { monthlyLimitUsd?: number; warningThresholdUsd?: number; enabled?: boolean }) => {
  assertTrustedRenderer(event.sender.id);
  return client.updateAiBudget(value);
});
ipcMain.handle("settings:create-backup", async (event) => {
  assertTrustedRenderer(event.sender.id);
  return client.createBackup();
});
ipcMain.handle("settings:verify-backup", async (event, id: string) => {
  assertTrustedRenderer(event.sender.id);
  return client.verifyBackup(id);
});
ipcMain.handle("settings:export-portable", async (event, value: import("@collector/capture-contracts").ExportRequest) => {
  assertTrustedRenderer(event.sender.id);
  return client.exportPortable(value);
});

async function ensureLocalApi(masterToken: string, legacyProviderCredential?: string): Promise<Server | undefined> {
  try {
    const response = await fetch(`${apiBaseUrl}/health`, { signal: AbortSignal.timeout(800) });
    if (response.ok && (await response.json() as { instanceId?: string }).instanceId === instanceId) return undefined;
  } catch { /* Start the embedded API below. */ }
  const url = new URL(apiBaseUrl);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error(`Collector API unavailable: ${apiBaseUrl}`);
  const paths = defaultDataPaths(process.env.COLLECTOR_DATA_DIR);
  const store = new SqliteStore(paths.database, paths.legacyJson);
  await store.init(); embeddedStore = store;
  if (legacyProviderCredential || store.getProviderProfile(LEGACY_DEEPSEEK_PROFILE_ID)) {
    await ensureLegacyProviderProfile(store, Boolean(legacyProviderCredential));
  }
  embeddedProviderResolver = new ProviderRuntimeResolver(DEFAULT_PROVIDER_REGISTRY, (profileId) => providerCredentialStore().get(profileId));
  const auth = new LocalAuth(store);
  await auth.registerTrustedToken(masterToken);
  const consent = store.getSetting("ai_consent") === "true";
  const activeProfile = store.getActiveProviderProfile();
  const runtime = consent && activeProfile?.credentialConfigured ? await resolveProviderRuntime(embeddedProviderResolver, activeProfile) : undefined;
  embeddedService = new CaptureService(store, paths.artifacts, undefined, runtime?.gateway);
  embeddedService.setModelGateway(runtime?.gateway, runtime?.route);
  embeddedService.setModelGatewayResolver(async (route) => {
    const storedProfile = store.getProviderProfile(route.providerProfileId);
    if (!storedProfile) throw new Error("Workflow provider profile no longer exists");
    if (storedProfile.providerId !== route.providerId || storedProfile.model !== route.model || storedProfile.configurationVersion !== route.configurationVersion || fingerprintBaseUrl(storedProfile.baseUrl) !== route.baseUrlFingerprint) {
      throw new Error("Workflow provider configuration has changed");
    }
    return (await embeddedProviderResolver!.resolve(storedProfile)).gateway;
  });
  await embeddedService.setAiConfiguration(consent, Boolean(activeProfile?.credentialConfigured));
  
  // 启动工作流调度器守护进程
  embeddedScheduler = new WorkflowScheduler(embeddedService);
  embeddedScheduler.start();
  
  const server = createApiServer(embeddedService, auth, { instanceId });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(Number(url.port || 80), "127.0.0.1", resolve); });
  return server;
}

async function showExtensionPairingCode(): Promise<void> {
  const pairing = await client.createPairingCode("Collector Browser Extension");
  await dialog.showMessageBox({ type: "info", title: "浏览器扩展配对", message: `配对码：${pairing.code}`, detail: "请在五分钟内输入扩展。配对码只能使用一次。" });
}

async function loadMasterToken(): Promise<string> {
  const path = join(app.getPath("userData"), "collector-master-token.bin");
  try { 
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(await readFile(path)); 
    } else {
      console.warn("[Main] safeStorage unavailable, using plaintext token storage");
      return await readFile(path, "utf8");
    }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const token = randomBytes(32).toString("base64url");
    await mkdir(app.getPath("userData"), { recursive: true });
    if (safeStorage.isEncryptionAvailable()) {
      await writeFile(path, safeStorage.encryptString(token)); 
    } else {
      console.warn("[Main] safeStorage unavailable, saving token in plaintext");
      await writeFile(path, token);
    }
    return token;
  }
}
function providerCredentialStore(): FileCredentialStore {
  return new FileCredentialStore(join(app.getPath("userData"), "provider-credentials"), safeStorage);
}

async function loadLegacyProviderCredential(): Promise<string | undefined> {
  const store = providerCredentialStore();
  const current = await store.get(LEGACY_DEEPSEEK_PROFILE_ID);
  if (current) return current;
  const legacy = await loadLegacyDeepSeekKey();
  if (!legacy) return undefined;
  await store.set(LEGACY_DEEPSEEK_PROFILE_ID, legacy);
  const verified = await store.get(LEGACY_DEEPSEEK_PROFILE_ID);
  if (verified !== legacy) throw new Error("Provider credential migration could not be verified");
  await rm(join(app.getPath("userData"), "deepseek-key.bin"), { force: true });
  return verified;
}

async function ensureLegacyProviderProfile(store: CollectorStore, credentialConfigured: boolean): Promise<ProviderProfile> {
  const existing = store.getProviderProfile(LEGACY_DEEPSEEK_PROFILE_ID);
  const definition = DEFAULT_PROVIDER_REGISTRY.get("deepseek");
  const now = new Date().toISOString();
  const profile: ProviderProfile = {
    id: LEGACY_DEEPSEEK_PROFILE_ID,
    providerId: definition.id,
    displayName: existing?.displayName ?? definition.label,
    baseUrl: existing?.baseUrl ?? definition.defaultBaseUrl,
    model: existing?.model ?? definition.defaultModel,
    credentialConfigured,
    enabled: existing?.enabled ?? true,
    configurationVersion: existing && existing.credentialConfigured === credentialConfigured ? existing.configurationVersion : (existing?.configurationVersion ?? 0) + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await store.saveProviderProfile(profile);
  if (credentialConfigured && profile.enabled && !store.getActiveProviderProfile()) await store.setActiveProviderProfile(profile.id);
  return profile;
}

async function resolveProviderRuntime(resolver: ProviderRuntimeResolver, profile: ProviderProfile): Promise<ResolvedProviderRuntime | undefined> {
  try { return await resolver.resolve(profile); }
  catch (error) {
    console.error("Provider runtime is unavailable", error instanceof Error ? error.message : "unknown provider error");
    return undefined;
  }
}

async function refreshEmbeddedProviderRuntime(): Promise<void> {
  if (!embeddedService || !embeddedProviderResolver) return;
  const profile = embeddedService.getActiveProviderProfile();
  const consent = embeddedService.getAiConfiguration().consent;
  const runtime = consent && profile?.credentialConfigured ? await resolveProviderRuntime(embeddedProviderResolver, profile) : undefined;
  embeddedService.setModelGateway(runtime?.gateway, runtime?.route);
}

async function loadLegacyDeepSeekKey(): Promise<string | undefined> {
  const path = join(app.getPath("userData"), "deepseek-key.bin");
  try {
    const fileData = await readFile(path);
    let isEncryptionAvailable = false;
    try { isEncryptionAvailable = safeStorage.isEncryptionAvailable(); }
    catch (error) { console.warn("[Main] safeStorage availability check failed during legacy credential migration", error instanceof Error ? error.message : "unknown error"); }
    
    // Detect file format: encrypted files are binary, plaintext is UTF-8 text
    let isEncryptedFile = false;
    try {
      const textContent = fileData.toString('utf8');
      // If it looks like an API key (starts with sk- or reasonable length with valid chars), it's plaintext
      if (textContent.startsWith('sk-') || 
          (textContent.length > 10 && textContent.length < 200 && /^[a-zA-Z0-9._-]+$/.test(textContent))) {
        isEncryptedFile = false;
      } else {
        isEncryptedFile = true;
      }
    } catch {
      // Cannot convert to UTF-8, must be encrypted binary
      isEncryptedFile = true;
    }
    
    // Case 1: File is encrypted and safeStorage is available - normal decryption
    if (isEncryptedFile && isEncryptionAvailable) {
      return safeStorage.decryptString(fileData);
    }
    
    // Case 2: File is plaintext and safeStorage is unavailable - read directly
    if (!isEncryptedFile && !isEncryptionAvailable) {
      console.warn('[Main] Reading plaintext key (safeStorage unavailable)');
      return fileData.toString('utf8');
    }
    
    // Case 3: File is encrypted but safeStorage is unavailable - cannot load
    if (isEncryptedFile && !isEncryptionAvailable) {
      console.error('[Main] CRITICAL: Encrypted file found but safeStorage unavailable!');
      console.error('[Main] Please re-enter your API key to save it in plaintext mode.');
      return undefined;
    }
    
    // Case 4: File is plaintext but safeStorage is available - migrate to encrypted
    if (!isEncryptedFile && isEncryptionAvailable) {
      const plaintext = fileData.toString('utf8');
      await writeFile(path, safeStorage.encryptString(plaintext));
      return plaintext;
    }
    
    return undefined;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return undefined;
    }
    console.error('[Main] Failed to migrate the legacy provider credential:', err.message);
    return undefined;
  }
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
