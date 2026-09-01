/**
 * #205 prompt/contract probe. It exercises deterministic planning, one bounded structured call,
 * evaluation-data isolation and invalid-output fallback without network access or data writes.
 * Run after build: node scripts/probe-answer-planning.mjs
 */
import assert from "node:assert/strict";
import { AnswerPlanningModule, ConversationContextResolver } from "@collector/api";

const timestamp = "2026-09-01T00:00:00.000Z";
const message = (id, role, content) => ({
  id,
  sessionId: "probe-session",
  nodeId: "probe-node",
  role,
  content,
  status: "completed",
  createdAt: timestamp,
  updatedAt: timestamp,
});

function input(question, taskId, context, structuredPlanning = "available") {
  return {
    taskId,
    generationAttempt: 1,
    inputMessageId: `${taskId}:input`,
    outputMessageId: `${taskId}:output`,
    currentQuestion: question,
    conversationContext: context,
    explicitAnswerSettings: {},
    adoptedAdaptationCategories: [],
    capabilities: { structuredPlanning, webSearch: "not_authorized" },
  };
}

function context(question, taskId, history = []) {
  const current = message(`${taskId}:input`, "user", question);
  return new ConversationContextResolver({ buildFingerprint: "probe-build" }).resolve({
    taskId,
    generationAttempt: 1,
    inputMessageId: current.id,
    outputMessageId: `${taskId}:output`,
    nodeId: "probe-node",
    currentMessage: current,
    messages: [...history, current],
  });
}

let modelCalls = 0;
let admittedPlanningInput = "";
const planner = new AnswerPlanningModule({
  buildFingerprint: "probe-build",
  model: {
    plan: async (assembly) => {
      modelCalls += 1;
      admittedPlanningInput = JSON.stringify(assembly.adopted.map((entry) => entry.candidate.content));
      return JSON.stringify({
        taskFamily: "decision",
        requiredOperations: ["compare", "recommend"],
        semanticCriteria: ["说明通用取舍条件"],
      });
    },
  },
});

const simpleQuestion = "解释事件循环是什么";
const simple = await planner.plan(input(simpleQuestion, "probe-simple", context(simpleQuestion, "probe-simple")));
assert.equal(simple.plan.planning.modelCall, "not_needed");
assert.equal(modelCalls, 0);

const complexQuestion = "请全面权衡两个方案的成本、风险和实施顺序，并给出建议";
const complex = await planner.plan(input(complexQuestion, "probe-complex", context(complexQuestion, "probe-complex")));
assert.equal(modelCalls, 1);
assert.equal(complex.plan.planning.modelCall, "completed");
assert.equal(complex.plan.taskFamily, "decision");
for (const forbidden of ["expectedTaskFamily", "expectedEvidenceApplicability", "mustCover", "rubric", "referenceAnswer"]) {
  assert.doesNotMatch(admittedPlanningInput, new RegExp(forbidden, "i"));
}

const formatQuestion = "改成表格比较这两个方案";
const formatHistory = [message("format-old", "user", "请用连续正文，不要标题")];
const format = await new AnswerPlanningModule({ buildFingerprint: "probe-build" }).plan(input(
  formatQuestion,
  "probe-format",
  context(formatQuestion, "probe-format", formatHistory),
  "unavailable",
));
assert.equal(format.plan.completionContract.machineChecks.find((check) => check.kind === "format")?.expected, "table");

const invalidQuestion = "请全面分析一个复杂问题";
const invalid = await new AnswerPlanningModule({
  buildFingerprint: "probe-build",
  model: { plan: async () => "invalid-json" },
}).plan(input(invalidQuestion, "probe-invalid", context(invalidQuestion, "probe-invalid")));
assert.equal(invalid.plan.planning.mode, "fallback");
assert.equal(invalid.plan.userGoal, invalidQuestion);

console.log(JSON.stringify({
  verdict: "PASS",
  plannerVersion: complex.plan.plannerVersion,
  simpleModelCalls: 0,
  complexModelCalls: modelCalls,
  complexTaskFamily: complex.plan.taskFamily,
  explicitFormat: format.plan.completionContract.machineChecks.find((check) => check.kind === "format")?.expected,
  fallbackReason: invalid.plan.planning.reason,
  productionInputBytes: Buffer.byteLength(admittedPlanningInput, "utf8"),
}, null, 2));
