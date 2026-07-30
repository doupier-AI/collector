import { beforeEach, describe, expect, it } from "vitest";
import type { RangeLike, SelectionContentContext } from "./selection-capture";
import { captureSelection, readContentContext, resolveBlockRange, textOffsetWithin } from "./selection-capture";

function buildMessageContainer(blockTexts: string[]): HTMLElement {
  const container = document.createElement("div");
  container.setAttribute("data-content-kind", "message");
  container.setAttribute("data-message-id", "m-out");
  blockTexts.forEach((text, ordinal) => {
    const paragraph = document.createElement("p");
    paragraph.setAttribute("data-block-id", `m-out#p${ordinal}`);
    paragraph.setAttribute("data-block-text", "true");
    paragraph.textContent = text;
    container.appendChild(paragraph);
  });
  document.body.appendChild(container);
  return container;
}

function buildSnapshotContainer(): HTMLElement {
  const container = document.createElement("article");
  container.setAttribute("data-content-kind", "snapshot");
  container.setAttribute("data-content-snapshot-id", "snap-1");
  const first = document.createElement("section");
  first.setAttribute("data-block-id", "b-1");
  first.innerHTML = '<p class="reading__anchor">第 1 行</p>';
  const firstText = document.createElement("p");
  firstText.setAttribute("data-block-text", "true");
  firstText.textContent = "第一章的正文段落，介绍背景。";
  first.appendChild(firstText);
  const second = document.createElement("section");
  second.setAttribute("data-block-id", "b-2");
  const secondText = document.createElement("p");
  secondText.setAttribute("data-block-text", "true");
  secondText.textContent = "第二章的正文段落。";
  second.appendChild(secondText);
  container.append(first, second);
  document.body.appendChild(container);
  return container;
}

function rangeWithin(
  startNode: Node,
  startOffset: number,
  endNode: Node,
  endOffset: number,
  text: string,
  collapsed = false,
): RangeLike {
  return { collapsed, startContainer: startNode, startOffset, endContainer: endNode, endOffset, toString: () => text };
}

const messageContext = (): SelectionContentContext => ({
  kind: "message",
  messageId: "m-out",
  blockIds: ["m-out#p0", "m-out#p1"],
  blockTexts: ["Alpha 段落一的内容。", "Beta 段落二的内容。"],
});

describe("readContentContext", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("从消息容器读取块 id 与块文本", () => {
    const container = buildMessageContainer(["第一段。", "第二段。"]);
    expect(readContentContext(container)).toEqual({
      kind: "message",
      messageId: "m-out",
      contentSnapshotId: undefined,
      blockIds: ["m-out#p0", "m-out#p1"],
      blockTexts: ["第一段。", "第二段。"],
    });
  });

  it("快照容器的块文本只取正文元素，不包含行号标注", () => {
    const container = buildSnapshotContainer();
    const context = readContentContext(container);
    expect(context?.kind).toBe("snapshot");
    expect(context?.contentSnapshotId).toBe("snap-1");
    expect(context?.blockIds).toEqual(["b-1", "b-2"]);
    expect(context?.blockTexts).toEqual(["第一章的正文段落，介绍背景。", "第二章的正文段落。"]);
  });

  it("缺少必要标记时不形成上下文", () => {
    const bare = document.createElement("div");
    bare.setAttribute("data-content-kind", "message");
    expect(readContentContext(bare)).toBeUndefined();
    const plain = document.createElement("div");
    expect(readContentContext(plain)).toBeUndefined();
  });
});

describe("resolveBlockRange", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("单块选区折算为去首尾空白后的块内偏移", () => {
    const blockText = "  选区前后有空白  ";
    const container = buildMessageContainer([blockText]);
    const context: SelectionContentContext = {
      kind: "message",
      messageId: "m-out",
      blockIds: ["m-out#p0"],
      blockTexts: [blockText],
    };
    const node = container.querySelector("[data-block-id='m-out#p0']")!.firstChild!;
    const range = rangeWithin(node, 0, node, blockText.length, blockText);

    const resolved = resolveBlockRange(range, context);
    expect(resolved).toEqual({
      startBlockId: "m-out#p0",
      endBlockId: "m-out#p0",
      startOffset: 2,
      endOffset: blockText.trimEnd().length,
      text: "选区前后有空白",
      blockCount: 1,
    });
  });

  it("折叠、纯空白或落在标注文本上的选区不形成范围", () => {
    const context = messageContext();
    const container = buildMessageContainer(context.blockTexts);
    const node = container.querySelector("[data-block-id='m-out#p0']")!.firstChild!;

    expect(resolveBlockRange(rangeWithin(node, 2, node, 2, "", true), context)).toBeUndefined();

    // 纯空白选区：块文本本身以空白开头，只选中该空白时不形成范围
    const spaceContext: SelectionContentContext = {
      kind: "message",
      messageId: "m-out",
      blockIds: ["m-out#p0"],
      blockTexts: [" 前导空白的段落。"],
    };
    expect(resolveBlockRange(rangeWithin(node, 0, node, 1, " "), spaceContext)).toBeUndefined();

    // 行号标注段落没有 data-block-text 标记，其上的选区不参与捕获
    const section = document.createElement("section");
    section.setAttribute("data-block-id", "b-1");
    const caption = document.createElement("p");
    caption.textContent = "第 1 行";
    section.appendChild(caption);
    container.appendChild(section);
    expect(
      resolveBlockRange(rangeWithin(caption.firstChild!, 0, caption.firstChild!, 3, "第 1 行"), context),
    ).toBeUndefined();
  });

  it("跨块选区返回块数与原文，不折算锚点偏移", () => {
    const context = messageContext();
    const container = buildMessageContainer(context.blockTexts);
    const startNode = container.querySelector("[data-block-id='m-out#p0']")!.firstChild!;
    const endNode = container.querySelector("[data-block-id='m-out#p1']")!.firstChild!;
    const text = "段落一的内容。\nBeta 段落二";

    const resolved = resolveBlockRange(rangeWithin(startNode, 6, endNode, 7, text), context);
    expect(resolved?.blockCount).toBe(2);
    expect(resolved?.text).toBe(text);
    expect(resolved?.startBlockId).toBe("m-out#p0");
    expect(resolved?.endBlockId).toBe("m-out#p1");
  });
});

describe("captureSelection", () => {
  it("单块消息选区生成带上下文的锚点，exact 与偏移严格对应", () => {
    const context = messageContext();
    const captured = captureSelection(
      { startBlockId: "m-out#p0", endBlockId: "m-out#p0", startOffset: 6, endOffset: 9, text: "段落一", blockCount: 1 },
      context,
    );
    expect(captured.anchor).toEqual({
      kind: "message",
      messageId: "m-out",
      blockOrdinal: 0,
      startOffset: 6,
      endOffset: 9,
      exact: "段落一",
      prefix: "Alpha ",
      suffix: "的内容。",
    });
  });

  it("快照选区锚点使用块 id，上下文按 120 字截断", () => {
    const longBefore = "前".repeat(200);
    const context: SelectionContentContext = {
      kind: "snapshot",
      contentSnapshotId: "snap-1",
      blockIds: ["b-1"],
      blockTexts: [`${longBefore}核心句子`],
    };
    const captured = captureSelection(
      {
        startBlockId: "b-1",
        endBlockId: "b-1",
        startOffset: 200,
        endOffset: 204,
        text: "核心句子",
        blockCount: 1,
      },
      context,
    );
    expect(captured.anchor?.kind).toBe("snapshot");
    if (captured.anchor?.kind !== "snapshot") return;
    expect(captured.anchor.blockId).toBe("b-1");
    expect(captured.anchor.contentSnapshotId).toBe("snap-1");
    expect(captured.anchor.prefix).toHaveLength(120);
    expect(captured.anchor.suffix).toBeUndefined();
  });

  it("跨块范围不生成锚点", () => {
    const context = messageContext();
    const captured = captureSelection(
      { startBlockId: "m-out#p0", endBlockId: "m-out#p1", startOffset: 0, endOffset: 4, text: "跨块原文", blockCount: 2 },
      context,
    );
    expect(captured.anchor).toBeUndefined();
  });
});

describe("textOffsetWithin", () => {
  it("嵌套元素按文档顺序累加文本长度", () => {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = "const a = 1;";
    pre.appendChild(code);
    const textNode = code.firstChild!;

    expect(textOffsetWithin(pre, textNode, 6)).toBe(6);
    expect(textOffsetWithin(pre, code, 1)).toBe("const a = 1;".length);
    expect(textOffsetWithin(pre, pre, 1)).toBe("const a = 1;".length);
  });

  it("节点不在根内时返回 undefined", () => {
    const root = document.createElement("p");
    const outsider = document.createElement("span");
    outsider.textContent = "外部";
    expect(textOffsetWithin(root, outsider.firstChild!, 1)).toBeUndefined();
  });
});
