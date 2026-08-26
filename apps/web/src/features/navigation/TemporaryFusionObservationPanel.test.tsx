import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ResearchTemporaryFusionListItem } from "@collector/capture-contracts";
import type { ApiClient } from "../../api/client";
import { ServicesProvider, type AppServices } from "../../app/services";
import { makeTemporaryFusionBundle } from "../../test/fakes";
import { TemporaryFusionObservationPanel } from "./TemporaryFusionObservationPanel";

function item(id: string): ResearchTemporaryFusionListItem {
  const bundle = makeTemporaryFusionBundle({ node: {
    id,
    creationKey: `${id}:creation`,
    triggerProposalId: `${id}:proposal`,
    activeDraftVersionId: `${id}:draft`,
    status: "active",
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  } });
  return { node: bundle.node, label: id, evidenceStatus: "verified", candidateSources: bundle.candidateSources };
}

function renderPanel(api: Partial<ApiClient>, onChanged = vi.fn()) {
  const services = { api, connectTaskEvents: vi.fn() } as unknown as AppServices;
  render(<ServicesProvider services={services}><TemporaryFusionObservationPanel onCloseObservation={vi.fn()} onOpenSource={vi.fn()} onChanged={onChanged} /></ServicesProvider>);
  return onChanged;
}

describe("TemporaryFusionObservationPanel T03 management", () => {
  it("supports keyboard selection and sends only the explicitly selected ids", async () => {
    const first = item("temporary-one");
    const second = item("temporary-two");
    const deleteTemporaryFusions = vi.fn(async () => ({ deletedIds: [first.node.id], missingIds: [] }));
    const onChanged = renderPanel({
      listTemporaryFusions: vi.fn(async () => [first, second]),
      deleteTemporaryFusions,
      getTemporaryFusion: vi.fn(), searchTemporaryFusions: vi.fn(), deleteTemporaryFusion: vi.fn(), clearTemporaryFusions: vi.fn(),
    });
    const user = userEvent.setup();
    const checkbox = await screen.findByRole("checkbox", { name: `选择 ${first.label}` });
    checkbox.focus();
    await user.keyboard(" ");
    expect(checkbox).toBeChecked();
    await user.click(screen.getByRole("button", { name: "删除所选" }));
    expect(deleteTemporaryFusions).toHaveBeenCalledWith([first.node.id]);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("cancels clear with zero writes, then confirms the explicitly named all-temporary operation", async () => {
    const first = item("temporary-one");
    const clearTemporaryFusions = vi.fn(async () => ({ deletedCount: 1 }));
    renderPanel({
      listTemporaryFusions: vi.fn(async () => [first]),
      clearTemporaryFusions,
      getTemporaryFusion: vi.fn(), searchTemporaryFusions: vi.fn(), deleteTemporaryFusion: vi.fn(), deleteTemporaryFusions: vi.fn(),
    });
    const user = userEvent.setup();
    await screen.findByText("temporary-one");
    await user.click(screen.getByRole("button", { name: "清空全部临时融合" }));
    expect(screen.getByRole("alertdialog", { name: "清空全部临时融合？" })).toBeInTheDocument();
    await user.keyboard("Escape");
    expect(clearTemporaryFusions).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "清空全部临时融合" }));
    await user.click(screen.getByRole("button", { name: "确认清空全部临时融合" }));
    expect(clearTemporaryFusions).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary discussion beside the read-only draft and sends it to the temporary endpoint", async () => {
    const candidate = makeTemporaryFusionBundle();
    const listed: ResearchTemporaryFusionListItem = { node: candidate.node, label: "候选讨论", evidenceStatus: "verified", candidateSources: candidate.candidateSources };
    const submitTemporaryFusionMessage = vi.fn(async () => ({
      inputMessage: { id: "input", temporaryFusionNodeId: candidate.node.id, role: "user" as const, content: "证据是否充分？", status: "completed" as const, createdAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-26T00:00:00.000Z" },
      outputMessage: { id: "output", temporaryFusionNodeId: candidate.node.id, role: "assistant" as const, content: "", status: "pending" as const, createdAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-26T00:00:00.000Z" },
      task: { id: "task", temporaryFusionNodeId: candidate.node.id, inputMessageId: "input", outputMessageId: "output", idempotencyKey: "key", status: "queued" as const, retryable: false, promptVersion: "temporary-fusion-conversation-v1", createdAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-26T00:00:00.000Z" },
    }));
    renderPanel({
      listTemporaryFusions: vi.fn(async () => [listed]), getTemporaryFusion: vi.fn(async () => candidate),
      getTemporaryFusionConversation: vi.fn(async () => ({ bundle: candidate, messages: [], tasks: [] })), submitTemporaryFusionMessage,
      searchTemporaryFusions: vi.fn(), deleteTemporaryFusion: vi.fn(), deleteTemporaryFusions: vi.fn(), clearTemporaryFusions: vi.fn(),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /候选讨论/ }));
    await screen.findByRole("heading", { name: "临时讨论" });
    expect(screen.getByText(/不会修改当前草案/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("围绕当前候选继续讨论"), "证据是否充分？");
    await user.click(screen.getByRole("button", { name: "发送讨论" }));
    await waitFor(() => expect(submitTemporaryFusionMessage).toHaveBeenCalledWith(candidate.node.id, "证据是否充分？", expect.any(String)));
  });
});
