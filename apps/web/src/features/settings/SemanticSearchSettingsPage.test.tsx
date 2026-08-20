import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SemanticSearchStatusView } from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import { ServicesProvider } from "../../app/services";
import type { AppServices } from "../../app/services";
import { SemanticSearchSettingsPage } from "./SemanticSearchSettingsPage";

function status(overrides: Partial<SemanticSearchStatusView> = {}): SemanticSearchStatusView {
  return {
    configuredProfile: "standard",
    runtimeState: "model-missing",
    installations: [
      { profile: "standard", state: "not-installed", downloadedBytes: 0, totalBytes: 1_179_663_362, canCancel: false, canRetry: false },
      { profile: "lightweight", state: "not-installed", downloadedBytes: 0, totalBytes: 94_851_877, canCancel: false, canRetry: false },
    ],
    ...overrides,
  };
}

function renderPage(api: Partial<ApiClient>) {
  const services = {
    api: api as ApiClient,
    connectTaskEvents: vi.fn(),
  } as unknown as AppServices;
  return render(
    <ServicesProvider services={services}>
      <SemanticSearchSettingsPage />
    </ServicesProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SemanticSearchSettingsPage #67 语义搜索设置", () => {
  it("只读取状态，不会在打开页面时自动下载、选择或重建", async () => {
    const getSemanticSearchStatus = vi.fn(async () => status());
    const executeSemanticSearchCommand = vi.fn(async () => status());
    renderPage({ getSemanticSearchStatus, executeSemanticSearchCommand });

    expect(await screen.findByRole("heading", { name: "语义搜索" })).toBeInTheDocument();
    await waitFor(() => expect(getSemanticSearchStatus).toHaveBeenCalledTimes(1));
    expect(executeSemanticSearchCommand).not.toHaveBeenCalled();
    expect(screen.getByText(/全部在这台电脑上运行/)).toBeInTheDocument();
    expect(screen.getByText(/不会自动下载/)).toBeInTheDocument();
  });

  it("只有用户明确点击后才下载并启用对应档位", async () => {
    const user = userEvent.setup();
    const getSemanticSearchStatus = vi.fn(async () => status());
    const executeSemanticSearchCommand = vi.fn(async () => status({ configuredProfile: "lightweight" }));
    renderPage({ getSemanticSearchStatus, executeSemanticSearchCommand });

    const lightweight = await screen.findByRole("region", { name: "轻量档" });
    await user.click(within(lightweight).getByRole("button", { name: "下载并启用轻量档" }));
    await waitFor(() => expect(executeSemanticSearchCommand).toHaveBeenCalledWith({ type: "download-profile", profile: "lightweight" }));
  });

  it("呈现下载与索引状态，并能取消明确由用户开始的下载", async () => {
    const user = userEvent.setup();
    const downloading = status({
      runtimeState: "model-downloading",
      installations: [
        { profile: "standard", state: "downloading", downloadedBytes: 590_000_000, totalBytes: 1_179_663_362, canCancel: true, canRetry: false },
        { profile: "lightweight", state: "installed", downloadedBytes: 94_851_877, totalBytes: 94_851_877, canCancel: false, canRetry: false },
      ],
      indexProgress: { completedUnits: 7, totalUnits: 12 },
    });
    const executeSemanticSearchCommand = vi.fn(async () => downloading);
    renderPage({ getSemanticSearchStatus: vi.fn(async () => downloading), executeSemanticSearchCommand });

    const standard = await screen.findByRole("region", { name: "标准档" });
    expect(within(standard).getByText(/已下载.*590/)).toBeInTheDocument();
    expect(screen.getByText("索引进度：7 / 12")).toBeInTheDocument();
    await user.click(within(standard).getByRole("button", { name: "取消标准档下载" }));
    await waitFor(() => expect(executeSemanticSearchCommand).toHaveBeenCalledWith({ type: "cancel-download", profile: "standard" }));
  });

  it("删除本地模型前要求确认；取消确认时不会发出删除命令", async () => {
    const user = userEvent.setup();
    const installed = status({
      runtimeState: "ready",
      installations: [
        { profile: "standard", state: "installed", downloadedBytes: 1_179_663_362, totalBytes: 1_179_663_362, canCancel: false, canRetry: false },
        { profile: "lightweight", state: "not-installed", downloadedBytes: 0, totalBytes: 94_851_877, canCancel: false, canRetry: false },
      ],
    });
    const executeSemanticSearchCommand = vi.fn(async () => installed);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage({ getSemanticSearchStatus: vi.fn(async () => installed), executeSemanticSearchCommand });

    const standard = await screen.findByRole("region", { name: "标准档" });
    await user.click(within(standard).getByRole("button", { name: "删除标准档" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(executeSemanticSearchCommand).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await user.click(within(standard).getByRole("button", { name: "删除标准档" }));
    await waitFor(() => expect(executeSemanticSearchCommand).toHaveBeenCalledWith({ type: "delete-profile", profile: "standard" }));
  });
});
