import type { ApiError } from "@collector/capture-contracts";

/** 网络层失败（服务停止、离线、连接被拒绝），与 HTTP 错误区分开。 */
export class NetworkError extends Error {
  constructor(message = "网络连接失败") {
    super(message);
    this.name = "NetworkError";
  }
}

/** 后端按统一结构返回的 HTTP 错误。逻辑判断只使用 code，不使用英文 message。 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message || code);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

export function parseApiErrorBody(body: unknown): { code: string; message: string } | undefined {
  if (!body || typeof body !== "object") return undefined;
  const error = (body as ApiError).error;
  if (!error || typeof error.code !== "string") return undefined;
  return { code: error.code, message: typeof error.message === "string" ? error.message : "" };
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 401 && error.code === "unauthorized";
}

export function isApiErrorCode(error: unknown, code: string): boolean {
  return error instanceof ApiRequestError && error.code === code;
}

export interface ErrorCopy {
  title: string;
  body: string;
}

/** 按错误 code 映射用户可见中文文案，不依赖后端英文 message 做逻辑判断。 */
export function apiErrorCopy(error: unknown): ErrorCopy {
  if (error instanceof NetworkError) {
    return {
      title: "连接失败",
      body: "无法连接 Collector 服务。请确认 Collector 正在运行，然后重试。",
    };
  }
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case "unauthorized":
        return { title: "需要重新配对", body: "登录状态已过期或尚未配对，配对成功后即可继续。" };
      case "invalid_pairing":
        return { title: "配对码不正确", body: "配对码不正确或已过期，请核对 Collector 启动器上显示的 6 位配对码。" };
      case "pairing_rate_limited":
        return { title: "尝试次数过多", body: "配对尝试太频繁，请一分钟后再试。" };
      case "local_access_denied":
        return { title: "来源被拒绝", body: "Collector 只允许本机页面访问，请从 Collector 启动器打开。" };
      case "not_found":
        return { title: "没有找到", body: "请求的内容不存在或已经清理。" };
      case "invalid_request":
        return { title: "请求无效", body: "提交内容不符合要求，请调整后重试。" };
      case "internal_error":
        return { title: "服务出现问题", body: "Collector 服务暂时出现错误，请稍后重试。" };
      default:
        return { title: "请求失败", body: "操作没有完成，请重试。" };
    }
  }
  return { title: "出现未知错误", body: "操作没有完成，请重试。" };
}
