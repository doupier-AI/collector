import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveDefaultResearchTitle,
  RESEARCH_TITLE_MAX_CHARACTERS,
  validateDeepResearchInput,
} from "@collector/capture-contracts";

test("validateDeepResearchInput accepts branch and session modes", () => {
  assert.doesNotThrow(() => validateDeepResearchInput({ mode: "branch" }));
  assert.doesNotThrow(() => validateDeepResearchInput({ mode: "session" }));
  assert.doesNotThrow(() => validateDeepResearchInput({ mode: "session", direction: "研究这个机制", title: "研究标题" }));
  assert.doesNotThrow(() => validateDeepResearchInput({ mode: "branch", direction: "沿当前内容展开" }));
});

test("validateDeepResearchInput rejects malformed input", () => {
  assert.throws(() => validateDeepResearchInput(null), /object/);
  assert.throws(() => validateDeepResearchInput("branch"), /object/);
  assert.throws(() => validateDeepResearchInput({}), /mode/);
  assert.throws(() => validateDeepResearchInput({ mode: "new-session" }), /mode/);
  assert.throws(() => validateDeepResearchInput({ mode: "session", direction: "   " }), /direction/);
  assert.throws(() => validateDeepResearchInput({ mode: "session", direction: 42 }), /direction/);
  assert.throws(() => validateDeepResearchInput({ mode: "session", direction: "x".repeat(2001) }), /2000/);
  assert.throws(() => validateDeepResearchInput({ mode: "branch", title: "" }), /title/);
  assert.throws(() => validateDeepResearchInput({ mode: "branch", title: "x".repeat(201) }), /title/);
});

test("deriveDefaultResearchTitle takes the first sentence deterministically", () => {
  assert.equal(deriveDefaultResearchTitle("第一句内容。第二句内容。"), "第一句内容");
  assert.equal(deriveDefaultResearchTitle("这是一个没有标点的选区"), "这是一个没有标点的选区");
  assert.equal(deriveDefaultResearchTitle("First line\nsecond line"), "First line");
  assert.equal(deriveDefaultResearchTitle("问题？回答。"), "问题");
  assert.equal(deriveDefaultResearchTitle("   "), "深入研究");
  const long = "x".repeat(RESEARCH_TITLE_MAX_CHARACTERS + 20);
  assert.equal(deriveDefaultResearchTitle(long), `${"x".repeat(RESEARCH_TITLE_MAX_CHARACTERS)}…`);
  // 同一输入多次派生结果一致
  assert.equal(deriveDefaultResearchTitle("同一输入。再次派生。"), deriveDefaultResearchTitle("同一输入。再次派生。"));
});
