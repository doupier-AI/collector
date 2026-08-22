// 失控自动融合数据清理（一次性维护脚本，2026-08-22 融合膨胀事故处置）。
// 删除全部 isAutoFusionNode=true 的节点及其派生数据；保留确认式融合节点与真实节点。
// 用法：node scripts/cleanup-runaway-fusion.mjs [--db <path>] [--execute]
// 默认干跑只打印前后对照；--execute 才在单事务内删除。
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const dbIndex = args.indexOf("--db");
const dbPathArg = dbIndex >= 0 ? args[dbIndex + 1] : undefined;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = dbPathArg ? resolve(repositoryRoot, dbPathArg) : join(repositoryRoot, ".collector-data", "collector.sqlite");
if (!existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}（只读检查）`);

const db = new DatabaseSync(dbPath, execute ? {} : { readOnly: true });
db.exec("PRAGMA busy_timeout = 5000");
const tableCheck = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'research_nodes'").get();
if (tableCheck.n !== 1) throw new Error(`打开的数据库缺少 research_nodes 表：${dbPath}`);

const fusionNodeIds = db.prepare(
  "SELECT id FROM research_nodes WHERE json_extract(record_json, '$.isAutoFusionNode') = 1",
).all().map((row) => row.id);
const manualFusionCount = db.prepare(
  "SELECT COUNT(*) AS n FROM research_nodes WHERE json_extract(record_json, '$.isFusionNode') = 1 AND json_extract(record_json, '$.isAutoFusionNode') IS NOT 1",
).get().n;
const bySession = db.prepare(
  "SELECT session_id, COUNT(*) AS n FROM research_nodes WHERE id IN (" + fusionNodeIds.map(() => "?").join(",") + ") GROUP BY session_id ORDER BY n DESC",
).all(...fusionNodeIds);

const scope = (table, column, sql) => {
  if (!fusionNodeIds.length) return 0;
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IN (SELECT value FROM json_each(?))`).get(JSON.stringify(fusionNodeIds)).n;
};

const messagesOf = scope("research_messages", "node_id");
const tasksOf = scope("research_tasks", "node_id");
const edgesOf = db.prepare(
  "SELECT COUNT(*) AS n FROM research_edges WHERE from_node_id IN (SELECT value FROM json_each(?)) OR to_node_id IN (SELECT value FROM json_each(?))",
).get(JSON.stringify(fusionNodeIds), JSON.stringify(fusionNodeIds)).n;
const proposalsTouching = db.prepare(
  "SELECT COUNT(*) AS n FROM research_fusion_proposals WHERE lo_node_id IN (SELECT value FROM json_each(?)) OR hi_node_id IN (SELECT value FROM json_each(?))",
).get(JSON.stringify(fusionNodeIds), JSON.stringify(fusionNodeIds)).n;
const autoProducedProposalIds = fusionNodeIds.length
  ? db.prepare(
      "SELECT substr(idempotency_key, length('auto-fuse:') + 1) AS proposal_id FROM research_tasks WHERE idempotency_key LIKE 'auto-fuse:%' AND node_id IN (SELECT value FROM json_each(?))",
    ).all(JSON.stringify(fusionNodeIds)).map((row) => row.proposal_id)
  : [];

console.log(`数据库：${dbPath}`);
console.log(`将删除的自动融合节点：${fusionNodeIds.length}（分布于 ${bySession.length} 个会话）`);
for (const row of bySession) console.log(`  会话 ${row.session_id}: ${row.n} 个`);
console.log(`保留的确认式融合节点：${manualFusionCount}`);
console.log(`将删除的关联数据：消息 ${messagesOf}、任务 ${tasksOf}、边 ${edgesOf}、涉及自动融合节点的提议 ${proposalsTouching}、自动融合产出的提议 ${autoProducedProposalIds.length}`);

if (!execute) {
  console.log("干跑完成——未做任何修改。加 --execute 执行删除。");
  db.close();
  process.exit(0);
}

db.exec("BEGIN IMMEDIATE");
try {
  const del = (sql, ...values) => db.prepare(sql).run(...values);
  const ids = JSON.stringify(fusionNodeIds);
  del(`UPDATE semantic_search_index_generations
    SET source_key = CASE WHEN source_key LIKE 'invalidated:%' THEN source_key ELSE 'invalidated:' || source_key END
    WHERE id IN (SELECT DISTINCT generation_id FROM semantic_search_units WHERE node_id IN (SELECT value FROM json_each(?)))`, ids);
  del("DELETE FROM semantic_search_units_fts WHERE rowid IN (SELECT rowid FROM semantic_search_units WHERE node_id IN (SELECT value FROM json_each(?)))", ids);
  del("DELETE FROM semantic_search_units WHERE node_id IN (SELECT value FROM json_each(?))", ids);
  del(`DELETE FROM research_semantic_fragments WHERE node_id IN (SELECT value FROM json_each(?)) OR message_id IN (SELECT id FROM research_messages WHERE node_id IN (SELECT value FROM json_each(?)))`, ids, ids);
  del(`DELETE FROM research_body_versions WHERE node_id IN (SELECT value FROM json_each(?)) OR message_id IN (SELECT id FROM research_messages WHERE node_id IN (SELECT value FROM json_each(?)))`, ids, ids);
  del(`DELETE FROM research_slices WHERE node_id IN (SELECT value FROM json_each(?)) OR message_id IN (SELECT id FROM research_messages WHERE node_id IN (SELECT value FROM json_each(?)))`, ids, ids);
  del(`DELETE FROM research_citations WHERE message_id IN (SELECT id FROM research_messages WHERE node_id IN (SELECT value FROM json_each(?)))`, ids);
  del(`DELETE FROM research_task_events WHERE task_id IN (SELECT id FROM research_tasks WHERE node_id IN (SELECT value FROM json_each(?)))`, ids);
  del(`DELETE FROM research_fusion_proposals WHERE lo_node_id IN (SELECT value FROM json_each(?)) OR hi_node_id IN (SELECT value FROM json_each(?))`, ids, ids);
  if (autoProducedProposalIds.length) {
    del(`DELETE FROM research_fusion_proposals WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(autoProducedProposalIds));
  }
  del(`DELETE FROM research_edges WHERE from_node_id IN (SELECT value FROM json_each(?)) OR to_node_id IN (SELECT value FROM json_each(?))`, ids, ids);
  del("DELETE FROM research_nodes WHERE id IN (SELECT value FROM json_each(?))", ids);
  del("DELETE FROM research_tasks WHERE node_id IN (SELECT value FROM json_each(?))", ids);
  del("DELETE FROM research_messages WHERE node_id IN (SELECT value FROM json_each(?))", ids);
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  console.error("清理失败，已回滚：", error);
  db.close();
  process.exit(1);
}

const remainingAuto = db.prepare("SELECT COUNT(*) AS n FROM research_nodes WHERE json_extract(record_json, '$.isAutoFusionNode') = 1").get().n;
const remainingNodes = db.prepare("SELECT COUNT(*) AS n FROM research_nodes").get().n;
const remainingProposals = db.prepare("SELECT COUNT(*) AS n FROM research_fusion_proposals").get().n;
console.log(`清理完成：剩余自动融合节点 ${remainingAuto}（应为 0）、剩余节点总数 ${remainingNodes}、剩余提议 ${remainingProposals}。`);
db.close();
