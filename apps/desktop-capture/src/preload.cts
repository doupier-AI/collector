import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { ArtifactRecord, CaptureInput, CaptureRecord, ReviewDecision } from "@collector/capture-contracts";

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
  },
  workspace: {
    load: () => ipcRenderer.invoke("workspace:load"),
    decide: (id: string, decision: ReviewDecision) => ipcRenderer.invoke("workspace:decide", id, decision),
    revoke: (id: string) => ipcRenderer.invoke("workspace:revoke", id),
    createTopic: (title: string) => ipcRenderer.invoke("workspace:create-topic", title),
    createSuggestedTopic: (input: unknown) => ipcRenderer.invoke("workspace:create-suggested-topic", input),
    updateTopic: (id: string, patch: unknown) => ipcRenderer.invoke("workspace:update-topic", id, patch),
    getTopic: (id: string) => ipcRenderer.invoke("workspace:get-topic", id),
    addTopicMember: (topicId: string, captureId: string) => ipcRenderer.invoke("workspace:add-topic-member", topicId, captureId),
    removeTopicMember: (topicId: string, captureId: string) => ipcRenderer.invoke("workspace:remove-topic-member", topicId, captureId),
    deepAnalysis: (captureId: string) => ipcRenderer.invoke("workspace:deep-analysis", captureId),
    navigateTo: (tab: string) => ipcRenderer.send("shell:navigate", tab),
  },
    recent: {
    organize: (idempotencyKey?: string) => ipcRenderer.invoke("recent:organize", idempotencyKey),
    snapshot: () => ipcRenderer.invoke("recent:snapshot"),
    run: (id: string) => ipcRenderer.invoke("recent:run", id),
    cancel: (id: string) => ipcRenderer.invoke("recent:cancel", id),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    saveAi: (value: { consent: boolean; apiKey?: string }) => ipcRenderer.invoke("settings:save-ai", value),
    saveShortcut: (value: string) => ipcRenderer.invoke("settings:save-shortcut", value),
    navigateTo: (tab: string) => ipcRenderer.send("shell:navigate", tab),
  },
});