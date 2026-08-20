import type { ResearchSearchMatch } from "@collector/capture-contracts";
import { stableNodePath } from "../../app/paths";

export interface ResearchSearchMatchTarget {
  path: string;
  fallback?: string;
}

export function researchSearchMatchTarget(nodeId: string, match: ResearchSearchMatch): ResearchSearchMatchTarget {
  const locator = match.locator;
  switch (locator.kind) {
    case "node-title":
      return { path: stableNodePath(nodeId) };
    case "message-semantic-range":
      return { path: `${stableNodePath(nodeId)}?${new URLSearchParams({
        fragment: locator.fragmentId,
        fragmentStart: String(locator.startOffset),
        fragmentEnd: String(locator.endOffset),
      })}` };
    case "message-text-range": {
      const params = new URLSearchParams({
        searchMessage: locator.messageId,
        searchHash: locator.contentHash,
        searchStart: String(locator.startOffset),
        searchEnd: String(locator.endOffset),
      });
      return { path: `${stableNodePath(nodeId)}?${params}` };
    }
    case "import-block": {
      const params = new URLSearchParams({
        searchBlock: locator.blockId,
        searchStart: String(locator.startOffset),
        searchEnd: String(locator.endOffset),
      });
      return {
        path: `/research/${encodeURIComponent(nodeId)}/reading/${encodeURIComponent(locator.contentSnapshotId)}?${params}`,
      };
    }
    case "fusion-snapshot-range":
      return {
        path: `${stableNodePath(nodeId)}?${new URLSearchParams({
          fusionDraft: locator.confirmedDraftVersionId,
          fusionStart: String(locator.startOffset),
          fusionEnd: String(locator.endOffset),
        })}`,
      };
  }
}
