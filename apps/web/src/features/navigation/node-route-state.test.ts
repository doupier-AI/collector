import { describe, expect, it } from "vitest";
import { nodeRouteStateWith, stripOneShotNodeRouteState } from "./node-route-state";

describe("节点路由一次性状态", () => {
  it("只保留可安全继续导航的字段，不让首次提问和生长标记泄漏到来源返回", () => {
    expect(stripOneShotNodeRouteState({ firstTurn: { query: "hello" }, grew: true, searchLocatorFallback: "已打开节点", keep: "yes" }))
      .toEqual({ keep: "yes" });
  });

  it("创建下一节点的一次性到达标记时不复活先前的标记", () => {
    expect(nodeRouteStateWith({ firstTurn: { query: "hello" }, keep: "yes" }, { grew: true }))
      .toEqual({ keep: "yes", grew: true });
  });
});
