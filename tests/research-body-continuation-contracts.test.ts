import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  joinContinuation,
  type ResearchBodyPlan,
  type ResearchTaskRecord,
} from "@collector/capture-contracts";

describe("joinContinuation 续写拼接去重", () => {
  it("去除 next 与 prior 尾部的最长重叠前缀", () => {
    // 重叠 "重复区块结尾之后" 共 8 字，≥ minOverlap，去重。
    assert.equal(joinContinuation("ABC_defgh_重复区块结尾之后", "重复区块结尾之后的新内容"), "ABC_defgh_重复区块结尾之后的新内容");
    // 中文 ≥8 字重叠同理（重叠 "处被迫停止在这里" 共 8 字）。
    assert.equal(joinContinuation("正文生长到断点处被迫停止在这里", "处被迫停止在这里，接下来继续。"), "正文生长到断点处被迫停止在这里，接下来继续。");
  });

  it("无重叠时原样拼接", () => {
    assert.equal(joinContinuation("前半部分。", "后半部分。"), "前半部分。后半部分。");
  });

  it("短于 minOverlap 的巧合重叠不去重", () => {
    // 尾部 "abc"（3 字）与头部相同，但 < 8，不去重。
    assert.equal(joinContinuation("结尾abc", "abc开头"), "结尾abcabc开头");
  });

  it("重叠恰好等于 minOverlap 时去重", () => {
    const prior = "前面内容" + "12345678"; // 尾部 8 字
    const next = "12345678" + "后续";
    assert.equal(joinContinuation(prior, next), "前面内容12345678后续");
  });

  it("取最长重叠而非最短", () => {
    const prior = "XYZ" + "ABCDABCD"; // 尾部 ABCDABCD
    const next = "ABCDABCD" + "新";
    assert.equal(joinContinuation(prior, next), "XYZABCDABCD新");
  });

  it("prior 或 next 为空时返回另一方", () => {
    assert.equal(joinContinuation("", "只有后续"), "只有后续");
    assert.equal(joinContinuation("只有前文", ""), "只有前文");
  });

  it("重叠上限 maxOverlap 限制扫描窗口", () => {
    const long = "x".repeat(3000);
    const prior = long;                 // 尾部是 long 的尾巴
    const next = long.slice(0, 1500) + "新"; // 头部 1500 字与 prior 尾部重叠
    // 重叠 1500 字（在 2000 窗口内）可去重。
    assert.equal(joinContinuation(prior, next), long + "新");
  });
});

describe("ResearchBodyPlanSection 与 streamCheckpoint 契约", () => {
  it("failed 状态、partialContent、failureReason 可 JSON 往返", () => {
    const plan: ResearchBodyPlan = {
      sections: [
        { heading: "起", summary: "开端", targetChars: 500, status: "completed", content: "已完成节正文。" },
        {
          heading: "承",
          summary: "发展",
          targetChars: 800,
          status: "failed",
          partialContent: "写到一半的部分正文。",
          failureReason: "截断续写耗尽",
        },
      ],
    };
    const roundTripped = JSON.parse(JSON.stringify(plan)) as ResearchBodyPlan;
    assert.equal(roundTripped.sections[0]?.status, "completed");
    assert.equal(roundTripped.sections[1]?.status, "failed");
    assert.equal(roundTripped.sections[1]?.partialContent, "写到一半的部分正文。");
    assert.equal(roundTripped.sections[1]?.failureReason, "截断续写耗尽");
  });

  it("streamCheckpoint 可 JSON 往返", () => {
    const task = {
      id: "task-1",
      sessionId: "session-1",
      inputMessageId: "in-1",
      outputMessageId: "out-1",
      idempotencyKey: "k",
      status: "failed",
      retryable: true,
      promptVersion: "v1",
      streamCheckpoint: { content: "已接收的部分正文前缀。", updatedAt: "2026-08-05T00:00:00.000Z", protocolPrefix: "<thi" },
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    } as ResearchTaskRecord;
    const roundTripped = JSON.parse(JSON.stringify(task)) as ResearchTaskRecord;
    assert.equal(roundTripped.streamCheckpoint?.content, "已接收的部分正文前缀。");
    assert.equal(roundTripped.streamCheckpoint?.updatedAt, "2026-08-05T00:00:00.000Z");
    assert.equal(roundTripped.streamCheckpoint?.protocolPrefix, "<thi");
  });
});
