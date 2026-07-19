import type {
  ResearchSessionRecord,
  ResearchSessionView,
  ResearchTaskRecord,
  ResearchTurnAccepted,
} from "@collector/capture-contracts";
import { ApiRequestError, NetworkError, parseApiErrorBody } from "./errors";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClient {
  listResearchSessions(): Promise<ResearchSessionRecord[]>;
  createResearchSession(idempotencyKey: string, title?: string): Promise<ResearchSessionRecord>;
  getResearchSessionView(sessionId: string): Promise<ResearchSessionView>;
  submitResearchMessage(sessionId: string, content: string, idempotencyKey: string): Promise<ResearchTurnAccepted>;
  getResearchTask(taskId: string): Promise<ResearchTaskRecord>;
  retryResearchTask(taskId: string): Promise<ResearchTaskRecord>;
  exchangePairingCode(code: string): Promise<{ paired: true }>;
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

async function requestJson<T>(fetchImpl: FetchLike, path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(path, init);
  } catch {
    throw new NetworkError();
  }
  if (!response.ok) {
    let code = response.status >= 500 ? "internal_error" : "request_failed";
    let message = "";
    try {
      const parsed = parseApiErrorBody(await response.json());
      if (parsed) {
        code = parsed.code;
        message = parsed.message;
      }
    } catch {
      // 错误体不是 JSON 时保留按状态码推断的 code
    }
    throw new ApiRequestError(response.status, code, message);
  }
  return (await response.json()) as T;
}

/**
 * 只请求当前页面同源 /v1/...；浏览器自动携带 HttpOnly Cookie。
 * 前端永远不读取、不存储 Cookie 或令牌。
 */
export function createApiClient(fetchImpl?: FetchLike): ApiClient {
  const fetchFn: FetchLike =
    fetchImpl ?? ((input, init) => window.fetch(input, { credentials: "same-origin", ...init }));

  return {
    listResearchSessions() {
      return requestJson<ResearchSessionRecord[]>(fetchFn, "/v1/research-sessions");
    },
    createResearchSession(idempotencyKey: string, title?: string) {
      const body = title === undefined ? "{}" : JSON.stringify({ title });
      return requestJson<ResearchSessionRecord>(fetchFn, "/v1/research-sessions", {
        method: "POST",
        headers: { ...JSON_HEADERS, "Idempotency-Key": idempotencyKey },
        body,
      });
    },
    getResearchSessionView(sessionId: string) {
      return requestJson<ResearchSessionView>(fetchFn, `/v1/research-sessions/${encodeURIComponent(sessionId)}`);
    },
    submitResearchMessage(sessionId: string, content: string, idempotencyKey: string) {
      return requestJson<ResearchTurnAccepted>(
        fetchFn,
        `/v1/research-sessions/${encodeURIComponent(sessionId)}/messages`,
        {
          method: "POST",
          headers: { ...JSON_HEADERS, "Idempotency-Key": idempotencyKey },
          body: JSON.stringify({ content }),
        },
      );
    },
    getResearchTask(taskId: string) {
      return requestJson<ResearchTaskRecord>(fetchFn, `/v1/research-tasks/${encodeURIComponent(taskId)}`);
    },
    retryResearchTask(taskId: string) {
      return requestJson<ResearchTaskRecord>(fetchFn, `/v1/research-tasks/${encodeURIComponent(taskId)}/retry`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}",
      });
    },
    exchangePairingCode(code: string) {
      return requestJson<{ paired: true }>(fetchFn, "/v1/pairings/exchange", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ code, session: true }),
      });
    },
  };
}
