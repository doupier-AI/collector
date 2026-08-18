/**
 * 直连探针（T03）：验证导入章节解析提示词的真实模型输出契约。
 * - 用一段无标题长文（多段落）构造编号块，调用 gateway.parseImportChapters；
 * - 校验输出为合法章节 JSON（块号在范围内、严格递增、标题非空），并报告弱标记残留。
 * 只读配置、不写仓库数据；输出打到 stdout。
 * 用法：node scripts/probe-import-chapters.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatImportChapterParseInput, validateImportChapterPlan } from "@collector/capture-contracts";
import { createProvider, DEFAULT_PROVIDER_REGISTRY, ModelGateway } from "@collector/model-gateway";

// 本机数据目录：显式覆盖优先，否则从脚本位置向上查找 .collector-data（工作区/worktree 下运行均可命中主目录数据）。
function locateDataDir() {
  if (process.env.COLLECTOR_REAL_MODEL_DATABASE?.trim()) return process.env.COLLECTOR_REAL_MODEL_DATABASE.trim();
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, ".collector-data", "collector.sqlite");
    if (existsSync(candidate)) return candidate;
    current = join(current, "..");
  }
  return join(process.cwd(), ".collector-data", "collector.sqlite");
}

const databasePath = locateDataDir();
const database = new DatabaseSync(databasePath, { readOnly: true });
const profiles = database.prepare("SELECT id, record_json FROM provider_profiles").all()
  .map((row) => ({ id: row.id, profile: JSON.parse(row.record_json) }));
const preferred = profiles.find(({ profile }) => profile.providerId === "deepseek" && profile.model === "deepseek-v4-flash") ?? profiles[0];
if (!preferred) {
  throw new Error(`探针前提未满足：${databasePath} 中没有模型档案——请先在 WebUI 的 AI 模型设置中保存并启用`);
}
const credential = database.prepare("SELECT api_key FROM provider_credentials WHERE id = ?").get(preferred.id)?.api_key;
database.close();
if (!credential) {
  throw new Error(`探针前提未满足：模型档案 ${preferred.id}（${preferred.profile.providerId}/${preferred.profile.model}）无凭证——请在 WebUI 检查该配置的 API Key`);
}

const definition = DEFAULT_PROVIDER_REGISTRY.get(preferred.profile.providerId);
const provider = createProvider(definition, {
  apiKey: () => credential.trim(),
  baseUrl: preferred.profile.baseUrl || definition.defaultBaseUrl,
});
const gateway = new ModelGateway(provider, { model: preferred.profile.model, thinking: false });

// 无标题多段样本：段落即块（与导入 TXT 解析产出一致）。探针直连 gateway.parseImportChapters，
// 不经过导入主流程的长文阈值门槛（阈值只决定是否创建解析任务），故样本无需达到阈值。
const paragraphs = [
  "城市公共交通的演化从来不只是工程问题。它折射出一个社会对空间、时间与公平的理解。",
  "在工业化早期，城市规模有限，步行与畜力足以覆盖大多数出行需求。电车与铁路的出现第一次把通勤距离拉长到十公里以上。",
  "二战以后，私人汽车一度成为规划的主导逻辑。宽阔的快速路把城市切开，也把生活功能推向边缘。",
  "拥堵治理的实践表明，单纯增加道路供给往往诱发更多出行需求，这就是交通经济学中的诱导需求现象。",
  "公交优先战略试图逆转这一逻辑：把有限的路权让给载客效率更高的交通工具，并用地价与停车政策引导出行结构。",
  "轨道交通的容量优势无可替代，但建设周期长、成本高，无法独自解决全部问题。地面公交的灵活性则是它的补充。",
  "慢行系统的回归同样重要。连续的步行与骑行网络不仅服务最后一公里，也直接改善街道活力与公共健康。",
  "票价体系的设计需要在公益性与财务可持续之间取得平衡。过低票价加重财政负担，过高票价又把乘客推回私人交通。",
  "数据技术的进步让动态调度、按需公交与一体化支付成为可能，但也带来了隐私与算法公平的新问题。",
  "面向未来，城市交通的评价标准正在从“车辆通行速度”转向“人的可达性”：一个普通居民能否在合理时间内抵达工作、学校、医疗与文化设施。",
  "这也意味着规划的组织方式需要变化：交通、住房、就业政策必须放在同一张图上协同决策，而不是各自为政。",
  "最终，一座出行友好的城市，是让不拥有私家车的人也能体面、便捷地生活的城市。",
].map((text, index) => ({ id: `p${index}`, ordinal: index, text, anchor: { kind: "text", startLine: index + 1, endLine: index + 1, exact: text.slice(0, 40) } }));

const input = formatImportChapterParseInput(paragraphs);
const startedAt = Date.now();
console.log(`[probe] blocks: ${input.blockCount}, input chars: ${input.content.length}`);
console.log(`[probe] started at ${new Date().toISOString()}`);

try {
  const raw = await gateway.parseImportChapters({ content: input.content });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[probe] finished in ${elapsed}s`);
  const anchors = validateImportChapterPlan(raw, input.blockCount);
  console.log(`[probe] weak markers [[ count: ${(raw.match(/\[\[/g) ?? []).length}`);
  if (!anchors) {
    console.log(`[probe] VERDICT: FAIL（输出不符合章节契约）`);
  } else if (anchors.length < 2) {
    console.log(`[probe] VERDICT: FAIL（章节数不足 2）`);
  } else {
    console.log(`[probe] VERDICT: PASS（${anchors.length} 章：${anchors.map((anchor) => `B${anchor.blockOrdinal}「${anchor.title}」`).join(" / ")}）`);
  }
  console.log("----- RAW OUTPUT BEGIN -----");
  console.log(raw.slice(0, 3000));
  console.log("----- RAW OUTPUT END (first 3000 chars) -----");
} catch (error) {
  console.log(`[probe] ERROR after ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${String(error).slice(0, 300)}`);
}
