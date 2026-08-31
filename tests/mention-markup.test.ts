import assert from "node:assert/strict";
import test from "node:test";
import { FinalBodyProtocolError, FinalBodySink } from "../apps/api/dist/final-body-sink.js";

test("最终正文拒绝全部旧控制协议，且任何流切分都不会泄露起始字符", () => {
  const controls = [
    "[[concept:backprop:反向传播]]",
    "[[entity:eu:欧盟]]",
    "[[abbreviation:rag:RAG]]",
    "[[notation:big-o:O(n log n)]]",
    "[来源1]",
  ];
  for (const control of controls) {
    for (let split = 0; split <= control.length; split += 1) {
      const sink = new FinalBodySink();
      let visible = "";
      assert.throws(() => {
        visible += sink.accept(control.slice(0, split));
        visible += sink.accept(control.slice(split));
      }, FinalBodyProtocolError, `${control} split=${split}`);
      assert.equal(visible, "", `${control} split=${split} must not leak`);
    }
  }
});

test("协议前缀在物理流切断后只用于隔离判定，不会成为正文", () => {
  const sink = new FinalBodySink();
  assert.equal(sink.accept("正常正文 [[con"), "正常正文 ");
  assert.equal(sink.protocolPrefix(), "[[con");
  sink.discardPending();
  assert.equal(sink.accept("新的普通正文"), "新的普通正文");
  assert.equal(sink.finish(), "");
});

test("不等于明确协议边界的自然文本按原样保存", () => {
  const content = "这里讨论 [[concept is prose]]，以及来源一的自然语言描述。";
  const sink = new FinalBodySink();
  assert.equal(sink.accept(content) + sink.finish(), content);
});
