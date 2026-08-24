import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  deriveBodyVersion,
  deriveFragmentsFromSlices,
  deriveMessageSlices,
  type ResearchAssociationHintRecord,
  type ResearchBodyVersionView,
} from "@collector/capture-contracts";
import { describe, expect, it, vi } from "vitest";
import { ServicesProvider, type AppServices } from "../../app/services";
import { AssociationCandidatePanel } from "./AssociationCandidatePanel";

const hint = {
  id: "hint-a-b",
  anchorNodeId: "node-a",
  relatedNodeId: "node-b",
  reason: "两段研究从不同角度解释了同一个限制。",
  relationType: "contrast",
  anchorRanges: [{ nodeId: "node-a", bodyVersionId: "body-a", fragmentId: "fragment-a" }],
  relatedRanges: [{ nodeId: "node-b", bodyVersionId: "body-b", fragmentId: "fragment-b" }],
  evidenceContentKey: "content-a-b",
  evidenceKey: "evidence-a-b",
  valueAssessment: {
    promptVersion: "association-hint-evaluation-v1",
    benefits: ["comparison"],
    priority: 97,
    assessedAt: "2026-08-24T00:00:00.000Z",
    contextKey: "context-a-b",
  },
  status: "active",
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
} as unknown as ResearchAssociationHintRecord;

function bodyView(id: "a" | "b"): ResearchBodyVersionView {
  const content = id === "a" ? "当前研究讨论模型限制。" : "旧研究记录了相反条件。";
  const version = deriveBodyVersion({
    messageId: `message-${id}`,
    nodeId: `node-${id}`,
    content,
    origin: "backfill",
    createdAt: "2026-08-24T00:00:00.000Z",
  });
  const fragments = deriveFragmentsFromSlices(
    version,
    deriveMessageSlices(`node-${id}`, `message-${id}`, content, 0, [], [], "2026-08-24T00:00:00.000Z"),
    [],
  );
  return {
    version: { ...version, id: `body-${id}` },
    fragments: fragments.map((fragment) => ({ ...fragment, id: `fragment-${id}`, bodyVersionId: `body-${id}`, excerpt: content })),
  };
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof AssociationCandidatePanel>> = {}) {
  const onClose = vi.fn();
  const onOpenRange = vi.fn();
  const onDismiss = vi.fn();
  const services = {
    api: {
      getResearchBodyVersion: async (bodyVersionId: string) => bodyView(bodyVersionId.endsWith("a") ? "a" : "b"),
    },
    connectTaskEvents: vi.fn(),
  } as unknown as AppServices;
  render(
    <ServicesProvider services={services}>
      <AssociationCandidatePanel
        hints={[hint]}
        nodeLabels={new Map([["node-a", "当前节点"], ["node-b", "旧节点"]])}
        scopeLabel="全部关联候选"
        loading={false}
        onClose={onClose}
        onOpenRange={onOpenRange}
        onDismiss={onDismiss}
        {...overrides}
      />
    </ServicesProvider>,
  );
  return { onClose, onOpenRange, onDismiss };
}

describe("AssociationCandidatePanel", () => {
  it("把有效提示明确呈现为临时观察，并只提供打开依据与忽略", async () => {
    const user = userEvent.setup();
    const { onClose, onOpenRange, onDismiss } = renderPanel();

    const panel = screen.getByRole("region", { name: "关联候选" });
    expect(panel).toHaveTextContent("全部关联候选");
    expect(panel).toHaveTextContent("1 条临时提示");
    expect(panel).toHaveTextContent("不会建立永久关系，也不会触发融合");
    expect(panel).toHaveTextContent(hint.reason);
    expect(panel).not.toHaveTextContent("保留关系");
    expect(panel).not.toHaveTextContent("97");
    expect(panel).not.toHaveTextContent("价值评分");
    expect(panel.querySelector('[data-action="fuse"]')).toBeNull();

    await waitFor(() => {
      expect(panel).toHaveTextContent("当前研究讨论模型限制");
      expect(panel).toHaveTextContent("旧研究记录了相反条件");
    });

    await user.click(screen.getByRole("button", { name: "打开当前节点的依据" }));
    expect(onOpenRange).toHaveBeenCalledWith(hint.anchorRanges[0]);
    await user.click(screen.getByRole("button", { name: "打开旧节点的依据" }));
    expect(onOpenRange).toHaveBeenCalledWith(hint.relatedRanges[0]);

    await user.click(screen.getByRole("button", { name: "忽略这条临时提示" }));
    expect(onDismiss).toHaveBeenCalledWith(hint.id);
    await user.click(screen.getByRole("button", { name: "关闭关联候选" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("加载和空集合都有可理解的状态", () => {
    const rendered = renderPanel({ hints: [], loading: true });
    expect(screen.getByRole("status")).toHaveTextContent("正在读取关联候选");
    rendered.onClose.mockClear();
  });

  it("完整呈现两端的全部可定位依据，不截断为首段", async () => {
    const user = userEvent.setup();
    const anchorExtra = { nodeId: "node-a", bodyVersionId: "body-a", fragmentId: "fragment-a-extra" };
    const relatedExtra = { nodeId: "node-b", bodyVersionId: "body-b", fragmentId: "fragment-b-extra" };
    const { onOpenRange } = renderPanel({
      hints: [{ ...hint, anchorRanges: [...hint.anchorRanges, anchorExtra], relatedRanges: [...hint.relatedRanges, relatedExtra] }],
    });

    const anchorButtons = await screen.findAllByRole("button", { name: /打开当前节点的第 \d+ 段的依据/ });
    const relatedButtons = screen.getAllByRole("button", { name: /打开旧节点的第 \d+ 段的依据/ });
    expect(anchorButtons).toHaveLength(2);
    expect(relatedButtons).toHaveLength(2);

    await user.click(anchorButtons[1]!);
    await user.click(relatedButtons[1]!);
    expect(onOpenRange).toHaveBeenNthCalledWith(1, anchorExtra);
    expect(onOpenRange).toHaveBeenNthCalledWith(2, relatedExtra);
  });
});
