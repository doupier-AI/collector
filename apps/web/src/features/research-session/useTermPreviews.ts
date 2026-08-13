import { useCallback, useEffect, useRef, useState } from "react";
import type {
  NodeGrowthAccepted,
  ResearchTermPreviewRecord,
  TermMarker,
} from "@collector/capture-contracts";
import { useServices } from "../../app/services";
import type { TermPreviewEventStream } from "../../api/term-preview-events";

export interface TermPreviewController {
  previews: Record<string, ResearchTermPreviewRecord>;
  start(messageId: string, marker: TermMarker): void;
  retry(preview: ResearchTermPreviewRecord): void;
  grow(preview: ResearchTermPreviewRecord): Promise<NodeGrowthAccepted>;
  /** 首次激活提及时记录生长意图：必要时等待预览完成，然后直接生长。 */
  growMarker(messageId: string, marker: TermMarker): Promise<NodeGrowthAccepted>;
}

export function termPreviewClientKey(messageId: string, marker: TermMarker): string {
  return marker.entityId
    ? [messageId, marker.entityId].join(":")
    : [messageId, marker.blockOrdinal, marker.startOffset, marker.endOffset, marker.text].join(":");
}

export function useTermPreviews(nodeId: string, onError?: (error: unknown) => void): TermPreviewController {
  const { api, connectTermPreviewEvents } = useServices();
  const [previews, setPreviews] = useState<Record<string, ResearchTermPreviewRecord>>({});
  const previewsRef = useRef(previews);
  const streamsRef = useRef(new Map<string, TermPreviewEventStream>());
  const requestsRef = useRef(new Map<string, Promise<ResearchTermPreviewRecord>>());
  /** 同节点跨消息复用时，一个服务端预览需要映射到当前提及的客户端键。 */
  const aliasKeysRef = useRef(new Map<string, Set<string>>());
  const readyWaitersRef = useRef(new Map<string, Array<{
    resolve: (preview: ResearchTermPreviewRecord) => void;
    reject: (error: Error) => void;
  }>>());
  previewsRef.current = previews;

  const updatePreview = useCallback((preview: ResearchTermPreviewRecord, aliasKey?: string) => {
    const canonicalKey = termPreviewClientKey(preview.messageId, preview.marker);
    const keys = aliasKeysRef.current.get(preview.id) ?? new Set<string>();
    keys.add(canonicalKey);
    if (aliasKey) keys.add(aliasKey);
    aliasKeysRef.current.set(preview.id, keys);
    const updates = Object.fromEntries([...keys].map((key) => [key, preview]));
    previewsRef.current = { ...previewsRef.current, ...updates };
    setPreviews((previous) => ({ ...previous, ...updates }));
    if (preview.status === "completed" || preview.status === "failed") {
      const waiters = readyWaitersRef.current.get(preview.id) ?? [];
      readyWaitersRef.current.delete(preview.id);
      for (const waiter of waiters) {
        if (preview.status === "completed") waiter.resolve(preview);
        else waiter.reject(new Error(preview.error?.message ?? "解释生成失败"));
      }
    }
  }, []);

  const closeStream = useCallback((previewId: string) => {
    streamsRef.current.get(previewId)?.close();
    streamsRef.current.delete(previewId);
  }, []);

  const connect = useCallback((preview: ResearchTermPreviewRecord) => {
    if (preview.status !== "queued" && preview.status !== "running") return;
    if (streamsRef.current.has(preview.id)) return;
    const stream = connectTermPreviewEvents({
      taskId: preview.id,
      getTask: (id) => api.getResearchTermPreviewTask(id),
      onEvent: (event) => updatePreview(event.preview),
      onTask: (updated) => {
        updatePreview(updated);
        if (updated.status === "completed" || updated.status === "failed") closeStream(updated.id);
      },
      onReconnecting: () => undefined,
      onFallbackToPolling: () => undefined,
      onError,
    });
    streamsRef.current.set(preview.id, stream);
  }, [api, closeStream, connectTermPreviewEvents, onError, updatePreview]);

  useEffect(() => {
    previewsRef.current = {};
    setPreviews({});
    requestsRef.current.clear();
    aliasKeysRef.current.clear();
    for (const waiters of readyWaitersRef.current.values()) {
      for (const waiter of waiters) waiter.reject(new Error("研究节点已切换"));
    }
    readyWaitersRef.current.clear();
    for (const stream of streamsRef.current.values()) stream.close();
    streamsRef.current.clear();
    return () => {
      for (const stream of streamsRef.current.values()) stream.close();
      streamsRef.current.clear();
    };
  }, [nodeId]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      for (const stream of streamsRef.current.values()) stream.syncNow();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  const ensurePreview = useCallback((messageId: string, marker: TermMarker): Promise<ResearchTermPreviewRecord> => {
    const key = termPreviewClientKey(messageId, marker);
    const existing = previewsRef.current[key];
    if (existing) {
      connect(existing);
      return Promise.resolve(existing);
    }
    const pending = requestsRef.current.get(key);
    if (pending) return pending;
    const identity = marker.entityId ?? `${marker.blockOrdinal}:${marker.startOffset}:${marker.endOffset}`;
    const idempotencyKey = `term-preview:${nodeId}:${messageId}:${identity}`;
    const request = api.startResearchTermPreview(nodeId, { messageId, marker }, idempotencyKey).then((accepted) => {
      updatePreview(accepted.preview, key);
      connect(accepted.preview);
      return accepted.preview;
    }).finally(() => requestsRef.current.delete(key));
    requestsRef.current.set(key, request);
    return request;
  }, [api, connect, nodeId, updatePreview]);

  const start = useCallback((messageId: string, marker: TermMarker) => {
    void ensurePreview(messageId, marker).catch((error) => onError?.(error));
  }, [ensurePreview, onError]);

  const waitUntilReady = useCallback((preview: ResearchTermPreviewRecord): Promise<ResearchTermPreviewRecord> => {
    const current = Object.values(previewsRef.current).find((candidate) => candidate.id === preview.id) ?? preview;
    if (current.status === "completed") return Promise.resolve(current);
    if (current.status === "failed") return Promise.reject(new Error(current.error?.message ?? "解释生成失败"));
    return new Promise<ResearchTermPreviewRecord>((resolve, reject) => {
      const waiters = readyWaitersRef.current.get(current.id) ?? [];
      waiters.push({ resolve, reject });
      readyWaitersRef.current.set(current.id, waiters);
    });
  }, []);

  const retry = useCallback((preview: ResearchTermPreviewRecord) => {
    closeStream(preview.id);
    void api.retryResearchTermPreviewTask(preview.id).then((updated) => {
      updatePreview(updated);
      connect(updated);
    }).catch((error) => onError?.(error));
  }, [api, closeStream, connect, onError, updatePreview]);

  const grow = useCallback((preview: ResearchTermPreviewRecord) => {
    return api.growResearchTermPreview(preview.id, `term-growth:${preview.id}`);
  }, [api]);

  const growMarker = useCallback(async (messageId: string, marker: TermMarker) => {
    const preview = await ensurePreview(messageId, marker);
    const ready = await waitUntilReady(preview);
    return grow(ready);
  }, [ensurePreview, grow, waitUntilReady]);

  return { previews, start, retry, grow, growMarker };
}
