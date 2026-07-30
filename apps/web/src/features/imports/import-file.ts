import type { ResearchImportMimeType } from "@collector/capture-contracts";
import { RESEARCH_IMPORT_MAX_BYTES, RESEARCH_IMPORT_MIME_TYPES } from "@collector/capture-contracts";
import { ApiRequestError, NetworkError } from "../../api/errors";

/** 文件选择器与拖放的 accept 提示；服务端校验仍是最终事实。 */
export const IMPORT_ACCEPT = ".txt,.md,.markdown,.docx,.pdf";

export const IMPORT_MAX_BYTES_LABEL = "20 MB";

const EXTENSION_MIME: Record<string, ResearchImportMimeType> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pdf": "application/pdf",
};

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot).toLowerCase();
}

/**
 * 解析上传要声明的 MIME：优先按扩展名（.md 在部分浏览器没有 MIME），
 * 其次采用浏览器提供的白名单 MIME；都不满足返回 null 表示前端不支持。
 */
export function resolveImportMimeType(fileName: string, browserMime: string): ResearchImportMimeType | null {
  const byExtension = EXTENSION_MIME[extensionOf(fileName)];
  if (byExtension) return byExtension;
  const normalized = browserMime.split(";", 1)[0].trim().toLowerCase();
  return (RESEARCH_IMPORT_MIME_TYPES as readonly string[]).includes(normalized)
    ? (normalized as ResearchImportMimeType)
    : null;
}

/** 上传前的前端预检；返回 null 表示可以发送，否则为用户可见文案。 */
export function validateImportFile(fileName: string, browserMime: string, size: number): string | null {
  if (resolveImportMimeType(fileName, browserMime) === null) {
    return "仅支持 TXT、Markdown、DOCX、PDF 文件。";
  }
  if (size <= 0) {
    return "文件为空，请选择有内容的文件。";
  }
  if (size > RESEARCH_IMPORT_MAX_BYTES) {
    return `文件超过 ${IMPORT_MAX_BYTES_LABEL} 上限，请选择更小的文件。`;
  }
  return null;
}

/** 上传失败时的用户可见文案；以稳定错误码为准，不依赖英文 message。 */
export function importUploadErrorCopy(error: unknown): string {
  if (error instanceof NetworkError) {
    return "上传结果不确定：连接中断。请稍后重试，重试不会产生重复附件。";
  }
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case "file_too_large":
        return `文件超过 ${IMPORT_MAX_BYTES_LABEL} 上限，请选择更小的文件。`;
      case "unsupported_file_type":
        return "仅支持 TXT、Markdown、DOCX、PDF 文件。";
      case "invalid_file_content":
        return "文件内容与声明的格式不符，请确认文件没有损坏。";
      case "empty_file":
        return "文件为空，请选择有内容的文件。";
      case "invalid_file_name":
        return "文件名不符合要求，请重命名后重试。";
      case "not_found":
        return "这场研究不存在或已经清理，无法导入文件。";
      case "internal_error":
        return "Collector 服务暂时出现错误，请稍后重试。";
      default:
        return "上传没有完成，请重试。";
    }
  }
  return "上传没有完成，请重试。";
}
