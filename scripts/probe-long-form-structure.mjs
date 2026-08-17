/**
 * 直连探针（#92 T02）：验证提示词收敛后真实模型的行为契约。
 * - 缺省模式：普通回答（writeResearchBodyStream）应连续行文，不出现 `##` 碎片标题；
 * - --long：长文 plan-then-write（generateBodyOutline → 逐节 expandBodySection），
 *   每节首行必须是 `##` 二级标题（章节导航锚点的架构保证）。
 * 两种模式都顺带报告弱标记 `[[` 数量，确认四类标记指令在两条路径上仍然生效。
 * 只读配置、不写仓库数据；输出打到 stdout。
 * 用法：node scripts/probe-long-form-structure.mjs [问题] [--long] [--no-thinking]
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
const longMode = process.argv.includes("--long");
const noThinking = process.argv.includes("--no-thinking");
const question = process.argv.slice(2).find((arg) => !arg.startsWith("--"))
  ?? (longMode ? "写一篇3000字左右的系统论述，全面梳理大语言模型的发展历程、核心技术与应用边界" : "什么是Transformer架构");
const gateway = new ModelGateway(provider, { model: preferred.profile.model, thinking: !noThinking });

// 与服务端 shouldPlanLongForm 的硬约束检测同规则：首行为 `## ` 二级标题才算合规。
function startsWithHeading(text) {
  const firstLine = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^\s+/, "").split("\n", 1)[0] ?? "";
  return /^##(?!#)\s+\S/.test(firstLine);
}

const startedAt = Date.now();
console.log(`[probe] mode: ${longMode ? "long-form (plan-then-write)" : "normal answer"}`);
console.log(`[probe] question: ${question}`);
console.log(`[probe] thinking: ${!noThinking}`);
console.log(`[probe] started at ${new Date().toISOString()}`);

try {
  if (!longMode) {
    let text = "";
    let lastLog = 0;
    for await (const delta of gateway.writeResearchBodyStream([{ role: "user", content: question }])) {
      text += delta;
      if (text.length - lastLog >= 500) {
        lastLog = text.length;
        console.log(`[probe] …${text.length} chars, ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      }
    }
    const headingLines = text.split("\n").filter((line) => /^#{1,6}\s/.test(line.trim()));
    console.log(`[probe] finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s, final length ${text.length}`);
    console.log(`[probe] heading-like lines: ${headingLines.length}${headingLines.length ? ` -> ${JSON.stringify(headingLines.slice(0, 5))}` : ""}`);
    console.log(`[probe] weak markers [[ count: ${(text.match(/\[\[/g) ?? []).length}`);
    console.log(`[probe] VERDICT: ${headingLines.length === 0 ? "PASS（连续行文，无碎片标题）" : "FAIL（普通回答出现标题行）"}`);
    console.log("----- RAW OUTPUT BEGIN -----");
    console.log(text.slice(0, 3000));
    console.log("----- RAW OUTPUT END (first 3000 chars) -----");
  } else {
    const outline = await gateway.generateBodyOutline([{ role: "user", content: question }]);
    console.log(`[probe] outline sections: ${outline.sections.map((section) => `${section.heading}(${section.targetChars})`).join(" / ")}`);
    let writtenSoFar = "";
    const results = [];
    for (let index = 0; index < outline.sections.length; index += 1) {
      const sectionStartedAt = Date.now();
      // 对齐服务端有界修复：空输出最多重问 2 次（生产路径由 expandSectionBounded 承担）。
      let result;
      for (let attempt = 0; ; attempt += 1) {
        try {
          result = await gateway.expandBodySection({
            goal: question, outline, sectionIndex: index, writtenSoFar,
            ...(attempt > 0 ? { repairHint: "上次输出为空" } : {}),
          });
          break;
        } catch (error) {
          if (/empty content/.test(String(error)) && attempt < 2) {
            console.log(`[probe] section ${index + 1} empty output, re-ask ${attempt + 1}/2`);
            continue;
          }
          throw error;
        }
      }
      const elapsed = ((Date.now() - sectionStartedAt) / 1000).toFixed(1);
      const ok = startsWithHeading(result.content);
      results.push(ok);
      console.log(`[probe] section ${index + 1}「${outline.sections[index].heading}」 ${result.content.length} chars in ${elapsed}s, heading-first: ${ok ? "PASS" : "FAIL"}`);
      if (!ok) console.log(`[probe]   first line: ${JSON.stringify(result.content.split("\n", 1)[0]?.slice(0, 80))}`);
      writtenSoFar = writtenSoFar ? `${writtenSoFar}\n\n${result.content}` : result.content;
    }
    console.log(`[probe] finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s, total length ${writtenSoFar.length}`);
    console.log(`[probe] weak markers [[ count: ${(writtenSoFar.match(/\[\[/g) ?? []).length}`);
    console.log(`[probe] VERDICT: ${results.every(Boolean) ? "PASS（每节首行均为 ## 标题）" : `FAIL（${results.filter((ok) => !ok).length} 节缺首行标题）`}`);
    console.log("----- FIRST SECTION RAW BEGIN -----");
    console.log(writtenSoFar.slice(0, 1500));
    console.log("----- FIRST SECTION RAW END -----");
  }
} catch (error) {
  console.log(`[probe] ERROR after ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${String(error).slice(0, 300)}`);
}
