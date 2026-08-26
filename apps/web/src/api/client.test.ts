import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client";

describe("F1 fusion proposal API client", () => {
  it("calls scan, list, and decision endpoints with their stable paths and bodies", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ proposals: [], temporaryFusionCount: 0 }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchMock);

    await client.scanResearchFusionProposals("node / one");
    await client.listResearchFusionProposals("node / one", "pending");
    await client.decideResearchFusionProposal("fusion:abc", "rejected");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/v1/research-nodes/node%20%2F%20one/fusion-proposals/scan",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/v1/research-nodes/node%20%2F%20one/fusion-proposals?status=pending",
      undefined,
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/v1/research-fusion-proposals/fusion%3Aabc/decide",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ decision: "rejected" }) }),
    );
  });
});

describe("#32 fusion auto config API client", () => {
  it("reads the existing temporary count and writes the auto fusion switch with stable paths and bodies", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ enabled: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchMock);

    await client.getTemporaryFusionCount();
    await client.getFusionAutoConfig();
    await client.updateFusionAutoConfig(true);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/v1/research-temporary-fusions/count", undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/v1/settings/fusion", undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/v1/settings/fusion",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ enabled: true }) }),
    );
  });
});

describe("#42 research body version API client", () => {
  it("calls the body version view endpoint with a stable encoded path", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ version: {}, fragments: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchMock);

    await client.getResearchBodyVersion("body:m-out:b8d974e5");

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/research-body-versions/body%3Am-out%3Ab8d974e5",
      undefined,
    );
  });
});

describe("#61 stable node address API client", () => {
  it("reads the node view through the session-free encoded path", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ node: {}, session: {}, messages: [], tasks: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchMock);

    await client.getResearchNodeView("node / one");

    // 只凭节点身份读取：URL 不含会话 ID，特殊字符正确编码
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/research-nodes/node%20%2F%20one",
      undefined,
    );
  });

  it("maps a missing node to a not_found error the page can render as 可理解结果", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "not_found", message: "Research node not found" } }), { status: 404, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchMock);

    await expect(client.getResearchNodeView("missing-node")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  it("maps a trashed-session write rejection to session_in_trash", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "session_in_trash", message: "Research session is in trash" } }), { status: 409, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchMock);

    await expect(
      client.submitResearchNodeMessage("node-1", "回收站里不应可写", "idem-key-1"),
    ).rejects.toMatchObject({ status: 409, code: "session_in_trash" });
  });
});

describe("#62 global research map API client", () => {
  it("reads one unified observation and preserves repeated scope and relationship query values", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ nodes: [], edges: [], appliedRelationshipKinds: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchMock);

    await client.getResearchMap({
      focusNodeId: "node / one",
      projectIds: ["project-a", "project-b"],
      includeUncategorized: true,
      lifecycles: ["archived", "active"],
      createdFrom: "2026-08-10T00:00:00.000Z",
      createdBefore: "2026-08-11T00:00:00.000Z",
      relationshipKinds: ["parent-child", "fused-from"],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/research-map?focusNodeId=node+%2F+one&projectId=project-a&projectId=project-b&includeUncategorized=true&lifecycle=active&lifecycle=archived&createdFrom=2026-08-10T00%3A00%3A00.000Z&createdBefore=2026-08-11T00%3A00%3A00.000Z&relationshipKind=parent-child&relationshipKind=fused-from",
      undefined,
    );
  });

  it("preserves an explicit empty relationship selection", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ nodes: [], edges: [], appliedRelationshipKinds: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchMock);

    await client.getResearchMap({ focusNodeId: "node-a", relationshipKinds: [] });

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/research-map?focusNodeId=node-a&relationshipKind=",
      undefined,
    );
  });

  it("only requests association evidence when candidate observation opens", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ nodes: [], edges: [], appliedRelationshipKinds: [], activeCandidateCount: 0, associationHints: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchMock);

    await client.getResearchMap({ includeAssociationHints: true, associationCandidateNodeId: "node / one" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/research-map?includeAssociationHints=true&associationCandidateNodeId=node+%2F+one",
      undefined,
    );
  });
});

describe("#67 semantic research search API client", () => {
  it("keeps search, status and explicit model commands on the unified client", async () => {
    const statusView = { configuredProfile: "standard", runtimeState: "model-missing", installations: [] };
    const keywordOnlyResponse = {
      query: "量子纠缠",
      mode: "keyword-only",
      degradationReason: "model-not-installed",
      groups: [
        { scope: "inside-current-scope", nodes: [{ nodeId: "node-a", nodeLabel: "节点 A", matches: [] }] },
      ],
    };
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return new Response(JSON.stringify(call === 2 ? keywordOnlyResponse : statusView), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = createApiClient(fetchMock);

    await client.getSemanticSearchStatus();
    const search = await client.searchResearch({ query: "量子纠缠", limit: 12, insideNodeIds: ["node-a"] });
    await client.executeSemanticSearchCommand({ type: "download-profile", profile: "lightweight" });

    expect(search).toEqual(keywordOnlyResponse);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/v1/semantic-search/status", undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/v1/semantic-search/search",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ query: "量子纠缠", limit: 12, insideNodeIds: ["node-a"] }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/v1/semantic-search/commands",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ type: "download-profile", profile: "lightweight" }) }),
    );
  });
});
