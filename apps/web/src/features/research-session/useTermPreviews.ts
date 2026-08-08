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
}

export function termPreviewClientKey(messageId: string, marker: TermMarker): string {
  return [messageId, marker.blockOrdinal, marker.startOffset, marker.endOffset, marker.text].join(":");
}

export function useTermPreviews(nodeId: string, onError?: (error: unknown) => void): TermPreviewController {
  const { api, connectTermPreviewEvents } = useServices();
  const [previews, setPreviews] = useState<Record<string, ResearchTermPreviewRecord>>({});
  const previewsRef = useRef(previews);
  const streamsRef = useRef(new Map<string, TermPreviewEventStream>());
  previewsRef.current = previews;

  const updatePreview = useCallback((preview: ResearchTermPreviewRecord) => {
    const key = termPreviewClientKey(preview.messageId, preview.marker);
    previewsRef.current = { ...previewsRef.current, [key]: preview };
    setPreviews((previous) => ({ ...previous, [key]: preview }));
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

  const start = useCallback((messageId: string, marker: TermMarker) => {
    const key = termPreviewClientKey(messageId, marker);
    const existing = previewsRef.current[key];
    if (existing) {
      connect(existing);
      return;
    }
    const idempotencyKey = `term-preview:${nodeId}:${messageId}:${marker.blockOrdinal}:${marker.startOffset}:${marker.endOffset}`;
    void api.startResearchTermPreview(nodeId, { messageId, marker }, idempotencyKey).then((accepted) => {
      updatePreview(accepted.preview);
      connect(accepted.preview);
    }).catch((error) => onError?.(error));
  }, [api, connect, nodeId, onError, updatePreview]);

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

  return { previews, start, retry, grow };
}
