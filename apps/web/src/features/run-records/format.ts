import type { RunRecordErrorCategory, RunRecordOperationType, RunRecordOutcome, RunRecordStatus } from "@collector/capture-contracts";

export const operationLabels: Record<RunRecordOperationType, string> = {
  research: "对话研究",
  selection_analysis: "选区分析",
  document_import: "文档导入",
  similarity_verification: "相似概念核验",
  chapter_parse: "导入章节解析",
};

export const outcomeLabels: Record<RunRecordOutcome, string> = {
  success: "成功",
  failure: "失败",
  active: "进行中",
  cancelled: "已取消",
  unavailable: "不可用",
};

export const statusLabels: Record<RunRecordStatus, string> = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  corrupt: "记录损坏",
};

export const errorCategoryLabels: Record<RunRecordErrorCategory, string> = {
  authentication: "认证",
  network: "网络",
  validation: "输入校验",
  provider: "模型服务",
  search: "联网搜索",
  storage: "本地存储",
  unknown: "其他",
};

export function formatDateTime(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return "时间不可用";
  return new Intl.DateTimeFormat("zh-Hans", { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

export function formatDuration(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1_000) return `${Math.round(value)} 毫秒`;
  const seconds = value / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${Math.round(seconds % 60)} 秒`;
}

export function formatTokens(value: number): string {
  return new Intl.NumberFormat("zh-Hans").format(Math.max(0, Math.round(value)));
}
