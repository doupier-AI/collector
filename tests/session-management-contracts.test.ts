import assert from "node:assert/strict";
import test from "node:test";
import {
  RESEARCH_TITLE_MAX_CHARACTERS,
  validateProjectInput,
  validateResearchSessionUpdateInput,
} from "@collector/capture-contracts";

test("validateProjectInput accepts valid names", () => {
  assert.doesNotThrow(() => validateProjectInput({ name: "工作项目" }));
  assert.doesNotThrow(() => validateProjectInput({ name: "A".repeat(RESEARCH_TITLE_MAX_CHARACTERS) }));
});

test("validateProjectInput rejects malformed names", () => {
  assert.throws(() => validateProjectInput(null), /object/);
  assert.throws(() => validateProjectInput("项目"), /object/);
  assert.throws(() => validateProjectInput({}), /name/);
  assert.throws(() => validateProjectInput({ name: "" }), /name/);
  assert.throws(() => validateProjectInput({ name: "   " }), /name/);
  assert.throws(() => validateProjectInput({ name: 42 }), /name/);
  assert.throws(() => validateProjectInput({ name: "x".repeat(RESEARCH_TITLE_MAX_CHARACTERS + 1) }), /40/);
});

test("validateResearchSessionUpdateInput accepts any single field and combinations", () => {
  assert.doesNotThrow(() => validateResearchSessionUpdateInput({ title: "新标题" }));
  assert.doesNotThrow(() => validateResearchSessionUpdateInput({ projectId: "project-1" }));
  assert.doesNotThrow(() => validateResearchSessionUpdateInput({ projectId: null }));
  assert.doesNotThrow(() => validateResearchSessionUpdateInput({ status: "archived" }));
  assert.doesNotThrow(() => validateResearchSessionUpdateInput({ status: "active" }));
  assert.doesNotThrow(() => validateResearchSessionUpdateInput({ isFavorite: true }));
  assert.doesNotThrow(() => validateResearchSessionUpdateInput({ isFavorite: false }));
  assert.doesNotThrow(() => validateResearchSessionUpdateInput({ title: "新标题", projectId: "p", status: "archived", isFavorite: true }));
});

test("validateResearchSessionUpdateInput rejects malformed updates", () => {
  assert.throws(() => validateResearchSessionUpdateInput({}), /at least one/i);
  assert.throws(() => validateResearchSessionUpdateInput(null), /object/);
  assert.throws(() => validateResearchSessionUpdateInput("title"), /object/);
  assert.throws(() => validateResearchSessionUpdateInput({ title: "" }), /title/);
  assert.throws(() => validateResearchSessionUpdateInput({ title: "   " }), /title/);
  assert.throws(() => validateResearchSessionUpdateInput({ title: "x".repeat(RESEARCH_TITLE_MAX_CHARACTERS + 1) }), /40/);
  assert.throws(() => validateResearchSessionUpdateInput({ title: 42 }), /title/);
  assert.throws(() => validateResearchSessionUpdateInput({ projectId: 42 }), /projectId/);
  assert.throws(() => validateResearchSessionUpdateInput({ status: "deleted" }), /status/);
  assert.throws(() => validateResearchSessionUpdateInput({ status: "paused" }), /status/);
  assert.throws(() => validateResearchSessionUpdateInput({ isFavorite: "true" }), /isFavorite/);
});
