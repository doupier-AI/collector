import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { apiJson, apiPortForPage, pairAndOpen, readDataDir, readResearchTables, trackBrowserIssues } from "./helpers";

const QUESTION = "什么是本地优先研究？";
/** 本 spec 的专属问题文本：与 research-session.spec 等共用同一 harness 数据目录，
 *  用唯一文本避免自动标题与「最近会话恢复」与其它 spec 的会话混淆。
 *  RUN_SUFFIX 与测试体内的 suffix 必须同源（同一毫秒派生），
 *  否则问题标题与项目名/会话名的后缀不一致，侧栏定位会落空。 */
const RUN_SUFFIX = Date.now().toString(36);
const OWN_QUESTION = `会话管理全流程验证 ${RUN_SUFFIX}`;

/** 在侧栏分组树中定位会话行的操作菜单（⋯）按钮。 */
function sessionMenuButton(page: Page, sessionTitle: string) {
  return page.getByLabel(`${sessionTitle} 的菜单`);
}

/** 在侧栏分组树中定位项目的操作菜单（⋯）按钮。 */
function projectMenuButton(page: Page, projectName: string) {
  return page.getByLabel(`${projectName} 的菜单`);
}

/** 通过开始页提交首问并等回答完成，返回会话 id（根节点 id 与之一致）。 */
async function submitFirstQuestion(page: Page, question = QUESTION): Promise<string> {
  await page.getByLabel("你的问题").fill(question);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/research\/(?!new$)[^/]+\/node\/[^/]+$/, { timeout: 10_000 });
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });
  return page.url().split("/research/")[1]?.split("/")[0] ?? "";
}

test("会话管理全流程：项目分组 → 改名 → 归档 → 软删/回收站/恢复 → 彻底删除", async ({ page }) => {
  const consoleIssues = trackBrowserIssues(page);
  const suffix = RUN_SUFFIX;
  const projectName = `项目-${suffix}`;
  const sessionTitle = `会话-${suffix}`;
  const renamedTitle = `改名-${suffix}`;

  await pairAndOpen(page, "/research/new");

  // ── 1. 侧栏新建项目（空状态入口）──
  const nav = page.getByRole("navigation", { name: "内容导航" });
  await expect(nav).toBeVisible();
  await page.getByRole("button", { name: "＋ 新建项目" }).click();
  await page.getByLabel("新项目名称").fill(projectName);
  await page.getByRole("button", { name: "创建" }).click();
  await expect(nav.getByRole("button", { name: new RegExp(`^${projectName}\\s*\\(` ) })).toBeVisible();

  // ── 2. 创建会话 ──
  const sessionId = await submitFirstQuestion(page, OWN_QUESTION);
  await expect(page.getByRole("heading", { name: new RegExp(OWN_QUESTION) })).toBeVisible();

  // ── 3. 侧栏把会话移动到项目 ──
  await page.goto("/");
  await expect(nav.getByRole("link", { name: new RegExp(OWN_QUESTION) })).toBeVisible();
  await sessionMenuButton(page, OWN_QUESTION).click();
  await page.getByRole("menuitem", { name: projectName, exact: true }).click();
  // 会话进入项目组：项目按钮计数为 (1)，证明会话已移入（菜单按钮 aria-label 不匹配此正则）
  await expect(nav.getByRole("button", { name: new RegExp(`^${projectName}\\s*\\(1\\)`) })).toBeVisible();

  // ── 4. 侧栏重命名会话（inline 输入）──
  await sessionMenuButton(page, OWN_QUESTION).click();
  await page.getByRole("menuitem", { name: "重命名" }).click();
  const renameInput = page.getByRole("textbox", { name: "重命名" });
  await renameInput.fill(sessionTitle);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(nav.getByRole("link", { name: sessionTitle })).toBeVisible();

  // ── 5. 会话页页头改名入口 ──
  await nav.getByRole("link", { name: sessionTitle }).click();
  await page.getByRole("button", { name: new RegExp(`^重命名「${sessionTitle}」`) }).click();
  const pageTitleInput = page.getByLabel("会话新标题");
  await pageTitleInput.fill(renamedTitle);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("heading", { name: renamedTitle })).toBeVisible();
  // 改名同步到侧栏（SESSIONS_CHANGED 广播）
  await page.goto("/");
  await expect(nav.getByRole("link", { name: renamedTitle })).toBeVisible();

  // ── 6. 改名后继续提问，标题不被自动标题覆盖（titleEdited 保护）──
  await nav.getByRole("link", { name: renamedTitle }).click();
  await page.getByLabel("你的问题").fill("继续追问：这部分如何落地？");
  await page.getByRole("button", { name: /发送/ }).click();
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: renamedTitle })).toBeVisible();
  const view = await apiJson<{ session: { title: string; titleEdited?: boolean } }>(
    page,
    `/v1/research-sessions/${sessionId}`,
  );
  expect(view.session.title).toBe(renamedTitle);
  expect(view.session.titleEdited).toBe(true);

  // ── 7. 归档 ──
  await page.goto("/");
  await sessionMenuButton(page, renamedTitle).click();
  await page.getByRole("menuitem", { name: "归档" }).click();
  await expect(nav.getByText(/已归档/)).toBeVisible();

  // ── 8. 软删除 → 回收站可见 ──
  page.once("dialog", (dialog) => void dialog.accept());
  await sessionMenuButton(page, renamedTitle).click();
  await page.getByRole("menuitem", { name: "删除…" }).click();
  await expect(nav.getByRole("link", { name: renamedTitle })).not.toBeVisible();
  // 数据库层面仍是软删（记录仍在，trashedAt 置位）
  const dataDir = await readDataDir(apiPortForPage(page));
  const dbSessions = readResearchTables(join(dataDir, "collector.sqlite")).sessions;
  const trashed = dbSessions.find((row) => row.id === sessionId);
  expect(trashed, "软删除后会话记录仍存在（回收站）").toBeTruthy();

  // ── 9. 回收站页：可见、恢复 ──
  await page.goto("/trash");
  await expect(page.getByRole("heading", { name: "回收站" })).toBeVisible();
  await expect(page.locator(".trash-page__item-title", { hasText: renamedTitle })).toBeVisible();
  await page.getByRole("button", { name: "恢复" }).click();
  await expect(page.locator(".trash-page__item-title", { hasText: renamedTitle })).not.toBeVisible();
  // 侧栏已同步回未分类（项目还在，会话恢复回原项目）
  await page.goto("/");
  await expect(nav.getByRole("link", { name: renamedTitle })).toBeVisible();

  // ── 10. 彻底删除（确认后级联清空）──
  // 删除前记录该会话的任务与事件（级联断言的基准）
  const taskIdsBefore = new Set(
    readResearchTables(join(dataDir, "collector.sqlite")).tasks
      .filter((row) => row.sessionId === sessionId)
      .map((row) => row.id),
  );
  expect(taskIdsBefore.size, "该会话应有任务记录").toBeGreaterThan(0);
  const eventsBefore = readResearchTables(join(dataDir, "collector.sqlite")).events
    .filter((row) => taskIdsBefore.has(row.taskId))
    .map((row) => row.id);
  await sessionMenuButton(page, renamedTitle).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("menuitem", { name: "删除…" }).click();
  await page.goto("/trash");
  await expect(page.locator(".trash-page__item-title", { hasText: renamedTitle })).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "彻底删除" }).click();
  await expect(page.locator(".trash-page__item-title", { hasText: renamedTitle })).not.toBeVisible();
  const tablesAfter = readResearchTables(join(dataDir, "collector.sqlite"));
  expect(tablesAfter.sessions.find((row) => row.id === sessionId), "彻底删除后会话记录不存在").toBeUndefined();
  expect(tablesAfter.messages.find((row) => row.sessionId === sessionId), "级联删除后消息不存在").toBeUndefined();
  expect(tablesAfter.tasks.find((row) => row.sessionId === sessionId), "级联删除后任务不存在").toBeUndefined();
  for (const taskId of taskIdsBefore) {
    expect(tablesAfter.events.find((row) => row.taskId === taskId), "级联删除后该任务事件不存在").toBeUndefined();
  }
  expect(eventsBefore.length, "删除前该会话应有任务事件").toBeGreaterThan(0);

  // ── 11. 删除项目：其下会话回未分类，不删除会话 ──
  // 先重建一个会话并移入项目，再删项目验证回退。第二个问题不含句末标点，
  // 避免自动标题截断后与第一个会话同名（侧栏同 name 元素会违反 strict 模式）。
  const secondQuestion = `本地优先第二轮验证${suffix}`;
  // 同一上下文已配对，直接导航开始页（再次 pairAndOpen 会因无配对页而超时）
  await page.goto("/research/new");
  const secondSessionId = await submitFirstQuestion(page, secondQuestion);
  await page.goto("/");
  await sessionMenuButton(page, secondQuestion).click();
  await page.getByRole("menuitem", { name: projectName, exact: true }).click();
  // 移动后项目计数为 (1)，会话已移入项目组
  await expect(nav.getByRole("button", { name: new RegExp(`^${projectName}\\s*\\(1\\)`) })).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await projectMenuButton(page, projectName).click();
  await page.getByRole("menuitem", { name: "删除项目…" }).click();
  await expect(nav.getByRole("button", { name: new RegExp(`^${projectName}\\s*\\(`) })).not.toBeVisible();
  // 删除项目后会话回未分类（不在任何项目组内，链接仍可见）
  await expect(nav.getByRole("link", { name: secondQuestion })).toBeVisible();
  const secondView = await apiJson<{ session: { id: string; projectId?: string } }>(
    page,
    `/v1/research-sessions/${secondSessionId}`,
  );
  expect(secondView.session.projectId, "删除项目后会话回未分类").toBeUndefined();

  // ── 12. 控制台无错误 ──
  expect(consoleIssues.issues, consoleIssues.issues.join("\n")).toEqual([]);
});

test("rail 设置/工具入口真实导航到对应页面（ADR-0017 切片 1）", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  const nav = page.getByRole("navigation", { name: "内容导航" });
  await expect(nav).toBeVisible();

  // 四个原"僵尸"入口：点击后地址栏到达对应路由，当前页入口带 aria-current
  await nav.getByRole("link", { name: "回收站" }).click();
  await page.waitForURL("**/trash");
  await expect(nav.getByRole("link", { name: "回收站" })).toHaveAttribute("aria-current", "page");

  await nav.getByRole("link", { name: "运行记录" }).click();
  await page.waitForURL("**/run-records");
  await expect(nav.getByRole("link", { name: "运行记录" })).toHaveAttribute("aria-current", "page");

  await nav.getByRole("link", { name: "AI 模型设置" }).click();
  await page.waitForURL("**/settings/ai-model");
  await expect(nav.getByRole("link", { name: "AI 模型设置" })).toHaveAttribute("aria-current", "page");

  await nav.getByRole("link", { name: "融合设置" }).click();
  await page.waitForURL("**/settings/fusion");
  await expect(nav.getByRole("link", { name: "融合设置" })).toHaveAttribute("aria-current", "page");
});
