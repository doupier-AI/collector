import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client";

describe("F1 fusion proposal API client", () => {
  it("calls scan and list endpoints with their stable paths and bodies", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ proposals: [], temporaryFusionCount: 0 }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchMock);

    await client.scanResearchFusionProposals("node / one");
    await client.listResearchFusionProposals("node / one", "pending");

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

describe("research map settings API client", () => {
  it("uses the stable read and update paths", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ defaultFocusFromNode: false }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchMock);

    await client.getResearchMapSettings();
    await client.updateResearchMapSettings({ defaultFocusFromNode: true });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/v1/settings/research-map", undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/v1/settings/research-map",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ defaultFocusFromNode: true }) }),
    );
  });
});

describe("T03 temporary fusion management API client", () => {
  it("uses separate single, explicit batch, and clear endpoints", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchMock);

    await client.deleteTemporaryFusion("temporary / one");
    await client.deleteTemporaryFusions(["temporary-1", "temporary-2"]);
    await client.clearTemporaryFusions();

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/v1/research-temporary-fusions/temporary%20%2F%20one", expect.objectContaining({ method: "DELETE" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/v1/research-temporary-fusions/batch-delete", expect.objectContaining({ method: "POST", body: JSON.stringify({ ids: ["temporary-1", "temporary-2"] }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/v1/research-temporary-fusions/clear", expect.objectContaining({ method: "POST", body: "{}" }));
  });
});

describe("T05 temporary fusion draft API client", () => {
  it("uses explicit version endpoints and carries the current-version precondition", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ versions: [], revalidationTasks: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchMock);
    await client.getTemporaryFusionDraftHistory("temporary / one");
    await client.updateTemporaryFusionDraft("temporary / one", { body: "修改草案", expectedDraftVersionId: "draft-v1" });
    await client.restoreTemporaryFusionDraft("temporary / one", "draft-v1", "draft-v2");
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/v1/research-temporary-fusions/temporary%20%2F%20one/drafts", undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/v1/research-temporary-fusions/temporary%20%2F%20one/drafts", expect.objectContaining({ method: "PUT", body: JSON.stringify({ body: "修改草案", expectedDraftVersionId: "draft-v1" }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/v1/research-temporary-fusions/temporary%20%2F%20one/drafts/draft-v1/restore", expect.objectContaining({ method: "POST", body: JSON.stringify({ expectedDraftVersionId: "draft-v2" }) }));
  });
});

describe("T07 temporary fusion confirmation API client", () => {
  it("confirms the visible current version through the stable temporary identity", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchMock);
    await client.confirmTemporaryFusion("temporary / one", "draft-v2");
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/research-temporary-fusions/temporary%20%2F%20one/confirm",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ expectedDraftVersionId: "draft-v2" }) }),
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

  it("retries answer chapters through the body-version-scoped endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "chapter-1" }), { status: 202, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchMock);
    await client.retryAnswerChapterParse("body:m-out:v2");
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/research-body-versions/body%3Am-out%3Av2/chapters/retry",
      expect.objectContaining({ method: "POST", body: "{}" }),
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
      client.submitResearchNodeMessage("node-1", "回收站里不应可写", "idem-key-1", {
        allowWebSearch: false,
        thinkingEnabled: false,
      }),
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
