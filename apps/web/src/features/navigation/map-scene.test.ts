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
  relationshipKinds: ["parent-child"],
  viewBox: { x: 12, y: 24, width: 480, height: 270 },
  layout: { world: { width: 960, height: 540 }, positions: new Map([["node-a", { x: 100, y: 120 }]]), edgeKeys: new Map([["edge-a", ["node-a", "node-b"] as const]]) },
});

describe("mapSceneV1", () => {
  it("只序列化地图观察所需的关系、视口和坐标", () => {
    expect(scene).toEqual({
      version: 1,
      relationshipKinds: ["parent-child"],
      viewBox: { x: 12, y: 24, width: 480, height: 270 },
      layout: { world: { width: 960, height: 540 }, positions: [["node-a", 100, 120]], edgeKeys: [["edge-a", "node-a", "node-b"]] },
    });
    expect(mapSceneFromRouteState({ mapSceneV1: scene })).toEqual(scene);
  });

  it.each([
    { mapSceneV1: { ...scene, version: 2 } },
    { mapSceneV1: { ...scene, viewBox: { ...scene.viewBox, x: Number.NaN } } },
    { mapSceneV1: { ...scene, layout: { ...scene.layout, positions: Array.from({ length: 2_001 }, () => ["n", 1, 2]) } } },
  ])("丢弃损坏、超版本或过大的快照", (routeState) => {
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
  });

  it("返回地图按历史索引计算完整步数，而非固定退一页", () => {
    const marker = createMapReturn({ idx: 3, key: "map-entry" }, "/map/focus/node-a");
    if (!marker) throw new Error("expected a valid map return marker");
    expect(mapReturnDelta(marker, { idx: 6, key: "node-entry" })).toBe(-3);
    expect(mapReturnDelta(marker, { idx: 3, key: "node-entry" })).toBeUndefined();
    expect(mapReturnDelta({ ...marker, sourcePath: "/nodes/nope" }, { idx: 6, key: "node-entry" })).toBeUndefined();
  });
});
