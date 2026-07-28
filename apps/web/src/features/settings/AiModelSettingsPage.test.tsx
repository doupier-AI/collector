import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProviderDefinition, ProviderProfile } from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { AiModelSettingsPage } from "./AiModelSettingsPage";

const catalog: ProviderDefinition[] = [
  {
    id: "openai",
    label: "OpenAI",
    apiMode: "openai_chat_completions",
    authMode: "bearer",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-mini",
    models: ["gpt-4.1-mini"],
    capabilities: { structuredJson: false, thinkingMode: "none", modelDiscovery: false, webGrounding: "unsupported" },
  },
  {
    id: "custom",
    label: "自定义兼容端点",
    apiMode: "openai_chat_completions",
    authMode: "bearer",
    defaultBaseUrl: "",
    defaultModel: "",
    models: [],
    capabilities: { structuredJson: false, thinkingMode: "none", modelDiscovery: false, webGrounding: "unsupported" },
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
    ...overrides,
  };
}

describe("AiModelSettingsPage", () => {
  it("保存并启用时提交 apiKey 且提交后清空输入框", async () => {
    const user = userEvent.setup();
    const saveProviderProfile = vi.fn<ApiClient["saveProviderProfile"]>().mockResolvedValue(makeProfile());
    renderSettings(baseApi({ saveProviderProfile }));

    expect(await screen.findByRole("heading", { name: "AI 模型设置" })).toBeInTheDocument();
    const keyInput = screen.getByLabelText("API Key");
    await user.type(keyInput, "sk-secret");
    await user.click(screen.getByRole("button", { name: "保存并启用" }));

    await waitFor(() => expect(saveProviderProfile).toHaveBeenCalledTimes(1));
    expect(saveProviderProfile.mock.calls[0][0]).toMatchObject({
      providerId: "openai",
      model: "gpt-4.1-mini",
      apiKey: "sk-secret",
      activate: true,
    });
    expect(keyInput).toHaveValue("");
    expect(await screen.findByText("已保存并启用")).toBeInTheDocument();
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
});
