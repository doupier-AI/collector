import { render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { AiConfigurationView, ComposerPreferences } from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import { ServicesProvider, type AppServices } from "../../app/services";
import { ChatComposer } from "./ChatComposer";
import { loadDraft } from "./draft";
import { notifyAiConfigurationChanged } from "../research-session/ai-configuration-events";

const supportedConfig: AiConfigurationView = {
  consent: true,
  configured: true,
  mode: "real",
  provider: "deepseek",
  model: "deepseek-chat",
  providerProfileId: "profile-1",
  routes: {
    chat: { provider: "deepseek", model: "deepseek-chat", providerProfileId: "profile-1", thinkingSupported: true },
    research: { provider: "deepseek", model: "deepseek-chat", providerProfileId: "profile-1", thinkingSupported: true },
  },
};

function renderWithServices(ui: ReactNode, api: Partial<ApiClient> = {}) {
  const services = {
    api: { getAiConfiguration: async () => supportedConfig, ...api } as ApiClient,
  } as unknown as AppServices;
  return render(<ServicesProvider services={services}>{ui}</ServicesProvider>);
}

function renderComposer(onSubmit: (content: string, options: ComposerPreferences) => Promise<boolean>, scope = "test-scope") {
  renderWithServices(<ChatComposer draftScope={scope} submitLabel="发送" onSubmit={onSubmit} />);
}

describe("ChatComposer", () => {
  it("后端确认前保留输入文字，确认后清空", async () => {
    const user = userEvent.setup();
    let release!: (accepted: boolean) => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    renderComposer(onSubmit);

    const textarea = screen.getByLabelText("你的问题");
    await user.type(textarea, "什么是本地优先");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(onSubmit).toHaveBeenCalledWith("什么是本地优先", { allowWebSearch: false, thinkingEnabled: false });
    expect(textarea).toHaveValue("什么是本地优先");

    release(true);
    await waitFor(() => expect(textarea).toHaveValue(""));
  });

  it("提交失败保留文字并提示尚未确认保存", async () => {
    const user = userEvent.setup();
    renderComposer(async () => false);

    const textarea = screen.getByLabelText("你的问题");
    await user.type(textarea, "保留这段草稿");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("尚未确认保存，请检查连接后重试。")).toBeInTheDocument();
    expect(textarea).toHaveValue("保留这段草稿");
  });

  it("空输入禁用发送，输入后可用", async () => {
    const user = userEvent.setup();
    renderComposer(async () => true);

    const button = screen.getByRole("button", { name: "发送" });
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText("你的问题"), "  ");
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText("你的问题"), "一个问题");
    expect(button).toBeEnabled();
  });

  it("Enter 发送，Shift+Enter 换行不发送", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => true);
    renderComposer(onSubmit);

    const textarea = screen.getByLabelText("你的问题");
    await user.click(textarea);
    await user.keyboard("第一行");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onSubmit).not.toHaveBeenCalled();

    await user.keyboard("第二行");
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("草稿写入带版本的本地存储，确认成功后清除", async () => {
    const user = userEvent.setup();
    renderComposer(async () => true, "draft-scope");

    const textarea = screen.getByLabelText("你的问题");
    await user.type(textarea, "未发送的内容");
    expect(loadDraft("draft-scope")).toBe("未发送的内容");

    const raw = window.localStorage.getItem("collector.web.draft.v1");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { version: number };
    expect(parsed.version).toBe(1);

    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(loadDraft("draft-scope")).toBe(""));
  });

  it("附件按钮功能未就绪，点击显示克制提示，再次点击收起", async () => {
    const user = userEvent.setup();
    renderComposer(async () => true);

    const attach = screen.getByRole("button", { name: "添加附件（后续版本提供）" });
    await user.click(attach);
    expect(await screen.findByText("附件等功能将在后续版本提供")).toBeInTheDocument();

    await user.click(attach);
    expect(screen.queryByText("附件等功能将在后续版本提供")).not.toBeInTheDocument();
  });

  it("提供 onImportFile 时附件按钮打开文件选择，选中后回传文件", async () => {
    const user = userEvent.setup();
    const onImportFile = vi.fn();
    const { container } = renderWithServices(
      <ChatComposer
        draftScope="import-scope"
        submitLabel="发送"
        onSubmit={async () => true}
        onImportFile={onImportFile}
        importAccept=".txt,.md,.markdown,.docx,.pdf"
      />,
    );

    const attach = screen.getByRole("button", { name: /添加附件/ });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    expect(input!.accept).toBe(".txt,.md,.markdown,.docx,.pdf");

    const clickSpy = vi.spyOn(input!, "click").mockImplementation(() => {});
    await user.click(attach);
    expect(clickSpy).toHaveBeenCalled();

    const file = new File(["你好"], "笔记.txt", { type: "text/plain" });
    fireEvent.change(input!, { target: { files: [file] } });
    expect(onImportFile).toHaveBeenCalledWith(file);
    // 同一文件可再次选择（input 值已清空）
    expect(input!.value).toBe("");
  });

  it("键盘提示在输入框外并保持与输入框的无障碍关联", () => {
    renderComposer(async () => true);

    const hint = screen.getByText("Enter 发送，Shift+Enter 换行");
    const textarea = screen.getByLabelText("你的问题");
    expect(hint).not.toBeNull();
    expect(textarea.getAttribute("aria-describedby")).toContain(hint.id);
  });

  it("联网开关默认关闭，并把用户本次选择传给提交回调", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => true);
    renderComposer(onSubmit, "web-search-toggle");

    const toggle = screen.getByRole("button", { name: "开启联网搜索" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(screen.getByRole("button", { name: "关闭联网搜索" })).toHaveAttribute("aria-pressed", "true");
    await user.type(screen.getByLabelText("你的问题"), "查一下最新资料");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(onSubmit).toHaveBeenCalledWith("查一下最新资料", { allowWebSearch: true, thinkingEnabled: false });
  });

  it("模型不支持时保留深度思考偏好，切回支持模型后自动恢复可用", async () => {
    const user = userEvent.setup();
    renderComposer(async () => true, "thinking-capability");

    const thinking = await screen.findByRole("button", { name: "开启深度思考" });
    await user.click(thinking);
    expect(screen.getByRole("button", { name: "关闭深度思考" })).toHaveAttribute("aria-pressed", "true");

    notifyAiConfigurationChanged({
      ...supportedConfig,
      routes: {
        ...supportedConfig.routes!,
        chat: { provider: "openai", model: "unknown-model", providerProfileId: "profile-2", thinkingSupported: false },
      },
    });
    expect(await screen.findByRole("button", { name: /深度思考偏好已开启：当前模型/ })).toHaveAttribute("aria-pressed", "true");

    notifyAiConfigurationChanged(supportedConfig);
    expect(await screen.findByRole("button", { name: "关闭深度思考" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("ChatComposer 双模发送（阶段 H4a）", () => {
  const citedSelection = {
    text: "一段被引用的选区文字",
    selectionId: "sel-1",
    anchor: {
      kind: "message" as const,
      messageId: "m-out",
      blockOrdinal: 0,
      startOffset: 0,
      endOffset: 10,
      exact: "一段被引用的选区文字",
    },
  };

  it("有引用时显示胶囊与双模按钮，无普通发送按钮", () => {
    renderWithServices(
      <ChatComposer
        draftScope="test"
        submitLabel="发送"
        onSubmit={async () => true}
        citedSelection={citedSelection}
        onRemoveCitation={() => {}}
        onStartChildNode={async () => true}
      />,
    );

    expect(screen.getByTestId("selection-capsule")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "在此追问" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "深入研究这段" })).toBeInTheDocument();
    // 普通圆形发送按钮被替换
    expect(screen.queryByRole("button", { name: "发送" })).not.toBeInTheDocument();
  });

  it("在此追问：携带选区文本作为引用上下文发送", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async (_content: string) => true);
    renderWithServices(
      <ChatComposer
        draftScope="test"
        submitLabel="发送"
        onSubmit={onSubmit}
        citedSelection={citedSelection}
        onRemoveCitation={() => {}}
        onStartChildNode={async () => true}
      />,
    );

    await user.type(screen.getByLabelText("你的问题"), "这段内容怎么理解？");
    await user.click(screen.getByRole("button", { name: "在此追问" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [content] = onSubmit.mock.calls[0];
    // 选区原文以引用格式进入消息内容
    expect(content).toContain("> 一段被引用的选区文字");
    expect(content).toContain("这段内容怎么理解？");
  });

  it("深入研究这段：调用 onStartChildNode，不需要输入也可点击", async () => {
    const user = userEvent.setup();
    const onStartChildNode = vi.fn(async () => true);
    renderWithServices(
      <ChatComposer
        draftScope="test"
        submitLabel="发送"
        onSubmit={async () => true}
        citedSelection={citedSelection}
        onRemoveCitation={() => {}}
        onStartChildNode={onStartChildNode}
      />,
    );

    // 不输入任何内容也可以点击"深入研究这段"
    const growButton = screen.getByRole("button", { name: "深入研究这段" });
    expect(growButton).toBeEnabled();
    await user.click(growButton);

    expect(onStartChildNode).toHaveBeenCalledTimes(1);
    expect(onStartChildNode).toHaveBeenCalledWith("", { allowWebSearch: false, thinkingEnabled: false });
  });

  it("深入研究这段：输入框有内容时作为 query 传入", async () => {
    const user = userEvent.setup();
    const onStartChildNode = vi.fn(async () => true);
    renderWithServices(
      <ChatComposer
        draftScope="test"
        submitLabel="发送"
        onSubmit={async () => true}
        citedSelection={citedSelection}
        onRemoveCitation={() => {}}
        onStartChildNode={onStartChildNode}
      />,
    );

    await user.type(screen.getByLabelText("你的问题"), "把背后的机制讲透");
    await user.click(screen.getByRole("button", { name: "深入研究这段" }));

    expect(onStartChildNode).toHaveBeenCalledWith("把背后的机制讲透", { allowWebSearch: false, thinkingEnabled: false });
  });

  it("胶囊移除按钮触发 onRemoveCitation", async () => {
    const user = userEvent.setup();
    const onRemoveCitation = vi.fn();
    renderWithServices(
      <ChatComposer
        draftScope="test"
        submitLabel="发送"
        onSubmit={async () => true}
        citedSelection={citedSelection}
        onRemoveCitation={onRemoveCitation}
        onStartChildNode={async () => true}
      />,
    );

    await user.click(screen.getByRole("button", { name: "移除引用" }));
    expect(onRemoveCitation).toHaveBeenCalledTimes(1);
  });

  it("有引用时提示语切换为在此追问说明", () => {
    renderWithServices(
      <ChatComposer
        draftScope="test"
        submitLabel="发送"
        onSubmit={async () => true}
        citedSelection={citedSelection}
        onRemoveCitation={() => {}}
        onStartChildNode={async () => true}
      />,
    );

    expect(screen.getByText("Enter 在此追问，Shift+Enter 换行")).toBeInTheDocument();
  });

  it("Enter 在有引用时走在此追问路径", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async (_content: string) => true);
    renderWithServices(
      <ChatComposer
        draftScope="test"
        submitLabel="发送"
        onSubmit={onSubmit}
        citedSelection={citedSelection}
        onRemoveCitation={() => {}}
        onStartChildNode={async () => true}
      />,
    );

    const textarea = screen.getByLabelText("你的问题");
    await user.click(textarea);
    await user.keyboard("问题内容");
    await user.keyboard("{Enter}");

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [content] = onSubmit.mock.calls[0];
    expect(content).toContain("> 一段被引用的选区文字");
    expect(content).toContain("问题内容");
  });
});
