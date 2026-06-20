export function initSettings() {
  const bridge = window.collector?.settings;
  if (!bridge) throw new Error("Collector settings bridge is unavailable");

  const titles = {
    general: ["通用", "控制 Collector 的桌面行为。"],
    ai: ["AI 服务", "管理云模型授权与凭证。"],
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

  // 初始化快捷键录制器
  let currentShortcutValue = "CommandOrControl+Shift+Space";
  setupShortcutRecorder(shortcut, currentShortcutValue);

  document.documentElement.dataset.collectorSettings = "ready";
  document.querySelectorAll<HTMLButtonElement>("[data-section]").forEach((button) => button.addEventListener("click", () => showSection(button.dataset.section as keyof typeof titles)));
  
  // 保存快捷键按钮（如果存在）
  const saveShortcutBtn = document.querySelector("#save-shortcut");
  if (saveShortcutBtn) {
    saveShortcutBtn.addEventListener("click", async () => {
      try { 
        const result = await bridge.saveShortcut(shortcut.value); 
        shortcut.value = result.shortcut; 
        setStatus(shortcutStatus, "快捷键已更新", "success"); 
      }
      catch (error) { setStatus(shortcutStatus, message(error), "error"); }
    });
  }

  toggleEye.addEventListener("click", () => {
    const isPassword = deepSeekKey.type === "password";
    deepSeekKey.type = isPassword ? "text" : "password";
    toggleEye.classList.toggle("showing", !isPassword);
  });

  testConn.addEventListener("click", async () => {
    testConn.disabled = true;
    testConn.classList.remove("success", "error");
    testConn.innerHTML = testConnSvg + " 测试中…";
    try {
      // 如果输入框为空，传递 undefined，让后端使用已保存的 key
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
    const rawKey = deepSeekKey.value.trim();
    
    saveAi.disabled = true;
    try {
      console.log('[Settings] saveAi called, rawKey:', JSON.stringify(rawKey), 'length:', rawKey.length);
      const result = await bridge.saveAi({ consent: aiConsent.checked, apiKey: rawKey });
      // 更新 UI 状态
      if (result.apiKey) { 
        // 保持输入框中的 key（密码形式显示）
        deepSeekKey.value = result.apiKey;
        deepSeekKey.type = "password"; 
        toggleEye.classList.remove("showing");
        setStatus(aiStatus, "AI 设置已保存", "success");
      } else {
        // 没有返回 key，说明已清除
        deepSeekKey.value = "";
        deepSeekKey.placeholder = "请输入 DeepSeek API Key";
        setStatus(aiStatus, "API Key 已清除", "warning");
      }
      renderAiStatus(result);
    } catch (error) { setStatus(aiStatus, message(error), "error"); }
    finally { saveAi.disabled = false; }
  });

  const clearBtn = document.querySelector<HTMLButtonElement>("#clear-all-data");
  const clearStatus = document.querySelector<HTMLElement>("#clear-status");
  if (clearBtn && clearStatus) {
    clearBtn.addEventListener("click", async () => {
      clearBtn.disabled = true;
      try {
        const result = await bridge.clearAllData();
        if (result.cleared) {
          setStatus(clearStatus, "所有数据已清除", "success");
          void load();
        }
      } catch (error) {
        setStatus(clearStatus, message(error), "error");
      } finally {
        clearBtn.disabled = false;
      }
    });
  }

  void load();

  async function load() {
    try {
      const value = await bridge.get();
      currentShortcutValue = value.shortcut;
      shortcut.value = value.shortcut;
      aiConsent.checked = value.ai.consent;
      // 页面加载时显示已保存的 key（以密码形式，保护隐私）
      if (value.ai.apiKey) {
        deepSeekKey.value = value.ai.apiKey;
        deepSeekKey.type = "password"; // 密码类型，显示为圆点
        toggleEye.classList.remove("showing"); // 默认隐藏
        deepSeekKey.placeholder = "";
      } else {
        // 没有 key 时清空输入框并确保是密码类型
        deepSeekKey.value = "";
        deepSeekKey.type = "password";
        toggleEye.classList.remove("showing");
        deepSeekKey.placeholder = "请输入 DeepSeek API Key";
      }
      if (value.ai.unavailable) { saveAi.disabled = true; setStatus(aiStatus, "当前连接外部 API，AI 设置只能在服务宿主中修改", "error"); }
      else {
        renderAiStatus(value.ai);
        if (value.ai.configured) { deepSeekKey.placeholder = "Key 已保存 · 输入新 Key 以更换"; }
      }
    } catch (error) { setStatus(aiStatus, message(error), "error"); }
  }
  
  /**
   * 设置快捷键录制器 - 类似 VS Code 的交互体验
   * @param inputEl - 快捷键输入框元素
   * @param currentShortcut - 当前已保存的快捷键值
   */
  function setupShortcutRecorder(inputEl: HTMLInputElement, currentShortcut: string): void {
    let isRecording = false;
    let recordingTimeout: number | null = null;
    
    inputEl.addEventListener("focus", () => {
      isRecording = true;
      inputEl.value = "按下快捷键...";
      inputEl.style.color = "#999";
      inputEl.style.cursor = "pointer";
      
      // 添加视觉提示
      const parent = inputEl.parentElement;
      if (parent && !parent.querySelector(".recording-hint")) {
        const hint = document.createElement("span");
        hint.className = "recording-hint";
        hint.textContent = "按任意组合键开始录制";
        hint.style.cssText = "font-size: 12px; color: #999; margin-left: 8px;";
        parent.appendChild(hint);
      }
    });
    
    inputEl.addEventListener("keydown", (e) => {
      if (!isRecording) return;
      e.preventDefault();
      e.stopPropagation();
      
      // 清除之前的超时
      if (recordingTimeout !== null) {
        clearTimeout(recordingTimeout);
      }
      
      // 构建快捷键字符串
      const parts: string[] = [];
      
      // 添加修饰键（跨平台兼容）
      if (e.ctrlKey || e.metaKey) {
        parts.push(process.platform === "darwin" ? "Cmd" : "Ctrl");
      }
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      
      // 获取主键
      let key = e.key;
      
      // 处理特殊键
      if (key === " ") key = "Space";
      else if (key.length === 1) key = key.toUpperCase();
      else if (["Escape", "Enter", "Tab", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(key)) {
        // 保留这些特殊键名
      } else {
        return; // 忽略无效键（如 F1-F12、CapsLock 等）
      }
      
      parts.push(key);
      
      // 至少需要一个修饰键 + 一个主键
      if (parts.length < 2) {
        inputEl.value = "需要修饰键（Ctrl/Alt/Shift）+ 主键";
        inputEl.style.color = "#f66";
        return;
      }
      
      const shortcut = parts.join("+");
      
      // 转换为 Electron globalShortcut 格式
      const electronFormat = shortcut
        .replace(/\bCmd\b/gi, "CommandOrControl")
        .replace(/\bCtrl\b/gi, "Control");
      
      inputEl.value = shortcut;
      inputEl.style.color = "#ddd";
      isRecording = false;
      
      // 移除提示
      const hint = inputEl.parentElement?.querySelector(".recording-hint");
      if (hint) hint.remove();
      
      // 自动保存（延迟执行以避免连续按键）
      recordingTimeout = window.setTimeout(async () => {
        try {
          const result = await bridge.saveShortcut(electronFormat);
          currentShortcutValue = result.shortcut;
          setStatus(shortcutStatus, "快捷键已自动保存", "success");
        } catch (error) {
          setStatus(shortcutStatus, message(error), "error");
          inputEl.value = currentShortcutValue || "未设置";
          inputEl.style.color = "#ddd";
        }
      }, 500);
    });
    
    inputEl.addEventListener("blur", () => {
      isRecording = false;
      if (recordingTimeout !== null) {
        clearTimeout(recordingTimeout);
        recordingTimeout = null;
      }
      
      // 移除提示
      const hint = inputEl.parentElement?.querySelector(".recording-hint");
      if (hint) hint.remove();
      
      // 恢复显示
      if (inputEl.value === "按下快捷键..." || inputEl.value === "需要修饰键（Ctrl/Alt/Shift）+ 主键") {
        inputEl.value = currentShortcutValue || "未设置";
      }
      inputEl.style.color = "#ddd";
      inputEl.style.cursor = "default";
    });
    
    // 阻止鼠标事件干扰
    inputEl.addEventListener("mousedown", (e) => {
      if (isRecording) e.preventDefault();
    });
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