/**
 * 直连探针（原始 API 层）：复现融合正文空正文问题（#86 场景九），打印 finish_reason、
 * reasoning_content 与 content 长度、usage，判断是预算耗尽（length）还是模型行为（stop 但空正文）。
 * 只读配置、不写仓库数据；输出打到 stdout。
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { DEFAULT_PROVIDER_REGISTRY, formatMentionMarkupInstructions } from "@collector/model-gateway";

const databasePath = join(process.cwd(), ".collector-data", "collector.sqlite");
const database = new DatabaseSync(databasePath, { readOnly: true });
const profiles = database.prepare("SELECT id, record_json FROM provider_profiles").all()
  .map((row) => ({ id: row.id, profile: JSON.parse(row.record_json) }));
const preferred = profiles.find(({ profile }) => profile.providerId === "deepseek" && profile.model === "deepseek-v4-flash") ?? profiles[0];
const credential = database.prepare("SELECT api_key FROM provider_credentials WHERE id = ?").get(preferred.id)?.api_key;
database.close();
if (!credential) throw new Error("no credential");

const definition = DEFAULT_PROVIDER_REGISTRY.get(preferred.profile.providerId);
const baseUrl = (preferred.profile.baseUrl || definition.defaultBaseUrl).replace(/\/$/, "");
const maxTokens = Number((process.argv.find((arg) => arg.startsWith("--max-tokens=")) ?? "--max-tokens=8192").split("=")[1]);
const thinking = !process.argv.includes("--no-thinking");

// 与 model-gateway composeFusion 完全一致的 prompt 组装（双来源 shared-concept）。
const sources = [
  { nodeId: "src-1", title: "Transformer自注意力机制详解", excerpt: "Transformer 的核心是自注意力机制（Self-Attention）：每个词分别生成查询（Query）、键（Key）、值（Value）向量，用查询与所有键的点积相似度做加权求和，从而让每个位置直接关注序列中任意其他位置。多头注意力（Multi-Head Attention）把这一过程并行拆成多个子空间，分别捕捉不同类型的依赖关系；位置编码（Positional Encoding）补充序列顺序信息；前馈网络（Feed-Forward Network）对每个位置做非线性变换。与传统循环神经网络（RNN）逐词顺序处理不同，Transformer 可完全并行计算，训练效率显著更高。" },
  { nodeId: "src-2", title: "BERT双向自注意力架构详解", excerpt: "BERT（Bidirectional Encoder Representations from Transformers）只使用 Transformer 的编码器堆叠，其自注意力不是单向的因果掩码，而是让每个词同时关注左右两侧的全部词，从而获得上下文双向表示。BERT 通过掩码语言模型（Masked Language Model）和下一句预测（Next Sentence Prediction）两个预训练任务学习，预训练后在下游任务上微调。与 GPT 的单向生成不同，BERT 不逐词生成，因此擅长理解类任务。" },
];
const relationGuidance = {
  "shared-concept": "这些来源共享概念但不等同：共同核心节说明共享概念，差异节说明各自边界与侧重。",
};
const sourceLines = sources.map((source, index) => {
  const ordinal = index + 1;
  return `来源${ordinal}（${source.title}，节点 ${source.nodeId}）：\n${JSON.stringify(source.excerpt.slice(0, 8_000))}`;
}).join("\n\n");
const prompt = `你是 Collector 的融合总结助手。用户确认了 shared-concept 关系，请把下面多个来源综合为一篇融合节点正文。

关系判断：${relationGuidance["shared-concept"]}

来源材料：
${sourceLines}

输出要求：
- 输出一篇连贯的中文 Markdown 正文，不使用代码围栏，不返回 JSON。
- 正文必须按顺序包含三个二级标题章节：## 共同核心、## 差异、## 综合推导。
  ## 共同核心 写各来源共同点；## 差异 写各来源差异（对比/类比关系时重点展开）；## 综合推导 写融合后的增量综合与结论。
- 正文以 [来源n] 标记引用对应来源（n 为来源序号），同一处可同时引用多个来源如 [来源1][来源2]；每条断言都应可追溯到来源材料。
- 只使用提供的来源材料，不补充外部事实、不编造来源。

${formatMentionMarkupInstructions({ scenario: "fusion", nodeDepth: 0 })}`;

const startedAt = Date.now();
console.log(`[probe-fusion-raw] model=${preferred.profile.model} maxTokens=${maxTokens}`);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error("client timeout 300s")), 300_000);
try {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential.trim()}`, "Content-Type": "application/json" },
    signal: controller.signal,
    body: JSON.stringify({
      model: preferred.profile.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      ...(thinking ? { thinking: { type: "enabled" } } : { thinking: { type: "disabled" } }),
    }),
  });
  const payload = await response.json().catch(() => undefined);
  const choice = payload?.choices?.[0];
  const message = choice?.message ?? {};
  const reasoning = message.reasoning_content ?? "";
  const content = message.content ?? "";
  console.log(`[probe-fusion-raw] HTTP ${response.status}`);
  console.log(`[probe-fusion-raw] finish_reason=${choice?.finish_reason}`);
  console.log(`[probe-fusion-raw] reasoning_content length=${reasoning.length}, content length=${content.length}`);
  console.log(`[probe-fusion-raw] usage=${JSON.stringify(payload?.usage ?? null)}`);
  console.log(`[probe-fusion-raw] elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.log(`[probe-fusion-raw] content head: ${content.slice(0, 200)}`);
  console.log(`[probe-fusion-raw] reasoning head: ${reasoning.slice(0, 200)}`);
} catch (error) {
  console.log(`[probe-fusion-raw] ERROR after ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${String(error).slice(0, 200)}`);
} finally {
  clearTimeout(timer);
}
