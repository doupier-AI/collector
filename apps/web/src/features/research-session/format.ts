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
