import { describe, expect, it } from "vitest";
import type { ResearchSelectionRecord } from "@collector/capture-contracts";
import { makeMessage, makeSelection } from "../../test/fakes";
import {
  backRouteForSelection,
  childNodeIdempotencyKey,
  highlightForMessages,
  laterIdempotencyKey,
  resolveHighlight,
  selectionExcerpt,
  setRangeFromOffsets,
} from "./selection-highlight";

describe("resolveHighlight", () => {
  const target = { startOffset: 4, endOffset: 8, exact: "本地优先" };

  it("锚点偏移切片与原文一致时直接采用锚点位置", () => {
    expect(resolveHighlight("第一段：本地优先会先保存", target)).toEqual({ start: 4, end: 8 });
  });

  it("锚点偏移不再匹配时用原文在块内重新定位", () => {
    const shifted = "前缀变长了一段：本地优先会先保存";
    const index = shifted.indexOf("本地优先");
    expect(resolveHighlight(shifted, target)).toEqual({ start: index, end: index + 4 });
  });

  it("原文在块中不存在时返回 null，交由调用方降级", () => {
    expect(resolveHighlight("完全不同的段落内容", target)).toBeNull();
  });
});

describe("setRangeFromOffsets", () => {
  it("选区跨过术语弱标记时仍能高亮且不改变正文文字", () => {
    const root = document.createElement("p");
    root.innerHTML = '前<span class="term-marker" data-term-marker data-term-category="abbreviation">REST</span>后';
    document.body.appendChild(root);
    const before = root.textContent;

    expect(setRangeFromOffsets(root, 0, 5)).toBe(true);
    expect(root.textContent).toBe(before);
    expect(root.querySelector("[data-selection-mark]")?.textContent).toBe("前REST");
    expect(root.querySelector("[data-term-marker]")).not.toBeNull();
  });
});

describe("backRouteForSelection", () => {
  it("消息选区带节点归属时回到所属节点的稳定地址并携带选区参数", () => {
    const selection = makeSelection({ id: "sel-3", sessionId: "session-1", nodeId: "node-child-1" });
    expect(backRouteForSelection(selection)).toBe("/nodes/node-child-1?sel=sel-3");
  });

  it("消息选区无节点归属（旧数据）时回到根节点稳定地址，行为与现状一致", () => {
    const selection = makeSelection({ id: "sel-1", sessionId: "session-1" });
    expect(backRouteForSelection(selection)).toBe("/nodes/session-1?sel=sel-1");
  });

  it("快照选区回到阅读页并携带选区参数", () => {
    const selection: ResearchSelectionRecord = makeSelection({
      id: "sel-2",
      sessionId: "session-1",
      anchor: {
        kind: "snapshot",
        contentSnapshotId: "snap-1",
        blockId: "block-1",
        startOffset: 0,
        endOffset: 6,
        exact: "一段选区文字",
      },
    });
    expect(backRouteForSelection(selection)).toBe("/research/session-1/reading/snap-1?sel=sel-2");
  });
});

describe("selectionExcerpt", () => {
  it("短文本原样返回，长文本截断并加省略号", () => {
    expect(selectionExcerpt("  简短选区  ")).toBe("简短选区");
    const long = "这".repeat(60);
    const excerpt = selectionExcerpt(long, 48);
    expect(excerpt).toHaveLength(49);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});

describe("highlightForMessages", () => {
  const message = makeMessage({
    id: "m-out",
    role: "assistant",
    status: "completed",
    content: "第一段讲本地优先。\n\n第二段讲渐进事件。",
  });

  it("锚点有效时返回消息、块与高亮范围", () => {
    const result = highlightForMessages([message], undefined, {
      kind: "message",
      messageId: "m-out",
      blockOrdinal: 1,
      startOffset: 0,
      endOffset: 3,
      exact: "第二段",
    }, "第二段");
    expect(result).toEqual({
      kind: "found",
      messageId: "m-out",
      blockId: "m-out#p1",
      blockOrdinal: 1,
      start: 0,
      end: 3,
    });
  });

  it("消息不存在时返回带段落说明的降级结果", () => {
    const result = highlightForMessages([], undefined, {
      kind: "message",
      messageId: "m-gone",
      blockOrdinal: 2,
      startOffset: 0,
      endOffset: 4,
      exact: "不存在的选区",
    }, "不存在的选区");
    expect(result).toEqual({ kind: "fallback", caption: "段落 3" });
  });

  it("块存在即返回 found；原文已不在块中匹配改为由渲染层 DOM 校验", () => {
    const result = highlightForMessages([message], undefined, {
      kind: "message",
      messageId: "m-out",
      blockOrdinal: 0,
      startOffset: 0,
      endOffset: 5,
      exact: "已被改写的内容",
    }, "已被改写的内容");
    expect(result).toEqual({
      kind: "found",
      messageId: "m-out",
      blockId: "m-out#p0",
      blockOrdinal: 0,
      start: 0,
      end: 5,
    });
  });

  it("快照锚点不属于会话页，返回 null", () => {
    const result = highlightForMessages([message], undefined, {
      kind: "snapshot",
      contentSnapshotId: "snap-1",
      blockId: "block-1",
      startOffset: 0,
      endOffset: 4,
      exact: "快照选区",
    }, "快照选区");
    expect(result).toBeNull();
  });
});

describe("highlightForMessages 锚点随呈现契约对齐（#48/#91）", () => {
  // 普通回答（短正文）：渲染为轮次卡片连续正文，DOM 块 = deriveMessageBlocks 原始段落块，
  // 捕获时 blockOrdinal 即原始段落下标，直接透传。
  const titled = makeMessage({
    id: "m-out",
    role: "assistant",
    status: "completed",
    content: "## 第一节\n\n这是第一段正文。\n\n## 第二节\n\n这是第二段正文。",
  });

  it("普通回答：blockOrdinal 即原始段落块下标，不经过节单元合并", () => {
    const result = highlightForMessages([titled], undefined, {
      kind: "message",
      messageId: "m-out",
      blockOrdinal: 1,
      startOffset: 4,
      endOffset: 8,
      exact: "第二段正文",
    }, "第二段正文");
    expect(result).toEqual({
      kind: "found",
      messageId: "m-out",
      blockId: "m-out#p1",
      blockOrdinal: 1,
      start: 4,
      end: 8,
    });
  });

  it("普通回答：标题块仍是独立锚点块（偏移落在标题块内定位到该块）", () => {
    const result = highlightForMessages([titled], undefined, {
      kind: "message",
      messageId: "m-out",
      blockOrdinal: 0,
      startOffset: 0,
      endOffset: 4,
      exact: "## 第",
    }, "## 第");
    expect(result).toEqual({
      kind: "found",
      messageId: "m-out",
      blockId: "m-out#p0",
      blockOrdinal: 0,
      start: 0,
      end: 4,
    });
  });

  it("普通回答：块下标越界时降级", () => {
    const result = highlightForMessages([titled], undefined, {
      kind: "message",
      messageId: "m-out",
      blockOrdinal: 5,
      startOffset: 0,
      endOffset: 4,
      exact: "不存在的节",
    }, "不存在的节");
    expect(result).toEqual({ kind: "fallback", caption: "段落 6" });
  });

  // 长文：渲染为节卡（标题块并入随后正文节），捕获时 blockOrdinal 是渲染后节单元下标。
  const longContent = "## 第一节\n\n" + "这是第一段正文。".repeat(150) + "\n\n## 第二节\n\n" + "这是第二段正文。".repeat(150);
  const longTitled = makeMessage({
    id: "m-out",
    role: "assistant",
    status: "completed",
    content: longContent,
  });
  const formalSlices = [{
    id: "slice:node:m-out:0",
    nodeId: "node-a",
    messageId: "m-out",
    ordinal: 0,
    title: "",
    normalizedConcepts: [] as string[],
    sourceRefs: [],
    isProvisional: false,
    createdAt: "2026-08-01T00:00:00.000Z",
  }];

  it("长文节卡：锚点 blockOrdinal 按节单元解析（blockId 用节首块段落 ordinal）", () => {
    // 节单元序列：0 = "## 第一节" + 首段正文块，1 = "## 第二节" + 末段正文块。
    const result = highlightForMessages([longTitled], { "m-out": formalSlices }, {
      kind: "message",
      messageId: "m-out",
      blockOrdinal: 1,
      startOffset: 4,
      endOffset: 8,
      exact: "第二段正文",
    }, "第二段正文");
    expect(result).toEqual({
      kind: "found",
      messageId: "m-out",
      blockId: "m-out#p2",
      blockOrdinal: 2,
      start: 4,
      end: 8,
    });
  });

  it("长文节卡：节单元下标越界时降级", () => {
    const result = highlightForMessages([longTitled], { "m-out": formalSlices }, {
      kind: "message",
      messageId: "m-out",
      blockOrdinal: 5,
      startOffset: 0,
      endOffset: 4,
      exact: "不存在的节",
    }, "不存在的节");
    expect(result).toEqual({ kind: "fallback", caption: "段落 6" });
  });
});

describe("childNodeIdempotencyKey", () => {
  const digest = (text: string) => `h${text.length}`;

  it("同一选区与同一追问得到同一个键", () => {
    const first = childNodeIdempotencyKey("sel-1", "  同一追问 ", digest);
    const second = childNodeIdempotencyKey("sel-1", "同一追问", digest);
    expect(first).toBe(second);
    expect(first).toBe("ng:sel-1:h4");
  });

  it("追问为空时使用固定占位", () => {
    expect(childNodeIdempotencyKey("sel-1", "", digest)).toBe("ng:sel-1:auto");
    expect(childNodeIdempotencyKey("sel-1", "   ", digest)).toBe("ng:sel-1:auto");
  });
});

describe("laterIdempotencyKey", () => {
  it("同一选区得到同一个纯 ASCII 键，短于请求头上限", () => {
    const key = laterIdempotencyKey("sel-1");
    expect(key).toBe("later:sel-1");
    expect(key).toMatch(/^later:[!-~]+$/);
    expect(key.length).toBeLessThanOrEqual(200);
  });
});
