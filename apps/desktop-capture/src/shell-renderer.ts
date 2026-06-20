import { initCapture } from "./renderer.js";
import { initWorkspace, invalidateWorkspace, checkRecentAIConfig } from "./workspace-renderer.js";
import { initSettings } from "./settings-renderer.js";

type Tab = "capture" | "recent" | "topics" | "materials" | "trash" | "settings";

// ── Application Shell State ──────────────────────────────

const shell = {
  activeTab: "capture" as Tab,
  previousTab: "capture" as Tab,
  compactMode: false,
  initialized: {} as Record<string, boolean>,
};

function switchTab(tab: Tab) {
  shell.activeTab = tab;
  document.querySelectorAll(".nav-tab").forEach((el) => el.classList.toggle("active", (el as HTMLElement).dataset.tab === tab));
  document.querySelectorAll(".shell-section").forEach((el) => el.classList.toggle("active", el.id === `section-${tab}`));

  if (!shell.initialized[tab]) {
    shell.initialized[tab] = true;
    if (tab === "recent" || tab === "topics" || tab === "materials" || tab === "trash") {
      const root = document.querySelector<HTMLElement>(`#section-${tab}`)!;
      initWorkspace(root, tab);
    } else if (tab === "settings") {
      initSettings();
    }
  } else if (tab === "recent") {
    // 每次切换回近期 tab 时重新检查 AI 配置（解决配置变更后警告不消失的问题）
    const root = document.querySelector<HTMLElement>(`#section-${tab}`)!;
    void checkRecentAIConfig(root);
  }
  if (tab === "capture") {
    document.querySelector<HTMLTextAreaElement>("#content")?.focus();
  }
}

function enterCompactMode() {
  if (!shell.compactMode) {
    shell.previousTab = shell.activeTab;
  }
  shell.compactMode = true;
  document.body.classList.add("compact");
  document.getElementById("shell-nav")!.style.display = "none";
  switchTab("capture");
  document.querySelector<HTMLTextAreaElement>("#content")?.focus();
}

function exitCompactMode() {
  shell.compactMode = false;
  document.body.classList.remove("compact");
  document.getElementById("shell-nav")!.style.display = "";
  if (shell.previousTab !== "capture") {
    switchTab(shell.previousTab);
  }
}

// Wire the compact-mode IPC from main process
window.collector?.capture.onModeChange((mode) => {
  if (mode === "compact" && !shell.compactMode) enterCompactMode();
  else if (mode === "normal" && shell.compactMode) exitCompactMode();
});

// Wire shell:navigate IPC (used by workspace buttons like viewUnclustered)
window.collector?.capture.onNavigate((tab) => {
  navigateTo(tab as Tab);
});

function navigateTo(tab: Tab) {
  if (shell.compactMode && tab !== "capture") {
    exitCompactMode();
  }
  switchTab(tab);
}

(window as unknown as Record<string, unknown>).collectorShell = { navigateTo, enterCompactMode, exitCompactMode };

document.querySelectorAll(".nav-tab").forEach((tab) => {
  tab.addEventListener("click", () => navigateTo((tab as HTMLElement).dataset.tab as Tab));
});

initCapture();

const dataTabs = ["recent", "topics", "materials", "trash"] as const;
window.collector?.capture.onDataCleared(() => {
  invalidateWorkspace();
  for (const tab of dataTabs) shell.initialized[tab] = false;
  if (dataTabs.includes(shell.activeTab as typeof dataTabs[number])) {
    shell.initialized[shell.activeTab] = true;
    const root = document.querySelector<HTMLElement>(`#section-${shell.activeTab}`)!;
    initWorkspace(root, shell.activeTab as typeof dataTabs[number]);
  }
});

export {};
