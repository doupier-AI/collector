import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
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
  render(<MemoryRouter><ServicesProvider services={services}><TemporaryFusionObservationPanel onCloseObservation={vi.fn()} onChanged={onChanged} /></ServicesProvider></MemoryRouter>);
  return onChanged;
}

describe("TemporaryFusionObservationPanel", () => {
  it("supports keyboard selection and sends only the explicitly selected ids", async () => {
    const first = item("temporary-one");
    const second = item("temporary-two");
    const deleteTemporaryFusions = vi.fn(async () => ({ deletedIds: [first.node.id], missingIds: [] }));
    const listTemporaryFusions = vi.fn()
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([second]);
    const onChanged = renderPanel({ listTemporaryFusions, deleteTemporaryFusions });
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
    const listTemporaryFusions = vi.fn()
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([]);
    renderPanel({ listTemporaryFusions, clearTemporaryFusions });
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

  it("keeps management in the map tool and opens editing on a dedicated page", async () => {
    const candidate = item("temporary-route");
    renderPanel({ listTemporaryFusions: vi.fn(async () => [candidate]) });

    const link = await screen.findByRole("link", { name: /temporary-route.*证据已核验/ });
    expect(link).toHaveAttribute("href", "/temporary-fusions/temporary-route");
    expect(screen.queryByRole("button", { name: "修改草案" })).not.toBeInTheDocument();
    expect(screen.getByText(/独立页面继续讨论与编辑/)).toBeInTheDocument();
  });
});
