import type { ResearchGenerationProvider, ResearchGenerationRequest } from "./research.js";
import type { ResearchSelectionProvider } from "./selection.js";

const DEMO_NOTICE = "【本地演示回答｜非真实 AI｜未联网检索】";
const DEMO_SELECTION_NOTICE = "【本地演示分析｜非真实 AI】";

export function createMvpDemoResearchProvider(): ResearchGenerationProvider {
  return {
    provider: "collector-mvp-demo",
    model: "deterministic-local-demo",
    promptVersion: "mvp-demo-v1",
    async *generate(request: ResearchGenerationRequest) {
      const latestQuestion = [...request.messages].reverse().find((message) => message.role === "user")?.content.trim();
      const topic = latestQuestion || "这个问题";
      const answer = `${DEMO_NOTICE}\n\n你正在研究：“${topic}”\n\n这是用于验证 Collector 核心流程的确定性本地内容。建议先明确关键概念，再列出需要比较的观点与证据，最后记录仍待验证的问题。文件导入和阅读内容可作为后续研究材料。\n\nTODO（正式版本）：接入用户配置的真实模型与来源检索后，由模型基于会话和已导入材料生成回答，并为事实性结论提供可返回的来源。`;
      for (let index = 0; index < answer.length; index += 80) yield answer.slice(index, index + 80);
    },
  };
}

export function createMvpDemoSelectionProvider(): ResearchSelectionProvider {
  return {
    provider: "collector-mvp-demo",
    model: "deterministic-local-demo",
    promptVersion: "mvp-demo-selection-v1",
    async analyze(request) {
      const excerpt = request.text.length > 24 ? `${request.text.slice(0, 24)}…` : request.text;
      const focus = request.recentUserMessages.length ? request.recentUserMessages[request.recentUserMessages.length - 1] : undefined;
      return {
        summary: `${DEMO_SELECTION_NOTICE}这段选区（“${excerpt}”）是确定性演示内容，用于验证选区智能窗口的展示与交互，不代表真实分析。`,
        difficulty: "中",
        quickReadMinutes: 2,
        deepStudyMinutes: 10,
        prerequisites: ["演示前置知识：仅用于界面验证，无实际学习要求"],
        relationToContent: `${DEMO_SELECTION_NOTICE}演示关系说明：该选区位于当前内容中，真实版本会由模型说明它与上下文的关系。`,
        ...(focus ? { relationToFocus: `${DEMO_SELECTION_NOTICE}演示关系说明：你最近在关注“${focus.slice(0, 40)}”，真实版本会分析选区与该方向的关系。` } : {}),
        rationale: `${DEMO_SELECTION_NOTICE}这是本地确定性输出，不基于模型推理，也不构成任何事实判断；所有字段仅用于验证界面与数据流。`,
      };
    },
  };
}

export { DEMO_NOTICE, DEMO_SELECTION_NOTICE };
