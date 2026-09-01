import type { ResearchGenerationProvider, ResearchGenerationRequest } from "./research.js";

const DEMO_NOTICE = "【本地演示回答｜非真实 AI｜未联网检索】";

export function createMvpDemoResearchProvider(): ResearchGenerationProvider {
  const demoProvider: ResearchGenerationProvider = {
    provider: "collector-mvp-demo",
    model: "deterministic-local-demo",
    promptVersion: "mvp-demo-v1",
    groundingCapability: "unsupported",
    // 生成自由化：demo 直接产出自由正文，正式切片由服务层按段落块确定性派生。
    async writeBody(request: ResearchGenerationRequest) {
      return demoAnswer(request);
    },
    async *generate(request: ResearchGenerationRequest) {
      const answer = demoAnswer(request);
      for (let index = 0; index < answer.length; index += 80) yield answer.slice(index, index + 80);
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

export { DEMO_NOTICE };
