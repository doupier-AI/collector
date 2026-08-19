import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveBodyVersion, deriveFragmentsFromSlices, deriveMessageSlices, messageContentBlockId } from "@collector/capture-contracts";
import type { ResearchBodyVersionView, ResearchMessageRecord, ResearchSliceRecord } from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import {
  FOCUS_DURATION_MS,
  __clearBodyVersionCache,
  fetchBodyVersionCached,
  fragmentDeepLink,
  locateFragment,
  parseFragmentId,
} from "./fragment-locator";

beforeEach(() => {
  __clearBodyVersionCache();
});

/** 三段式正文（与 fake provider 同形态）：段落即节，无标题块合并 → ordinal 与下标一致。 */
const CONTENT = "第一段。\n\n第二段。\n\n第三段。";

function makeAssistantMessage(messageId = "m-out", content = CONTENT): ResearchMessageRecord {
  return {
    id: messageId,
    sessionId: "session-1",
    nodeId: "node-a",
    role: "assistant",
    content,
    status: "completed",
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
}

/** 用契约层派生造真实版本 + 片段 + 切片（与生产同规则，ID/偏移逐字一致）。 */
function makeArtifacts(message: ResearchMessageRecord, nodeId = "node-a") {
  const version = deriveBodyVersion({
    messageId: message.id,
    nodeId,
    content: message.content,
    origin: "backfill",
    createdAt: "2026-08-02T00:00:00.000Z",
  });
  const slices: ResearchSliceRecord[] = deriveMessageSlices(
    nodeId,
    message.id,
    message.content,
    0,
    [],
  );
  const fragments = deriveFragmentsFromSlices(version, slices, []);
  return { version, slices, fragments };
}

describe("parseFragmentId", () => {
  it("解析合法 fragmentId（bodyVersionId 内嵌冒号被贪婪前缀吸收）", () => {
    expect(parseFragmentId("fragment:body:m-out:abc:2")).toEqual({ bodyVersionId: "body:m-out:abc", ordinal: 2 });
    expect(parseFragmentId("fragment:body:m-out:abc:0")).toEqual({ bodyVersionId: "body:m-out:abc", ordinal: 0 });
  });

  it("拒绝非法标识", () => {
    expect(parseFragmentId("")).toBeNull();
    expect(parseFragmentId("body:m-out:abc")).toBeNull();
    expect(parseFragmentId("fragment:body:m-out:abc:x")).toBeNull();
    expect(parseFragmentId("fragment:body:m-out:abc:-1")).toBeNull();
    expect(parseFragmentId("fragment:body:m-out:abc:")).toBeNull();
    expect(parseFragmentId("fragment:")).toBeNull();
  });
});

describe("locateFragment", () => {
  it("正常定位（普通回答）：返回轮次卡片光环、段落精确落点与局部文字高亮", () => {
    const message = makeAssistantMessage();
    const { version, slices, fragments } = makeArtifacts(message);
    const result = locateFragment({
      currentNodeId: "node-a",
      fragmentId: fragments[1].id,
      version,
      fragments,
      messages: [message],
      slicesByMessage: { [message.id]: slices },
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.slice.id).toBe(slices[1].id);
    // 片段摘录来自正文版本，局部高亮按段落文本空间定位。
    expect(result.target.excerpt).toBe("第二段。");
    expect(result.target.cardId).toBe("m-out-turn");
    // 无标题块合并：节起始块 ordinal = 切片下标 1；仍用于精确滚动和焦点。
    expect(result.target.elementId).toBe(messageContentBlockId(message.id, 1));
    expect(result.target.highlights).toEqual([{ blockOrdinal: 1, start: 0, end: 4, exact: "第二段。" }]);
  });

  it("短回答标题与后续正文分块时，片段分别投影到实际渲染的两个块", () => {
    const message = makeAssistantMessage("m-titled", "## 标题\n\n**正文** [链接](https://example.test)");
    const { version, slices, fragments } = makeArtifacts(message);
    const result = locateFragment({
      currentNodeId: "node-a",
      fragmentId: fragments[0]!.id,
      version,
      fragments,
      messages: [message],
      slicesByMessage: { [message.id]: slices },
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // 仍滚到首块（标题），但不能把整个节摘录塞给标题块。
    expect(result.target.elementId).toBe(messageContentBlockId(message.id, 0));
    expect(result.target.highlights).toEqual([
      { blockOrdinal: 0, start: 0, end: 2, exact: "标题" },
      { blockOrdinal: 1, start: 0, end: 5, exact: "正文 链接" },
    ]);
  });

  it("序数对齐后片段摘录若无法逐字投影到目标正文，诚实降级", () => {
    const message = makeAssistantMessage();
    const { version, fragments } = makeArtifacts(message);
    // 构造错位：片段序号与片段摘录不一致。片段与切片仍按序数对齐，
    // 但 #96 不允许把无法逐字验证的摘录静默高亮到另一段正文。
    const mismatched = [
      { ...fragments[2], id: fragments[2].id, ordinal: 0 },
      { ...fragments[1], id: fragments[1].id, ordinal: 1 },
      { ...fragments[0], id: fragments[0].id, ordinal: 2 },
    ];
    const { slices } = makeArtifacts(message);
    // 排序前传逆序数组：ordinal=0 的切片排在数组末位；locateFragment 与
    // deriveSliceCardTargets 都按 ordinal 排序，序数 0 恒命中 ordinal=0 的切片。
    const reversedSlices = [slices[2], slices[1], slices[0]];
    const result = locateFragment({
      currentNodeId: "node-a",
      fragmentId: mismatched[0].id,
      version,
      fragments: mismatched,
      messages: [message],
      slicesByMessage: { [message.id]: reversedSlices },
    });
    expect(result).toEqual({ kind: "failure", failure: "target-not-derived" });
  });

  it("正常定位（长文）：轮次卡片承载光环，节容器保留精确落点与合并节文字高亮", () => {
    const content = "## 第一节\n\n" + "这是第一段正文。".repeat(150) + "\n\n## 第二节\n\n" + "这是第二段正文。".repeat(150);
    const message = makeAssistantMessage("m-long", content);
    const { version, slices, fragments } = makeArtifacts(message);
    const result = locateFragment({
      currentNodeId: "node-a",
      fragmentId: fragments[1].id,
      version,
      fragments,
      messages: [message],
      slicesByMessage: { [message.id]: slices },
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.slice.id).toBe(slices[1].id);
    // 节单元 0 = "## 第一节 + 首段正文"，节单元 1 = "## 第二节 + 末段正文"（节首块 ordinal=2）。
    expect(result.target.cardId).toBe("m-long-turn");
    expect(result.target.elementId).toBe(`${messageContentBlockId(message.id, 2)}-card`);
    expect(result.target.excerpt).toContain("## 第二节");
    expect(result.target.highlights[0]).toMatchObject({ blockOrdinal: 2, start: 0 });
    expect(result.target.highlights.at(-1)?.end).toBeGreaterThan(0);
  });

  it("invalid-id：标识无法解析", () => {
    const message = makeAssistantMessage();
    const { version, slices, fragments } = makeArtifacts(message);
    const result = locateFragment({
      currentNodeId: "node-a",
      fragmentId: "not-a-fragment",
      version,
      fragments,
      messages: [message],
      slicesByMessage: { [message.id]: slices },
    });
    expect(result).toEqual({ kind: "failure", failure: "invalid-id" });
  });

  it("fragment-missing：片段不在版本视图中", () => {
    const message = makeAssistantMessage();
    const { version, slices, fragments } = makeArtifacts(message);
    const result = locateFragment({
      currentNodeId: "node-a",
      fragmentId: `fragment:${version.id}:99`,
      version,
      fragments,
      messages: [message],
      slicesByMessage: { [message.id]: slices },
    });
    expect(result).toEqual({ kind: "failure", failure: "fragment-missing" });
  });

  it("node-mismatch：版本归属节点与当前节点不一致", () => {
    const message = makeAssistantMessage();
    const { version, slices, fragments } = makeArtifacts(message);
    const result = locateFragment({
      currentNodeId: "other-node",
      fragmentId: fragments[0].id,
      version,
      fragments,
      messages: [message],
      slicesByMessage: { [message.id]: slices },
    });
    expect(result).toEqual({ kind: "failure", failure: "node-mismatch" });
  });

  it("integrity-failed：片段摘录校验和不一致（篡改后绝不静默关联）", () => {
    const message = makeAssistantMessage();
    const { version, slices, fragments } = makeArtifacts(message);
    const tampered = { ...fragments[0], excerptChecksum: "tampered" };
    const result = locateFragment({
      currentNodeId: "node-a",
      fragmentId: tampered.id,
      version,
      fragments: [tampered, ...fragments.slice(1)],
      messages: [message],
      slicesByMessage: { [message.id]: slices },
    });
    expect(result).toEqual({ kind: "failure", failure: "integrity-failed" });
  });

  it("slice-not-found：序号与内容都不匹配", () => {
    const message = makeAssistantMessage();
    const { version, fragments } = makeArtifacts(message);
    const otherMessage = makeAssistantMessage("m-other", "完全不同的另一段正文。");
    const { slices } = makeArtifacts(otherMessage, "node-a");
    const result = locateFragment({
      currentNodeId: "node-a",
      fragmentId: fragments[0].id,
      version,
      fragments,
      messages: [message],
      slicesByMessage: { [otherMessage.id]: slices },
    });
    expect(result).toEqual({ kind: "failure", failure: "slice-not-found" });
  });

  it("provisional 切片：切片缺失时返回 slice-not-found（与现状一致）", () => {
    const message = makeAssistantMessage();
    const { version, fragments } = makeArtifacts(message);
    const provisional = [{ ...fragments[0], isProvisional: true }];
    const result = locateFragment({
      currentNodeId: "node-a",
      fragmentId: fragments[0].id,
      version,
      fragments: provisional,
      messages: [message],
      slicesByMessage: { [message.id]: [] },
    });
    expect(result).toEqual({ kind: "failure", failure: "slice-not-found" });
  });
});

describe("fetchBodyVersionCached", () => {
  it("同版本只请求一次（成功后缓存）", async () => {
    const getResearchBodyVersion = vi.fn(async () => ({
      version: { id: "body:m-out:abc", messageId: "m-out", nodeId: "node-a", version: 1, content: CONTENT, contentHash: "h", origin: "backfill", createdAt: "2026-08-02T00:00:00.000Z" },
      fragments: [],
    })) as unknown as ApiClient["getResearchBodyVersion"];
    const api = { getResearchBodyVersion } as Pick<ApiClient, "getResearchBodyVersion">;
    const first = await fetchBodyVersionCached(api, "body:m-out:abc");
    const second = await fetchBodyVersionCached(api, "body:m-out:abc");
    expect(second).toBe(first);
    expect(getResearchBodyVersion).toHaveBeenCalledTimes(1);
  });

  it("失败后删除缓存条目，允许重试", async () => {
    const versionView: ResearchBodyVersionView = {
      version: { id: "body:m-out:abc", messageId: "m-out", nodeId: "node-a", version: 1, content: CONTENT, contentHash: "h", origin: "backfill", createdAt: "2026-08-02T00:00:00.000Z" },
      fragments: [],
    };
    const getResearchBodyVersion = vi
      .fn<() => Promise<ResearchBodyVersionView>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(versionView);
    const api = { getResearchBodyVersion } as Pick<ApiClient, "getResearchBodyVersion">;
    await expect(fetchBodyVersionCached(api, "body:m-out:abc")).rejects.toThrow("boom");
    const retry = await fetchBodyVersionCached(api, "body:m-out:abc");
    expect(retry.version.id).toBe("body:m-out:abc");
    expect(getResearchBodyVersion).toHaveBeenCalledTimes(2);
  });
});

describe("fragmentDeepLink", () => {
  it("构造深链：保留既有查询参数，设置 fragment；#61 起使用稳定节点地址", () => {
    const existing = new URLSearchParams("sel=sel-1");
    expect(fragmentDeepLink("node-b", "fragment:body:m-out:abc:1", existing)).toBe(
      "/nodes/node-b?sel=sel-1&fragment=fragment%3Abody%3Am-out%3Aabc%3A1",
    );
  });

  it("无既有参数时只带 fragment", () => {
    expect(fragmentDeepLink("node-b", "fragment:body:m-out:abc:0")).toBe(
      "/nodes/node-b?fragment=fragment%3Abody%3Am-out%3Aabc%3A0",
    );
  });
});

describe("FOCUS_DURATION_MS", () => {
  it("强调时长固定为 1600ms（e2e 等待依赖此值）", () => {
    expect(FOCUS_DURATION_MS).toBe(1600);
  });
});
