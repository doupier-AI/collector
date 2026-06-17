import { initCapture } from "./renderer.js";
import { initWorkspace } from "./workspace-renderer.js";
import { initSettings } from "./settings-renderer.js";

type Tab = "capture" | "recent" | "topics" | "materials" | "settings";

let activeTab: Tab = "capture";
let previousTab: Tab = "capture";
let recentInitialized = false;
let topicsInitialized = false;
let materialsInitialized = false;
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

  if (tab === "recent" && !recentInitialized) {
    recentInitialized = true;
    const root = document.querySelector<HTMLElement>("#section-recent")!;
    initWorkspace(root, "recent");
  }
  if (tab === "topics" && !topicsInitialized) {
    topicsInitialized = true;
    const root = document.querySelector<HTMLElement>("#section-topics")!;
    initWorkspace(root, "topics");
  }
  if (tab === "materials" && !materialsInitialized) {
    materialsInitialized = true;
    const root = document.querySelector<HTMLElement>("#section-materials")!;
    initWorkspace(root, "materials");
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
  if (!compactMode) {
    previousTab = activeTab;
  }
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
  if (previousTab !== "capture") {
    switchTab(previousTab);
  }
}

(window as unknown as Record<string, unknown>).collectorShell = { navigateTo, enterCompactMode, exitCompactMode };

document.querySelectorAll(".nav-tab").forEach((tab) => {
  tab.addEventListener("click", () => navigateTo((tab as HTMLElement).dataset.tab as Tab));
});

initCapture();

export {};
