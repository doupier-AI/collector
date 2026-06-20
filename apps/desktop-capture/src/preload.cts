import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { ArtifactRecord, CaptureInput, CaptureRecord } from "@collector/capture-contracts";

contextBridge.exposeInMainWorld("collector", {
  capture: {
    submit: (input: CaptureInput): Promise<CaptureRecord> => ipcRenderer.invoke("capture:submit", input),
    upload: (file: File): Promise<ArtifactRecord> => ipcRenderer.invoke("capture:upload", {
      path: webUtils.getPathForFile(file), name: file.name, type: file.type, size: file.size,
    }),
    hide: () => ipcRenderer.send("shell:hide"),
    navigate: (tab: string) => ipcRenderer.send("shell:navigate", tab),
    onFocus: (callback: () => void) => ipcRenderer.on("capture:focus", callback),
    onShortcutError: (callback: (shortcut: string) => void) => ipcRenderer.on("capture:shortcut-error", (_event, shortcut) => callback(shortcut)),
    onModeChange: (callback: (mode: string) => void) => ipcRenderer.on("shell:mode", (_event, mode) => callback(mode)),
    onNavigate: (callback: (tab: string) => void) => ipcRenderer.on("shell:navigate", (_event, tab) => callback(tab)),
    onDataCleared: (callback: () => void) => ipcRenderer.on("data:cleared", callback),
  },
  workspace: {
    load: () => ipcRenderer.invoke("workspace:load"),
    createTopic: (title: string) => ipcRenderer.invoke("workspace:create-topic", title),
    createSuggestedTopic: (input: unknown) => ipcRenderer.invoke("workspace:create-suggested-topic", input),
    updateTopic: (id: string, patch: unknown) => ipcRenderer.invoke("workspace:update-topic", id, patch),
    getTopic: (id: string) => ipcRenderer.invoke("workspace:get-topic", id),
    addTopicMember: (topicId: string, captureId: string) => ipcRenderer.invoke("workspace:add-topic-member", topicId, captureId),
    removeTopicMember: (topicId: string, captureId: string) => ipcRenderer.invoke("workspace:remove-topic-member", topicId, captureId),
    deepAnalysis: (captureId: string) => ipcRenderer.invoke("workspace:deep-analysis", captureId),
    generateDocument: (topicId: string, idempotencyKey?: string) => ipcRenderer.invoke("workspace:generate-document", topicId, idempotencyKey),
    listDocuments: (topicId: string) => ipcRenderer.invoke("workspace:list-documents", topicId),
    getLatestDocument: (topicId: string) => ipcRenderer.invoke("workspace:get-latest-document", topicId),
  },
  recent: {
    organize: (idempotencyKey?: string) => ipcRenderer.invoke("recent:organize", idempotencyKey),
    snapshot: () => ipcRenderer.invoke("recent:snapshot"),
    run: (id: string) => ipcRenderer.invoke("recent:run", id),
    cancel: (id: string) => ipcRenderer.invoke("recent:cancel", id),
  },
  material: {
    list: (params?: { q?: string; page?: number; limit?: number; trash?: boolean }) => ipcRenderer.invoke("material:list", params),
    get: (id: string) => ipcRenderer.invoke("material:get", id),
    revisions: (id: string) => ipcRenderer.invoke("material:revisions", id),
    edit: (id: string, content: string) => ipcRenderer.invoke("material:edit", id, content),
    trash: (id: string) => ipcRenderer.invoke("material:trash", id),
    restore: (id: string) => ipcRenderer.invoke("material:restore", id),
    deleteImpact: (id: string) => ipcRenderer.invoke("material:delete-impact", id),
    permanentDelete: (id: string, acknowledge?: boolean) => ipcRenderer.invoke("material:permanent-delete", id, acknowledge),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    testConnection: (key?: string) => ipcRenderer.invoke("settings:test-connection", key),
    saveAi: (value: { consent: boolean; apiKey?: string }) => ipcRenderer.invoke("settings:save-ai", value),
    saveShortcut: (value: string) => ipcRenderer.invoke("settings:save-shortcut", value),
    clearAllData: () => ipcRenderer.invoke("settings:clear-all-data"),
  },
});
