import { describe, expect, it } from "vitest";
import { researchBodyVersionId, type ResearchMessageRecord, type TermMarker } from "@collector/capture-contracts";
import { makeMessage } from "../../test/fakes";
import { currentBodyTermMarkers } from "./term-marker-view";

function sidecarMarker(messageId: string, content: string, text: string): TermMarker {
  const startOffset = content.indexOf(text);
  return {
    mentionId: `mention:${text}`,
    entityId: `entity:${messageId}:${text}`,
    text,
    blockOrdinal: 0,
    startOffset,
    endOffset: startOffset + text.length,
    category: "concept",
    location: {
      contentId: messageId,
      bodyVersionId: researchBodyVersionId(messageId, content),
      sourceRange: { startOffset, endOffset: startOffset + text.length },
      exact: text,
    },
  };
}

function messageWith(content: string, markers: TermMarker[], status: ResearchMessageRecord["status"] = "completed") {
  return makeMessage({ id: "answer", role: "assistant", content, status, termMarkers: markers });
}

describe("当前正文 sidecar 弱标记", () => {
  it("只返回与当前正文版本和绝对范围逐字一致的记录", () => {
    const content = "苹果是水果，苹果公司发布手机。";
    const valid = sidecarMarker("answer", content, "苹果公司");
    const stale = { ...sidecarMarker("answer", content, "水果"), location: { ...sidecarMarker("answer", content, "水果").location!, bodyVersionId: "body:answer:stale" } };
    const wrongRange = { ...sidecarMarker("answer", content, "手机"), location: { ...sidecarMarker("answer", content, "手机").location!, sourceRange: { startOffset: 0, endOffset: 2 } } };
    const message = messageWith(content, [valid, stale, wrongRange]);

    expect(currentBodyTermMarkers(message, researchBodyVersionId(message.id, content))).toEqual([valid]);
  });

  it("不把无稳定位置的旧词法检测结果提升为可交互标记", () => {
    const content = "REST API";
    const legacy: TermMarker = { text: "REST", blockOrdinal: 0, startOffset: 0, endOffset: 4, category: "abbreviation" };
    expect(currentBodyTermMarkers(messageWith(content, [legacy]))).toEqual([]);
  });

  it("流式正文只追加时保留已闭合提及，完成后的旧版本记录则失效", () => {
    const prefix = "REST 已定义。";
    const marker = sidecarMarker("answer", prefix, "REST");
    const appended = `${prefix}\n\n后续正文。`;
    expect(currentBodyTermMarkers(messageWith(appended, [marker], "streaming"))).toEqual([marker]);
    expect(currentBodyTermMarkers(messageWith(appended, [marker], "completed"))).toEqual([]);
  });
});
