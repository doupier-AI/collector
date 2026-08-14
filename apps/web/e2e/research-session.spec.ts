import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { apiJson, apiPortForPage, pairAndOpen, readDataDir, readResearchTables } from "./helpers";

const QUESTION = "什么是本地优先研究？";

interface SessionView {
  session: { id: string; title: string };
  messages: Array<{ id: string; role: string; content: string; status: string }>;
  tasks: Array<{ id: string; status: string; retryable: boolean }>;
}

async function submitFirstQuestion(page: Page, question = QUESTION): Promise<string> {
  await page.getByLabel("你的问题").fill(question);
  await page.getByRole("button", { name: "开始研究" }).click();
  // #61：开始页直接落到稳定节点地址 /nodes/:id（根节点 id = 会话 id）
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  return page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
}

test("首次打开显示开始页与空状态邀请", async ({ page }) => {
  // 直接进入开始页：/ 在已有会话时会按产品逻辑恢复最近会话（由另一场景覆盖）
  await pairAndOpen(page, "/research/new");

  // 开始页：占位 logo、居中标题与说明、精简输入区（占位提示 + 圆形按钮）
  await expect(page.locator(".page__logo")).toBeVisible();
  await expect(page.getByRole("heading", { name: "从一个问题开始" })).toBeVisible();
  await expect(page.getByText("写下你正在理解的内容，Collector 会保存这次研究，并让你随时回来继续。")).toBeVisible();
  await expect(page.getByLabel("你的问题")).toBeVisible();
  await expect(page.getByRole("button", { name: "开始研究" })).toBeVisible();
  await expect(page.getByRole("button", { name: /添加附件（TXT、Markdown、DOCX、PDF/ })).toBeVisible();

  // 宽屏（默认 1280px）左侧固定内容导航初始展开为空状态
  // （#56 已移除右侧常驻标记栏，标记改为会话 ⋯ 菜单内的按需弹窗，开始页不再有标记区）
  const nav = page.getByRole("navigation", { name: "内容导航" });
  await expect(nav).toBeVisible();
  await expect(page.getByText(/还没有研究会话/)).toBeVisible();

  // 左侧栏收展由侧栏内部按钮控制（顶栏已无「内容」整体隐藏入口）：收起为窄 rail 再展开
  await nav.getByRole("button", { name: "收起侧栏" }).click();
  await expect(page.getByText(/还没有研究会话/)).toBeHidden();
  await expect(nav.getByRole("button", { name: "展开侧栏" })).toBeVisible();
  await nav.getByRole("button", { name: "展开侧栏" }).click();
  await expect(page.getByText(/还没有研究会话/)).toBeVisible();
});

test("提交后渐进内容进入同一条 AI 消息并完成，控制台无错误，网络符合契约", async ({ page }) => {
  const consoleIssues: string[] = [];
  const apiRequests: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  const apiResponses: Array<{ url: string; contentType: string }> = [];
  page.on("request", (request) => {
    if (request.url().includes("/v1/")) {
      apiRequests.push({ method: request.method(), url: request.url(), headers: request.headers() });
    }
  });
  page.on("response", (response) => {
    if (response.url().includes("/v1/")) {
      apiResponses.push({ url: response.url(), contentType: response.headers()["content-type"] ?? "" });
    }
  });

  await pairAndOpen(page, "/research/new");

  // 配对前未带凭证的探测请求会返回 401 并被 Chromium 记为资源加载错误，
  // 属于预期流程；控制台断言只覆盖配对后的研究操作。
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") consoleIssues.push(message.text());
  });
  page.on("pageerror", (error) => consoleIssues.push(String(error)));

  await submitFirstQuestion(page);

  // 用户消息与 AI 固定占位立即出现，状态“已保存，正在生成”
  await expect(page.getByText(QUESTION, { exact: true })).toBeVisible();
  await expect(page.getByTestId("ai-placeholder")).toBeVisible();
  // 状态文字同时存在于消息状态与 sr-only aria-live 区，用 class 限定避免 strict 冲突。
  // “正在生成”同时匹配“已保存，正在生成”与“正在生成”两个生成期瞬态，
  // 不能在此断言完成态的材料范围说明——那会阻塞到生成结束、让后续渐进断言失去中间态。
  await expect(page.locator(".message__status")).toContainText("正在生成");

  // 渐进内容进入同一条 AI 消息
  const assistantMessages = page.locator(".message--assistant");
  const assistantContent = page.locator(".message--assistant .message__content");
  // 流式中段只有生成中的单一 .message__content（GeneratingBody），单匹配定位有效。
  await expect(assistantContent).toContainText("你问的是", { timeout: 15_000 });
  const earlyText = (await assistantContent.textContent()) ?? "";
  await expect(assistantMessages).toHaveCount(1);
  await expect(assistantContent.last()).toContainText("回答完毕", { timeout: 15_000 });
  await expect(assistantMessages).toHaveCount(1);
  // 完成后渲染为多张切片卡片（各含一个 .message__content），渲染丢弃段落间 \n\n；
  // 拼接所有块文本即完整正文（无 \n\n）。earlyText 是流式中段捕获的部分内容：
  // 中段 GeneratingBody 是单一 Markdown 容器，段落间 \n\n 在 textContent 里保留为 \n，
  // 而完成态各卡片拼接不含换行——两侧都归一化去掉换行后再比较。完整正文应更长且含该中间片段。
  const fullText = (await assistantContent.allTextContents()).join("").replace(/\n+/g, "");
  const earlyNorm = earlyText.replace(/\n+/g, "");
  expect(fullText.length).toBeGreaterThan(earlyNorm.length);
  expect(fullText).toContain(earlyNorm.trim());

  // 完成状态：aria-live 播报，不弹成功提示
  await expect(page.locator("[aria-live=polite]")).toHaveText("已完成", { timeout: 15_000 });

  // 阶段 E 决策（2026-07-30）后联网搜索默认关闭：完成后材料范围说明如实呈现未联网。
  await expect(page.getByTestId("grounding-scope-note")).toHaveText("本轮未请求联网。");

  // 完成的回答按确定性段落块渲染，块 ID 与选区锚点同源
  const blocks = page.locator(".message--assistant [data-block-id]");
  expect(await blocks.count()).toBeGreaterThan(0);
  await expect(blocks.first()).toHaveAttribute("data-block-id", /#p0$/);

  // 模型状态点已加载并明确标识当前模式（e2e 假模型按未配置外的状态显示，具体文案由接口决定）
  await expect(page.locator(".model-status")).toBeVisible();

  // 网络契约：统一节点页 POST /v1/research-nodes/:id/messages 携带幂等键；events 响应为 text/event-stream
  const postMessage = apiRequests.find(
    (request) => request.method === "POST" && /\/v1\/research-nodes\/[^/]+\/messages/.test(request.url),
  );
  expect(postMessage?.headers["idempotency-key"]).toBeTruthy();
  const eventsResponse = apiResponses.find((response) => /\/v1\/research-tasks\/[^/]+\/events/.test(response.url));
  expect(eventsResponse?.contentType).toContain("text/event-stream");

  expect(consoleIssues, `浏览器控制台不应有错误和警告: ${consoleIssues.join(" | ")}`).toEqual([]);
});

test("刷新页面恢复同一会话与完整内容", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  const sessionId = await submitFirstQuestion(page);
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });

  await page.reload();

  expect(page.url()).toContain(`/nodes/${sessionId}`);
  await expect(page.getByRole("heading", { name: "什么是本地优先研究" })).toBeVisible();
  await expect(page.getByText(QUESTION, { exact: true })).toBeVisible();
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });
  await expect(page.locator(".message--assistant")).toHaveCount(1);
});

test("侧栏会话条目保留样式（回归保护：#40 曾误删 drawer__* 样式）", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  await submitFirstQuestion(page);
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });

  // 刷新让侧栏重新挂载，拉到新创建的会话
  await page.reload();
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });

  // 宽屏固定侧栏：会话条目有块级布局、标题单行省略、时间弱化颜色
  const sessionItem = page.locator(".drawer__session").first();
  await expect(sessionItem).toBeVisible();
  await expect(sessionItem).toHaveCSS("display", "grid");
  const title = page.locator(".drawer__session-title").first();
  await expect(title).toHaveCSS("white-space", "nowrap");
  await expect(title).toHaveCSS("text-overflow", "ellipsis");
  const time = page.locator(".drawer__session-time").first();
  await expect(time).toHaveCSS("color", "rgb(107, 113, 104)");
});

test("关闭页面后重新打开自动恢复最近会话", async ({ page, context }) => {
  await pairAndOpen(page, "/research/new");
  await submitFirstQuestion(page);
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });

  const reopened = await context.newPage();
  await reopened.goto("/");
  await reopened.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  await expect(reopened.getByText(QUESTION, { exact: true })).toBeVisible();
  await expect(reopened.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });
  await reopened.close();
});

test("创建响应丢失后重试恢复同一会话", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  const creationKeys: string[] = [];
  let dropFirstResponse = true;
  await page.route("**/v1/research-sessions", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    creationKeys.push(route.request().headers()["idempotency-key"] ?? "");
    if (!dropFirstResponse) {
      await route.continue();
      return;
    }
    dropFirstResponse = false;
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    await route.abort("failed");
  });

  await page.getByLabel("你的问题").fill(QUESTION);
  await page.getByRole("button", { name: "开始研究" }).click();
  await expect(page.getByText("连接失败，请重试。")).toBeVisible();
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });

  expect(creationKeys).toHaveLength(2);
  expect(creationKeys[0]).toBeTruthy();
  expect(creationKeys[1]).toBe(creationKeys[0]);
  const sessionId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
  const dataDir = await readDataDir(apiPortForPage(page));
  const sessions = readResearchTables(join(dataDir, "collector.sqlite")).sessions
    .filter((session) => session.creationIdempotencyKey === creationKeys[0]);
  expect(sessions).toEqual([{ id: sessionId, creationIdempotencyKey: creationKeys[0] }]);
});

test("快速双击发送只创建一个任务", async ({ page }) => {
  const sessionCreates: string[] = [];
  const messagePosts: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (/\/v1\/research-sessions$/.test(request.url())) sessionCreates.push(request.url());
    if (/\/v1\/research-nodes\/[^/]+\/messages$/.test(request.url())) messagePosts.push(request.url());
  });

  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill(QUESTION);
  await page.getByRole("button", { name: "开始研究" }).dblclick();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });

  await expect(page.getByText(QUESTION, { exact: true })).toBeVisible();
  await expect(page.locator(".message--assistant")).toHaveCount(1);

  const sessionId = page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
  const view = await apiJson<SessionView>(page, `/v1/research-sessions/${sessionId}`);
  expect(view.tasks).toHaveLength(1);
  expect(sessionCreates, "创建会话请求只应发出一次").toHaveLength(1);
  expect(messagePosts, "提交消息请求只应发出一次").toHaveLength(1);
});

test("键盘完成侧栏收起与展开、输入与发送", async ({ page }) => {
  // 宽屏固定侧栏默认展开：键盘触发侧栏内部「收起侧栏」收成窄 rail，再用「展开侧栏」重新展开
  await page.setViewportSize({ width: 1024, height: 800 });
  await pairAndOpen(page, "/research/new");

  const nav = page.getByRole("navigation", { name: "内容导航" });
  await expect(nav).toBeVisible();
  // 「最近研究」标题只在展开态出现（不依赖会话是否存在的空态文案，harness 可能已累积会话）
  await expect(nav.getByText("最近研究")).toBeVisible();

  const collapseTrigger = nav.getByRole("button", { name: "收起侧栏" });
  await collapseTrigger.focus();
  await page.keyboard.press("Enter");
  await expect(nav.getByText("最近研究")).toBeHidden();
  await expect(nav.getByRole("button", { name: "展开侧栏" })).toBeVisible();

  const expandTrigger = nav.getByRole("button", { name: "展开侧栏" });
  await expandTrigger.focus();
  await page.keyboard.press("Enter");
  await expect(nav.getByText("最近研究")).toBeVisible();

  const textarea = page.getByLabel("你的问题");
  await textarea.focus();
  await page.keyboard.type("用键盘提交的问题");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  // 提交的消息出现在消息流中（会话标题已自动提炼为同一问题文本，须限定在消息列表内避免歧义）
  await expect(page.locator(".message--user .message__content").getByText("用键盘提交的问题", { exact: true })).toBeVisible();
});

test("320/768/1024/1440 视口无横向溢出并留截图", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  await submitFirstQuestion(page);
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });

  mkdirSync("e2e-artifacts", { recursive: true });
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    // 视口切换后等浏览器完成响应式重排再量。setViewportSize → 媒体查询 change → React 多次提交
    // （mode 翻转 → setCollapsed effect）→ 样式重算 → 重排，全程异步；低负载立即量即终态，
    // 高负载下会捕到重排前的瞬时 scrollWidth（如 320px 下仍见上一档 264px 内联宽刚清除、布局未重算）。
    // 先等左侧栏到达该断点的结构性目标宽度（窄屏收起 rail=64px / 宽屏展开≥MIN），再等 scrollWidth
    // 收敛进视口，最后断最终值——结构性等待比单纯轮询 scrollWidth 更能避开读到的中间过渡帧。
    await page.waitForFunction(
      (w) => {
        const drawer = document.querySelector(".drawer.side-drawer");
        if (!drawer) return true;
        const dw = drawer.getBoundingClientRect().width;
        return w < 900 ? dw <= 64 : dw >= 208;
      },
      width,
      { timeout: 10_000 },
    );
    await page.waitForFunction(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      undefined,
      { timeout: 5_000 },
    );
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(metrics.scrollWidth, `视口 ${width}px 不应横向溢出`).toBeLessThanOrEqual(metrics.clientWidth + 1);
    if (width < 900) {
      // 窄屏：左侧栏为常驻窄 rail（收起态可见）
      const nav = page.getByRole("navigation", { name: "内容导航" });
      await expect(nav).toBeVisible();
      await expect(nav.getByRole("button", { name: "展开侧栏" })).toBeVisible();
    } else {
      // 宽屏：左侧固定侧栏默认展开（#56 已移除右侧常驻标记栏，不再存在标记区可断言）
      await expect(page.getByRole("navigation", { name: "内容导航" })).toBeVisible();
    }
    await page.screenshot({ path: `e2e-artifacts/viewport-${width}.png`, fullPage: true });
  }
});

test("开始页显示占位 logo 与居中输入区并留截图", async ({ page }) => {
  await pairAndOpen(page, "/research/new");

  await expect(page.locator(".page__logo")).toBeVisible();
  await expect(page.getByRole("heading", { name: "从一个问题开始" })).toBeVisible();
  await expect(page.getByLabel("你的问题")).toBeVisible();
  await expect(page.getByRole("button", { name: /添加附件（TXT、Markdown、DOCX、PDF/ })).toBeVisible();
  // 标题、说明与输入区整体水平居中
  const center = await page.locator(".page--start").evaluate((element) => getComputedStyle(element).textAlign);
  expect(center).toBe("center");

  await page.setViewportSize({ width: 1440, height: 800 });
  mkdirSync("e2e-artifacts", { recursive: true });
  await page.screenshot({ path: "e2e-artifacts/start-page-1440.png", fullPage: true });
});

test("界面、API 与 SQLite 记录一致", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  const sessionId = await submitFirstQuestion(page);
  const assistantContent = page.locator(".message--assistant .message__content");
  await expect(assistantContent.last()).toContainText("回答完毕", { timeout: 15_000 });
  await expect(page.locator("[aria-live=polite]")).toHaveText("已完成", { timeout: 15_000 });
  // 生成自由化后一条回答渲染为多张切片卡片（各含一个 .message__content 块），
  // 渲染丢弃段落间的 \n\n 分隔；拼接所有块文本并与去掉换行的持久化正文比对。
  const uiText = (await assistantContent.allTextContents()).join("");

  const view = await apiJson<SessionView>(page, `/v1/research-sessions/${sessionId}`);
  expect(view.messages).toHaveLength(2);
  expect(view.messages[1].content.replace(/\n+/g, "")).toBe(uiText);
  expect(view.messages[1].status).toBe("completed");
  expect(view.tasks).toHaveLength(1);
  expect(view.tasks[0].status).toBe("completed");

  const dataDir = await readDataDir(apiPortForPage(page));
  const tables = readResearchTables(join(dataDir, "collector.sqlite"));
  const messageRows = tables.messages.filter((row) => row.sessionId === sessionId);
  expect(messageRows).toHaveLength(2);
  const assistantRow = messageRows.find((row) => row.role === "assistant");
  expect(assistantRow?.status).toBe("completed");
  const record = JSON.parse(assistantRow?.recordJson ?? "{}") as { content?: string };
  // 持久化正文含 \n\n 段落分隔，UI 渲染丢弃；统一去掉换行后与拼接的 UI 文本一致。
  expect(record.content?.replace(/\n+/g, "")).toBe(uiText);

  const taskRows = tables.tasks.filter((row) => row.sessionId === sessionId);
  expect(taskRows).toHaveLength(1);
  expect(taskRows[0].status).toBe("completed");
  expect(Number(taskRows[0].retryable)).toBe(0);

  const eventRows = tables.events.filter((row) => row.taskId === taskRows[0].id);
  expect(eventRows.some((row) => row.eventType === "delta")).toBe(true);
  expect(eventRows.some((row) => row.eventType === "completed")).toBe(true);
});
