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

/** 返回左侧栏中实际会显示横向滚动槽的元素，避免底部出现无意义的滚动条。 */
async function sidebarHorizontalScrollers(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".side-drawer, .side-drawer *"))
      .filter((element) => {
        const overflowX = getComputedStyle(element).overflowX;
        return ["auto", "scroll"].includes(overflowX) && element.scrollWidth > element.clientWidth + 1;
      })
      .map((element) => ({
        selector: element.className || element.tagName.toLowerCase(),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflowX: getComputedStyle(element).overflowX,
      })),
  );
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

test("侧栏项目菜单可重命名项目", async ({ page }) => {
  const consoleIssues = trackBrowserIssues(page);
  const suffix = Date.now().toString(36);
  const originalName = `待改名项目-${suffix}`;
  const renamedName = `已改名项目-${suffix}`;

  await pairAndOpen(page, "/research/new");
  const nav = page.getByRole("navigation", { name: "内容导航" });
  await page.getByRole("button", { name: "＋ 新建项目" }).click();
  await page.getByLabel("新项目名称").fill(originalName);
  await page.getByRole("button", { name: "创建" }).click();

  await projectMenuButton(page, originalName).click();
  await page.getByRole("menuitem", { name: "重命名" }).click();
  const renameInput = page.getByRole("textbox", { name: "重命名" });
  await expect(renameInput).toBeFocused();
  await renameInput.fill(renamedName);
  await renameInput.press("Enter");
  await expect(nav.getByRole("button", { name: new RegExp(`^${renamedName}\\s*\\(`) })).toBeVisible();

  await page.reload();
  await expect(nav.getByRole("button", { name: new RegExp(`^${renamedName}\\s*\\(`) })).toBeVisible();
  expect(consoleIssues.issues, consoleIssues.issues.join("\n")).toEqual([]);
});

test("侧栏单行输入框具有足够尺寸与实体表面", async ({ page }) => {
  const consoleIssues = trackBrowserIssues(page);
  await page.setViewportSize({ width: 1175, height: 1272 });
  await pairAndOpen(page, "/map");

  const nav = page.getByRole("navigation", { name: "内容导航" });
  await nav.getByRole("button", { name: "搜索会话" }).click();
  const searchInput = nav.getByRole("searchbox", { name: "搜索会话标题" });
  await expect(searchInput).toBeFocused();
  await nav.getByRole("button", { name: /新建项目/ }).click();

  const inputStyles = await nav.locator("input.input").evaluateAll((inputs) =>
    inputs.map((input) => {
      const element = input as HTMLInputElement;
      const styles = getComputedStyle(element);
      const parentBackground = element.parentElement ? getComputedStyle(element.parentElement).backgroundColor : "";
      return {
        height: element.getBoundingClientRect().height,
        paddingLeft: Number.parseFloat(styles.paddingLeft),
        borderRadius: Number.parseFloat(styles.borderRadius),
        background: styles.backgroundColor,
        parentBackground,
      };
    }),
  );

  expect(inputStyles.length).toBeGreaterThanOrEqual(2);
  for (const styles of inputStyles) {
    expect(styles.height, "单行输入框点击高度至少 44px").toBeGreaterThanOrEqual(44);
    expect(styles.paddingLeft, "输入文字与边界保留足够内边距").toBeGreaterThanOrEqual(12);
    expect(styles.borderRadius, "输入框使用产品圆角层级").toBeGreaterThanOrEqual(10);
    expect(styles.background, "输入框必须有非透明实体底色").not.toBe("rgba(0, 0, 0, 0)");
    expect(styles.background, "输入框实体底色需与周围容器形成层次").not.toBe(styles.parentBackground);
  }

  await searchInput.focus();
  await expect.poll(() => searchInput.evaluate((input) => getComputedStyle(input).boxShadow)).not.toBe("none");
  expect(await sidebarHorizontalScrollers(page), "增大输入框后侧栏不应出现横向滚动条").toEqual([]);
  expect(consoleIssues.issues, consoleIssues.issues.join("\n")).toEqual([]);
});

test("单层级侧栏：收展无残留 + 底部设置聚合菜单真实导航（#54 / ADR-0020）", async ({ page }) => {
  const browserIssues = trackBrowserIssues(page);
  await pairAndOpen(page, "/research/new");
  const nav = page.getByRole("navigation", { name: "内容导航" });
  await expect(nav).toBeVisible();

  // 展开态：顶部按钮组（收起/搜索/新建会话）+ 完整侧栏
  await expect(nav.getByRole("button", { name: "收起侧栏" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "搜索会话" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "新建会话" })).toBeVisible();
  await expect(nav.getByText("最近研究")).toBeVisible();

  // 展开态底部保持单列：主题必须完整落在设置下方，不能并排跑到设置右侧。
  const settingsBox = await nav.getByRole("button", { name: "设置" }).boundingBox();
  const themeBox = await nav.getByRole("button", { name: "主题：跟随系统" }).boundingBox();
  expect(settingsBox).not.toBeNull();
  expect(themeBox).not.toBeNull();
  expect(themeBox!.y).toBeGreaterThanOrEqual(settingsBox!.y + settingsBox!.height);
  expect(themeBox!.x).toBe(settingsBox!.x);

  // 底部设置聚合菜单：四个入口真实导航
  await nav.getByRole("button", { name: "设置" }).click();
  const settingsMenu = nav.getByRole("menu", { name: "设置" });
  await settingsMenu.getByRole("menuitem", { name: "回收站" }).click();
  await page.waitForURL("**/trash");
  await nav.getByRole("button", { name: "设置" }).click();
  await settingsMenu.getByRole("menuitem", { name: "运行记录" }).click();
  await page.waitForURL("**/run-records");
  await nav.getByRole("button", { name: "设置" }).click();
  await settingsMenu.getByRole("menuitem", { name: "AI 模型设置" }).click();
  await page.waitForURL("**/settings/ai-model");
  await nav.getByRole("button", { name: "设置" }).click();
  await settingsMenu.getByRole("menuitem", { name: "融合设置" }).click();
  await page.waitForURL("**/settings/fusion");

  // 收起为干净图标 rail：详情（最近研究/设置文字钮）消失，只剩图标，无残留窄条
  await nav.getByRole("button", { name: "收起侧栏" }).click();
  await expect(nav.getByText("最近研究")).not.toBeVisible();
  await expect(nav.getByRole("button", { name: "展开侧栏" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "会话", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "主题：跟随系统" })).toBeVisible();

  // 收起态点「设置」：一次点击同时展开侧栏并打开菜单，无需先手动展开
  await nav.getByRole("button", { name: "设置" }).click();
  await expect(nav.getByText("最近研究")).toBeVisible();
  await expect(nav.getByRole("button", { name: "收起侧栏" })).toBeVisible();
  await expect(nav.getByRole("menu", { name: "设置" })).toBeVisible();
  expect(browserIssues.issues, browserIssues.issues.join("\n")).toEqual([]);
});

test("左侧栏不生成横向滚动条，调宽把手仍可使用", async ({ page }) => {
  await pairAndOpen(page, "/research/new", true);

  const nav = page.getByRole("navigation", { name: "内容导航" });
  await expect(nav).toBeVisible();
  expect(await sidebarHorizontalScrollers(page), "展开侧栏底部不应出现横向滚动条").toEqual([]);

  const resizeHandle = nav.getByRole("separator", { name: "调整内容侧栏宽度" });
  const widthBeforeResize = Number(await resizeHandle.getAttribute("aria-valuenow"));
  await resizeHandle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(resizeHandle).toHaveAttribute("aria-valuenow", String(widthBeforeResize + 16));
});

test("主题三态：手动选择优先、刷新保持、跟随系统实时响应（#55）", async ({ page }) => {
  const browserIssues = trackBrowserIssues(page);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await pairAndOpen(page, "/research/new");

  const nav = page.getByRole("navigation", { name: "内容导航" });
  const canvasColor = () =>
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-canvas").trim().toLowerCase());

  // 默认跟随系统；浅色系统下使用浅色令牌。
  await expect(nav.getByRole("button", { name: "主题：跟随系统" })).toBeVisible();
  await expect.poll(canvasColor).toBe("#faf9f5");

  // 手动深色优先于当前浅色系统，并在刷新后保持。
  await nav.getByRole("button", { name: "主题：跟随系统" }).click();
  await nav.getByRole("radio", { name: "深色" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(canvasColor).toBe("#262624");
  await page.reload();
  await expect(nav.getByRole("button", { name: "主题：深色" })).toBeVisible();
  await expect.poll(canvasColor).toBe("#262624");

  // 手动浅色同样优先于深色系统。
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await nav.getByRole("button", { name: "主题：深色" }).click();
  await nav.getByRole("radio", { name: "浅色" }).click();
  await expect.poll(canvasColor).toBe("#faf9f5");

  // 切回跟随系统后，系统变化不需刷新即可切换令牌。
  await nav.getByRole("button", { name: "主题：浅色" }).click();
  await nav.getByRole("radio", { name: "跟随系统" }).click();
  await expect.poll(canvasColor).toBe("#262624");
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await expect.poll(canvasColor).toBe("#faf9f5");

  // 320px 常驻 rail 仍能打开完整三态；当前 radio 获焦后可用方向键选择，弹层不溢出视口。
  await page.setViewportSize({ width: 320, height: 800 });
  await page.reload();
  await nav.getByRole("button", { name: "主题：跟随系统" }).click();
  const themeGroup = nav.getByRole("radiogroup", { name: "选择主题" });
  await expect(themeGroup).toBeVisible();
  const groupBox = await themeGroup.boundingBox();
  expect(groupBox).not.toBeNull();
  expect(groupBox!.x).toBeGreaterThanOrEqual(0);
  expect(groupBox!.x + groupBox!.width).toBeLessThanOrEqual(320);
  const groupCenterIsClickable = await page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return Boolean(hit?.closest(".theme-switcher__popover"));
  }, {
    x: groupBox!.x + groupBox!.width / 2,
    y: groupBox!.y + groupBox!.height / 2,
  });
  expect(groupCenterIsClickable, "窄 rail 的主题弹层不能被侧栏 overflow 裁剪").toBe(true);
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(nav.getByRole("button", { name: "主题：浅色" })).toBeFocused();

  expect(browserIssues.issues, browserIssues.issues.join("\n")).toEqual([]);
});

test("自动融合设置页：正文与左右侧栏之间保留页面留白", async ({ page }) => {
  await pairAndOpen(page, "/settings/fusion");

  for (const width of [320, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>(".app-main");
      const heading = document.querySelector<HTMLElement>('[aria-label="自动融合"] :is(h1, h2)');
      if (!main || !heading) throw new Error("自动融合设置页尚未渲染");
      const mainRect = main.getBoundingClientRect();
      const headingRect = heading.getBoundingClientRect();
      return {
        leftGap: headingRect.left - mainRect.left,
        headingRightGap: mainRect.right - headingRect.right,
      };
    });
    expect(geometry.leftGap).toBeGreaterThanOrEqual(16);
    expect(geometry.headingRightGap).toBeGreaterThanOrEqual(16);
  }
});

test("⋯ 菜单在可滚动侧栏中不漂移不被裁剪（#10）", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  // 造 3 个项目 × 各 1 会话，让侧栏出现分组与 ⋯ 菜单
  await submitFirstQuestion(page, OWN_QUESTION);
  const nav = page.getByRole("navigation", { name: "内容导航" });
  // 新建一个项目并把当前会话移入，确保有项目 ⋯ 菜单
  await nav.getByRole("button", { name: /新建项目/ }).click();
  await nav.getByLabel("新项目名称").fill(`菜单定位-${RUN_SUFFIX}`);
  await nav.getByRole("button", { name: /^创建$/ }).click();

  // 打开会话 ⋯ 菜单：应为 fixed 定位（position: fixed），脱离滚动容器
  const trigger = sessionMenuButton(page, OWN_QUESTION).first();
  await trigger.click();
  const menu = page.getByRole("menu", { name: `${OWN_QUESTION} 的操作` });
  await expect(menu).toBeVisible();
  const position = await menu.evaluate((el) => getComputedStyle(el).position);
  expect(position, "⋯ 菜单应为 fixed 定位，脱离侧栏滚动容器").toBe("fixed");

  // 菜单在视口内（未被裁剪）：其边界矩形应在视口范围内
  const box = await menu.boundingBox();
  const viewport = page.viewportSize();
  expect(box, "菜单应有可见边界").not.toBeNull();
  expect(box!.x, "菜单左缘不应溢出视口左侧").toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, "菜单右缘不应溢出视口右侧").toBeLessThanOrEqual(viewport!.width);
  expect(box!.y + box!.height, "菜单下缘不应溢出视口底部").toBeLessThanOrEqual(viewport!.height);

  // 菜单项仍可用（移动/重命名契约未破）
  await expect(menu.getByRole("menuitem", { name: "重命名" })).toBeVisible();
  await page.keyboard.press("Escape");
});
