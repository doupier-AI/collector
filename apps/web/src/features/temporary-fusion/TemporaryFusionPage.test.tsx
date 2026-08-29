import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type {
  ResearchTemporaryFusionBundle,
  ResearchTemporaryFusionConversationView,
  ResearchTemporaryFusionListItem,
} from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import { ServicesProvider, type AppServices } from "../../app/services";
import { makeTemporaryFusionBundle } from "../../test/fakes";
import { TemporaryFusionPage } from "./TemporaryFusionPage";

function listed(bundle: ResearchTemporaryFusionBundle, label = "跨来源的新认识"): ResearchTemporaryFusionListItem {
  return { node: bundle.node, label, evidenceStatus: bundle.activeDraft.evidenceStatus, candidateSources: bundle.candidateSources };
}

function baseApi(bundle: ResearchTemporaryFusionBundle, overrides: Partial<ApiClient> = {}): Partial<ApiClient> {
  const conversation: ResearchTemporaryFusionConversationView = { bundle, messages: [], tasks: [] };
  return {
    getTemporaryFusion: vi.fn(async () => bundle),
    getTemporaryFusionConversation: vi.fn(async () => conversation),
    getTemporaryFusionDraftHistory: vi.fn(async () => ({ versions: [bundle.activeDraft], revalidationTasks: [] })),
    listTemporaryFusions: vi.fn(async () => [listed(bundle)]),
    ...overrides,
  };
}

function renderPage(api: Partial<ApiClient>, id: string) {
  const services = { api, connectTaskEvents: vi.fn() } as unknown as AppServices;
  render(
    <MemoryRouter initialEntries={[`/temporary-fusions/${id}`]}>
      <ServicesProvider services={services}>
        <Routes>
          <Route path="temporary-fusions/:temporaryFusionId" element={<TemporaryFusionPage />} />
          <Route path="nodes/:nodeId" element={<h1>正式融合正文</h1>} />
        </Routes>
      </ServicesProvider>
    </MemoryRouter>,
  );
}

describe("TemporaryFusionPage", () => {
  it("offers a retry when the candidate cannot be loaded", async () => {
    const bundle = makeTemporaryFusionBundle();
    const getTemporaryFusion = vi.fn()
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValueOnce(bundle);
    renderPage(baseApi(bundle, { getTemporaryFusion }), bundle.node.id);
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "无法打开这个临时融合" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("heading", { name: "跨来源的新认识" })).toBeInTheDocument();
    expect(getTemporaryFusion).toHaveBeenCalledTimes(2);
  });

  it("presents the draft and temporary discussion as a dedicated conversation page", async () => {
    const base = makeTemporaryFusionBundle();
    const bundle = { ...base, activeDraft: { ...base.activeDraft, body: "跨来源判断。[来源1][来源2]" } };
    const messages: ResearchTemporaryFusionConversationView["messages"] = [];
    const submitTemporaryFusionMessage = vi.fn(async (_id: string, content: string) => {
      messages.push({ id: "input", temporaryFusionNodeId: bundle.node.id, role: "user", content, status: "completed", createdAt: bundle.node.createdAt, updatedAt: bundle.node.updatedAt });
      return {
        inputMessage: messages[0]!,
        outputMessage: { id: "output", temporaryFusionNodeId: bundle.node.id, role: "assistant" as const, content: "", status: "pending" as const, createdAt: bundle.node.createdAt, updatedAt: bundle.node.updatedAt },
        task: { id: "task", temporaryFusionNodeId: bundle.node.id, inputMessageId: "input", outputMessageId: "output", idempotencyKey: "key", status: "queued" as const, retryable: false, promptVersion: "temporary-fusion-conversation-v1", createdAt: bundle.node.createdAt, updatedAt: bundle.node.updatedAt },
      };
    });
    const getTemporaryFusionConversation = vi.fn(async () => ({ bundle, messages: [...messages], tasks: [] }));
    const api = baseApi(bundle, { getTemporaryFusionConversation, submitTemporaryFusionMessage });
    renderPage(api, bundle.node.id);

    expect(await screen.findByRole("heading", { name: "跨来源的新认识" })).toBeInTheDocument();
    expect(screen.getByText("跨来源判断。[来源1][来源2]")).toBeInTheDocument();
    expect(screen.getByText(/讨论不会改写这份草案/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("围绕当前候选继续讨论"), "证据边界是什么？");
    await user.click(screen.getByRole("button", { name: "发送讨论" }));
    await waitFor(() => expect(submitTemporaryFusionMessage).toHaveBeenCalledWith(bundle.node.id, "证据边界是什么？", expect.any(String)));
    expect(await screen.findByText("证据边界是什么？")).toBeInTheDocument();
  });

  it("creates a new draft version only after the explicit edit action", async () => {
    const bundle = makeTemporaryFusionBundle();
    const nextBundle = {
      ...bundle,
      node: { ...bundle.node, activeDraftVersionId: "draft-v2" },
      activeDraft: { ...bundle.activeDraft, id: "draft-v2", version: 2, body: "修改后的判断", evidenceStatus: "pending" as const },
    };
    const updateTemporaryFusionDraft = vi.fn(async () => ({ bundle: nextBundle, previousDraftVersionId: bundle.activeDraft.id, revalidationTasks: [] }));
    renderPage(baseApi(bundle, { updateTemporaryFusionDraft }), bundle.node.id);
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "待确认的新认识" });
    expect(updateTemporaryFusionDraft).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "修改草案" }));
    await user.clear(screen.getByLabelText(/修改草案/));
    await user.type(screen.getByLabelText(/修改草案/), "修改后的判断");
    await user.click(screen.getByRole("button", { name: "保存为新版本并核验" }));
    await waitFor(() => expect(updateTemporaryFusionDraft).toHaveBeenCalledWith(bundle.node.id, { body: "修改后的判断", expectedDraftVersionId: bundle.activeDraft.id }));
    expect(await screen.findByText("等待核验", { selector: ".temporary-fusion-draft .temporary-fusion-status" })).toBeInTheDocument();
  });

  it("confirms only the current verified draft and opens the unchanged stable node address", async () => {
    const bundle = makeTemporaryFusionBundle();
    const confirmTemporaryFusion = vi.fn(async () => ({
      fusionNode: { id: bundle.node.id, sessionId: bundle.node.id, isFusionNode: true, status: "active" as const, createdAt: bundle.node.createdAt, updatedAt: bundle.node.updatedAt },
      session: { id: bundle.node.id, title: "正式融合", status: "active" as const, isFavorite: false, createdAt: bundle.node.createdAt, updatedAt: bundle.node.updatedAt },
      snapshot: { fusionNodeId: bundle.node.id, confirmedDraftVersionId: bundle.activeDraft.id, body: bundle.activeDraft.body, contentHash: bundle.activeDraft.contentHash, directSources: [], confirmedAt: bundle.node.updatedAt },
    }));
    renderPage(baseApi(bundle, { confirmTemporaryFusion }), bundle.node.id);
    const user = userEvent.setup();

    expect(await screen.findByText(/确认对象是当前草案/)).toHaveTextContent(`v${bundle.activeDraft.version}`);
    await user.click(screen.getByRole("button", { name: "确认当前核验版本" }));
    await waitFor(() => expect(confirmTemporaryFusion).toHaveBeenCalledWith(bundle.node.id, bundle.activeDraft.id));
    expect(await screen.findByRole("heading", { name: "正式融合正文" })).toBeInTheDocument();
  });

  it("shows unavailable sources honestly and blocks confirmation", async () => {
    const available = makeTemporaryFusionBundle();
    const bundle = {
      ...available,
      candidateSources: available.candidateSources.map((source, index) => index === 0 ? { ...source, sourceHealth: "temporarily-unavailable" as const } : source),
    };
    renderPage(baseApi(bundle), bundle.node.id);

    expect(await screen.findByText(/来源暂不可用，恢复后可打开/)).toBeInTheDocument();
    expect(screen.getByText("直接来源当前不可用，恢复后才能确认。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认当前核验版本" })).not.toBeInTheDocument();
  });
});
