interface UploadedArtifact { id: string; fileName: string; mimeType: string; checksum: string }

export function initCapture() {
  
  const form = document.querySelector<HTMLFormElement>("#capture-form")!;
  const content = document.querySelector<HTMLTextAreaElement>("#content")!;
  const status = document.querySelector<HTMLElement>("#status")!;
  const attachments = document.querySelector<HTMLElement>("#attachments")!;
  const fileInput = document.querySelector<HTMLInputElement>("#file-input")!;
  const attachButton = document.querySelector<HTMLButtonElement>("#attach")!;
  const submitButton = document.querySelector<HTMLButtonElement>("#submit-button")!;
  const pendingFiles: File[] = [];
  
  if (!window.collector?.capture) throw new Error("Collector preload bridge is unavailable");
  document.documentElement.dataset.collectorRenderer = "ready";
  restoreDraft();
  syncSubmitState();
  
  window.collector.capture.onFocus(() => content.focus());
  window.collector.capture.onShortcutError((shortcut) => setStatus(`快捷键 ${shortcut} 被占用，请在设置中修改`, "error"));
  attachButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => { addFiles(Array.from(fileInput.files ?? [])); fileInput.value = ""; });
  content.addEventListener("input", () => { saveDraft(); syncSubmitState(); });
  form.addEventListener("submit", (event) => { event.preventDefault(); void submit(); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { saveDraft(); window.collector.capture.hide(); }
    if (event.key === "Enter" && event.ctrlKey) { event.preventDefault(); void submit(); }
  });
  for (const name of ["dragenter", "dragover"]) form.addEventListener(name, (event) => { event.preventDefault(); form.classList.add("dragging"); });
  for (const name of ["dragleave", "drop"]) form.addEventListener(name, (event) => { event.preventDefault(); form.classList.remove("dragging"); });
  form.addEventListener("drop", (event) => addFiles(Array.from(event.dataTransfer?.files ?? [])));
  
  async function submit() {
    if (!content.value.trim() && pendingFiles.length === 0) return;
    submitButton.disabled = true;
    setStatus("正在保存…", "pending");
    try {
      const artifacts: UploadedArtifact[] = [];
      for (const file of pendingFiles) {
        const uploadFile = file.type ? file : new File([file], file.name, { type: inferMime(file.name) });
        artifacts.push(await window.collector.capture.upload(uploadFile));
      }
      const text = content.value.trim();
      const url = isUrl(text) ? text : undefined;
      console.log('[collector] submitting capture via IPC...');
      const result = await window.collector.capture.submit({
        captureType: artifacts.length ? "local_file" : url ? "pasted_url" : "pasted_text",
        content: url ? undefined : text || undefined,
        sourceUrl: url,
        locator: artifacts.length
          ? { kind: "file", fileName: artifacts[0].fileName, mimeType: artifacts[0].mimeType, checksum: artifacts[0].checksum }
          : { kind: "user_supplied" },
        artifactIds: artifacts.map((item) => item.id),
        clientCaptureId: `desktop-${crypto.randomUUID()}`,
        capturedAt: new Date().toISOString(),
      });
      console.log('[collector] submit succeeded, id:', result.id);
      clearDraft();
      setStatus("已收集", "success");
      setTimeout(() => window.collector.capture.hide(), 420);
    } catch (error) {
      console.error('[collector] submit FAILED:', error instanceof Error ? error.message : error);
      saveDraft();
      setStatus(error instanceof Error ? error.message : "保存失败，内容已保留", "error");
      syncSubmitState();
    }
  }
  
  function addFiles(files: File[]) {
    const accepted = new Set(["txt", "md", "pdf", "png", "jpg", "jpeg", "webp"]);
    for (const file of files) {
      const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
      if (!accepted.has(extension)) { setStatus(`不支持 ${file.name}`, "error"); continue; }
      if (!pendingFiles.some((item) => item.name === file.name && item.size === file.size)) pendingFiles.push(file);
    }
    renderFiles(); syncSubmitState();
  }
  function renderFiles() {
    attachments.replaceChildren();
    pendingFiles.forEach((file, index) => {
      const chip = document.createElement("div"); chip.className = "attachment";
      const name = document.createElement("span"); name.textContent = `${file.name} · ${formatBytes(file.size)}`;
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.title = "移除";
      remove.addEventListener("click", () => { pendingFiles.splice(index, 1); renderFiles(); syncSubmitState(); });
      chip.append(name, remove); attachments.append(chip);
    });
  }
  function saveDraft() { localStorage.setItem("collector:draft", content.value); }
  function restoreDraft() { content.value = localStorage.getItem("collector:draft") ?? ""; }
  function clearDraft() { content.value = ""; pendingFiles.length = 0; renderFiles(); localStorage.removeItem("collector:draft"); syncSubmitState(); }
  function syncSubmitState() { submitButton.disabled = !content.value.trim() && pendingFiles.length === 0; }
  function setStatus(message: string, kind: string) { status.textContent = message; status.dataset.kind = kind; }
  function isUrl(value: string) { try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; } }
  function inferMime(name: string) { const extension = name.split(".").pop()?.toLowerCase(); return ({ txt: "text/plain", md: "text/markdown", pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" } as Record<string,string>)[extension ?? ""] ?? "application/octet-stream"; }
  function formatBytes(value: number) { return value < 1024 * 1024 ? `${Math.max(1, Math.ceil(value / 1024))} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
  
}
