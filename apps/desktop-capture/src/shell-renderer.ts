import { initCapture } from "./renderer.js";
// TODO: workspace-renderer to be rewritten by Gemini
import { initSettings } from "./settings-renderer.js";

type Tab = "capture" | "workspace" | "settings";

let activeTab: Tab = "capture";
let workspaceInitialized = false;
let settingsInitialized = false;
let compactMode = false;

function navigateTo(tab: Tab) {
  if (compactMode && tab !== "capture") {
    exitCompactMode();
  }
  switchTab(tab);
}

function switchTab(tab: Tab) {
  activeTab = tab;
  document.querySelectorAll(".nav-tab").forEach((el) => el.classList.toggle("active", (el as HTMLElement).dataset.tab === tab));
  document.querySelectorAll(".shell-section").forEach((el) => el.classList.toggle("active", el.id === `section-${tab}`));

  if (tab === "workspace" && !workspaceInitialized) {
    workspaceInitialized = true;
    const root = document.querySelector<HTMLElement>("#section-workspace")!;
    // initWorkspace(root); // TODO: re-enable after Gemini UI rewrite
  }
  if (tab === "settings" && !settingsInitialized) {
    settingsInitialized = true;
    initSettings();
  }
  if (tab === "capture") {
    document.querySelector<HTMLTextAreaElement>("#content")?.focus();
  }
}

function enterCompactMode() {
  compactMode = true;
  document.body.classList.add("compact");
  document.getElementById("shell-nav")!.style.display = "none";
  switchTab("capture");
  document.querySelector<HTMLTextAreaElement>("#content")?.focus();
}

function exitCompactMode() {
  compactMode = false;
  document.body.classList.remove("compact");
  document.getElementById("shell-nav")!.style.display = "";
}

(window as unknown as Record<string, unknown>).collectorShell = { navigateTo };

document.querySelectorAll(".nav-tab").forEach((tab) => {
  tab.addEventListener("click", () => navigateTo((tab as HTMLElement).dataset.tab as Tab));
});

initCapture();

export {};