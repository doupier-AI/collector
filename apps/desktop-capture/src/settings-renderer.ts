export function initSettings() {
  const bridge = window.collector?.settings;
  if (!bridge) throw new Error("Collector settings bridge is unavailable");

  const titles = {
    general: ["通用", "控制 Collector 的桌面行为。"],
    ai: ["AI 服务", "管理云模型授权与凭证。"],
    data: ["数据", "管理本地知识和可迁移性。"],
    future: ["后续能力", "明确展示尚未进入当前里程碑的功能。"],
  } as const;

  const shortcut = document.querySelector<HTMLInputElement>("#shortcut")!;
  const shortcutStatus = document.querySelector<HTMLElement>("#shortcut-status")!;
  const aiConsent = document.querySelector<HTMLInputElement>("#ai-consent")!;
  const deepSeekKey = document.querySelector<HTMLInputElement>("#deepseek-key")!;
  const aiStatus = document.querySelector<HTMLElement>("#ai-status")!;
  const saveAi = document.querySelector<HTMLButtonElement>("#save-ai")!;
  const toggleEye = document.querySelector<HTMLButtonElement>("#toggle-key-vis")!;
  const testConn = document.querySelector<HTMLButtonElement>("#test-connection")!;
  const testConnSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>';

  document.documentElement.dataset.collectorSettings = "ready";
  document.querySelector("#open-workspace")?.addEventListener("click", () => bridge.navigateTo("workspace"));
  document.querySelectorAll<HTMLButtonElement>("[data-section]").forEach((button) => button.addEventListener("click", () => showSection(button.dataset.section as keyof typeof titles)));
  document.querySelector("#save-shortcut")!.addEventListener("click", async () => {
    try { const result = await bridge.saveShortcut(shortcut.value); shortcut.value = result.shortcut; setStatus(shortcutStatus, "快捷键已更新", "success"); }
    catch (error) { setStatus(shortcutStatus, message(error), "error"); }
  });

  // Eye toggle
  toggleEye.addEventListener("click", () => {
    const isPassword = deepSeekKey.type === "password";
    deepSeekKey.type = isPassword ? "text" : "password";
    toggleEye.classList.toggle("showing", !isPassword);
  });

  // Test connection
  testConn.addEventListener("click", async () => {
    testConn.disabled = true;
    testConn.classList.remove("success", "error");
    testConn.innerHTML = testConnSvg + " 测试中\u2026";
    try {
      const key = deepSeekKey.value.trim() || undefined;
      const result = await bridge.testConnection(key);
      if (result.ok) {
        testConn.classList.add("success");
        testConn.innerHTML = testConnSvg + " " + result.model + " 连接正常";
        setStatus(aiStatus, "连接成功 - 模型: " + result.model, "success");
      } else {
        testConn.classList.add("error");
        testConn.innerHTML = testConnSvg + " 连接失败";
        setStatus(aiStatus, result.error, "error");
      }
    } catch (error) {
      testConn.classList.add("error");
      testConn.innerHTML = testConnSvg + " 连接失败";
      setStatus(aiStatus, message(error), "error");
    } finally {
      testConn.disabled = false;
      setTimeout(() => { testConn.classList.remove("success", "error"); testConn.innerHTML = testConnSvg + " 测试连接"; }, 5000);
    }
  });

  saveAi.addEventListener("click", async () => {
    saveAi.disabled = true;
    try {
      const result = await bridge.saveAi({ consent: aiConsent.checked, apiKey: deepSeekKey.value.trim() || undefined });
      deepSeekKey.type = "password"; toggleEye.classList.remove("showing"); deepSeekKey.placeholder = "Key 已保存（安全存储）"; renderAiStatus(result);
    } catch (error) { setStatus(aiStatus, message(error), "error"); }
    finally { saveAi.disabled = false; }
  });

  void load();

  async function load() {
    try {
      const value = await bridge.get(); shortcut.value = value.shortcut; aiConsent.checked = value.ai.consent;
      if (value.ai.unavailable) { saveAi.disabled = true; setStatus(aiStatus, "当前连接外部 API，AI 设置只能在服务宿主中修改", "error"); }
      else {
        renderAiStatus(value.ai);
        if (value.ai.configured) { deepSeekKey.placeholder = "Key 已保存 · 输入新 Key 以更换"; }
      }
    } catch (error) { setStatus(aiStatus, message(error), "error"); }
  }
  function showSection(id: keyof typeof titles) {
    document.querySelectorAll(".settings-section").forEach((node) => node.classList.toggle("active", node.id === id));
    document.querySelectorAll<HTMLButtonElement>("[data-section]").forEach((node) => node.classList.toggle("active", node.dataset.section === id));
    document.querySelector("#page-title")!.textContent = titles[id][0]; document.querySelector("#page-copy")!.textContent = titles[id][1];
  }
  function renderAiStatus(value: { consent: boolean; configured: boolean; provider?: string; model?: string }) {
    const text = value.consent && value.configured ? (value.provider ?? "DeepSeek") + " 已配置并授权" : value.configured ? "Key 已保存，云端处理未授权" : "尚未配置 API Key";
    setStatus(aiStatus, text, value.configured ? "success" : "ready");
  }
  function setStatus(node: HTMLElement, text: string, kind: string) { node.textContent = text; node.dataset.kind = kind; }
  function message(error: unknown) { return error instanceof Error ? error.message : "保存失败"; }

}