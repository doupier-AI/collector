import { parseNativeResearchSliceGeneration, type ResearchGroundingScenario, type ResearchGroundingScopeStatus } from "@collector/capture-contracts";
import type { ResearchGenerationProvider, ResearchGenerationRequest } from "./research.js";
import type { ResearchSelectionProvider } from "./selection.js";

const DEMO_NOTICE = "【本地演示回答｜非真实 AI｜未联网检索】";
const DEMO_SELECTION_NOTICE = "【本地演示分析｜非真实 AI】";

export function createMvpDemoResearchProvider(): ResearchGenerationProvider {
  const demoProvider: ResearchGenerationProvider = {
    provider: "collector-mvp-demo",
    model: "deterministic-local-demo",
    promptVersion: "mvp-demo-v1",
    groundingCapability: "unsupported",
    async generateNative(request: ResearchGenerationRequest) {
      return nativeDemoSlices(request, demoAnswer(request));
    },
    async *generate(request: ResearchGenerationRequest) {
      const answer = demoAnswer(request);
      for (let index = 0; index < answer.length; index += 80) yield answer.slice(index, index + 80);
    },
    async generateAgentGrounded(request: ResearchGenerationRequest & { scenario: ResearchGroundingScenario }) {
      const content = `${DEMO_NOTICE}\n\n量子计算是一种利用量子力学原理进行信息处理的计算范式。与传统计算不同，量子比特可以同时处于 0 和 1 的叠加态，从而在特定问题上实现指数级加速。\n\n目前最著名的量子算法是 Shor 算法和 Grover 算法，它们分别在整数分解和无序搜索上展示了量子优势。\n\n在硬件实现方面，超导量子比特和离子阱是目前最成熟的两条技术路线。`;
      const native = nativeDemoSlices(request, content);
      return {
        content: native.content,
        slices: native.slices,
        status: "grounded" as ResearchGroundingScopeStatus,
        queries: ["量子计算基本原理"],
        sources: [
          { title: "量子计算基本概念与原理", url: "https://example.com/quantum-intro", snippet: "量子计算利用量子叠加和纠缠实现并行计算。" },
          { title: "量子算法综述", url: "https://example.com/quantum-algorithms", snippet: "Shor 算法实现了整数分解的指数加速。" },
        ],
        citations: [],
      };
    },
  };
  return demoProvider;
}

function demoAnswer(request: ResearchGenerationRequest): string {
  if (request.deepResearch) {
    const selectionText = request.deepResearch.selectionText;
    const excerpt = selectionText.length > 24 ? `${selectionText.slice(0, 24)}…` : selectionText;
    const destination = request.deepResearch.mode === "branch" ? "沿当前内容建立的研究分支" : "独立研究会话";
    const direction = [...request.messages].reverse().find((message) => message.role === "user")?.content.trim() || "这段选区";
    return `${DEMO_NOTICE}\n\n你从选区"${excerpt}"发起了深入研究，进入${destination}。研究方向："${direction.slice(0, 80)}"。\n\n这是用于验证深入研究流程的确定性本地内容，只基于当前已有材料，未联网检索，也不代表真实 AI 研究结果。\n\nTODO（正式版本）：接入用户配置的真实模型后，由模型基于来源内容、选区上下文和研究方向生成第一轮研究内容，并如实说明材料范围。`;
  }
  const latestQuestion = [...request.messages].reverse().find((message) => message.role === "user")?.content.trim();
  const topic = latestQuestion || "这个问题";
  return `${DEMO_NOTICE}\n\n你正在研究："${topic}"\n\n这是用于验证 Collector 核心流程的确定性本地内容。建议先明确关键概念，再列出需要比较的观点与证据，最后记录仍待验证的问题。文件导入和阅读内容可作为后续研究材料。\n\nTODO（正式版本）：接入用户配置的真实模型与来源检索后，由模型基于会话和已导入材料生成回答，并为事实性结论提供可返回的来源。`;
}

function nativeDemoSlices(request: ResearchGenerationRequest, answer: string) {
  return parseNativeResearchSliceGeneration({
    slices: answer.trim().split(/\n\s*\n/).map((content, index) => ({
      title: `演示段落 ${index + 1}`,
      content,
      normalizedConcepts: [],
    })),
  }, {
    nodeId: request.nodeId ?? request.session.id,
    messageId: request.outputMessageId ?? request.taskId,
    ordinalStart: request.sliceOrdinalStart ?? 0,
  });
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
        summary: `${DEMO_SELECTION_NOTICE}这段选区（"${excerpt}"）是确定性演示内容，用于验证选区智能窗口的展示与交互，不代表真实分析。`,
        difficulty: "中",
        quickReadMinutes: 2,
        deepStudyMinutes: 10,
        prerequisites: ["演示前置知识：仅用于界面验证，无实际学习要求"],
        relationToContent: `${DEMO_SELECTION_NOTICE}演示关系说明：该选区位于当前内容中，真实版本会由模型说明它与上下文的关系。`,
        ...(focus ? { relationToFocus: `${DEMO_SELECTION_NOTICE}演示关系说明：你最近在关注"${focus.slice(0, 40)}"，真实版本会分析选区与该方向的关系。` } : {}),
        rationale: `${DEMO_SELECTION_NOTICE}这是本地确定性输出，不基于模型推理，也不构成任何事实判断；所有字段仅用于验证界面与数据流。`,
      };
    },
  };
}

export { DEMO_NOTICE, DEMO_SELECTION_NOTICE };
