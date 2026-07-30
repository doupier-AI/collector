import { cp, mkdir, rm } from "node:fs/promises";

const extensionBuild = new URL("../apps/browser-extension/build/", import.meta.url);
await rm(extensionBuild, { recursive: true, force: true });
await mkdir(extensionBuild, { recursive: true });
await cp(new URL("../apps/browser-extension/manifest.json", import.meta.url), new URL("manifest.json", extensionBuild));
await cp(new URL("../apps/browser-extension/icon.svg", import.meta.url), new URL("icon.svg", extensionBuild));
await cp(new URL("../apps/browser-extension/dist/background.js", import.meta.url), new URL("background.js", extensionBuild));
await cp(new URL("../apps/browser-extension/dist/content.js", import.meta.url), new URL("content.js", extensionBuild));
await cp(new URL("../apps/browser-extension/dist/popup.js", import.meta.url), new URL("popup.js", extensionBuild));
await cp(new URL("../apps/browser-extension/popup.html", import.meta.url), new URL("popup.html", extensionBuild));
console.log("Browser extension assets built.");
