import { describe, expect, it } from "vitest";
import { RESEARCH_IMPORT_MAX_BYTES } from "@collector/capture-contracts";
import { ApiRequestError, NetworkError } from "../../api/errors";
import { importUploadErrorCopy, resolveImportMimeType, validateImportFile } from "./import-file";

describe("resolveImportMimeType", () => {
  it("按扩展名解析稳定 MIME，浏览器 MIME 缺失时也能识别", () => {
    expect(resolveImportMimeType("笔记.txt", "")).toBe("text/plain");
    expect(resolveImportMimeType("研究.MD", "")).toBe("text/markdown");
    expect(resolveImportMimeType("草稿.markdown", "application/octet-stream")).toBe("text/markdown");
    expect(resolveImportMimeType("报告.docx", "")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(resolveImportMimeType("论文.pdf", "application/pdf")).toBe("application/pdf");
  });

  it("无已知扩展名时回退到浏览器白名单 MIME", () => {
    expect(resolveImportMimeType("README", "text/markdown")).toBe("text/markdown");
    expect(resolveImportMimeType("数据", "text/plain; charset=utf-8")).toBe("text/plain");
  });

  it("不支持的类型返回 null", () => {
    expect(resolveImportMimeType("程序.exe", "application/x-msdownload")).toBeNull();
    expect(resolveImportMimeType("照片.png", "image/png")).toBeNull();
    expect(resolveImportMimeType("无扩展名", "")).toBeNull();
  });
});

describe("validateImportFile", () => {
  it("接受白名单内且未超限的文件", () => {
    expect(validateImportFile("笔记.txt", "text/plain", 1024)).toBeNull();
    expect(validateImportFile("论文.pdf", "application/pdf", RESEARCH_IMPORT_MAX_BYTES)).toBeNull();
  });

  it("拒绝不支持的类型、空文件与超限文件", () => {
    expect(validateImportFile("程序.exe", "application/x-msdownload", 10)).toContain("TXT、Markdown、DOCX、PDF");
    expect(validateImportFile("空.txt", "text/plain", 0)).toContain("为空");
    expect(validateImportFile("大.pdf", "application/pdf", RESEARCH_IMPORT_MAX_BYTES + 1)).toContain("20 MB");
  });
});

describe("importUploadErrorCopy", () => {
  it("按稳定错误码映射用户可见文案", () => {
    expect(importUploadErrorCopy(new ApiRequestError(413, "file_too_large", ""))).toContain("20 MB");
    expect(importUploadErrorCopy(new ApiRequestError(415, "unsupported_file_type", ""))).toContain(
      "TXT、Markdown、DOCX、PDF",
    );
    expect(importUploadErrorCopy(new ApiRequestError(422, "invalid_file_content", ""))).toContain("格式不符");
    expect(importUploadErrorCopy(new ApiRequestError(400, "empty_file", ""))).toContain("为空");
    expect(importUploadErrorCopy(new ApiRequestError(404, "not_found", ""))).toContain("不存在");
    expect(importUploadErrorCopy(new ApiRequestError(500, "internal_error", ""))).toContain("暂时出现错误");
  });

  it("网络错误提示结果不确定且重试安全", () => {
    const copy = importUploadErrorCopy(new NetworkError());
    expect(copy).toContain("不确定");
    expect(copy).toContain("不会");
  });
});
