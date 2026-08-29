import { expect, test } from "@playwright/test";
import { installGlobalMapFilterFixture } from "./global-map-fixture";
import { pairAndOpen } from "./helpers";

test.describe("研究图谱全局画布", () => {
  test("筛选只隐藏节点，清除后恢复本次打开期间的稳定坐标；窄屏改用列表", async ({ page }) => {
    await installGlobalMapFilterFixture(page);
    await pairAndOpen(page, "/map");
    const canvas = page.getByTestId("global-map-canvas");
    await expect(canvas).toHaveAttribute("data-entry-animation", "complete");
    const node = canvas.locator("[data-node-id='filter-a']");
    const middle = canvas.locator("[data-node-id='filter-b']");
    await expect(node).toBeVisible();
    await expect(node).toHaveAttribute("data-root-node", "true");
    await expect(middle).not.toHaveAttribute("data-root-node", "true");
    const before = await node.getAttribute("transform");

    await page.getByRole("button", { name: "筛选地图" }).click();
    await page.getByRole("checkbox", { name: "项目一" }).check();
    await expect(canvas.locator("[data-node-id='filter-b']")).toBeHidden();
    await page.getByRole("button", { name: "关闭工具面板" }).click();
    await page.getByRole("button", { name: "筛选地图" }).click();
    await page.getByRole("checkbox", { name: "项目一" }).uncheck();
    await expect(node).toHaveAttribute("transform", before ?? "");
    await page.getByRole("checkbox", { name: "项目二" }).check();
    await expect(node).toBeHidden();
    await expect(middle).toBeVisible();
    await expect(middle).not.toHaveAttribute("data-root-node", "true");
    await page.getByRole("checkbox", { name: "项目二" }).uncheck();

    await page.setViewportSize({ width: 768, height: 800 });
    await page.getByRole("button", { name: "切换到节点列表" }).click();
    await expect(page.getByTestId("global-map-list")).toBeVisible();
    await expect(page.getByRole("button", { name: /项目一节点 A/ })).toBeVisible();
  });
});
