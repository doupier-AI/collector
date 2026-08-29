import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createPreviewSnapshot, PREVIEW_MANIFEST_FILE } from "./preview-data.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "collector-preview-data-"));
  const source = join(root, "main-data");
  const workspace = join(root, "task-worktree");
  const target = join(workspace, ".collector-data", "preview");
  await mkdir(join(source, "artifacts", "research-imports"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  const database = new DatabaseSync(join(source, "collector.sqlite"));
  database.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (45, '2026-08-29T00:00:00.000Z');
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('research_fusion_auto', 'true');
    INSERT INTO settings VALUES ('ai_consent', 'true');
    INSERT INTO settings VALUES ('ai_configured', 'true');
    INSERT INTO settings VALUES ('search_tavily_api_key', 'secret-search-key');
    CREATE TABLE provider_credentials(id TEXT PRIMARY KEY, api_key TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO provider_credentials VALUES ('profile-1', 'secret-model-key', '2026-08-29T00:00:00.000Z');
    CREATE TABLE provider_profiles(id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, enabled INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, record_json TEXT NOT NULL);
    CREATE TABLE paired_clients(id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO paired_clients VALUES ('client-1', 'main browser', 'secret-hash', '2026-08-29T00:00:00.000Z');
    CREATE TABLE research_sessions(id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
    INSERT INTO research_sessions VALUES ('session-1', '{"id":"session-1"}');
  `);
  database.prepare("INSERT INTO provider_profiles VALUES (?, ?, ?, ?, ?, ?)").run(
    "profile-1",
    "deepseek",
    1,
    "2026-08-29T00:00:00.000Z",
    "2026-08-29T00:00:00.000Z",
    JSON.stringify({ id: "profile-1", providerId: "deepseek", credentialConfigured: true, enabled: true }),
  );
  database.close();
  await writeFile(join(source, "artifacts", "research-imports", "document.txt"), "正式资料\n");
  await writeFile(join(source, "instance-control.token"), "must-not-copy\n");
  await writeFile(join(source, "service.lock"), "must-not-copy\n");
  return { root, source, workspace, target };
}

test("creates an isolated snapshot without credentials, pairing, runtime state, or automatic fusion", async (t) => {
  const { root, source, workspace, target } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const result = await createPreviewSnapshot({
    sourceDataRoot: source,
    targetDataRoot: target,
    workspaceRoot: workspace,
    sourceRevision: "main-sha",
    now: () => new Date("2026-08-29T12:00:00.000Z"),
  });

  assert.equal(result.created, true);
  assert.equal(await readFile(join(target, "artifacts", "research-imports", "document.txt"), "utf8"), "正式资料\n");
  await assert.rejects(readFile(join(target, "instance-control.token")), /ENOENT/);
  await assert.rejects(readFile(join(target, "service.lock")), /ENOENT/);

  const preview = new DatabaseSync(join(target, "collector.sqlite"), { readOnly: true });
  assert.equal(preview.prepare("SELECT COUNT(*) AS count FROM provider_credentials").get().count, 0);
  assert.equal(preview.prepare("SELECT COUNT(*) AS count FROM paired_clients").get().count, 0);
  assert.equal(preview.prepare("SELECT value FROM settings WHERE key = 'research_fusion_auto'").get().value, "false");
  assert.equal(preview.prepare("SELECT value FROM settings WHERE key = 'ai_consent'").get().value, "false");
  assert.equal(preview.prepare("SELECT value FROM settings WHERE key = 'ai_configured'").get().value, "false");
  assert.equal(preview.prepare("SELECT value FROM settings WHERE key = 'search_tavily_api_key'").get(), undefined);
  assert.equal(JSON.parse(preview.prepare("SELECT record_json FROM provider_profiles WHERE id = 'profile-1'").get().record_json).credentialConfigured, false);
  assert.equal(preview.prepare("SELECT COUNT(*) AS count FROM research_sessions").get().count, 1);
  preview.close();

  const sourceDatabase = new DatabaseSync(join(source, "collector.sqlite"), { readOnly: true });
  assert.equal(sourceDatabase.prepare("SELECT value FROM settings WHERE key = 'research_fusion_auto'").get().value, "true");
  assert.equal(sourceDatabase.prepare("SELECT COUNT(*) AS count FROM provider_credentials").get().count, 1);
  sourceDatabase.close();
  const manifestText = await readFile(join(target, PREVIEW_MANIFEST_FILE), "utf8");
  assert.equal(manifestText.includes("secret-model-key"), false);
  assert.equal(manifestText.includes("secret-search-key"), false);
});

test("reuses an owned snapshot by default and refreshes it only when explicitly requested", async (t) => {
  const { root, source, workspace, target } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await createPreviewSnapshot({ sourceDataRoot: source, targetDataRoot: target, workspaceRoot: workspace });
  const sourceDatabase = new DatabaseSync(join(source, "collector.sqlite"));
  sourceDatabase.prepare("INSERT INTO research_sessions VALUES (?, ?)").run("session-2", '{"id":"session-2"}');
  sourceDatabase.close();

  const reused = await createPreviewSnapshot({ sourceDataRoot: source, targetDataRoot: target, workspaceRoot: workspace });
  assert.equal(reused.created, false);
  let preview = new DatabaseSync(join(target, "collector.sqlite"), { readOnly: true });
  assert.equal(preview.prepare("SELECT COUNT(*) AS count FROM research_sessions").get().count, 1);
  preview.close();

  const refreshed = await createPreviewSnapshot({ sourceDataRoot: source, targetDataRoot: target, workspaceRoot: workspace, refresh: true });
  assert.equal(refreshed.created, true);
  preview = new DatabaseSync(join(target, "collector.sqlite"), { readOnly: true });
  assert.equal(preview.prepare("SELECT COUNT(*) AS count FROM research_sessions").get().count, 2);
  preview.close();
});

test("refuses a target outside the current worktree and an unowned refresh directory", async (t) => {
  const { root, source, workspace, target } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await assert.rejects(
    createPreviewSnapshot({ sourceDataRoot: source, targetDataRoot: join(root, "outside"), workspaceRoot: workspace }),
    /isolated directory/,
  );
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "sentinel.txt"), "user data\n");
  await assert.rejects(
    createPreviewSnapshot({ sourceDataRoot: source, targetDataRoot: target, workspaceRoot: workspace, refresh: true }),
    /unowned preview directory/,
  );
  assert.equal(await readFile(join(target, "sentinel.txt"), "utf8"), "user data\n");
});

test("refuses to reuse a damaged owned preview instead of silently rebuilding it", async (t) => {
  const { root, source, workspace, target } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await createPreviewSnapshot({ sourceDataRoot: source, targetDataRoot: target, workspaceRoot: workspace });
  await rm(join(target, "collector.sqlite"));
  await assert.rejects(
    createPreviewSnapshot({ sourceDataRoot: source, targetDataRoot: target, workspaceRoot: workspace }),
    /database is missing/,
  );
});
