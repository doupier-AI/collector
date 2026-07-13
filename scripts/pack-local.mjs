import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const release = join(root, "release", "Collector-win32-x64");

rmSync(release, { recursive: true, force: true });
mkdirSync(release, { recursive: true });

const electronDist = join(root, "node_modules", "electron", "dist");
if (!existsSync(electronDist)) throw new Error("Electron not found. Run npm install first.");

console.log("Copying Electron runtime...");
copyRecursive(electronDist, release);

const appDir = join(release, "resources", "app");
mkdirSync(appDir, { recursive: true });

const items = [
  { src: "package.json", isFile: true },
  { src: "apps/api/dist" },
  { src: "apps/desktop-capture/dist" },
  { src: "packages/capture-contracts/dist" },
  { src: "packages/capture-client/dist" },
  { src: "packages/model-gateway/dist" },
];

for (const item of items) {
  const s = join(root, item.src);
  const d = join(appDir, item.src);
  if (!existsSync(s)) { console.log("  SKIP:", item.src); continue; }
  mkdirSync(dirname(d), { recursive: true });
  if (item.isFile) copyFileSync(s, d);
  else copyRecursive(s, d);
  console.log("  OK:", item.src);
}

console.log("Copying node_modules...");
const dstMod = join(appDir, "node_modules");
mkdirSync(dstMod, { recursive: true });
const skip = new Set(["electron", "@electron", "electron-builder", "typescript", "@types"]);
const nodeMods = join(root, "node_modules");
for (const entry of readdirSync(nodeMods)) {
  if (skip.has(entry)) continue;
  const s = join(nodeMods, entry);
  if (!statSync(s).isDirectory()) continue;
  copyRecursive(s, join(dstMod, entry));
}

const exe = "Collector.exe";
renameSync(join(release, "electron.exe"), join(release, exe));
console.log("\nPacked:", release);
console.log("Launch:", join(release, exe));

function copyRecursive(src, dst) {
  const stat = statSync(src);
  if (stat.isFile()) { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(src, dst); return; }
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) copyRecursive(join(src, entry), join(dst, entry));
}
