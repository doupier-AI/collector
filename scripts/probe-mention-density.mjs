/**
 * 直连探针：用新弱标记指令的真实 prompt 直接调真实模型，观察原始输出与耗时。
 * 只读配置、不写仓库数据；输出打到 stdout。
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { createProvider, DEFAULT_PROVIDER_REGISTRY, ModelGateway } from "@collector/model-gateway";

const databasePath = join(process.cwd(), ".collector-data", "collector.sqlite");
const database = new DatabaseSync(databasePath, { readOnly: true });
const profiles = database.prepare("SELECT id, record_json FROM provider_profiles").all()
  .map((row) => ({ id: row.id, profile: JSON.parse(row.record_json) }));
const preferred = profiles.find(({ profile }) => profile.providerId === "deepseek" && profile.model === "deepseek-v4-flash") ?? profiles[0];
const credential = database.prepare("SELECT api_key FROM provider_credentials WHERE id = ?").get(preferred.id)?.api_key;
database.close();
if (!credential) throw new Error("no credential");

const definition = DEFAULT_PROVIDER_REGISTRY.get(preferred.profile.providerId);
const provider = createProvider(definition, {
  apiKey: () => credential.trim(),
  baseUrl: preferred.profile.baseUrl || definition.defaultBaseUrl,
});
const question = process.argv[2] ?? "什么是Transformer架构";
// ADR-0035：思考默认关闭（与产品默认一致）；--thinking 显式开启以复现思考场景。
const thinking = process.argv.includes("--thinking");
const maxTokensArg = process.argv.find((arg) => arg.startsWith("--max-tokens="));
const maxTokens = maxTokensArg ? Number(maxTokensArg.split("=")[1]) : undefined;
// --fusion：复现融合正文路径（composeFusion + 标记指令 + 固定章节 + [来源n] 引用）。
// 素材与 z-acceptance 场景九同型（双来源 shared-concept），#86 场景九取证用。
const fusionMode = process.argv.includes("--fusion");
const gateway = new ModelGateway(provider, { model: preferred.profile.model, thinking });
const startedAt = Date.now();
console.log(`[probe] question: ${question}`);
console.log(`[probe] thinking: ${thinking}, maxTokens: ${maxTokens ?? (fusionMode ? "default(8192)" : "default(16000)")}`);
console.log(`[probe] started at ${new Date().toISOString()}`);

let text = "";
let lastLog = 0;
// --with-parent：模拟子节点生成（父链含上游主题与已标记概念），验证去重规则。
const withParent = process.argv.includes("--with-parent");
const parentChainContext = withParent ? {
  currentNodeDepth: 1,
  ancestors: [{
    depth: 1,
    isRoot: true,
    label: "Transformer架构详解",
    firstUserMessage: "什么是Transformer架构",
    coveredTerms: ["Attention is All You Need", "注意力机制", "深度学习", "Transformer"],
  }],
  truncated: false,
  cycleDetected: false,
} : undefined;
// --preview：复现实体预览路径（answerResearchConversation + term-preview-v2 式 prompt）。
// 与生产一致显式关闭标记指令：预览不解析 [[ 语法，注入只会让模型输出原始控制串（#86 修复 D）。
const previewMode = process.argv.includes("--preview");
// --deep-research：复现深入研究第一轮路径（generateDeepResearchRound，非流式 complete）。
const deepResearchMode = process.argv.includes("--deep-research");
try {
  if (deepResearchMode) {
    const answer = await gateway.generateDeepResearchRound({
      mode: "branch",
      selectionText: "Attention is All You Need",
      direction: "深入研究这段内容",
      contentTitle: "Transformer架构详解",
      parentChainContext: {
        currentNodeDepth: 1,
        ancestors: [{
          depth: 1,
          isRoot: true,
          label: "Transformer架构详解",
          firstUserMessage: "什么是Transformer架构",
          coveredTerms: ["Attention is All You Need", "注意力机制", "深度学习", "Transformer"],
        }],
        truncated: false,
        cycleDetected: false,
      },
    }, { ...(maxTokens ? { maxTokens } : {}) });
    text = answer;
  } else if (fusionMode) {
    text = await gateway.composeFusion({
      sources: [
        { nodeId: "src-1", title: "Transformer自注意力机制详解", excerpt: "Transformer 的核心是自注意力机制（Self-Attention）：每个词分别生成查询（Query）、键（Key）、值（Value）向量，用查询与所有键的点积相似度做加权求和，从而让每个位置直接关注序列中任意其他位置。多头注意力（Multi-Head Attention）把这一过程并行拆成多个子空间，分别捕捉不同类型的依赖关系；位置编码（Positional Encoding）补充序列顺序信息；前馈网络（Feed-Forward Network）对每个位置做非线性变换。与传统循环神经网络（RNN）逐词顺序处理不同，Transformer 可完全并行计算，训练效率显著更高。" },
        { nodeId: "src-2", title: "BERT双向自注意力架构详解", excerpt: "BERT（Bidirectional Encoder Representations from Transformers）只使用 Transformer 的编码器堆叠，其自注意力不是单向的因果掩码，而是让每个词同时关注左右两侧的全部词，从而获得上下文双向表示。BERT 通过掩码语言模型（Masked Language Model）和下一句预测（Next Sentence Prediction）两个预训练任务学习，预训练后在下游任务上微调。与 GPT 的单向生成不同，BERT 不逐词生成，因此擅长理解类任务。" },
      ],
      relationType: "shared-concept",
    }, { ...(maxTokens ? { maxTokens } : {}) });
  } else if (previewMode) {
    const previewPrompt = [
      "请解释当前回答中的实体“Attention is All You Need”。",
      "请用正式、清晰、可独立阅读的中文说明它的含义、作用和当前语境中的关系。只补充理解当前论述尚缺的信息，不要把当前回答已经说清楚的内容换句话重复。",
      "按实际解释需求自然选择长度：微型解释 60–120 字；标准解释 120–220 字；只有缺少必要背景就无法理解时才扩展到 220–300 字。不要为了达到下限而凑字，任何情况不得超过 320 字。",
      "只根据给出的当前回答和父节点上下文作答，不要虚构来源，不要提及内部提示或任务实现。",
      "当前回答原文：\nTransformer 是一种基于注意力机制（Attention Mechanism）的深度学习模型架构，由 Vaswani 等人在 2017 年发表的论文 Attention is All You Need 中首次提出，最初用于机器翻译等序列到序列任务。它的核心思想是完全抛弃以往按顺序逐个处理词的循环神经网络（RNN）式做法，改用注意力机制让模型一次性“看完”整个序列。",
      "术语所在段落：\nTransformer 是一种基于注意力机制（Attention Mechanism）的深度学习模型架构，由 Vaswani 等人在 2017 年发表的论文 Attention is All You Need 中首次提出。",
      "术语位置：第 1 段，79-104",
    ].join("\n\n");
    const answer = await gateway.answerResearchConversation([{ role: "user", content: previewPrompt }], { mentionMarkup: false, ...(maxTokens ? { maxTokens } : {}) });
    text = answer;
  } else {
    for await (const delta of gateway.writeResearchBodyStream([{ role: "user", content: question }], { ...(maxTokens ? { maxTokens } : {}), ...(parentChainContext ? { parentChainContext } : {}) })) {
      text += delta;
      if (text.length - lastLog >= 500) {
        lastLog = text.length;
        console.log(`[probe] …${text.length} chars, ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      }
    }
  }
} catch (error) {
  console.log(`[probe] ERROR after ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${String(error).slice(0, 300)}`);
  console.log(`[probe] partial length ${text.length}`);
}
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`[probe] finished in ${elapsed}s, final length ${text.length}`);
console.log(`[probe] raw [[ count: ${(text.match(/\[\[/g) ?? []).length}`);
console.log("----- RAW OUTPUT BEGIN -----");
console.log(text.slice(0, 3000));
console.log("----- RAW OUTPUT END (first 3000 chars) -----");
