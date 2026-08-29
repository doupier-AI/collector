import type {
  ResearchCandidateSourceConnectionRecord,
  ResearchFusionEvidenceStatus,
} from "@collector/capture-contracts";

export function evidenceStatusLabel(status: ResearchFusionEvidenceStatus): string {
  if (status === "verified") return "证据已核验";
  if (status === "pending") return "等待核验";
  return "证据无效";
}

export function evidenceStatusDescription(status: ResearchFusionEvidenceStatus): string {
  if (status === "verified") return "当前版本的判断已核验，可以在来源可用时确认。";
  if (status === "pending") return "仅受修改影响的判断正在等待核验。";
  return "当前版本包含不能保持已核验的判断。";
}

export function sourceHealthLabel(source: ResearchCandidateSourceConnectionRecord): string | undefined {
  if (source.sourceHealth === "available") return undefined;
  return source.sourceHealth === "deleted" ? "来源已永久删除，不能打开" : "来源暂不可用，恢复后可打开";
}

export function adjacentDraftDifference(current: string, previous: string): string {
  let prefix = 0;
  while (prefix < current.length && prefix < previous.length && current[prefix] === previous[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < current.length - prefix && suffix < previous.length - prefix && current[current.length - suffix - 1] === previous[previous.length - suffix - 1]) suffix += 1;
  const removed = previous.slice(prefix, previous.length - suffix);
  const added = current.slice(prefix, current.length - suffix);
  return `相对上一版：${removed ? `删除“${removed}”` : "无删除"}${added ? `；新增“${added}”` : "；无新增"}`;
}
