import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { ArtifactRecord, CaptureInput, CaptureRecord } from "@collector/capture-contracts";

contextBridge.exposeInMainWorld("collector", {
  submit: (input: CaptureInput): Promise<CaptureRecord> => ipcRenderer.invoke("capture:submit", input),
  upload: (file: File): Promise<ArtifactRecord> => ipcRenderer.invoke("capture:upload", {
    path: webUtils.getPathForFile(file),
    name: file.name,
    type: file.type,
    size: file.size,
  }),
  hide: () => ipcRenderer.send("capture:hide"),
  setShortcut: (value: string): Promise<boolean> => ipcRenderer.invoke("capture:set-shortcut", value),
  onFocus: (callback: () => void) => ipcRenderer.on("capture:focus", callback),
  onShortcutError: (callback: (shortcut: string) => void) => {
    ipcRenderer.on("capture:shortcut-error", (_event, shortcut) => callback(shortcut));
  },
});
