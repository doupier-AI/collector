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
});
