// PROTOTYPE ONLY: launches the isolated single-window shell study.
import { app, BrowserWindow } from "electron";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

app.setPath("userData", join(tmpdir(), "collector-single-shell-prototype"));

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1320,
    height: 850,
    minWidth: 980,
    minHeight: 680,
    title: "Collector Single Shell Prototype",
    backgroundColor: "#0b0d10",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadFile(resolve("apps/desktop-capture/prototypes/single-shell.html"));
});

app.on("window-all-closed", () => app.quit());
