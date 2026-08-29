import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const PREVIEW_MANIFEST_FILE = "preview-manifest.json";
export const PREVIEW_MANIFEST_KIND = "collector-branch-data-preview";
export const PREVIEW_MANIFEST_VERSION = 1;

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function comparablePath(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInside(path, root) {
  const result = relative(resolve(root), resolve(path));
  return result === "" || (!result.startsWith("..") && !isAbsolute(result));
}

async function readOwnedManifest(targetDataRoot) {
  const path = join(targetDataRoot, PREVIEW_MANIFEST_FILE);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Refusing to reuse or refresh an unowned preview directory: ${targetDataRoot}`);
  }
  if (manifest?.kind !== PREVIEW_MANIFEST_KIND || manifest?.version !== PREVIEW_MANIFEST_VERSION) {
    throw new Error(`Refusing to reuse or refresh an unowned preview directory: ${targetDataRoot}`);
  }
  return manifest;
}

async function assertOrdinaryDirectory(path, label) {
  if (!(await exists(path))) return;
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} must be an ordinary local directory, not a file, symbolic link, or junction: ${path}`);
  }
}

async function copyPlainDirectory(source, target) {
  const result = { fileCount: 0, totalBytes: 0 };
  if (!(await exists(source))) return result;
  await mkdir(target, { recursive: true });
  const pending = [[source, target]];
  while (pending.length > 0) {
    const [currentSource, currentTarget] = pending.pop();
    for (const entry of await readdir(currentSource, { withFileTypes: true })) {
      const sourcePath = join(currentSource, entry.name);
      const targetPath = join(currentTarget, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Preview data refuses symbolic links and junctions: ${sourcePath}`);
      }
      if (entry.isDirectory()) {
        await mkdir(targetPath);
        pending.push([sourcePath, targetPath]);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Preview data refuses non-file artifacts: ${sourcePath}`);
      const details = await stat(sourcePath);
      await copyFile(sourcePath, targetPath);
      result.fileCount += 1;
      result.totalBytes += details.size;
    }
  }
  return result;
}

function tableNames(database) {
  return new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
}

function sanitizePreviewDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;");
    try {
      const tables = tableNames(database);
      if (tables.has("provider_credentials")) database.exec("DELETE FROM provider_credentials");
      if (tables.has("paired_clients")) database.exec("DELETE FROM paired_clients");
      if (tables.has("settings")) {
        database.prepare("DELETE FROM settings WHERE key = ?").run("search_tavily_api_key");
        const saveSetting = database.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
        saveSetting.run("research_fusion_auto", "false");
        saveSetting.run("ai_consent", "false");
        saveSetting.run("ai_configured", "false");
      }
      if (tables.has("provider_profiles")) {
        const update = database.prepare("UPDATE provider_profiles SET record_json = ? WHERE id = ?");
        for (const row of database.prepare("SELECT id, record_json FROM provider_profiles").all()) {
          const profile = JSON.parse(row.record_json);
          update.run(JSON.stringify({ ...profile, credentialConfigured: false }), row.id);
        }
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return tableNames(database).has("schema_migrations")
      ? Number(database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version)
      : 0;
  } finally {
    database.close();
  }
}

async function buildSnapshotStage(sourceDataRoot, stageRoot, metadata) {
  const sourceDatabasePath = join(sourceDataRoot, "collector.sqlite");
  const targetDatabasePath = join(stageRoot, "collector.sqlite");
  const sourceDatabase = new DatabaseSync(sourceDatabasePath, { readOnly: true });
  let databasePages;
  try {
    databasePages = await backup(sourceDatabase, targetDatabasePath);
  } finally {
    sourceDatabase.close();
  }

  const artifacts = await copyPlainDirectory(join(sourceDataRoot, "artifacts"), join(stageRoot, "artifacts"));
  const schemaVersion = sanitizePreviewDatabase(targetDatabasePath);
  const sourceDatabaseStat = await stat(sourceDatabasePath);
  const manifest = {
    kind: PREVIEW_MANIFEST_KIND,
    version: PREVIEW_MANIFEST_VERSION,
    createdAt: metadata.createdAt,
    sourceDataRoot,
    sourceRevision: metadata.sourceRevision ?? null,
    schemaVersion,
    databaseBytes: sourceDatabaseStat.size,
    databasePages,
    artifacts,
    safety: {
      credentialsRemoved: true,
      pairingRemoved: true,
      automaticFusionDisabled: true,
      runtimeStateCopied: false,
      modelCachesCopied: false,
    },
  };
  await writeFile(join(stageRoot, PREVIEW_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export async function createPreviewSnapshot({
  sourceDataRoot,
  targetDataRoot,
  workspaceRoot,
  sourceRevision,
  refresh = false,
  now = () => new Date(),
}) {
  const sourceRoot = resolve(sourceDataRoot);
  const targetRoot = resolve(targetDataRoot);
  const workspace = resolve(workspaceRoot);
  const allowedTarget = resolve(workspace, ".collector-data", "preview");
  if (comparablePath(targetRoot) !== comparablePath(allowedTarget)) {
    throw new Error(`Preview target must be the current worktree's isolated directory: ${allowedTarget}`);
  }
  if (!isInside(targetRoot, workspace) || comparablePath(sourceRoot) === comparablePath(targetRoot)) {
    throw new Error("Preview source and target must be distinct, and the target must stay inside the current worktree");
  }
  const sourceDatabasePath = join(sourceRoot, "collector.sqlite");
  const sourceDetails = await stat(sourceDatabasePath).catch(() => undefined);
  if (!sourceDetails?.isFile()) throw new Error(`Collector source database not found: ${sourceDatabasePath}`);

  const targetParent = dirname(targetRoot);
  await assertOrdinaryDirectory(targetParent, "Preview parent");
  await assertOrdinaryDirectory(targetRoot, "Preview target");
  if (await exists(targetRoot)) {
    const manifest = await readOwnedManifest(targetRoot);
    const targetDatabaseDetails = await stat(join(targetRoot, "collector.sqlite")).catch(() => undefined);
    if (!targetDatabaseDetails?.isFile()) throw new Error(`Owned preview database is missing: ${targetRoot}`);
    if (!refresh) return { created: false, targetDataRoot: targetRoot, manifest };
  }

  const parent = targetParent;
  await mkdir(parent, { recursive: true });
  const stageRoot = await mkdtemp(join(parent, "preview-stage-"));
  let stageExists = true;
  try {
    const manifest = await buildSnapshotStage(sourceRoot, stageRoot, {
      createdAt: now().toISOString(),
      sourceRevision,
    });
    if (!(await exists(targetRoot))) {
      await rename(stageRoot, targetRoot);
      stageExists = false;
      return { created: true, targetDataRoot: targetRoot, manifest };
    }

    await readOwnedManifest(targetRoot);
    const previousRoot = join(parent, `preview-previous-${randomUUID()}`);
    await rename(targetRoot, previousRoot);
    try {
      await rename(stageRoot, targetRoot);
      stageExists = false;
    } catch (error) {
      await rename(previousRoot, targetRoot).catch(() => undefined);
      throw error;
    }
    await rm(previousRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return { created: true, targetDataRoot: targetRoot, manifest };
  } finally {
    if (stageExists) await rm(stageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
}

function runGit(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const worktreeRoot = resolve(runGit(["rev-parse", "--show-toplevel"], scriptRoot));
  const commonGitDir = resolve(runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], scriptRoot));
  const mainWorkspaceRoot = dirname(commonGitDir);
  if (comparablePath(worktreeRoot) === comparablePath(mainWorkspaceRoot)) {
    throw new Error("Branch preview must run from an isolated worktree, not the main workspace");
  }
  const sourceDataRoot = resolve(
    argumentValue(args, "--source-data")
      ?? process.env.COLLECTOR_MAIN_DATA_DIR?.trim()
      ?? join(mainWorkspaceRoot, ".collector-data"),
  );
  const targetDataRoot = join(worktreeRoot, ".collector-data", "preview");
  const sourceRevision = runGit(["rev-parse", "master"], scriptRoot);
  const result = await createPreviewSnapshot({
    sourceDataRoot,
    targetDataRoot,
    workspaceRoot: worktreeRoot,
    sourceRevision,
    refresh: args.includes("--refresh"),
  });
  process.stdout.write(`${result.created ? "Created" : "Reused"} isolated Collector preview data at ${result.targetDataRoot}\n`);
  process.stdout.write(`Snapshot: schema v${result.manifest.schemaVersion}, ${result.manifest.artifacts.fileCount} artifact file(s), credentials removed, automatic model work disabled.\n`);
  if (args.includes("--snapshot-only")) return;

  process.env.COLLECTOR_DATA_DIR = targetDataRoot;
  process.env.COLLECTOR_PREVIEW_MODE = "1";
  process.env.COLLECTOR_PORT = "0";
  if (args.includes("--no-open-browser")) process.env.COLLECTOR_NO_BROWSER = "1";
  await import("../apps/api/dist/launcher-main.js");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
