import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { AiConfigurationView, ProviderProfile } from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { ModelStatusIndicator } from "./ModelStatusIndicator";

function makeProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  const now = "2026-07-29T00:00:00.000Z";
  return {
    id: "profile-1",
    providerId: "openai",
    displayName: "主配置",
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

const activeConfig: AiConfigurationView = {
  consent: true,
  configured: true,
  mode: "real",
  provider: "openai",
  model: "gpt-4.1-mini",
  providerProfileId: "profile-1",
};

function renderIndicator(api: Partial<ApiClient>) {
  const services = { api: api as ApiClient } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <MemoryRouter>
        <ModelStatusIndicator />
      </MemoryRouter>
    </ServicesProvider>,
  );
}

describe("ModelStatusIndicator 快速切换", () => {
  it("点击状态点展开已保存配置并直接切换当前模型", async () => {
    const user = userEvent.setup();
    const backup = makeProfile({ id: "profile-2", displayName: "备用配置", model: "gpt-4.1" });
    const activateProviderProfile = vi.fn<ApiClient["activateProviderProfile"]>().mockResolvedValue(backup);
    const getAiConfiguration = vi.fn<ApiClient["getAiConfiguration"]>()
      .mockResolvedValueOnce(activeConfig)
      .mockResolvedValue({ ...activeConfig, model: "gpt-4.1", providerProfileId: "profile-2" });
    renderIndicator({
      getAiConfiguration,
      listProviderProfiles: vi.fn<ApiClient["listProviderProfiles"]>().mockResolvedValue([makeProfile(), backup]),
      activateProviderProfile,
    });

    const toggle = await screen.findByRole("button", { name: /模型：openai · gpt-4.1-mini/ });
    await user.click(toggle);

    const current = await screen.findByRole("menuitem", { name: /主配置（openai · gpt-4.1-mini） · 当前/ });
    expect(current).toBeDisabled();

    await user.click(screen.getByRole("menuitem", { name: /备用配置（openai · gpt-4.1）/ }));
    await waitFor(() => expect(activateProviderProfile).toHaveBeenCalledWith("profile-2"));
    expect(await screen.findByRole("button", { name: /模型：openai · gpt-4.1/ })).toBeInTheDocument();
  });

  it("无可用配置时展示空态并保留设置入口", async () => {
    const user = userEvent.setup();
    renderIndicator({
      getAiConfiguration: vi.fn<ApiClient["getAiConfiguration"]>().mockResolvedValue({ consent: false, configured: false, mode: "unconfigured" }),
      listProviderProfiles: vi.fn<ApiClient["listProviderProfiles"]>().mockResolvedValue([]),
    });

    await user.click(await screen.findByRole("button", { name: /未配置模型/ }));
    expect(await screen.findByText("还没有可用的模型配置")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "模型设置…" })).toHaveAttribute("href", "/settings/ai-model");
  });

  it("配置无效时展示具体失败原因而不是通用未配置文案", async () => {
    renderIndicator({
      getAiConfiguration: vi.fn<ApiClient["getAiConfiguration"]>()
        .mockResolvedValue({ consent: true, configured: true, mode: "real", providerProfileId: "profile-1", modelError: "当前模型配置缺少 API Key。请在模型设置中补充凭证。" }),
      listProviderProfiles: vi.fn<ApiClient["listProviderProfiles"]>().mockResolvedValue([]),
    });

    expect(await screen.findByRole("button", { name: /模型不可用：当前模型配置缺少 API Key/ })).toBeInTheDocument();
  });

  it("点击遮罩或按 Escape 关闭菜单", async () => {
    const user = userEvent.setup();
    renderIndicator({
      getAiConfiguration: vi.fn<ApiClient["getAiConfiguration"]>().mockResolvedValue(activeConfig),
      listProviderProfiles: vi.fn<ApiClient["listProviderProfiles"]>().mockResolvedValue([makeProfile()]),
    });

    const toggle = await screen.findByRole("button", { name: /模型：openai/ });
    await user.click(toggle);
    expect(await screen.findByRole("menu")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "关闭模型切换菜单" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(toggle);
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
