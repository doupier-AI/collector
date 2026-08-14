import { expect, test, type Page } from "@playwright/test";
import { apiJson, pairAndOpen } from "./helpers";

const RUN_SUFFIX = Date.now().toString(36);
const OWN_QUESTION = `批量操作验证 ${RUN_SUFFIX}`;

/** 通过开始页提交首问并等回答完成，返回会话 id（根节点 id 与之一致）。 */
async function submitFirstQuestion(page: Page, question: string): Promise<string> {
  await page.getByLabel("你的问题").fill(question);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });
  return page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
}

/** 在侧栏分组树中定位会话行的操作菜单（⋯）按钮。 */
function sessionMenuButton(page: Page, sessionTitle: string) {
  return page.getByLabel(`${sessionTitle} 的菜单`);
}

test("会话批量操作：选择模式 → 批量移动 → 批量删除 → 回收站批量恢复/彻底删除", async ({ page }) => {
  const suffix = RUN_SUFFIX;
  const projectA = `项目A-${suffix}`;
  const projectB = `项目B-${suffix}`;
  const q1 = `批量会话一 ${suffix}`;
  const q2 = `批量会话二 ${suffix}`;

  await pairAndOpen(page, "/research/new");
  const nav = page.getByRole("navigation", { name: "内容导航" });

  // ── 1. 建两个项目 ──
  for (const projectName of [projectA, projectB]) {
    await page.getByRole("button", { name: "＋ 新建项目" }).click();
    await page.getByLabel("新项目名称").fill(projectName);
    await page.getByRole("button", { name: "创建" }).click();
    await expect(nav.getByRole("button", { name: new RegExp(`^${projectName}\\s*\\(`) })).toBeVisible();
  }

  // ── 2. 建两个会话 ──
  const id1 = await submitFirstQuestion(page, q1);
  await page.goto("/research/new");
  const id2 = await submitFirstQuestion(page, q2);

  // ── 3. 侧栏选择模式：勾选两个会话 → 批量移动到项目B ──
  await page.goto("/");
  await expect(nav.getByRole("link", { name: new RegExp(q1) })).toBeVisible();
  await page.getByRole("button", { name: "选择" }).click();
  await page.getByRole("button", { name: `选择${q1}` }).click();
  await page.getByRole("button", { name: `选择${q2}` }).click();
  await expect(page.getByText("已选 2 项")).toBeVisible();
  await page.getByRole("button", { name: "移动到…" }).click();
  await page.getByRole("button", { name: projectB, exact: true }).click();
  // 批量移动完成：自动退出选择模式，项目B计数 (2)
  await expect(nav.getByRole("button", { name: new RegExp(`^${projectB}\\s*\\(2\\)`) })).toBeVisible();
  // 数据库层面验证 projectId
  const view1 = await apiJson<{ session: { projectId?: string } }>(page, `/v1/research-sessions/${id1}`);
  expect(view1.session.projectId).toBeTruthy();

  // ── 4. 再次选择模式：批量删除（软删）──
  await page.getByRole("button", { name: "选择" }).click();
  await page.getByRole("button", { name: `选择${q1}` }).click();
  await page.getByRole("button", { name: `选择${q2}` }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(nav.getByRole("link", { name: new RegExp(q1) })).not.toBeVisible();
  await expect(nav.getByRole("link", { name: new RegExp(q2) })).not.toBeVisible();

  // ── 5. 回收站：批量恢复 ──
  await page.goto("/trash");
  await expect(page.getByRole("heading", { name: "回收站" })).toBeVisible();
  // 回收站页头操作区（与侧栏「选择」区分）
  const trashHeaderActions = page.locator(".trash-page__header-actions");
  await trashHeaderActions.getByRole("button", { name: "选择" }).click();
  await page.getByRole("button", { name: `选择${q1}` }).click();
  await page.getByRole("button", { name: `选择${q2}` }).click();
  await expect(page.getByText("已选 2 项")).toBeVisible();
  await page.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(page.locator(".trash-page__item-title", { hasText: q1 })).not.toBeVisible();
  // 侧栏同步回未分类
  await page.goto("/");
  await expect(nav.getByRole("link", { name: new RegExp(q1) })).toBeVisible();

  // ── 6. 回收站：批量彻底删除（级联清空）──
  await page.getByRole("button", { name: "选择" }).click();
  await page.getByRole("button", { name: `选择${q1}` }).click();
  await page.getByRole("button", { name: `选择${q2}` }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await page.goto("/trash");
  await expect(page.locator(".trash-page__item-title", { hasText: q1 })).toBeVisible();
  await trashHeaderActions.getByRole("button", { name: "选择" }).click();
  await page.getByRole("button", { name: `选择${q1}` }).click();
  await page.getByRole("button", { name: `选择${q2}` }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "彻底删除", exact: true }).click();
  await expect(page.locator(".trash-page__item-title", { hasText: q1 })).not.toBeVisible();
  // 会话已彻底删除：API 404
  const response = await page.request.get(`/v1/research-sessions/${id1}`);
  expect(response.status()).toBe(404);
});
