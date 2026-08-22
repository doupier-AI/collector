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

describe("SemanticSearchSettingsPage #67 修复/切档/重建入口", () => {
  it("失败且可重试的档位发出 retry-download 命令", async () => {
    const user = userEvent.setup();
    const failed = status({
      runtimeState: "failed",
      installations: [
        { profile: "standard", state: "failed", downloadedBytes: 3, totalBytes: 1_179_663_362, canCancel: false, canRetry: true },
        { profile: "lightweight", state: "not-installed", downloadedBytes: 0, totalBytes: 94_851_877, canCancel: false, canRetry: false },
      ],
    });
    const executeSemanticSearchCommand = vi.fn(async () => failed);
    renderPage({ getSemanticSearchStatus: vi.fn(async () => failed), executeSemanticSearchCommand });

    const standard = await screen.findByRole("region", { name: "标准档" });
    await user.click(within(standard).getByRole("button", { name: "重试下载标准档" }));
    await waitFor(() => expect(executeSemanticSearchCommand).toHaveBeenCalledWith({ type: "retry-download", profile: "standard" }));
  });

  it("已安装但未选用的档位可以通过 select-profile 切换", async () => {
    const user = userEvent.setup();
    const configured = status({
      configuredProfile: "standard",
      runtimeState: "ready",
      installations: [
        { profile: "standard", state: "installed", downloadedBytes: 1_179_663_362, totalBytes: 1_179_663_362, canCancel: false, canRetry: false },
        { profile: "lightweight", state: "installed", downloadedBytes: 94_851_877, totalBytes: 94_851_877, canCancel: false, canRetry: false },
      ],
    });
    const executeSemanticSearchCommand = vi.fn(async () => configured);
    renderPage({ getSemanticSearchStatus: vi.fn(async () => configured), executeSemanticSearchCommand });

    const lightweight = await screen.findByRole("region", { name: "轻量档" });
    await user.click(within(lightweight).getByRole("button", { name: "使用轻量档" }));
    await waitFor(() => expect(executeSemanticSearchCommand).toHaveBeenCalledWith({ type: "select-profile", profile: "lightweight" }));
  });

  it("用户可以手动发出 rebuild-index 命令", async () => {
    const user = userEvent.setup();
    const ready = status({
      runtimeState: "ready",
      installations: [
        { profile: "standard", state: "installed", downloadedBytes: 1_179_663_362, totalBytes: 1_179_663_362, canCancel: false, canRetry: false },
        { profile: "lightweight", state: "not-installed", downloadedBytes: 0, totalBytes: 94_851_877, canCancel: false, canRetry: false },
      ],
    });
    const executeSemanticSearchCommand = vi.fn(async () => ready);
    renderPage({ getSemanticSearchStatus: vi.fn(async () => ready), executeSemanticSearchCommand });

    await user.click(await screen.findByRole("button", { name: "重新建立索引" }));
    await waitFor(() => expect(executeSemanticSearchCommand).toHaveBeenCalledWith({ type: "rebuild-index" }));
  });
});

describe("SemanticSearchSettingsPage 下载代理与源不可达提示", () => {
  it("保存代理发出 set-download-proxy 命令并回显脱敏出口", async () => {
    const user = userEvent.setup();
    const base = status();
    const withProxy = { ...base, downloadProxy: { configured: true, preview: "http://***@127.0.0.1:7890/" } };
    const getSemanticSearchStatus = vi.fn(async () => base);
    const executeSemanticSearchCommand = vi.fn(async () => withProxy);
    renderPage({ getSemanticSearchStatus, executeSemanticSearchCommand });

    await screen.findByRole("heading", { name: "语义搜索" });
    expect(screen.getByText(/未配置，直接连接模型源/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("下载代理地址"), "http://user:secret@127.0.0.1:7890");
    await user.click(screen.getByRole("button", { name: "保存代理" }));
    await waitFor(() => expect(executeSemanticSearchCommand).toHaveBeenCalledWith({ type: "set-download-proxy", proxyUrl: "http://user:secret@127.0.0.1:7890" }));
    expect(await screen.findByText(/已配置（http:\/\/\*\*\*@127.0.0.1:7890\/）/)).toBeInTheDocument();
  });

  it("源不可达失败显示明确的网络原因与代理指引", async () => {
    const failed = status({
      installations: [
        { profile: "standard", state: "failed", downloadedBytes: 0, totalBytes: 1_179_663_362, canCancel: false, canRetry: true, errorCode: "model-source-unreachable" },
        { profile: "lightweight", state: "not-installed", downloadedBytes: 0, totalBytes: 94_851_877, canCancel: false, canRetry: false },
      ],
    });
    renderPage({ getSemanticSearchStatus: vi.fn(async () => failed), executeSemanticSearchCommand: vi.fn(async () => failed) });

    const standard = await screen.findByRole("region", { name: "标准档" });
    expect(within(standard).getByText(/无法连接模型下载源/)).toBeInTheDocument();
    expect(within(standard).getByText(/下载代理/)).toBeInTheDocument();
  });
});
