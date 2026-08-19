/**
 * 直连探针：验证 ADR-0035 思考传输链路（真实 DeepSeek）。
 * - 默认（开关关闭）：无 reasoning 增量、正文快速开始（首字延迟小）。
 * - --thinking：reasoning 增量经 onReasoning 旁路逐字到达、与正文分离、正文不受污染。
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
const thinking = process.argv.includes("--thinking");
const gateway = new ModelGateway(provider, { model: preferred.profile.model, thinking });

const startedAt = Date.now();
const at = () => ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`[probe] model=${preferred.profile.model} thinking=${thinking} question=${question}`);

let reasoningChars = 0;
let firstReasoningAt;
let contentChars = 0;
let firstContentAt;
for await (const delta of gateway.writeResearchBodyStream([{ role: "user", content: question }], {
  onReasoning: (text) => {
    if (firstReasoningAt === undefined) firstReasoningAt = Date.now();
    reasoningChars += text.length;
  },
})) {
  if (firstContentAt === undefined) firstContentAt = Date.now();
  contentChars += delta.length;
}
console.log(`[probe] 总耗时 ${at()}s`);
console.log(`[probe] 思考增量: ${reasoningChars} 字，首思考增量 ${firstReasoningAt ? ((firstReasoningAt - startedAt) / 1000).toFixed(1) + "s" : "从未到达"}`);
console.log(`[probe] 正文增量: ${contentChars} 字，首正文增量 ${firstContentAt ? ((firstContentAt - startedAt) / 1000).toFixed(1) + "s" : "从未到达"}`);
if (thinking && reasoningChars === 0) {
  console.error("[probe] FAIL：thinking 开启但无思考增量到达（reasoning_content 解析或旁路转发失效）");
  process.exit(1);
}
if (!thinking && reasoningChars > 0) {
  console.error("[probe] FAIL：thinking 关闭仍收到思考增量（开关未生效）");
  process.exit(1);
}
console.log("[probe] OK");
