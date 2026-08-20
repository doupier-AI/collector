import { describe, expect, it } from "vitest";
import { researchSearchMatchTarget } from "./research-search-navigation";

describe("researchSearchMatchTarget", () => {
  it("把 AI 片段送到节点片段定位，把导入正文送到阅读块定位", () => {
    expect(researchSearchMatchTarget("node-a", {
      field: "ai-body",
      preview: "正文中的第一处命中",
      locator: { kind: "message-semantic-range", nodeId: "node-a", messageId: "message-a", bodyVersionId: "body-a", fragmentId: "fragment-a", startOffset: 10, endOffset: 20 },
    })).toEqual({ path: "/nodes/node-a?fragment=fragment-a&fragmentStart=10&fragmentEnd=20" });

    expect(researchSearchMatchTarget("session-a", {
      field: "import-body",
      preview: "导入正文命中",
      locator: { kind: "import-block", nodeId: "session-a", contentSnapshotId: "snapshot-a", blockId: "block-a", startOffset: 12, endOffset: 24 },
    })).toEqual({ path: "/research/session-a/reading/snapshot-a?searchBlock=block-a&searchStart=12&searchEnd=24" });
  });

  it("用户问题可按当前消息范围定位；标题直接打开；确认融合快照诚实降级", () => {
    expect(researchSearchMatchTarget("node-a", {
      field: "user-question",
      preview: "用户问题命中",
      locator: { kind: "message-text-range", nodeId: "node-a", messageId: "message-a", contentHash: "abcd1234", startOffset: 2, endOffset: 8 },
    })).toEqual({ path: "/nodes/node-a?searchMessage=message-a&searchHash=abcd1234&searchStart=2&searchEnd=8" });
    expect(researchSearchMatchTarget("node-a", { field: "node-title", preview: "节点标题命中", locator: { kind: "node-title", nodeId: "node-a" } })).toEqual({ path: "/nodes/node-a" });
    expect(researchSearchMatchTarget("fusion-a", {
      field: "formal-fusion-body",
      preview: "正式融合正文命中",
      locator: { kind: "fusion-snapshot-range", nodeId: "fusion-a", confirmedDraftVersionId: "draft-a", startOffset: 2, endOffset: 8 },
    })).toEqual({ path: "/nodes/fusion-a?fusionDraft=draft-a&fusionStart=2&fusionEnd=8" });
  });
});
