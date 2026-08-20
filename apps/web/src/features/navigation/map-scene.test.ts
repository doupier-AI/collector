import { describe, expect, it } from "vitest";
import {
  createMapReturn,
  mapReturnDelta,
  mapReturnFromRouteState,
  mapSceneFromRouteState,
  mergeRouteState,
  nodeEntryStateFromMapReturn,
  serializeMapScene,
  stripOneShotRouteState,
} from "./map-scene";

const scene = serializeMapScene({
  filters: {
    projectScope: { kind: "selected", projectIds: ["project-b", "project-a"], includeUncategorized: true },
    fromDate: "2026-08-10",
    throughDate: "2026-08-12",
    lifecycles: ["archived", "active"],
  },
  relationshipKinds: ["parent-child"],
  viewBox: { x: 12, y: 24, width: 480, height: 270 },
  layout: { world: { width: 960, height: 540 }, positions: new Map([["node-a", { x: 100, y: 120 }]]), edgeKeys: new Map([["edge-a", ["node-a", "node-b"] as const]]) },
});

describe("mapSceneV2", () => {
  it("完整往返规范化后的筛选、关系、视口和坐标", () => {
    expect(scene).toEqual({
      version: 2,
      filters: {
        projectScope: { kind: "selected", projectIds: ["project-a", "project-b"], includeUncategorized: true },
        fromDate: "2026-08-10",
        throughDate: "2026-08-12",
        lifecycles: ["active", "archived"],
      },
      relationshipKinds: ["parent-child"],
      viewBox: { x: 12, y: 24, width: 480, height: 270 },
      layout: { world: { width: 960, height: 540 }, positions: [["node-a", 100, 120]], edgeKeys: [["edge-a", "node-a", "node-b"]] },
    });
    expect(mapSceneFromRouteState({ mapSceneV2: scene })).toEqual(scene);
  });

  it.each([
    { mapSceneV1: { version: 1, relationshipKinds: scene.relationshipKinds, viewBox: scene.viewBox, layout: scene.layout } },
    { mapSceneV2: { ...scene, version: 1 } },
    { mapSceneV2: { ...scene, filters: { ...scene.filters, throughDate: "not-a-date" } } },
    { mapSceneV2: { ...scene, filters: { ...scene.filters, projectScope: { kind: "selected", projectIds: ["same", "same"], includeUncategorized: false } } } },
    { mapSceneV2: { ...scene, filters: { ...scene.filters, projectScope: { kind: "selected", projectIds: Array.from({ length: 501 }, (_, index) => `project-${index}`), includeUncategorized: false } } } },
    { mapSceneV2: { ...scene, relationshipKinds: ["parent-child", "parent-child"] } },
    { mapSceneV2: { ...scene, viewBox: { ...scene.viewBox, x: Number.NaN } } },
    { mapSceneV2: { ...scene, layout: { ...scene.layout, positions: Array.from({ length: 2_001 }, () => ["n", 1, 2]) } } },
  ])("丢弃旧V1、损坏、重复或过大的快照", (routeState) => {
    expect(mapSceneFromRouteState(routeState)).toBeUndefined();
  });
});

describe("地图返回标记", () => {
  it("保留 React Router usr 的既有字段，并只删除一次性字段", () => {
    const mapReturn = createMapReturn({ idx: 4, key: "map-entry" }, "/map/focus/node-a");
    const merged = mergeRouteState({ firstTurn: { query: "hello" }, grew: true, keep: "yes" }, { mapReturn });
    expect(merged).toMatchObject({ firstTurn: { query: "hello" }, grew: true, keep: "yes", mapReturn });
    expect(stripOneShotRouteState(merged)).toEqual({ keep: "yes", mapReturn });
    expect(mapReturnFromRouteState(merged)).toEqual(mapReturn);
    expect(nodeEntryStateFromMapReturn(mapReturn)).toEqual({ mapReturn });
    expect(nodeEntryStateFromMapReturn(mapReturn)).not.toHaveProperty("mapSceneV1");
    expect(nodeEntryStateFromMapReturn(mapReturn)).not.toHaveProperty("mapSceneV2");
  });

  it("返回地图按历史索引计算完整步数，而非固定退一页", () => {
    const marker = createMapReturn({ idx: 3, key: "map-entry" }, "/map/focus/node-a");
    if (!marker) throw new Error("expected a valid map return marker");
    expect(mapReturnDelta(marker, { idx: 6, key: "node-entry" })).toBe(-3);
    expect(mapReturnDelta(marker, { idx: 3, key: "node-entry" })).toBeUndefined();
    expect(mapReturnDelta({ ...marker, sourcePath: "/nodes/nope" }, { idx: 6, key: "node-entry" })).toBeUndefined();
  });
});
