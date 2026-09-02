import { expect, test } from "@playwright/test";
import { pairAndOpen } from "./helpers";

/**
 * 模型设置页真实浏览器验收（确定性：只操作本地配置，不访问真实云模型）：
 * 1. 首次使用自动展开新建表单；保存后 Key 以暗文停留在输入框；
 * 2. 眼睛按钮切换明文/暗文；
 * 3. 刷新后表单收起、列表呈现，当前使用中的配置不能停用；
 * 4. 编辑配置时 Key 从本机凭证自动回填为暗文（等价于服务重启后仍可见）；
 * 5. 第二套配置可通过复选框停用/启用。
 * 测试结束清理创建的配置，避免影响共享 harness 上的后续用例。
 */
test("模型设置：新建入口、Key 暗文持久与眼睛切换、配置启停", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await pairAndOpen(page, "/settings/ai-model");

  // 首次使用（无已保存配置）：新建表单自动展开，给出明确起点
  await expect(page.getByRole("heading", { name: "新建模型供应商" })).toBeVisible();
  const keyInput = page.getByLabel("API Key", { exact: true });
  await expect(keyInput).toHaveAttribute("type", "password");
  await page.getByLabel("配置名称").fill("主配置");
  await keyInput.fill("sk-e2e-main");
  await page.getByRole("button", { name: "保存并启用" }).click();
  await expect(page.getByText("已保存并启用")).toBeVisible();

  // 配置结束后 Key 以暗文持续停留在输入框
  await expect(keyInput).toHaveValue("sk-e2e-main");
  await expect(keyInput).toHaveAttribute("type", "password");

  // 眼睛按钮切换明文/暗文
  await page.getByRole("button", { name: "显示 API Key" }).click();
  await expect(keyInput).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "隐藏 API Key" }).click();
  await expect(keyInput).toHaveAttribute("type", "password");

  // 刷新页面：表单收起为「新建模型供应商」入口，列表呈现；当前使用的配置不能停用
  await page.reload();
  await expect(page.getByRole("button", { name: "新建模型供应商" })).toBeVisible();
  await expect(page.getByText("主配置", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "停用 主配置" })).toBeDisabled();

  // 编辑：Key 从本机凭证自动回填为暗文（服务重启后重新打开同样可见）
  await page.getByRole("button", { name: "编辑" }).click();
  await expect(page.getByRole("heading", { name: "编辑模型供应商「主配置」" })).toBeVisible();
  const editKeyInput = page.getByLabel("API Key", { exact: true });
  await expect(editKeyInput).toHaveValue("sk-e2e-main");
  await expect(editKeyInput).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "取消" }).click();

  // 新建第二套配置（仅保存），随后通过复选框停用
  await page.getByRole("button", { name: "新建模型供应商" }).click();
  await page.getByLabel("配置名称").fill("备用配置");
  await page.getByLabel("模型", { exact: true }).fill("gpt-4.1");
  await page.getByLabel("API Key", { exact: true }).fill("sk-e2e-backup");
  await page.getByRole("button", { name: "仅保存" }).click();
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();

  const standbyToggle = page.getByRole("checkbox", { name: "停用 备用配置" });
  await expect(standbyToggle).toBeChecked();
  await standbyToggle.click();
  await expect(page.getByText(/已停用/)).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "启用 备用配置" })).not.toBeChecked();

  expect(pageErrors).toEqual([]);

  // 清理：删除本次创建的配置，恢复 harness 初始状态
  const profiles = await page.request.get("/v1/provider-profiles").then((response) => response.json() as Promise<Array<{ id: string }>>);
  for (const profile of profiles) {
    await page.request.delete(`/v1/provider-profiles/${profile.id}`);
  }
});

test("MiMo Token Plan：发现模型、保存后检测、刷新保持并启用深度思考", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await pairAndOpen(page, "/settings/ai-model");

  // 保证该场景从空配置开始，避免共享 harness 中前序失败留下配置。
  const existing = await page.request.get("/v1/provider-profiles").then((response) => response.json() as Promise<Array<{ id: string }>>);
  for (const profile of existing) await page.request.delete(`/v1/provider-profiles/${profile.id}`);
  await page.reload();

  await page.getByLabel("模型供应商", { exact: true }).selectOption("custom");
  await page.getByLabel("配置名称").fill("MiMo Token Plan");
  await page.getByLabel("模型", { exact: true }).fill("MIMO-V2.5-Pro");
  await page.getByLabel("Base URL").fill("https://token-plan-cn-hz.xiaomimimo.com/v1");
  await page.getByLabel("API Key", { exact: true }).fill("sk-e2e-mimo");
  await page.getByRole("button", { name: "获取模型" }).click();

  const discovered = page.locator(".settings-model-picker__item").filter({ hasText: "MIMO-V2.5-Pro" });
  await expect(discovered).toBeVisible();
  await expect(discovered.getByRole("checkbox")).toBeChecked();
  await page.getByRole("button", { name: "保存并启用（1）" }).click();

  const saved = page.locator(".settings-profile-item").filter({ hasText: "MiMo Token Plan · MIMO-V2.5-Pro" });
  await expect(saved).toBeVisible();
  await expect(saved.locator(".settings-capability-matrix__item").filter({ hasText: "深度思考支持" })).toBeVisible({ timeout: 15_000 });
  await expect(saved.getByRole("button", { name: "重新检测" })).toBeEnabled({ timeout: 15_000 });

  await page.reload();
  const restored = page.locator(".settings-profile-item").filter({ hasText: "MiMo Token Plan · MIMO-V2.5-Pro" });
  await expect(restored.locator(".settings-capability-matrix__item").filter({ hasText: "深度思考支持" })).toBeVisible();

  await page.goto("/research/new");
  const thinking = page.getByRole("button", { name: "开启深度思考" });
  await expect(thinking).toHaveAttribute("aria-disabled", "false");
  await thinking.click();
  await expect(page.getByRole("button", { name: "关闭深度思考" })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("你的问题").fill("验证 MiMo Token Plan 深度思考");
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  await expect(page.locator("[aria-live=polite]")).toHaveText("已完成", { timeout: 15_000 });
  expect(pageErrors).toEqual([]);

  const profiles = await page.request.get("/v1/provider-profiles").then((response) => response.json() as Promise<Array<{ id: string }>>);
  for (const profile of profiles) await page.request.delete(`/v1/provider-profiles/${profile.id}`);
});
