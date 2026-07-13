export function initSettings() {
  const bridge = window.collector?.settings;
  if (!bridge) throw new Error("Collector settings bridge is unavailable");

  const titles = {
    general: ["通用", "控制 Collector 的桌面行为。"],
    ai: ["AI 服务", "管理云模型授权与凭证。"],
    data: ["数据与用量", "查看 AI 成本并管理本地备份与便携导出。"],
  } as const;

  const shortcut = document.querySelector<HTMLInputElement>("#shortcut")!;
  const shortcutStatus = document.querySelector<HTMLElement>("#shortcut-status")!;
  const aiConsent = document.querySelector<HTMLInputElement>("#ai-consent")!;
  const aiStatus = document.querySelector<HTMLElement>("#ai-status")!;
  const providerList = document.querySelector<HTMLElement>("#provider-list")!;
  const profileId = document.querySelector<HTMLInputElement>("#provider-profile-id")!;
  const providerId = document.querySelector<HTMLSelectElement>("#provider-id")!;
  const providerDisplayName = document.querySelector<HTMLInputElement>("#provider-display-name")!;
  const providerBaseUrlField = document.querySelector<HTMLElement>("#provider-base-url-field")!;
  const providerBaseUrl = document.querySelector<HTMLInputElement>("#provider-base-url")!;
  const providerModel = document.querySelector<HTMLInputElement>("#provider-model")!;
  const providerModelOptions = document.querySelector<HTMLDataListElement>("#provider-model-options")!;
  const providerApiKey = document.querySelector<HTMLInputElement>("#provider-api-key")!;
  const providerEditorTitle = document.querySelector<HTMLElement>("#provider-editor-title")!;
  const saveProvider = document.querySelector<HTMLButtonElement>("#save-provider")!;
  const testProvider = document.querySelector<HTMLButtonElement>("#test-provider")!;
  const resetProvider = document.querySelector<HTMLButtonElement>("#reset-provider")!;
  const toggleEye = document.querySelector<HTMLButtonElement>("#toggle-key-vis")!;
  let catalog: import("@collector/capture-contracts").ProviderDefinition[] = [];
  let profiles: import("@collector/capture-contracts").ProviderProfile[] = [];
  let activeProviderProfileId: string | undefined;
  let apiKeyModified = false;

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
    const isPassword = providerApiKey.type === "password";
    providerApiKey.type = isPassword ? "text" : "password";
    toggleEye.classList.toggle("showing", !isPassword);
  });

  providerId.addEventListener("change", () => applyProviderDefinition(true));
  providerApiKey.addEventListener("input", () => { apiKeyModified = true; });
  resetProvider.addEventListener("click", () => resetProviderEditor());
  aiConsent.addEventListener("change", async () => {
    try {
      const ai = await bridge.setAiConsent(aiConsent.checked);
      renderAiStatus(ai);
    } catch (error) { aiConsent.checked = !aiConsent.checked; setStatus(aiStatus, message(error), "error"); }
  });

  testProvider.addEventListener("click", async () => {
    testProvider.disabled = true;
    try {
      const result = await bridge.testProvider({ profile: providerInput(), apiKey: apiKeyModified ? providerApiKey.value.trim() : undefined });
      setStatus(aiStatus, result.ok ? `连接成功 · ${result.model}` : result.error, result.ok ? "success" : "error");
    } catch (error) { setStatus(aiStatus, message(error), "error"); }
    finally { testProvider.disabled = false; }
  });

  saveProvider.addEventListener("click", async () => {
    saveProvider.disabled = true;
    try {
      const result = await bridge.saveProvider({
        profile: providerInput(),
        apiKey: apiKeyModified ? providerApiKey.value.trim() : undefined,
        consent: aiConsent.checked,
        activate: true,
      });
      providerApiKey.value = "";
      providerApiKey.type = "password";
      providerApiKey.placeholder = result.profile.credentialConfigured ? "Key 已保存 · 输入新 Key 以更换" : "输入 API Key";
      apiKeyModified = false;
      setStatus(aiStatus, `${result.profile.displayName} 已保存并启用`, "success");
      await load();
    } catch (error) { setStatus(aiStatus, message(error), "error"); }
    finally { saveProvider.disabled = false; }
  });

  function providerInput(): import("@collector/capture-contracts").ProviderProfileInput {
    return {
      id: profileId.value || undefined,
      providerId: providerId.value,
      displayName: providerDisplayName.value.trim(),
      baseUrl: providerBaseUrl.value.trim() || undefined,
      model: providerModel.value.trim(),
      enabled: true,
    };
  }

  function applyProviderDefinition(resetValues: boolean): void {
    const definition = catalog.find((candidate) => candidate.id === providerId.value);
    if (!definition) return;
    providerBaseUrlField.hidden = !definition.id.startsWith("custom");
    providerModelOptions.replaceChildren(...definition.models.map((model) => {
      const option = document.createElement("option"); option.value = model; return option;
    }));
    if (resetValues) {
      providerDisplayName.value = definition.label;
      const isCustom = definition.id.startsWith("custom");
      providerBaseUrl.value = isCustom ? "" : definition.defaultBaseUrl;
      providerModel.value = isCustom ? "" : definition.defaultModel;
    }
  }

  function resetProviderEditor(): void {
    profileId.value = "";
    providerId.disabled = false;
    providerEditorTitle.textContent = "添加供应商";
    providerApiKey.value = "";
    providerApiKey.placeholder = "输入 API Key";
    providerApiKey.type = "password";
    apiKeyModified = false;
    if (catalog[0]) { providerId.value = catalog[0].id; applyProviderDefinition(true); }
  }

  function editProvider(profile: import("@collector/capture-contracts").ProviderProfile): void {
    profileId.value = profile.id;
    providerId.value = profile.providerId;
    providerId.disabled = true;
    providerEditorTitle.textContent = `编辑 ${profile.displayName}`;
    providerDisplayName.value = profile.displayName;
    providerBaseUrl.value = profile.baseUrl;
    providerModel.value = profile.model;
    providerApiKey.value = "";
    providerApiKey.placeholder = profile.credentialConfigured ? "Key 已保存 · 输入新 Key 以更换" : "输入 API Key";
    providerApiKey.type = "password";
    apiKeyModified = false;
    applyProviderDefinition(false);
  }

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

  const usageSummary = document.querySelector<HTMLElement>("#ai-usage-summary");
  const usageBreakdown = document.querySelector<HTMLElement>("#ai-usage-breakdown");
  const budgetEnabled = document.querySelector<HTMLInputElement>("#ai-budget-enabled");
  const budgetLimit = document.querySelector<HTMLInputElement>("#ai-budget-limit");
  const budgetWarning = document.querySelector<HTMLInputElement>("#ai-budget-warning");
  const saveBudget = document.querySelector<HTMLButtonElement>("#save-ai-budget");
  const budgetStatus = document.querySelector<HTMLElement>("#ai-budget-status");
  const dataPaths = document.querySelector<HTMLElement>("#data-paths");
  const createBackup = document.querySelector<HTMLButtonElement>("#create-backup");
  const exportPortable = document.querySelector<HTMLButtonElement>("#export-portable");
  const dataStatus = document.querySelector<HTMLElement>("#data-control-status");
  const backupHistory = document.querySelector<HTMLElement>("#backup-history");

  saveBudget?.addEventListener("click", async () => {
    if (!budgetEnabled || !budgetLimit || !budgetWarning || !budgetStatus) return;
    saveBudget.disabled = true;
    try {
      const limit = Number(budgetLimit.value || 0);
      const warning = Number(budgetWarning.value || 0);
      if (limit < 0 || warning < 0 || (limit > 0 && warning > limit)) throw new Error("提醒阈值不能超过月度上限");
      await bridge.saveAiBudget({ enabled: budgetEnabled.checked, monthlyLimitUsd: limit, warningThresholdUsd: warning });
      setStatus(budgetStatus, "预算已保存", "success");
      await loadDataControl();
    } catch (error) { setStatus(budgetStatus, message(error), "error"); }
    finally { saveBudget.disabled = false; }
  });

  createBackup?.addEventListener("click", async () => {
    if (!dataStatus) return;
    createBackup.disabled = true;
    try {
      const result = await bridge.createBackup();
      setStatus(dataStatus, `备份完成：${result.path}`, "success");
      await loadDataControl();
    } catch (error) { setStatus(dataStatus, message(error), "error"); }
    finally { createBackup.disabled = false; }
  });

  exportPortable?.addEventListener("click", async () => {
    if (!dataStatus) return;
    exportPortable.disabled = true;
    try {
      const result = await bridge.exportPortable({ includeArtifacts: true, format: "both" });
      setStatus(dataStatus, `导出完成：${result.path}`, "success");
    } catch (error) { setStatus(dataStatus, message(error), "error"); }
    finally { exportPortable.disabled = false; }
  });

  void load();

  async function load() {
    try {
      const value = await bridge.get();
      currentShortcutValue = value.shortcut;
      shortcut.value = value.shortcut;
      aiConsent.checked = value.ai.consent;
      catalog = value.providerCatalog;
      profiles = value.providerProfiles;
      activeProviderProfileId = value.activeProviderProfileId;
      providerId.replaceChildren(...catalog.map((definition) => {
        const option = document.createElement("option"); option.value = definition.id; option.textContent = definition.label; return option;
      }));
      renderProviderProfiles();
      const selected = profiles.find((profile) => profile.id === activeProviderProfileId) ?? profiles[0];
      if (selected) editProvider(selected); else resetProviderEditor();
      if (value.ai.unavailable) { saveProvider.disabled = true; testProvider.disabled = true; setStatus(aiStatus, "当前连接外部 API，供应商设置只能在服务宿主中修改", "error"); }
      else {
        renderAiStatus(value.ai);
      }
      await loadDataControl();
    } catch (error) { setStatus(aiStatus, message(error), "error"); }
  }

  function renderProviderProfiles(): void {
    providerList.replaceChildren();
    if (!profiles.length) {
      const empty = document.createElement("p"); empty.className = "help-text"; empty.textContent = "尚未配置供应商。"; providerList.append(empty); return;
    }
    for (const profile of profiles) {
      const row = document.createElement("div"); row.className = "provider-row";
      if (profile.id === activeProviderProfileId) row.classList.add("provider-active");
      const summary = document.createElement("div");
      const title = document.createElement("strong"); title.textContent = profile.displayName;
      const meta = document.createElement("small"); meta.textContent = `${profile.providerId} · ${profile.model} · ${profile.credentialConfigured ? "Key 已配置" : "缺少 Key"}`;
      summary.append(title, meta);
      const actions = document.createElement("div"); actions.className = "provider-actions";
      const edit = document.createElement("button"); edit.type = "button"; edit.className = "button"; edit.textContent = "编辑"; edit.addEventListener("click", () => editProvider(profile)); actions.append(edit);
      if (profile.id === activeProviderProfileId) {
        const active = document.createElement("span"); active.className = "provider-active-badge"; active.textContent = "当前"; actions.append(active);
      } else {
        const activate = document.createElement("button"); activate.type = "button"; activate.className = "button"; activate.textContent = "启用";
        activate.addEventListener("click", async () => { try { await bridge.activateProvider(profile.id); await load(); } catch (error) { setStatus(aiStatus, message(error), "error"); } }); actions.append(activate);
      }
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "button danger"; remove.textContent = "删除";
      remove.addEventListener("click", async () => { if (!window.confirm(`删除供应商配置“${profile.displayName}”？`)) return; try { await bridge.deleteProvider(profile.id); await load(); } catch (error) { setStatus(aiStatus, message(error), "error"); } }); actions.append(remove);
      row.append(summary, actions); providerList.append(row);
    }
  }

  async function loadDataControl(): Promise<void> {
    if (!usageSummary || !usageBreakdown || !budgetEnabled || !budgetLimit || !budgetWarning || !dataPaths || !backupHistory) return;
    try {
      const value = await bridge.dataControl();
      usageSummary.textContent = `${value.usage.totalCalls} 次调用 · ${value.usage.totalInputTokens + value.usage.totalOutputTokens} tokens · $${value.usage.totalCostUsd.toFixed(4)}${value.usage.unknownCostCalls ? ` · ${value.usage.unknownCostCalls} 次费用未知` : ""} · 成功率 ${(value.usage.successRate * 100).toFixed(1)}%`;
      usageBreakdown.replaceChildren();
      for (const [model, stats] of Object.entries(value.usage.byProviderModel)) {
        const row = document.createElement("p");
        row.textContent = `${model}: ${stats.calls} 次 / ${stats.tokens} tokens / $${stats.costUsd.toFixed(4)}${stats.unknownCostCalls ? ` / ${stats.unknownCostCalls} 次费用未知` : ""}`;
        usageBreakdown.append(row);
      }
      budgetEnabled.checked = value.budget.enabled;
      budgetLimit.value = String(value.budget.monthlyLimitUsd);
      budgetWarning.value = String(value.budget.warningThresholdUsd);
      if (budgetStatus) setStatus(budgetStatus, `本月 $${value.budget.currentMonthCostUsd.toFixed(4)} · ${value.budget.status}`, value.budget.status === "exceeded" || value.budget.status === "unknown" ? "error" : value.budget.status === "warning" ? "warning" : "ready");
      dataPaths.textContent = value.paths ? `数据库：${value.paths.database} · 附件：${value.paths.artifacts}` : "数据位置由外部 API 宿主管理";
      backupHistory.replaceChildren();
      for (const backup of value.backups) {
        const row = document.createElement("div");
        row.className = "backup-row";
        const label = document.createElement("span");
        label.textContent = `${new Date(backup.createdAt).toLocaleString()} · ${(backup.sizeBytes / 1024 / 1024).toFixed(2)} MB · ${backup.status}`;
        row.append(label);
        if (backup.status === "completed") {
          const verify = document.createElement("button");
          verify.className = "button";
          verify.type = "button";
          verify.textContent = "校验";
          verify.addEventListener("click", async () => {
            if (!dataStatus) return;
            const result = await bridge.verifyBackup(backup.id);
            setStatus(dataStatus, result.valid ? "备份校验通过" : `备份校验失败：${result.errors.join("；")}`, result.valid ? "success" : "error");
          });
          row.append(verify);
        }
        backupHistory.append(row);
      }
    } catch (error) {
      if (dataStatus) setStatus(dataStatus, message(error), "error");
    }
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
        parts.push(/Mac|iPhone|iPad/.test(navigator.platform) ? "Cmd" : "Ctrl");
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
    if (id === "data") void loadDataControl();
  }
  function renderAiStatus(value: { consent: boolean; configured: boolean; provider?: string; model?: string }) {
    const text = value.consent && value.configured ? `${value.provider ?? "外部供应商"} / ${value.model ?? "默认模型"} 已配置并授权` : value.configured ? "Key 已保存，云端处理未授权" : "尚未配置外部供应商 API Key";
    setStatus(aiStatus, text, value.configured ? "success" : "ready");
  }
  function setStatus(node: HTMLElement, text: string, kind: string) { node.textContent = text; node.dataset.kind = kind; }
  function message(error: unknown) { return error instanceof Error ? error.message : "保存失败"; }

}
