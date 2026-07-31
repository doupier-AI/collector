import {
  RUN_RECORD_EXPORT_FORMAT_VERSION,
  type RunRecordDetail,
  type RunRecordExportLine,
} from "@collector/capture-contracts";
import { RunRecordsService, type RunRecordListInput } from "./observability.js";

export const RUN_RECORD_EXPORT_PAGE_SIZE = 50;

export interface RunRecordExportWriter {
  write(chunk: string): Promise<void>;
}

/**
 * Stream the current filtered run records as NDJSON. The final summary line is
 * deliberately written only after every page has been read, so an interrupted
 * download is distinguishable from a complete export.
 */
export async function streamRunRecordExport(
  service: RunRecordsService,
  input: RunRecordListInput = {},
  writer: RunRecordExportWriter,
  generatedAt = new Date().toISOString(),
): Promise<void> {
  const filters = service.normalizeExportFilters(input);
  await writer.write(line({
    type: "header",
    formatVersion: RUN_RECORD_EXPORT_FORMAT_VERSION,
    generatedAt,
    filters,
  }));

  let cursor: string | undefined;
  let recordCount = 0;
  while (true) {
    const page = service.exportPage({ ...filters, limit: RUN_RECORD_EXPORT_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
    for (const record of page.items) {
      await writer.write(line({ type: "record", record: redactExportValue(record) as RunRecordDetail }));
      recordCount += 1;
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  await writer.write(line({
    type: "summary",
    formatVersion: RUN_RECORD_EXPORT_FORMAT_VERSION,
    recordCount,
    complete: true,
  }));
}

function line(value: RunRecordExportLine): string {
  return `${JSON.stringify(value)}\n`;
}

const SENSITIVE_KEY = /(?:api[-_]?key|x[-_]?api[-_]?key|authorization|proxy[-_]?authorization|auth(?:entication)?[-_]?header|cookie|set[-_]?cookie|access[-_]?token|refresh[-_]?token|session[-_](?:token|secret|cookie|key)|control[-_]?token|launcher[-_]?token|pairing[-_]?code|idempotency[-_]?key|password|secret|credential|signature|csrf|xsrf|nonce)/i;
const SENSITIVE_QUERY_PARAMETER = /^(?:api[-_]?key|x[-_]?api[-_]?key|key|token|access[-_]?token|refresh[-_]?token|session|session[-_]?id|sid|auth|authorization|cookie|secret|signature|sig|credential|password|code|state|nonce|ticket|control[-_]?token|launcher[-_]?token|pairing[-_]?code|idempotency[-_]?key)$/i;
const SECRET_VALUE = /\b(?:sk|AIza|ghp|xox[baprs]-)[-_A-Za-z0-9]{8,}\b/gi;
const SENSITIVE_TEXT = /((?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|x[-_]?api[-_]?key|api[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?token|control[-_]?token|launcher[-_]?token|pairing[-_]?code|idempotency[-_]?key)\s*[:=]\s*)[^\s,;]+/gi;
const BEARER_VALUE = /\b(bearer|basic)\s+[^\s,;]+/gi;
const SENSITIVE_URL_PARAMETER = /([?&](?:api[-_]?key|x[-_]?api[-_]?key|key|token|access[-_]?token|refresh[-_]?token|session|session[-_]?id|sid|auth|authorization|cookie|secret|signature|sig|credential|password|code|state|nonce|ticket|control[-_]?token|launcher[-_]?token|pairing[-_]?code|idempotency[-_]?key)=)[^&#\s]*/gi;

function redactExportValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactExportText(value);
  if (Array.isArray(value)) return value.map((item) => redactExportValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
      entryKey,
      redactExportValue(entryValue, entryKey),
    ]));
  }
  return value;
}

function redactExportText(value: string): string {
  const url = redactUrl(value);
  const text = url ?? value;
  return text
    .replace(SENSITIVE_TEXT, "$1[REDACTED]")
    .replace(BEARER_VALUE, "$1 [REDACTED]")
    .replace(SECRET_VALUE, "[REDACTED]")
    .replace(SENSITIVE_URL_PARAMETER, "$1[REDACTED]");
}

function redactUrl(value: string): string | undefined {
  if (!/^https?:\/\//i.test(value.trim())) return undefined;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_PARAMETER.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return undefined;
  }
}
