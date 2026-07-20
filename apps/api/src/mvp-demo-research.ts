import type { ResearchGenerationProvider, ResearchGenerationRequest } from "./research.js";

const DEMO_NOTICE = "【本地演示回答｜非真实 AI｜未联网检索】";

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

export { DEMO_NOTICE };
