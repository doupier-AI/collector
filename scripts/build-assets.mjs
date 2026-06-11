import { cp, mkdir, rm } from "node:fs/promises";

const extensionBuild = new URL("../apps/browser-extension/build/", import.meta.url);
await rm(extensionBuild, { recursive: true, force: true });
await mkdir(extensionBuild, { recursive: true });
await cp(new URL("../apps/browser-extension/manifest.json", import.meta.url), new URL("manifest.json", extensionBuild));
await cp(new URL("../apps/browser-extension/icon.svg", import.meta.url), new URL("icon.svg", extensionBuild));
await cp(new URL("../apps/browser-extension/dist/background.js", import.meta.url), new URL("background.js", extensionBuild));
await cp(new URL("../apps/browser-extension/dist/content.js", import.meta.url), new URL("content.js", extensionBuild));

const desktopDist = new URL("../apps/desktop-capture/dist/", import.meta.url);
await rm(new URL("preload.js", desktopDist), { force: true });
await rm(new URL("preload.js.map", desktopDist), { force: true });
await cp(new URL("../apps/desktop-capture/src/index.html", import.meta.url), new URL("index.html", desktopDist));
await cp(new URL("../apps/desktop-capture/src/styles.css", import.meta.url), new URL("styles.css", desktopDist));
console.log("Static assets built.");
