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
  // 不能匹配当前所在的 /research/new（Playwright 对当前 URL 会立即放行）
  await page.waitForURL(/\/research\/(?!new$)[^/]+$/, { timeout: 10_000 });
  return page.url().split("/research/")[1];
}

test("首次打开显示开始页与空状态邀请", async ({ page }) => {
  await pairAndOpen(page);

  // 开始页：占位 logo、居中标题与说明、精简输入区（占位提示 + 圆形按钮）
  await expect(page.locator(".page__logo")).toBeVisible();
  await expect(page.getByRole("heading", { name: "从一个问题开始" })).toBeVisible();
  await expect(page.getByText("写下你正在理解的内容，Collector 会保存这次研究，并让你随时回来继续。")).toBeVisible();
  await expect(page.getByLabel("你的问题")).toBeVisible();
  await expect(page.getByRole("button", { name: "开始研究" })).toBeVisible();
  await expect(page.getByRole("button", { name: "添加附件（后续版本提供）" })).toBeVisible();

  // 宽屏（默认 1280px）左右固定侧栏初始展开：左侧内容导航空状态、右侧稍后再学空态
  const nav = page.getByRole("navigation", { name: "内容导航" });
  await expect(nav).toBeVisible();
  await expect(page.getByText(/还没有研究会话/)).toBeVisible();
  await expect(page.getByRole("complementary", { name: "稍后再学" })).toBeVisible();
  await expect(page.getByText("暂无内容")).toBeVisible();

  // 顶栏图标按钮收起再展开
  await page.getByRole("button", { name: "内容" }).click();
  await expect(nav).toBeHidden();
  await page.getByRole("button", { name: "内容" }).click();
  await expect(nav).toBeVisible();
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
  // 状态文字同时存在于消息状态与 sr-only aria-live 区，用 class 限定避免 strict 冲突
  await expect(page.locator(".message__status")).toHaveText("已保存，正在生成");

  // 渐进内容进入同一条 AI 消息
  const assistantMessages = page.locator(".message--assistant");
  const assistantContent = page.locator(".message--assistant .message__content");
  await expect(assistantContent).toContainText("你问的是", { timeout: 15_000 });
  const earlyText = (await assistantContent.textContent()) ?? "";
  await expect(assistantMessages).toHaveCount(1);
  await expect(assistantContent).toContainText("回答完毕", { timeout: 15_000 });
  const fullText = (await assistantContent.textContent()) ?? "";
  await expect(assistantMessages).toHaveCount(1);
  expect(fullText.length).toBeGreaterThan(earlyText.length);
  expect(fullText.startsWith(earlyText)).toBe(true);

  // 完成状态：aria-live 播报，不弹成功提示
  await expect(page.locator("[aria-live=polite]")).toHaveText("已完成", { timeout: 15_000 });

  // 网络契约：POST messages 携带幂等键；events 响应为 text/event-stream
  const postMessage = apiRequests.find(
    (request) => request.method === "POST" && /\/v1\/research-sessions\/[^/]+\/messages/.test(request.url),
  );
  expect(postMessage?.headers["idempotency-key"]).toBeTruthy();
  const eventsResponse = apiResponses.find((response) => /\/v1\/research-tasks\/[^/]+\/events/.test(response.url));
  expect(eventsResponse?.contentType).toContain("text/event-stream");

  expect(consoleIssues, `浏览器控制台不应有错误和警告: ${consoleIssues.join(" | ")}`).toEqual([]);
});

test("刷新页面恢复同一会话与完整内容", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  const sessionId = await submitFirstQuestion(page);
  await expect(page.locator(".message--assistant .message__content")).toContainText("回答完毕", { timeout: 15_000 });

  await page.reload();

  expect(page.url()).toContain(`/research/${sessionId}`);
  await expect(page.getByRole("heading", { name: "新研究会话" })).toBeVisible();
  await expect(page.getByText(QUESTION, { exact: true })).toBeVisible();
  await expect(page.locator(".message--assistant .message__content")).toContainText("回答完毕", { timeout: 15_000 });
  await expect(page.locator(".message--assistant")).toHaveCount(1);
});

test("关闭页面后重新打开自动恢复最近会话", async ({ page, context }) => {
  await pairAndOpen(page, "/research/new");
  await submitFirstQuestion(page);
  await expect(page.locator(".message--assistant .message__content")).toContainText("回答完毕", { timeout: 15_000 });

  const reopened = await context.newPage();
  await reopened.goto("/");
  await reopened.waitForURL(/\/research\/(?!new$)[^/]+$/, { timeout: 10_000 });
  await expect(reopened.getByText(QUESTION, { exact: true })).toBeVisible();
  await expect(reopened.locator(".message--assistant .message__content")).toContainText("回答完毕", { timeout: 15_000 });
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
  await page.waitForURL(/\/research\/(?!new$)[^/]+$/, { timeout: 10_000 });

  expect(creationKeys).toHaveLength(2);
  expect(creationKeys[0]).toBeTruthy();
  expect(creationKeys[1]).toBe(creationKeys[0]);
  const sessionId = page.url().split("/research/")[1];
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
    if (/\/v1\/research-sessions\/[^/]+\/messages$/.test(request.url())) messagePosts.push(request.url());
  });

  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill(QUESTION);
  await page.getByRole("button", { name: "开始研究" }).dblclick();
  await page.waitForURL(/\/research\/(?!new$)[^/]+$/, { timeout: 10_000 });

  await expect(page.getByText(QUESTION, { exact: true })).toBeVisible();
  await expect(page.locator(".message--assistant")).toHaveCount(1);

  const sessionId = page.url().split("/research/")[1];
  const view = await apiJson<SessionView>(page, `/v1/research-sessions/${sessionId}`);
  expect(view.tasks).toHaveLength(1);
  expect(sessionCreates, "创建会话请求只应发出一次").toHaveLength(1);
  expect(messagePosts, "提交消息请求只应发出一次").toHaveLength(1);
});

test("键盘完成侧栏收起与展开、输入与发送", async ({ page }) => {
  // 宽屏固定侧栏默认展开：键盘收起后焦点留在触发按钮，再按一次重新展开
  await page.setViewportSize({ width: 1024, height: 800 });
  await pairAndOpen(page, "/research/new");

  const nav = page.getByRole("navigation", { name: "内容导航" });
  await expect(nav).toBeVisible();

  const trigger = page.getByRole("button", { name: "内容" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(nav).toBeHidden();
  await expect(trigger).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(nav).toBeVisible();

  const textarea = page.getByLabel("你的问题");
  await textarea.focus();
  await page.keyboard.type("用键盘提交的问题");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/research\/(?!new$)[^/]+$/, { timeout: 10_000 });
  await expect(page.getByText("用键盘提交的问题", { exact: true })).toBeVisible();
});

test("320/768/1024/1440 视口无横向溢出并留截图", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  await submitFirstQuestion(page);
  await expect(page.locator(".message--assistant .message__content")).toContainText("回答完毕", { timeout: 15_000 });

  mkdirSync("e2e-artifacts", { recursive: true });
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(metrics.scrollWidth, `视口 ${width}px 不应横向溢出`).toBeLessThanOrEqual(metrics.clientWidth + 1);
    if (width < 900) {
      // 窄屏：侧栏为覆盖抽屉，默认收起
      await expect(page.getByRole("navigation", { name: "内容导航" })).toBeHidden();
      await expect(page.getByRole("complementary", { name: "稍后再学" })).toBeHidden();
    } else {
      // 宽屏：左右固定侧栏默认展开
      await expect(page.getByRole("navigation", { name: "内容导航" })).toBeVisible();
      await expect(page.getByRole("complementary", { name: "稍后再学" })).toBeVisible();
    }
    await page.screenshot({ path: `e2e-artifacts/viewport-${width}.png`, fullPage: true });
  }
});

test("开始页显示占位 logo 与居中输入区并留截图", async ({ page }) => {
  await pairAndOpen(page, "/research/new");

  await expect(page.locator(".page__logo")).toBeVisible();
  await expect(page.getByRole("heading", { name: "从一个问题开始" })).toBeVisible();
  await expect(page.getByLabel("你的问题")).toBeVisible();
  await expect(page.getByRole("button", { name: "添加附件（后续版本提供）" })).toBeVisible();
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
  await expect(assistantContent).toContainText("回答完毕", { timeout: 15_000 });
  await expect(page.locator("[aria-live=polite]")).toHaveText("已完成", { timeout: 15_000 });
  const uiText = (await assistantContent.textContent()) ?? "";

  const view = await apiJson<SessionView>(page, `/v1/research-sessions/${sessionId}`);
  expect(view.messages).toHaveLength(2);
  expect(view.messages[1].content).toBe(uiText);
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
  expect(record.content).toBe(uiText);

  const taskRows = tables.tasks.filter((row) => row.sessionId === sessionId);
  expect(taskRows).toHaveLength(1);
  expect(taskRows[0].status).toBe("completed");
  expect(Number(taskRows[0].retryable)).toBe(0);

  const eventRows = tables.events.filter((row) => row.taskId === taskRows[0].id);
  expect(eventRows.some((row) => row.eventType === "delta")).toBe(true);
  expect(eventRows.some((row) => row.eventType === "completed")).toBe(true);
});
