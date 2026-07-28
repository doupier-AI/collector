import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { CaptureService, MemoryStore } from "@collector/api";

async function fixture() {
  const store = new MemoryStore();
  await store.init();
  const service = new CaptureService(store, join(tmpdir(), "collector-model-routing"), undefined, undefined, {
    autoRunRecentOrganization: false,
  });
  return { store, service };
}

async function saveProfile(service: CaptureService, model: string, apiKey: string) {
  return service.saveProviderProfileWithCredential({
    providerId: "openai",
    displayName: `OpenAI ${model}`,
    model,
    apiKey,
  });
}

test("model routing validates purpose, profile, and credential", async () => {
  const { service } = await fixture();
  assert.deepEqual(service.getModelRouting(), { routes: [] });
  await assert.rejects(() => service.setModelRouting("nonsense" as never, "x"), /Unknown model purpose/);
  await assert.rejects(() => service.setModelRouting("chat", "missing-profile"), /not found/);
  const noKey = await service.saveProviderProfileWithCredential({
    providerId: "openai",
    displayName: "No Key",
    model: "gpt-4.1-mini",
  });
  await assert.rejects(() => service.setModelRouting("chat", noKey.id), /credential/);
});

test("purpose gateway follows routing and falls back to the active profile", async () => {
  const { service } = await fixture();
  const active = await saveProfile(service, "gpt-4.1-mini", "sk-active");
  const research = await saveProfile(service, "gpt-4.1", "sk-research");
  await service.activateProviderProfile(active.id);

  // 未分配时全部回退激活配置
  assert.equal((await service.gatewayForPurpose("research"))?.modelName, "gpt-4.1-mini");

  await service.setModelRouting("research", research.id);
  assert.deepEqual(service.getModelRouting(), { routes: [{ purpose: "research", profileId: research.id }] });
  assert.equal((await service.gatewayForPurpose("research"))?.modelName, "gpt-4.1");
  assert.equal((await service.gatewayForPurpose("chat"))?.modelName, "gpt-4.1-mini", "其他用途仍跟随激活配置");

  // 清除分配后回退
  await service.setModelRouting("research", null);
  assert.equal((await service.gatewayForPurpose("research"))?.modelName, "gpt-4.1-mini");
});

test("purpose gateway snapshot refreshes after profile update or deletion", async () => {
  const { service } = await fixture();
  const active = await saveProfile(service, "gpt-4.1-mini", "sk-active");
  const routed = await saveProfile(service, "gpt-4.1", "sk-routed");
  await service.activateProviderProfile(active.id);
  await service.setModelRouting("chat", routed.id);
  assert.equal((await service.gatewayForPurpose("chat"))?.modelName, "gpt-4.1");

  // 更新被分配配置的模型后快照失效重建
  await service.saveProviderProfileWithCredential({
    id: routed.id,
    providerId: "openai",
    displayName: routed.displayName,
    model: "gpt-4o-mini",
  });
  assert.equal((await service.gatewayForPurpose("chat"))?.modelName, "gpt-4o-mini");

  // 删除被分配配置后路由联动清理并回退激活配置
  await service.deleteProviderProfile(routed.id);
  assert.deepEqual(service.getModelRouting(), { routes: [] });
  assert.equal((await service.gatewayForPurpose("chat"))?.modelName, "gpt-4.1-mini");
});
