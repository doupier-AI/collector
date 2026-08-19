// startup-restore.test.ts — #47 启动恢复模型网关
// 覆盖：重启后从持久化状态重建网关（首条消息直接可用）、不覆写已保存同意记录、
// 无效配置暴露具体原因（停用/缺 Key/解析失败）。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProviderProfile } from "@collector/capture-contracts";
import { CaptureService, SqliteStore } from "@collector/api";

const NOW = "2026-08-08T00:00:00.000Z";

function makeProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: "profile-restore",
    providerId: "openai",
    displayName: "启动恢复测试",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    credentialConfigured: true,
    enabled: true,
    configurationVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

async function makeStore(dbPath: string) {
  const store = new SqliteStore(dbPath);
  await store.init();
  return store;
}

test("#47 启动恢复：已保存配置+凭证+同意记录齐备即建立可用网关，重启后首条消息直接可用", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-startup-restore-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const dbPath = join(root, "collector.sqlite");

  // 第一阶段：模拟用户此前在 WebUI 保存并启用模型配置（持久化状态）。
  let store = await makeStore(dbPath);
  await store.saveProviderProfile(makeProfile());
  await store.saveProviderCredential("profile-restore", "sk-restore");
  await store.setActiveProviderProfile("profile-restore");
  await store.saveSetting("ai_consent", "true");
  store.close();

  // 第二阶段：重启（新 SqliteStore + 新 CaptureService，不传网关、不传环境变量通道）。
  // 对应 server.ts 启动路径：restoreModelGateway() 以持久化状态重建网关。
  store = await makeStore(dbPath);
  const service = new CaptureService(store, join(root, "artifacts"), undefined, {
    autoRunRecentOrganization: false,
  });
  await service.restoreModelGateway();

  const config = service.getAiConfiguration();
  assert.equal(config.mode, "real", "重启后应为真实模型模式");
  assert.equal(config.provider, "openai");
  assert.equal(config.model, "gpt-4.1-mini");
  assert.equal(config.providerProfileId, "profile-restore");
  assert.equal(config.modelError, undefined, "网关可用时不应携带错误原因");

  // 首条消息直接可用：网关按用途解析可用（研究用途无分配时跟随激活网关）。
  const purpose = await service.gatewayForPurpose("research");
  assert.ok(purpose, "按任务用途应能解析出网关");
  assert.equal(purpose!.modelName, "gpt-4.1-mini");

  // 同意记录未被覆写。
  assert.equal(store.getSetting("ai_consent"), "true", "重启不得覆写已保存的同意记录");

  store.close();
});

test("#47 启动恢复不覆写同意记录：无环境变量通道时保持已保存值", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-startup-consent-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const dbPath = join(root, "collector.sqlite");

  let store = await makeStore(dbPath);
  await store.saveProviderProfile(makeProfile());
  await store.saveProviderCredential("profile-restore", "sk-consent");
  await store.setActiveProviderProfile("profile-restore");
  await store.saveSetting("ai_consent", "true");
  store.close();

  // 重启：即使进程环境未传 COLLECTOR_AI_CONSENT，也保持持久化的同意值。
  store = await makeStore(dbPath);
  const service = new CaptureService(store, join(root, "artifacts"), undefined, {
    autoRunRecentOrganization: false,
  });
  await service.restoreModelGateway();
  assert.equal(service.getAiConfiguration().consent, true, "同意记录保持已保存值");
  store.close();
});

test("#47 无效配置区分具体原因：配置缺失 / 停用 / 缺 Key", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-startup-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const dbPath = join(root, "collector.sqlite");

  // 场景一：从未配置过模型 → 一律"未配置"，但错误信息说明去向。
  let store = await makeStore(dbPath);
  let service = new CaptureService(store, join(root, "artifacts"), undefined, { autoRunRecentOrganization: false });
  await service.restoreModelGateway();
  let config = service.getAiConfiguration();
  assert.equal(config.mode, "unconfigured");
  assert.ok(config.modelError, "无配置时应给出可行动的提示");
  assert.match(config.modelError!, /模型设置/);
  store.close();

  // 场景二：配置已停用 → 明确"已停用"。
  // 先以启用态激活（模拟用户此前正常保存启用），再停用（模拟用户随后停用）。
  store = await makeStore(dbPath);
  await store.saveProviderProfile(makeProfile());
  await store.saveProviderCredential("profile-restore", "sk-disabled");
  await store.setActiveProviderProfile("profile-restore");
  await store.saveProviderProfile(makeProfile({ enabled: false }));
  service = new CaptureService(store, join(root, "artifacts"), undefined, { autoRunRecentOrganization: false });
  await service.restoreModelGateway();
  config = service.getAiConfiguration();
  assert.ok(config.modelError, "停用配置应暴露原因");
  assert.match(config.modelError!, /停用/);
  store.close();

  // 场景三：配置缺 API Key → 明确"缺少凭证"。
  // 先以带凭证态激活，再保存无凭证的副本（模拟用户清空 Key 后仍保持激活）。
  store = await makeStore(dbPath);
  await store.saveProviderProfile(makeProfile());
  await store.saveProviderCredential("profile-restore", "sk-missing");
  await store.setActiveProviderProfile("profile-restore");
  await store.saveProviderProfile(makeProfile({ credentialConfigured: false }));
  service = new CaptureService(store, join(root, "artifacts"), undefined, { autoRunRecentOrganization: false });
  await service.restoreModelGateway();
  config = service.getAiConfiguration();
  assert.ok(config.modelError, "缺 Key 配置应暴露原因");
  assert.match(config.modelError!, /API Key/);
  const connection = await service.testAiConnection();
  assert.equal(connection.ok, false, "网关不可用应暴露，不静默成功");
  assert.ok(connection.error, "连接测试应返回具体错误");
  store.close();
});
