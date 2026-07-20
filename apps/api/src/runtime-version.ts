import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

const RUNTIME_VERSION_PREFIX = "collector-runtime-v1";
const RUNTIME_VERSION_PATTERN = /^collector-runtime-v1-[a-f0-9]{64}$/;

export async function calculateRuntimeVersion(apiRoot: string, webRoot: string): Promise<string> {
  const workspaceRoot = resolve(apiRoot, "../../..");
  const roots = [
    resolve(apiRoot),
    resolve(webRoot),
    resolve(workspaceRoot, "packages/capture-contracts/dist"),
    resolve(workspaceRoot, "packages/model-gateway/dist"),
    resolve(workspaceRoot, "package-lock.json"),
  ];
  const files = (
    await Promise.all(roots.map((root) => listRuntimeFiles(root)))
  ).flat().sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  hash.update(`${RUNTIME_VERSION_PREFIX}\0`);
  for (const file of files) {
    const rootIndex = roots.findIndex((root) => file === root || file.startsWith(`${root}\\`) || file.startsWith(`${root}/`));
    if (rootIndex < 0) continue;
    const root = roots[rootIndex]!;
    const rootStat = await stat(root);
    const name = rootStat.isFile() ? basename(root) : relative(root, file).replaceAll("\\", "/");
    hash.update(`${rootIndex}:${name}\0`);
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return `${RUNTIME_VERSION_PREFIX}-${hash.digest("hex")}`;
}

export function isRuntimeVersion(value: string): boolean {
  return RUNTIME_VERSION_PATTERN.test(value);
}

async function listRuntimeFiles(root: string): Promise<string[]> {
  const rootStat = await stat(root);
  if (rootStat.isFile()) return [root];
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listRuntimeFiles(path));
    } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".html") || entry.name.endsWith(".css"))) {
      files.push(path);
    }
  }
  return files;
}
