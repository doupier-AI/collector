import assert from "node:assert/strict";
import { readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CaptureService, SqliteStore } from "@collector/api";

test("full backup is consistent and portable export excludes credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-data-control-"));
  const database = join(root, "collector.sqlite");
  const artifacts = join(root, "artifacts");
  const store = new SqliteStore(database);
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const service = new CaptureService(store, artifacts, undefined, undefined, { autoRunRecentOrganization: false });
  const material = await service.createCapture({
    captureType: "pasted_text",
    content: "A portable source material.",
    locator: { kind: "user_supplied" },
    clientCaptureId: "data-control-material",
    capturedAt: new Date().toISOString(),
  }, "data-control-material");
  const topic = await service.createTopic("Portable topic", [material.id]);
  await store.saveClientToken("secret-token", "test", "credential-hash-must-not-export", new Date().toISOString());
  await store.saveSetting("private-test-setting", "credential-value-must-not-export");

  assert.deepEqual(service.getDataPaths(), { database, artifacts, databaseExists: true });
  const backup = await service.createBackup();
  assert.equal(backup.manifest.exportedMaterialCount, 1);
  assert.deepEqual(backup.manifest.exportedTopicIds, [topic.id]);
  assert.ok(backup.manifest.checksums.sqlite);
  const verification = await service.verifyBackup(backup.id);
  assert.equal(verification.valid, true, verification.errors.join("; "));

  const exported = await service.exportPortable({ includeArtifacts: false, format: "both" });
  const json = await readFile(join(exported.path, "collector-export.json"), "utf8");
  assert.match(json, /A portable source material/);
  assert.match(json, /Portable topic/);
  assert.doesNotMatch(json, /credential-hash-must-not-export|credential-value-must-not-export/);
  assert.ok(exported.manifest.checksums.export);
  assert.equal(exported.manifest.exportedMaterialCount, 1);

  await writeFile(join(backup.path, "collector.sqlite"), "corrupted backup", "utf8");
  const corrupted = await service.verifyBackup(backup.id);
  assert.equal(corrupted.valid, false);
  assert.ok(corrupted.errors.some((error) => /checksum|database|file/i.test(error)));
});

test("AI budget validation rejects negative and inverted thresholds", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-budget-validation-"));
  const store = new SqliteStore(join(root, "collector.sqlite"));
  await store.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { autoRunRecentOrganization: false });
  await assert.rejects(service.updateAiBudgetSettings({ monthlyLimitUsd: -1 }), /non-negative/);
  await assert.rejects(service.updateAiBudgetSettings({ monthlyLimitUsd: 5, warningThresholdUsd: 6 }), /cannot exceed/);
});
