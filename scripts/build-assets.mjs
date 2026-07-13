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

const desktopDist = new URL("../apps/desktop-capture/dist/", import.meta.url);
await rm(new URL("preload.js", desktopDist), { force: true });
await rm(new URL("preload.js.map", desktopDist), { force: true });
await cp(new URL("../apps/desktop-capture/src/shell.html", import.meta.url), new URL("shell.html", desktopDist));
await cp(new URL("../apps/desktop-capture/src/styles.css", import.meta.url), new URL("styles.css", desktopDist));
await cp(new URL("../apps/desktop-capture/src/workspace.css", import.meta.url), new URL("workspace.css", desktopDist));
await cp(new URL("../apps/desktop-capture/src/settings.css", import.meta.url), new URL("settings.css", desktopDist));
await cp(new URL("../node_modules/marked/lib/marked.umd.js", import.meta.url), new URL("marked.min.js", desktopDist));
await cp(new URL("../node_modules/dompurify/dist/purify.min.js", import.meta.url), new URL("purify.min.js", desktopDist));
await cp(new URL("../node_modules/easymde/dist/easymde.min.js", import.meta.url), new URL("easymde.min.js", desktopDist));
await cp(new URL("../node_modules/easymde/dist/easymde.min.css", import.meta.url), new URL("easymde.min.css", desktopDist));
await cp(new URL("../apps/desktop-capture/src/fontawesome.min.css", import.meta.url), new URL("fontawesome.min.css", desktopDist));
await cp(new URL("../apps/desktop-capture/src/webfonts", import.meta.url), new URL("webfonts", desktopDist), { recursive: true });
console.log("Static assets built.");