import type { Page } from "@playwright/test";
import type { ResearchGraphObservation } from "@collector/capture-contracts";

const AT = "2026-08-20T00:00:00.000Z";

const node = (
  id: string,
  label: string,
  options: {
    projectId?: string;
    projectName?: string;
    projectColorRole?: "amber" | "violet" | "blue" | "teal" | "rose";
    lifecycle?: "active" | "archived";
    role?: "research" | "fusion";
  } = {},
): ResearchGraphObservation["nodes"][number] => ({
  node: {
    id,
    sessionId: `session-${id}`,
    status: "active",
    ...(options.role === "fusion" ? { isFusionNode: true } : {}),
    createdAt: AT,
    updatedAt: AT,
  },
  label,
  sessionTitle: `${label}会话`,
  ...(options.projectId ? { projectId: options.projectId } : {}),
  ...(options.projectName ? { projectName: options.projectName } : {}),
  ...(options.projectColorRole ? { projectColorRole: options.projectColorRole } : {}),
  lifecycle: options.lifecycle ?? "active",
  role: options.role ?? "research",
  scope: "inside-current-filter",
  connectivity: "default",
  candidateCount: 0,
  fusionEvidenceHealth: options.role === "fusion" ? "available" : "not-applicable",
});

export const GLOBAL_MAP_VISUAL_OBSERVATION: ResearchGraphObservation = {
  nodes: [
    node("map-amber", "检索架构", { projectId: "project-amber", projectName: "知识工程", projectColorRole: "amber" }),
    node("map-blue", "证据链", { projectId: "project-blue", projectName: "研究方法", projectColorRole: "blue" }),
    node("map-violet", "跨域综合", {
      projectId: "project-violet",
      projectName: "综合成果",
      projectColorRole: "violet",
      lifecycle: "archived",
      role: "fusion",
    }),
    node("map-neutral", "未分类观察"),
  ],
  edges: [
    {
      edge: {
        id: "edge-map-parent",
        kind: "parent-child",
        fromNodeId: "map-amber",
        toNodeId: "map-blue",
        status: "active",
        createdAt: AT,
      },
      connectivity: "default",
    },
    {
      edge: {
        id: "edge-map-fusion",
        kind: "fused-from",
        fromNodeId: "map-blue",
        toNodeId: "map-violet",
        status: "active",
        createdAt: AT,
      },
      connectivity: "default",
    },
  ],
  appliedRelationshipKinds: ["parent-child", "fused-from"],
};

export async function installGlobalMapVisualFixture(page: Page): Promise<void> {
  await page.route("**/v1/research-map*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(GLOBAL_MAP_VISUAL_OBSERVATION),
  }));
}
