import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client";
import { ApiRequestError } from "../../api/errors";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { FusionSettingsPage } from "./FusionSettingsPage";

function renderPage(api: Partial<ApiClient>) {
  const services = {
    api: api as ApiClient,
    connectTaskEvents: vi.fn(),
  } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <FusionSettingsPage />
    </ServicesProvider>,
  );
}

describe("FusionSettingsPage #32 自动融合设置", () => {
  it("读取开关状态并渲染为复选框（默认关闭）", async () => {
    const getFusionAutoConfig = vi.fn(async () => ({ enabled: false }));
    renderPage({ getFusionAutoConfig });
    await waitFor(() => expect(getFusionAutoConfig).toHaveBeenCalled());
    const checkbox = await screen.findByRole("checkbox", { name: /自动融合/ });
    expect(checkbox).not.toBeChecked();
  });

  it("点击开启调用 updateFusionAutoConfig(true) 并反映为已勾选", async () => {
    const user = userEvent.setup();
    const getFusionAutoConfig = vi.fn(async () => ({ enabled: false }));
    const updateFusionAutoConfig = vi.fn(async () => ({ enabled: true }));
    renderPage({ getFusionAutoConfig, updateFusionAutoConfig });
    const checkbox = await screen.findByRole("checkbox", { name: /自动融合/ });
    await user.click(checkbox);
    await waitFor(() => expect(updateFusionAutoConfig).toHaveBeenCalledWith(true));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /自动融合/ })).toBeChecked());
  });

  it("保存失败显示错误文案且复选框保持原状态", async () => {
    const user = userEvent.setup();
    const getFusionAutoConfig = vi.fn(async () => ({ enabled: false }));
    const updateFusionAutoConfig = vi.fn(async () => {
      throw new ApiRequestError(400, "invalid_body", "enabled must be a boolean");
    });
    renderPage({ getFusionAutoConfig, updateFusionAutoConfig });
    const checkbox = await screen.findByRole("checkbox", { name: /自动融合/ });
    await user.click(checkbox);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /自动融合/ })).not.toBeChecked();
  });

  it("客户端方法缺失时给出明确提示", async () => {
    renderPage({});
    expect(await screen.findByRole("alert")).toHaveTextContent(/不支持自动融合设置/);
  });
});
