import type { ResearchTaskRecord } from "@collector/capture-contracts";

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatSessionTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return timeFormatter.format(date);
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 超出 7 天回落为具体时间。 */
export function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return timeFormatter.format(date);
}

/** 任务失败原因的中文说明；只按 code 映射，不展示堆栈、供应商响应或密钥。 */
export function taskErrorReason(task: ResearchTaskRecord): string {
  switch (task.error?.code) {
    case "model_not_configured":
      return "还没有配置可用模型。输入已保存，配置模型后可以重试。";
    case "provider_error":
      return "生成过程中出现问题。已保存的内容不会丢失，可以稍后重试。";
    case "service_restarted":
      return "服务在生成过程中重启。已保存的内容不会丢失，可以重试。";
    default:
      return "生成没有完成。已保存的内容不会丢失。";
  }
}
