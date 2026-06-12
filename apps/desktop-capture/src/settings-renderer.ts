const bridge = window.collector?.settings;
if (!bridge) throw new Error("Collector settings bridge is unavailable");

const titles = {
  general: ["通用", "控制 Collector 的桌面行为。"],
  ai: ["AI 服务", "管理云模型授权与凭据。"],
  data: ["数据", "管理本地知识和可迁移性。"],
  future: ["后续能力", "明确展示尚未进入当前里程碑的功能。"],
} as const;

const shortcut = document.querySelector<HTMLInputElement>("#shortcut")!;
const shortcutStatus = document.querySelector<HTMLElement>("#shortcut-status")!;
const aiConsent = document.querySelector<HTMLInputElement>("#ai-consent")!;
const deepSeekKey = document.querySelector<HTMLInputElement>("#deepseek-key")!;
const aiStatus = document.querySelector<HTMLElement>("#ai-status")!;
const saveAi = document.querySelector<HTMLButtonElement>("#save-ai")!;

document.documentElement.dataset.collectorSettings = "ready";
document.querySelector("#open-workspace")!.addEventListener("click", () => bridge.openWorkspace());
document.querySelectorAll<HTMLButtonElement>("[data-section]").forEach((button) => button.addEventListener("click", () => showSection(button.dataset.section as keyof typeof titles)));
document.querySelector("#save-shortcut")!.addEventListener("click", async () => {
  try { const result = await bridge.saveShortcut(shortcut.value); shortcut.value = result.shortcut; setStatus(shortcutStatus, "快捷键已更新", "success"); }
  catch (error) { setStatus(shortcutStatus, message(error), "error"); }
});
saveAi.addEventListener("click", async () => {
  saveAi.disabled = true;
  try {
    const result = await bridge.saveAi({ consent: aiConsent.checked, apiKey: deepSeekKey.value.trim() || undefined });
    deepSeekKey.value = ""; renderAiStatus(result);
  } catch (error) { setStatus(aiStatus, message(error), "error"); }
  finally { saveAi.disabled = false; }
});

void load();

async function load() {
  try {
    const value = await bridge.get(); shortcut.value = value.shortcut; aiConsent.checked = value.ai.consent;
    if (value.ai.unavailable) { saveAi.disabled = true; setStatus(aiStatus, "当前连接外部 API，AI 设置只能在服务宿主中修改", "error"); }
    else renderAiStatus(value.ai);
  } catch (error) { setStatus(aiStatus, message(error), "error"); }
}
function showSection(id: keyof typeof titles) {
  document.querySelectorAll(".settings-section").forEach((node) => node.classList.toggle("active", node.id === id));
  document.querySelectorAll<HTMLButtonElement>("[data-section]").forEach((node) => node.classList.toggle("active", node.dataset.section === id));
  document.querySelector("#page-title")!.textContent = titles[id][0]; document.querySelector("#page-copy")!.textContent = titles[id][1];
}
function renderAiStatus(value: { consent: boolean; configured: boolean; provider?: string; model?: string }) {
  const text = value.consent && value.configured ? `${value.provider ?? "DeepSeek"} 已配置并授权` : value.configured ? "Key 已保存，云端处理未授权" : "尚未配置 API Key";
  setStatus(aiStatus, text, value.configured ? "success" : "ready");
}
function setStatus(node: HTMLElement, text: string, kind: string) { node.textContent = text; node.dataset.kind = kind; }
function message(error: unknown) { return error instanceof Error ? error.message : "保存失败"; }

export {};
