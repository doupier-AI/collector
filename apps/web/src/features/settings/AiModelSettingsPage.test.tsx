import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProviderDefinition, ProviderProfile } from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { AiModelSettingsPage, groupModelsByFamily } from "./AiModelSettingsPage";

const catalog: ProviderDefinition[] = [
  {
    id: "openai",
    label: "OpenAI",
    apiMode: "openai_chat_completions",
    authMode: "bearer",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-mini",
    models: ["gpt-4.1-mini"],
    capabilities: { structuredJson: false, reasoningOutput: "none", thinkingMode: "none", modelDiscovery: false, webGrounding: "unsupported" },
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    apiMode: "openai_chat_completions",
    authMode: "bearer",
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-flash",
    models: ["deepseek-v4-flash"],
    capabilities: { structuredJson: true, reasoningOutput: "openai_reasoning_content", thinkingMode: "openai_compatible", modelDiscovery: false, webGrounding: "unsupported" },
  },
  {
    id: "custom",
    label: "自定义兼容端点",
    apiMode: "openai_chat_completions",
    authMode: "bearer",
    defaultBaseUrl: "",
    defaultModel: "",
    models: [],
    capabilities: { structuredJson: false, reasoningOutput: "none", thinkingMode: "none", modelDiscovery: false, webGrounding: "unsupported" },
  },
];

function makeProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  const now = "2026-07-29T00:00:00.000Z";
  return {
    id: "profile-1",
    providerId: "openai",
    displayName: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    credentialConfigured: true,
    enabled: true,
    configurationVersion: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function renderSettings(api: Partial<ApiClient>) {
  const services = { api: api as ApiClient } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <AiModelSettingsPage />
    </ServicesProvider>,
  );
}

function baseApi(overrides: Partial<ApiClient> = {}): Partial<ApiClient> {
  return {
    getProviderCatalog: vi.fn<ApiClient["getProviderCatalog"]>().mockResolvedValue(catalog),
    listProviderProfiles: vi.fn<ApiClient["listProviderProfiles"]>().mockResolvedValue([]),
    getActiveProviderProfile: vi.fn<ApiClient["getActiveProviderProfile"]>().mockResolvedValue(undefined),
    discoverProviderModels: vi.fn<ApiClient["discoverProviderModels"]>().mockResolvedValue({ ok: false, error: "未 mock" }),
    getModelRouting: vi.fn<ApiClient["getModelRouting"]>().mockResolvedValue({ routes: [] }),
    ...overrides,
  };
}

describe("groupModelsByFamily", () => {
  it("按 / 前缀与 - 首段分组并保持顺序", () => {
    const groups = groupModelsByFamily([
      "deepseek-ai/DeepSeek-V3.2",
      "gpt-4.1-mini",
      "deepseek-ai/DeepSeek-R1",
      "gpt-4.1",
      "llama",
    ]);
    expect(groups).toEqual([
      { family: "deepseek-ai", models: ["deepseek-ai/DeepSeek-V3.2", "deepseek-ai/DeepSeek-R1"] },
      { family: "gpt", models: ["gpt-4.1-mini", "gpt-4.1"] },
      { family: "llama", models: ["llama"] },
    ]);
  });
});

describe("AiModelSettingsPage", () => {
  it("保存并启用时提交 apiKey，保存后 Key 以暗文停留在输入框", async () => {
    const user = userEvent.setup();
    const saveProviderProfile = vi.fn<ApiClient["saveProviderProfile"]>().mockResolvedValue(makeProfile());
    renderSettings(baseApi({ saveProviderProfile }));

    expect(await screen.findByRole("heading", { name: "AI 模型设置" })).toBeInTheDocument();
    const keyInput = screen.getByLabelText("API Key");
    expect(keyInput).toHaveAttribute("type", "password");
    await user.type(keyInput, "sk-secret");
    await user.click(screen.getByRole("button", { name: "保存并启用" }));

    await waitFor(() => expect(saveProviderProfile).toHaveBeenCalledTimes(1));
    expect(saveProviderProfile.mock.calls[0][0]).toMatchObject({
      providerId: "openai",
      model: "gpt-4.1-mini",
      apiKey: "sk-secret",
      activate: true,
    });
    expect(await screen.findByText("已保存并启用")).toBeInTheDocument();
    expect(keyInput).toHaveValue("sk-secret");
    expect(keyInput).toHaveAttribute("type", "password");
  });

  it("眼睛按钮切换 API Key 明文与暗文", async () => {
    const user = userEvent.setup();
    renderSettings(baseApi());

    await screen.findByRole("heading", { name: "AI 模型设置" });
    const keyInput = screen.getByLabelText("API Key");
    await user.type(keyInput, "sk-visible");

    const toggle = screen.getByRole("button", { name: "显示 API Key" });
    await user.click(toggle);
    expect(keyInput).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "隐藏 API Key" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "隐藏 API Key" }));
    expect(keyInput).toHaveAttribute("type", "password");
  });

  it("测试连接调用后端测试接口并展示结果", async () => {
    const user = userEvent.setup();
    const testProviderProfileConfig = vi.fn<ApiClient["testProviderProfileConfig"]>().mockResolvedValue({ ok: true, model: "gpt-4.1-mini" });
    renderSettings(baseApi({ testProviderProfileConfig }));

    await screen.findByRole("heading", { name: "AI 模型设置" });
    await user.type(screen.getByLabelText("API Key"), "sk-test");
    await user.click(screen.getByRole("button", { name: "测试连接" }));

    await waitFor(() => expect(testProviderProfileConfig).toHaveBeenCalledTimes(1));
    expect(testProviderProfileConfig.mock.calls[0][0]).toMatchObject({ providerId: "openai", apiKey: "sk-test" });
    expect(await screen.findByText("连接成功：gpt-4.1-mini")).toBeInTheDocument();
  });

  it("列出已保存配置并支持设为当前与删除", async () => {
    const user = userEvent.setup();
    const inactive = makeProfile({ id: "profile-2", displayName: "备用配置" });
    const active = makeProfile({ id: "profile-1", displayName: "主配置" });
    const activateProviderProfile = vi.fn<ApiClient["activateProviderProfile"]>().mockResolvedValue(active);
    const deleteProviderProfile = vi.fn<ApiClient["deleteProviderProfile"]>().mockResolvedValue(undefined);
    renderSettings(baseApi({
      listProviderProfiles: vi.fn<ApiClient["listProviderProfiles"]>().mockResolvedValue([active, inactive]),
      getActiveProviderProfile: vi.fn<ApiClient["getActiveProviderProfile"]>().mockResolvedValue(active),
      activateProviderProfile,
      deleteProviderProfile,
    }));

    expect(await screen.findByText("备用配置")).toBeInTheDocument();
    expect(screen.getByText("主配置")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "设为当前" }));
    await waitFor(() => expect(activateProviderProfile).toHaveBeenCalledWith("profile-2"));

    const deleteButtons = screen.getAllByRole("button", { name: "删除" });
    await user.click(deleteButtons[0]);
    await waitFor(() => expect(deleteProviderProfile).toHaveBeenCalledWith("profile-1"));
  });

  it("仅保存不启用当前配置", async () => {
    const user = userEvent.setup();
    const saveProviderProfile = vi.fn<ApiClient["saveProviderProfile"]>().mockResolvedValue(makeProfile());
    renderSettings(baseApi({ saveProviderProfile }));

    await screen.findByRole("heading", { name: "AI 模型设置" });
    await user.type(screen.getByLabelText("API Key"), "sk-keep");
    await user.click(screen.getByRole("button", { name: "仅保存" }));

    await waitFor(() => expect(saveProviderProfile).toHaveBeenCalledTimes(1));
    expect(saveProviderProfile.mock.calls[0][0]).toMatchObject({ apiKey: "sk-keep", activate: false });
    expect(await screen.findByText("已保存")).toBeInTheDocument();
  });

  it("编辑模式自动回填已保存的 Key（暗文），保存时随表单提交", async () => {
    const user = userEvent.setup();
    const existing = makeProfile({ id: "profile-1", displayName: "主配置" });
    const saveProviderProfile = vi.fn<ApiClient["saveProviderProfile"]>().mockResolvedValue(existing);
    const getProviderCredential = vi.fn<ApiClient["getProviderCredential"]>().mockResolvedValue("sk-saved");
    renderSettings(baseApi({
      listProviderProfiles: vi.fn<ApiClient["listProviderProfiles"]>().mockResolvedValue([existing]),
      saveProviderProfile,
      getProviderCredential,
    }));

    await screen.findByText("主配置");
    await user.click(screen.getByRole("button", { name: "编辑" }));

    expect(await screen.findByRole("heading", { name: "编辑模型供应商「主配置」" })).toBeInTheDocument();
    expect(screen.getByLabelText("模型供应商")).toBeDisabled();
    expect(screen.getByLabelText("配置名称")).toHaveValue("主配置");
    const keyInput = screen.getByLabelText("API Key");
    await waitFor(() => expect(keyInput).toHaveValue("sk-saved"));
    expect(keyInput).toHaveAttribute("type", "password");
    expect(getProviderCredential).toHaveBeenCalledWith("profile-1");

    await user.click(screen.getByRole("button", { name: "仅保存" }));
    await waitFor(() => expect(saveProviderProfile).toHaveBeenCalledTimes(1));
    expect(saveProviderProfile.mock.calls[0][0]).toMatchObject({ id: "profile-1", apiKey: "sk-saved", activate: false });
  });

  it("编辑模式下读取 Key 失败时留空保存保持原凭证", async () => {
    const user = userEvent.setup();
    const existing = makeProfile({ id: "profile-1", displayName: "主配置" });
    const saveProviderProfile = vi.fn<ApiClient["saveProviderProfile"]>().mockResolvedValue(existing);
    const getProviderCredential = vi.fn<ApiClient["getProviderCredential"]>().mockRejectedValue(new Error("网络错误"));
    renderSettings(baseApi({
      listProviderProfiles: vi.fn<ApiClient["listProviderProfiles"]>().mockResolvedValue([existing]),
      saveProviderProfile,
      getProviderCredential,
    }));

    await screen.findByText("主配置");
    await user.click(screen.getByRole("button", { name: "编辑" }));

    expect(await screen.findByText(/已保存的 Key 读取失败/)).toBeInTheDocument();
    expect(screen.getByLabelText("API Key")).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "仅保存" }));
    await waitFor(() => expect(saveProviderProfile).toHaveBeenCalledTimes(1));
    expect(saveProviderProfile.mock.calls[0][0]).toMatchObject({ id: "profile-1", apiKey: undefined, activate: false });
  });

  it("已有配置时表单默认收起，通过「新建模型供应商」入口展开", async () => {
    const user = userEvent.setup();
    const existing = makeProfile({ id: "profile-1", displayName: "主配置" });
    renderSettings(baseApi({
      listProviderProfiles: vi.fn<ApiClient["listProviderProfiles"]>().mockResolvedValue([existing]),
    }));

    await screen.findByText("主配置");
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "新建模型供应商" }));
    expect(await screen.findByRole("heading", { name: "新建模型供应商" })).toBeInTheDocument();
    expect(screen.getByLabelText("API Key")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建模型供应商" })).toBeInTheDocument();
  });

  it("启用/停用复选框切换配置可用性，当前使用中的配置不能停用", async () => {
    const user = userEvent.setup();
    const active = makeProfile({ id: "profile-1", displayName: "主配置" });
    const standby = makeProfile({ id: "profile-2", displayName: "备用配置" });
    const setProviderProfileEnabled = vi.fn<ApiClient["setProviderProfileEnabled"]>()
      .mockResolvedValue({ ...standby, enabled: false });
    renderSettings(baseApi({
      listProviderProfiles: vi.fn<ApiClient["listProviderProfiles"]>().mockResolvedValue([active, standby]),
      getActiveProviderProfile: vi.fn<ApiClient["getActiveProviderProfile"]>().mockResolvedValue(active),
      setProviderProfileEnabled,
    }));

    await screen.findByText("备用配置");
    expect(screen.getByRole("checkbox", { name: "停用 主配置" })).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: "停用 备用配置" }));
    await waitFor(() => expect(setProviderProfileEnabled).toHaveBeenCalledWith("profile-2", false));
  });

  it("获取模型成功后展示勾选列表而非下拉框，失败时展示原因", async () => {
    const user = userEvent.setup();
    const discoverProviderModels = vi.fn<ApiClient["discoverProviderModels"]>()
      .mockResolvedValueOnce({ ok: true, models: ["fetched-a", "fetched-b"] })
      .mockResolvedValueOnce({ ok: false, error: "认证失败：请检查 API Key 是否正确" });
    const { container } = renderSettings(baseApi({ discoverProviderModels }));

    await screen.findByRole("heading", { name: "AI 模型设置" });
    await user.type(screen.getByLabelText("API Key"), "sk-fetch");
    await user.click(screen.getByRole("button", { name: "获取模型" }));

    await waitFor(() => expect(discoverProviderModels).toHaveBeenCalledTimes(1));
    expect(discoverProviderModels.mock.calls[0][0]).toMatchObject({ providerId: "openai", apiKey: "sk-fetch" });
    expect(await screen.findByText(/已获取 2 个可调用模型/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "fetched-a" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "fetched-b" })).toBeInTheDocument();
    expect(container.querySelector("#model-options")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "获取模型" }));
    expect(await screen.findByText("认证失败：请检查 API Key 是否正确")).toBeInTheDocument();
  });

  it("测试连接成功时显示延迟", async () => {
    const user = userEvent.setup();
    const testProviderProfileConfig = vi.fn<ApiClient["testProviderProfileConfig"]>().mockResolvedValue({ ok: true, model: "gpt-4.1-mini", durationMs: 1200 });
    renderSettings(baseApi({ testProviderProfileConfig }));

    await screen.findByRole("heading", { name: "AI 模型设置" });
    await user.type(screen.getByLabelText("API Key"), "sk-test");
    await user.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByText("连接成功：gpt-4.1-mini · 1.2s")).toBeInTheDocument();
  });

  it("任务模型分配：展示当前分配并保存变更", async () => {
    const user = userEvent.setup();
    const primary = makeProfile({ id: "profile-1", displayName: "主配置" });
    const backup = makeProfile({ id: "profile-2", displayName: "备用配置" });
    const setModelRouting = vi.fn<ApiClient["setModelRouting"]>().mockResolvedValue({
      routes: [
        { purpose: "research", profileId: "profile-2" },
        { purpose: "extraction", profileId: "profile-1" },
      ],
    });
    renderSettings(baseApi({
      listProviderProfiles: vi.fn<ApiClient["listProviderProfiles"]>().mockResolvedValue([primary, backup]),
      getModelRouting: vi.fn<ApiClient["getModelRouting"]>().mockResolvedValue({ routes: [{ purpose: "research", profileId: "profile-2" }] }),
      setModelRouting,
    }));

    expect(await screen.findByText("任务模型分配")).toBeInTheDocument();
    expect(screen.getByLabelText("深入研究")).toHaveValue("profile-2");
    expect(screen.getByLabelText("对话与问答")).toHaveValue("");

    await user.selectOptions(screen.getByLabelText("事后语义抽取"), "profile-1");
    await waitFor(() => expect(setModelRouting).toHaveBeenCalledWith("extraction", "profile-1"));
    await waitFor(() => expect(screen.getByLabelText("事后语义抽取")).toHaveValue("profile-1"));
  });

  it("获取模型后展示分组勾选列表，默认勾选当前默认模型", async () => {
    const user = userEvent.setup();
    const discoverProviderModels = vi.fn<ApiClient["discoverProviderModels"]>()
      .mockResolvedValue({ ok: true, models: ["gpt-4.1-mini", "gpt-4.1", "o4-mini"] });
    renderSettings(baseApi({ discoverProviderModels }));

    await screen.findByRole("heading", { name: "AI 模型设置" });
    await user.type(screen.getByLabelText("API Key"), "sk-fetch");
    await user.click(screen.getByRole("button", { name: "获取模型" }));

    expect(await screen.findByText(/已获取 3 个可调用模型/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "可调用模型列表" })).toBeInTheDocument();
    expect(screen.getByText("gpt")).toBeInTheDocument();
    expect(screen.getByText("o4")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "gpt-4.1-mini" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "gpt-4.1" })).not.toBeChecked();
  });

  it("勾选多个模型后保存并启用：每个模型各生成一套配置且只启用第一个", async () => {
    const user = userEvent.setup();
    const discoverProviderModels = vi.fn<ApiClient["discoverProviderModels"]>()
      .mockResolvedValue({ ok: true, models: ["gpt-4.1-mini", "gpt-4.1", "o4-mini"] });
    const saveProviderProfile = vi.fn<ApiClient["saveProviderProfile"]>().mockResolvedValue(makeProfile());
    renderSettings(baseApi({ discoverProviderModels, saveProviderProfile }));

    await screen.findByRole("heading", { name: "AI 模型设置" });
    await user.type(screen.getByLabelText("API Key"), "sk-batch");
    await user.click(screen.getByRole("button", { name: "获取模型" }));
    await screen.findByRole("checkbox", { name: "gpt-4.1" });
    await user.click(screen.getByRole("checkbox", { name: "gpt-4.1" }));

    await user.click(screen.getByRole("button", { name: "保存并启用（2）" }));

    await waitFor(() => expect(saveProviderProfile).toHaveBeenCalledTimes(2));
    expect(saveProviderProfile.mock.calls[0][0]).toMatchObject({
      providerId: "openai",
      displayName: "OpenAI · gpt-4.1-mini",
      model: "gpt-4.1-mini",
      apiKey: "sk-batch",
      activate: true,
    });
    expect(saveProviderProfile.mock.calls[1][0]).toMatchObject({
      displayName: "OpenAI · gpt-4.1",
      model: "gpt-4.1",
      apiKey: "sk-batch",
      activate: false,
    });
    expect(await screen.findByText("已保存 2 个配置并启用第一个")).toBeInTheDocument();
    expect(screen.getByLabelText("API Key")).toHaveValue("sk-batch");
  });

  it("勾选多个模型后仅保存：全部不启用", async () => {
    const user = userEvent.setup();
    const discoverProviderModels = vi.fn<ApiClient["discoverProviderModels"]>()
      .mockResolvedValue({ ok: true, models: ["gpt-4.1-mini", "gpt-4.1"] });
    const saveProviderProfile = vi.fn<ApiClient["saveProviderProfile"]>().mockResolvedValue(makeProfile());
    renderSettings(baseApi({ discoverProviderModels, saveProviderProfile }));

    await screen.findByRole("heading", { name: "AI 模型设置" });
    await user.type(screen.getByLabelText("API Key"), "sk-batch");
    await user.click(screen.getByRole("button", { name: "获取模型" }));
    await screen.findByRole("checkbox", { name: "gpt-4.1" });
    await user.click(screen.getByRole("checkbox", { name: "gpt-4.1" }));

    await user.click(screen.getByRole("button", { name: "仅保存（2）" }));

    await waitFor(() => expect(saveProviderProfile).toHaveBeenCalledTimes(2));
    expect(saveProviderProfile.mock.calls[0][0]).toMatchObject({ activate: false });
    expect(saveProviderProfile.mock.calls[1][0]).toMatchObject({ activate: false });
    expect(await screen.findByText("已保存 2 个配置")).toBeInTheDocument();
  });

  it("批量保存部分失败：失败的模型保持勾选与 Key 可直接重试", async () => {
    const user = userEvent.setup();
    const discoverProviderModels = vi.fn<ApiClient["discoverProviderModels"]>()
      .mockResolvedValue({ ok: true, models: ["gpt-4.1-mini", "gpt-4.1"] });
    const saveProviderProfile = vi.fn<ApiClient["saveProviderProfile"]>()
      .mockResolvedValueOnce(makeProfile())
      .mockRejectedValueOnce(new Error("网络错误"));
    renderSettings(baseApi({ discoverProviderModels, saveProviderProfile }));

    await screen.findByRole("heading", { name: "AI 模型设置" });
    await user.type(screen.getByLabelText("API Key"), "sk-batch");
    await user.click(screen.getByRole("button", { name: "获取模型" }));
    await screen.findByRole("checkbox", { name: "gpt-4.1" });
    await user.click(screen.getByRole("checkbox", { name: "gpt-4.1" }));

    await user.click(screen.getByRole("button", { name: "保存并启用（2）" }));

    expect(await screen.findByText(/已保存 1 个，1 个失败（gpt-4.1），可直接重试/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "gpt-4.1" })).toBeChecked();
    expect(screen.getByLabelText("API Key")).toHaveValue("sk-batch");
  });

  it("已保存过的同厂商模型在勾选列表中标记已保存并禁用", async () => {
    const user = userEvent.setup();
    const existing = makeProfile({ id: "profile-1", model: "gpt-4.1-mini" });
    const discoverProviderModels = vi.fn<ApiClient["discoverProviderModels"]>()
      .mockResolvedValue({ ok: true, models: ["gpt-4.1-mini", "gpt-4.1"] });
    renderSettings(baseApi({
      discoverProviderModels,
      listProviderProfiles: vi.fn<ApiClient["listProviderProfiles"]>().mockResolvedValue([existing]),
    }));

    await screen.findByRole("button", { name: "新建模型供应商" });
    await user.click(screen.getByRole("button", { name: "新建模型供应商" }));
    await user.type(screen.getByLabelText("API Key"), "sk-fetch");
    await user.click(screen.getByRole("button", { name: "获取模型" }));

    const existingCheckbox = await screen.findByRole("checkbox", { name: /gpt-4\.1-mini/ });
    expect(existingCheckbox).toBeDisabled();
    expect(screen.getByText("已保存")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "gpt-4.1" })).toBeEnabled();
  });

  it("编辑模式获取模型后可勾选补充模型：保存当前配置并批量新增", async () => {
    const user = userEvent.setup();
    const existing = makeProfile({ id: "profile-1", displayName: "主配置", model: "gpt-4.1-mini" });
    const discoverProviderModels = vi.fn<ApiClient["discoverProviderModels"]>()
      .mockResolvedValue({ ok: true, models: ["gpt-4.1-mini", "gpt-4.1"] });
    const saveProviderProfile = vi.fn<ApiClient["saveProviderProfile"]>().mockResolvedValue(existing);
    const getProviderCredential = vi.fn<ApiClient["getProviderCredential"]>().mockResolvedValue("sk-edit");
    renderSettings(baseApi({
      discoverProviderModels,
      saveProviderProfile,
      getProviderCredential,
      listProviderProfiles: vi.fn<ApiClient["listProviderProfiles"]>().mockResolvedValue([existing]),
    }));

    await screen.findByText("主配置");
    await user.click(screen.getByRole("button", { name: "编辑" }));
    await screen.findByRole("heading", { name: "编辑模型供应商「主配置」" });
    await waitFor(() => expect(screen.getByLabelText("API Key")).toHaveValue("sk-edit"));

    await user.click(screen.getByRole("button", { name: "获取模型" }));
    const currentCheckbox = await screen.findByRole("checkbox", { name: /gpt-4\.1-mini/ });
    expect(currentCheckbox).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "gpt-4.1" }));

    await user.click(screen.getByRole("button", { name: "仅保存（1）" }));

    await waitFor(() => expect(saveProviderProfile).toHaveBeenCalledTimes(2));
    expect(saveProviderProfile.mock.calls[0][0]).toMatchObject({ id: "profile-1", model: "gpt-4.1-mini", apiKey: "sk-edit", activate: false });
    expect(saveProviderProfile.mock.calls[1][0]).toMatchObject({
      providerId: "openai",
      displayName: "主配置 · gpt-4.1",
      model: "gpt-4.1",
      apiKey: "sk-edit",
      activate: false,
    });
    expect(await screen.findByText("已保存当前配置，并新增 1 个模型配置")).toBeInTheDocument();
  });
});

describe("深度思考改为会话级偏好", () => {
  it("模型设置不再显示或保存配置级开关", async () => {
    const saveProviderProfile = vi.fn<ApiClient["saveProviderProfile"]>().mockResolvedValue(makeProfile());
    const user = userEvent.setup();
    renderSettings(baseApi({ saveProviderProfile }));

    await screen.findByLabelText("模型供应商");
    expect(screen.queryByRole("checkbox", { name: /深度思考/ })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("模型供应商"), "deepseek");
    await user.type(screen.getByLabelText("API Key"), "sk-deepseek");
    await user.click(screen.getByRole("button", { name: "保存并启用" }));
    await waitFor(() => expect(saveProviderProfile).toHaveBeenCalledTimes(1));
    expect(saveProviderProfile.mock.calls[0][0]).toMatchObject({ providerId: "deepseek" });
    expect(saveProviderProfile.mock.calls[0][0]).not.toHaveProperty("thinkingEnabled");
  });
});
