import assert from "node:assert/strict";
import test from "node:test";
import {
  RESEARCH_LATER_DEFAULT_SUMMARY_CHARACTERS,
  deriveDefaultLaterSummary,
  validateResearchLaterItemInput,
  validateResearchLaterItemUpdate,
} from "@collector/capture-contracts";

test("validateResearchLaterItemInput accepts minimal and full input", () => {
  assert.doesNotThrow(() => validateResearchLaterItemInput({ selectionId: "selection-1" }));
  assert.doesNotThrow(() => validateResearchLaterItemInput({ selectionId: "selection-1", priority: 1, summary: "用户概括" }));
  assert.doesNotThrow(() => validateResearchLaterItemInput({ selectionId: "selection-1", priority: 5 }));
});

test("validateResearchLaterItemInput rejects malformed input", () => {
  assert.throws(() => validateResearchLaterItemInput(null), /object/);
  assert.throws(() => validateResearchLaterItemInput("selection"), /object/);
  assert.throws(() => validateResearchLaterItemInput({}), /selectionId/);
  assert.throws(() => validateResearchLaterItemInput({ selectionId: "   " }), /selectionId/);
  assert.throws(() => validateResearchLaterItemInput({ selectionId: "s", priority: 0 }), /priority/);
  assert.throws(() => validateResearchLaterItemInput({ selectionId: "s", priority: 6 }), /priority/);
  assert.throws(() => validateResearchLaterItemInput({ selectionId: "s", priority: 2.5 }), /priority/);
  assert.throws(() => validateResearchLaterItemInput({ selectionId: "s", priority: "3" }), /priority/);
  assert.throws(() => validateResearchLaterItemInput({ selectionId: "s", summary: "   " }), /summary/);
  assert.throws(() => validateResearchLaterItemInput({ selectionId: "s", summary: 42 }), /summary/);
  assert.throws(() => validateResearchLaterItemInput({ selectionId: "s", summary: "x".repeat(201) }), /200/);
});

test("validateResearchLaterItemUpdate requires at least one field and valid values", () => {
  assert.doesNotThrow(() => validateResearchLaterItemUpdate({ priority: 4 }));
  assert.doesNotThrow(() => validateResearchLaterItemUpdate({ summary: "新概括" }));
  assert.doesNotThrow(() => validateResearchLaterItemUpdate({ status: "done" }));
  assert.doesNotThrow(() => validateResearchLaterItemUpdate({ status: "pending" }));
  assert.doesNotThrow(() => validateResearchLaterItemUpdate({ priority: 2, summary: "新概括", status: "done" }));
  assert.throws(() => validateResearchLaterItemUpdate({}), /at least one/);
  assert.throws(() => validateResearchLaterItemUpdate(null), /object/);
  assert.throws(() => validateResearchLaterItemUpdate({ status: "archived" }), /status/);
  assert.throws(() => validateResearchLaterItemUpdate({ priority: 9 }), /priority/);
  assert.throws(() => validateResearchLaterItemUpdate({ summary: "" }), /summary/);
});

test("deriveDefaultLaterSummary takes the first sentence deterministically", () => {
  assert.equal(deriveDefaultLaterSummary("第一句内容。第二句内容。"), "第一句内容");
  assert.equal(deriveDefaultLaterSummary("这是一个没有标点的选区"), "这是一个没有标点的选区");
  assert.equal(deriveDefaultLaterSummary("First line\nsecond line"), "First line");
  assert.equal(deriveDefaultLaterSummary("问题？回答。"), "问题");
  assert.equal(deriveDefaultLaterSummary("   "), "稍后再学");
  const long = "x".repeat(RESEARCH_LATER_DEFAULT_SUMMARY_CHARACTERS + 20);
  assert.equal(deriveDefaultLaterSummary(long), `${"x".repeat(RESEARCH_LATER_DEFAULT_SUMMARY_CHARACTERS)}…`);
  // 首句超过 80 字符时按字符截断，而不是延伸到下一句
  assert.equal(deriveDefaultLaterSummary(`${"y".repeat(100)}。第二句。`), `${"y".repeat(RESEARCH_LATER_DEFAULT_SUMMARY_CHARACTERS)}…`);
  // 同一输入多次派生结果一致
  assert.equal(deriveDefaultLaterSummary("同一输入。再次派生。"), deriveDefaultLaterSummary("同一输入。再次派生。"));
});
