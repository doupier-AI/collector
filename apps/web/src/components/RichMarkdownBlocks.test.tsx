import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownContent } from "./MarkdownContent";
import { projectMarkdownVisibleText } from "./markdown-projection";

const mermaidRender = vi.fn(async (_id: string, source: string) => {
  if (source.includes("invalid-syntax")) throw new Error("parse");
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" onclick="evil()"><script>evil()</script><foreignObject>bad</foreignObject><a href="https://evil.example"><text>${source}</text></a><text>安全图形</text></svg>`,
  };
});
const mermaidInitialize = vi.fn();
const clipboardWriteText = vi.fn(async () => undefined);

function installClipboardSpy() {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWriteText },
  });
}

vi.mock("mermaid", () => ({
  default: { initialize: mermaidInitialize, render: mermaidRender },
}));

beforeEach(() => {
  mermaidRender.mockClear();
  mermaidInitialize.mockClear();
  clipboardWriteText.mockClear();
  installClipboardSpy();
});

describe("富 Markdown 块", () => {
  it("把正文显式软换行渲染为语义 br，不依赖保留结构性空白", () => {
    const { container } = render(<MarkdownContent text={"第一行\n第二行"} />);
    expect(container.querySelector("p > br")).not.toBeNull();
    expect(container.querySelector("p")).toHaveTextContent(/第一行\s+第二行/);
  });

  it("保留连续段落、紧凑与嵌套列表以及多级标题的原生结构", () => {
    const { container } = render(<MarkdownContent text={`## 主章节

第一段。

第二段。

- 并列一
- 并列二
  - 子项

### 子章节

1. 第一步
2. 第二步`} />);
    expect(screen.getByRole("heading", { level: 2, name: "主章节" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "子章节" })).toBeInTheDocument();
    expect(container.querySelectorAll("p")).toHaveLength(2);
    expect(container.querySelectorAll("ul")).toHaveLength(2);
    expect(container.querySelector("ul ul")).not.toBeNull();
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
  });

  it("代码块显示语言、使用安全 AST 样式标记并提供键盘可聚焦复制反馈", async () => {
    const user = userEvent.setup();
    installClipboardSpy();
    const { container } = render(<MarkdownContent text={'```ts\nconst answer = "safe";\n```'} />);
    expect(screen.getByText("ts")).toBeInTheDocument();
    expect(container.querySelector(".syntax-token--keyword")).toHaveTextContent("const");
    const copy = screen.getByRole("button", { name: "复制代码" });
    copy.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("button", { name: "已复制" })).toHaveFocus();
    expect(clipboardWriteText).toHaveBeenCalledWith('const answer = "safe";');
  });

  it("未知语言保持纯文本，不生成高亮节点", () => {
    const { container } = render(<MarkdownContent text={'```unknown\n<not-executed>\n```'} />);
    expect(container.querySelector(".syntax-token")).toBeNull();
    expect(container.querySelector("code")).toHaveTextContent("<not-executed>");
  });

  it("宽表格保留语义并提供可聚焦横向滚动区和数字对齐", () => {
    const { container } = render(<MarkdownContent text={`| 项目 | 数量 | 很长的说明 |
| --- | ---: | --- |
| A | 12345 | 一段需要换行的长文本 |`} />);
    const region = screen.getByRole("region", { name: "可横向滚动的表格" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region.querySelector("table")).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: "数量" })).toBeInTheDocument();
    expect(container.querySelector("td.markdown-table__numeric")).toHaveTextContent("12345");
  });

  it.each([
    ["flowchart LR\nA-->B\nclick A https://evil.example", "点击指令"],
    ["flowchart LR\nA[<b>HTML</b>]", "HTML"],
    [`flowchart LR\nA[${"x".repeat(20_100)}]`, "超长源码"],
  ])("Mermaid 拒绝恶意或超限源码：%s", async (source) => {
    render(<MarkdownContent text={`\`\`\`mermaid\n${source}\n\`\`\``} />);
    expect(await screen.findByText(/已显示原始代码/)).toBeInTheDocument();
    expect(mermaidRender).not.toHaveBeenCalled();
    expect(screen.getByText(/flowchart LR/)).toBeInTheDocument();
  });

  it("Mermaid 无效语法降级为原始代码", async () => {
    render(<MarkdownContent text={'```mermaid\ninvalid-syntax\n```'} />);
    expect(await screen.findByText(/图表语法无效或渲染失败/)).toBeInTheDocument();
    expect(screen.getByText("invalid-syntax")).toBeInTheDocument();
  });

  it("Mermaid 使用严格模式、净化 SVG，并支持查看与复制唯一源码", async () => {
    const user = userEvent.setup();
    installClipboardSpy();
    const source = "flowchart LR\nA-->B";
    const { container } = render(<MarkdownContent text={`\`\`\`mermaid\n${source}\n\`\`\``} />);
    await waitFor(() => expect(container.querySelector('svg[aria-label="Mermaid 图表"]')).not.toBeNull());
    expect(mermaidInitialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: "strict", htmlLabels: false }));
    expect(container.querySelector("script, foreignObject, a, image")).toBeNull();
    expect(container.querySelector("svg")?.hasAttribute("onclick")).toBe(false);

    await user.click(screen.getByRole("button", { name: "查看源码" }));
    expect(screen.getByRole("button", { name: "查看图表" })).toBeInTheDocument();
    expect(container.querySelector("pre code")?.textContent).toBe(source);
    await user.click(screen.getByRole("button", { name: "复制 Mermaid 源码" }));
    expect(clipboardWriteText).toHaveBeenCalledWith(source);
  });

  it("Mermaid 装饰不会改变 Markdown 可见文字的稳定投影", () => {
    const source = "flowchart LR\nA-->B";
    const text = `前文\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\n后文`;
    const projection = projectMarkdownVisibleText(text).text;
    expect(projection.match(/flowchart LR/g)).toHaveLength(1);
    expect(projection).toContain("前文");
    expect(projection).toContain("后文");
  });
});
