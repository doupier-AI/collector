interface UploadedArtifact { id: string; fileName: string; mimeType: string; checksum: string }
interface CollectorBridge {
  submit(input: unknown): Promise<unknown>;
  upload(file: File): Promise<UploadedArtifact>;
  hide(): void;
  setShortcut(value: string): Promise<boolean>;
  onFocus(callback: () => void): void;
  onShortcutError(callback: (shortcut: string) => void): void;
}
declare global { interface Window { collector: CollectorBridge } }

const form = document.querySelector<HTMLFormElement>("#capture-form")!;
const content = document.querySelector<HTMLTextAreaElement>("#content")!;
const note = document.querySelector<HTMLInputElement>("#note")!;
const source = document.querySelector<HTMLInputElement>("#source")!;
const topic = document.querySelector<HTMLInputElement>("#topic")!;
const status = document.querySelector<HTMLElement>("#status")!;
const filesElement = document.querySelector<HTMLElement>("#files")!;
const dropZone = document.querySelector<HTMLElement>("#drop-zone")!;
const fileInput = document.querySelector<HTMLInputElement>("#file-input")!;
const shortcutInput = document.querySelector<HTMLInputElement>("#shortcut")!;
const submitButton = document.querySelector<HTMLButtonElement>("#submit-button")!;
const pendingFiles: File[] = [];

if (!window.collector) {
  throw new Error("Collector preload bridge is unavailable");
}
document.documentElement.dataset.collectorRenderer = "ready";
submitButton.disabled = false;
dropZone.tabIndex = 0;
dropZone.setAttribute("aria-disabled", "false");
setStatus("", "ready");

restoreDraft();
window.collector.onFocus(() => content.focus());
window.collector.onShortcutError((shortcut) => setStatus(`快捷键 ${shortcut} 注册失败，请在设置中更换`, "error"));

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.add("active"); });
}
for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.remove("active"); });
}
dropZone.addEventListener("drop", (event) => {
  addFiles(Array.from(event.dataTransfer?.files ?? []));
});
dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener("change", () => {
  addFiles(Array.from(fileInput.files ?? []));
  fileInput.value = "";
});

form.addEventListener("input", saveDraft);
form.addEventListener("submit", (event) => { event.preventDefault(); void submit(); });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { saveDraft(); window.collector.hide(); }
  if (event.key === "Enter" && event.ctrlKey) { event.preventDefault(); void submit(); }
});

shortcutInput.addEventListener("change", async () => {
  const ok = await window.collector.setShortcut(shortcutInput.value.trim());
  setStatus(ok ? "快捷键已更新" : "快捷键冲突，请更换", ok ? "success" : "error");
});

async function submit() {
  if (!content.value.trim() && pendingFiles.length === 0) return setStatus("请输入内容或拖放文件", "error");
  setStatus("正在提交...", "pending");
  try {
    const artifacts: UploadedArtifact[] = [];
    for (const file of pendingFiles) {
      const uploadFile = file.type ? file : new File([file], file.name, { type: inferMime(file.name) });
      artifacts.push(await window.collector.upload(uploadFile));
    }
    const text = content.value.trim();
    const url = isUrl(text) ? text : undefined;
    const isFile = artifacts.length > 0;
    await window.collector.submit({
      captureType: isFile ? "local_file" : url ? "pasted_url" : "pasted_text",
      content: url ? undefined : text || undefined,
      sourceUrl: url,
      locator: isFile
        ? { kind: "file", fileName: artifacts[0].fileName, mimeType: artifacts[0].mimeType, checksum: artifacts[0].checksum }
        : { kind: "user_supplied", sourceLabel: source.value.trim() || undefined },
      note: note.value.trim() || undefined,
      topicId: topic.value.trim() || undefined,
      artifactIds: artifacts.map((item) => item.id),
      clientCaptureId: `desktop-${crypto.randomUUID()}`,
      capturedAt: new Date().toISOString(),
    });
    clearDraft();
    setStatus("已进入知识收件箱", "success");
    setTimeout(() => window.collector.hide(), 500);
  } catch (error) {
    saveDraft();
    setStatus(error instanceof Error ? error.message : "提交失败，草稿已保留", "error");
  }
}

function saveDraft() {
  localStorage.setItem("collector:draft", JSON.stringify({ content: content.value, note: note.value, source: source.value, topic: topic.value }));
}
function restoreDraft() {
  const raw = localStorage.getItem("collector:draft");
  if (!raw) return;
  try {
    const draft = JSON.parse(raw);
    content.value = draft.content ?? ""; note.value = draft.note ?? ""; source.value = draft.source ?? ""; topic.value = draft.topic ?? "";
  } catch { localStorage.removeItem("collector:draft"); }
}
function clearDraft() {
  form.reset(); pendingFiles.length = 0; renderFiles(); localStorage.removeItem("collector:draft");
}
function addFiles(files: File[]) {
  const accepted = new Set(["txt", "md", "pdf", "png", "jpg", "jpeg", "webp"]);
  for (const file of files) {
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!accepted.has(extension)) {
      setStatus(`不支持文件：${file.name}`, "error");
      continue;
    }
    if (!pendingFiles.some((item) => item.name === file.name && item.size === file.size)) pendingFiles.push(file);
  }
  renderFiles();
  saveDraft();
}
function renderFiles() { filesElement.textContent = pendingFiles.map((file) => `${file.name} (${formatBytes(file.size)})`).join("\n"); }
function setStatus(message: string, kind: string) { status.textContent = message; status.dataset.kind = kind; }
function isUrl(value: string) { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol); } catch { return false; } }
function inferMime(name: string) {
  const extension = name.split(".").pop()?.toLowerCase();
  return ({ txt: "text/plain", md: "text/markdown", pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}
function formatBytes(value: number) { return value < 1024 * 1024 ? `${Math.ceil(value / 1024)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`; }

export {};
