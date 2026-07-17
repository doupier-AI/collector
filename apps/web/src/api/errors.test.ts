import { describe, expect, it } from "vitest";
import { ApiRequestError, NetworkError, apiErrorCopy, isUnauthorized } from "./errors";

describe("apiErrorCopy 错误文案映射", () => {
  it("401 unauthorized 映射为配对引导文案", () => {
    const copy = apiErrorCopy(new ApiRequestError(401, "unauthorized", "unauthorized"));
    expect(copy.title).toBe("需要重新配对");
    expect(isUnauthorized(new ApiRequestError(401, "unauthorized", ""))).toBe(true);
    expect(isUnauthorized(new ApiRequestError(401, "invalid_pairing", ""))).toBe(false);
  });

  it("404 not_found 映射为不存在文案", () => {
    expect(apiErrorCopy(new ApiRequestError(404, "not_found", "")).title).toBe("没有找到");
  });

  it("500 internal_error 映射为通用重试文案", () => {
    const copy = apiErrorCopy(new ApiRequestError(500, "internal_error", "db locked"));
    expect(copy.title).toBe("服务出现问题");
    expect(copy.body).toContain("重试");
  });

  it("invalid_pairing 映射为配对码错误文案", () => {
    const copy = apiErrorCopy(new ApiRequestError(401, "invalid_pairing", ""));
    expect(copy.title).toBe("配对码不正确");
    expect(copy.body).toContain("6 位配对码");
  });

  it("pairing_rate_limited 映射为限流文案", () => {
    const copy = apiErrorCopy(new ApiRequestError(429, "pairing_rate_limited", ""));
    expect(copy.title).toBe("尝试次数过多");
  });

  it("403 local_access_denied 不提示绕过方式", () => {
    const copy = apiErrorCopy(new ApiRequestError(403, "local_access_denied", ""));
    expect(copy.title).toBe("来源被拒绝");
    expect(copy.body).toContain("本机");
  });

  it("网络失败映射为连接失败文案", () => {
    expect(apiErrorCopy(new NetworkError()).title).toBe("连接失败");
  });

  it("未知错误有兜底文案", () => {
    expect(apiErrorCopy(new Error("boom")).title).toBe("出现未知错误");
    expect(apiErrorCopy(undefined).title).toBe("出现未知错误");
  });
});
