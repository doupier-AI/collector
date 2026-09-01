import { expect, test, type Page } from "@playwright/test";
import type { ResearchTaskRecord } from "@collector/capture-contracts";
import {
  pairAndOpen,
  performAcceptedJsonAction,
  trackBrowserIssues,
  waitForTaskAttemptTerminalAndUi,
} from "./helpers";

const QUESTION = "什么是本地优先研究？";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

async function submitQuestion(page: Page, question = QUESTION): Promise<string> {
  await page.getByLabel("你的问题").fill(question);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  return page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
}

test("复制：AI 回答复制到剪贴板并显示已复制反馈", async ({ page }) => {
  const browserIssues = trackBrowserIssues(page);
  await pairAndOpen(page, "/research/new");
  await submitQuestion(page);
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", { timeout: 15_000 });

  // 消息视觉契约：不显示角色标签；用户气泡与操作靠右；AI 卡片不再绘制左侧来源线/圆点。
  await expect(page.locator(".message__role")).toHaveCount(0);
  const userMessage = page.locator(".message--user");
  const userBubble = userMessage.locator(".message-user-bubble");
  const userActions = userMessage.locator(".message-actions--user");
  const [userMessageBox, userBubbleBox, userActionsBox] = await Promise.all([
    userMessage.boundingBox(),
    userBubble.boundingBox(),
    userActions.boundingBox(),
  ]);
  expect(userMessageBox && userBubbleBox && userActionsBox).toBeTruthy();
  expect(Math.abs((userBubbleBox!.x + userBubbleBox!.width) - (userMessageBox!.x + userMessageBox!.width))).toBeLessThan(2);
  expect(Math.abs((userActionsBox!.x + userActionsBox!.width) - (userBubbleBox!.x + userBubbleBox!.width))).toBeLessThan(2);

  const assistant = page.locator(".message--assistant");
  const assistantDecoration = await assistant.evaluate((element) => ({
    before: getComputedStyle(element, "::before").content,
    after: getComputedStyle(element, "::after").content,
    paddingLeft: getComputedStyle(element).paddingLeft,
  }));
  expect(assistantDecoration).toEqual({ before: "none", after: "none", paddingLeft: "0px" });

  const userCopy = userMessage.getByRole("button", { name: "复制" });
  await expect(userCopy.locator("svg")).toHaveCount(1);
  await expect(userCopy).toHaveAttribute("data-tooltip", "复制");
  await userCopy.hover();
  await expect.poll(() => userCopy.evaluate((element) => getComputedStyle(element, "::after").opacity)).toBe("1");

  // 消息列表里用户消息也有复制按钮：定位 AI 消息内的按钮。
  const assistantCopy = assistant.getByRole("button", { name: "复制" });
  const assistantCard = assistant.locator(".turn-card");
  const assistantActions = assistant.locator(".message-actions");
  const [assistantCardBox, assistantActionsBox] = await Promise.all([assistantCard.boundingBox(), assistantActions.boundingBox()]);
  expect(assistantCardBox && assistantActionsBox).toBeTruthy();
  expect(Math.abs((assistantActionsBox!.x + assistantActionsBox!.width) - (assistantCardBox!.x + assistantCardBox!.width))).toBeLessThan(2);
  await expect(assistantCopy.locator("svg")).toHaveCount(1);
  await assistantCopy.click();
  await expect(assistant.getByRole("button", { name: "已复制" })).toBeVisible();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain("你问的是");
  expect(clipboard).toContain("回答完毕");
  expect(browserIssues.issues, browserIssues.issues.join("\n")).toEqual([]);
});

test("重新生成：第二版内容替换展示，旧版可经左右箭头回看", async ({ page }) => {
  const browserIssues = trackBrowserIssues(page);
  await pairAndOpen(page, "/research/new");
  await submitQuestion(page);
  const content = page.locator(".message--assistant .message__content");
  await expect(content.last()).toContainText("回答完毕", { timeout: 15_000 });

  // 重新生成：第二版内容落位（假模型第二次生成带「第二版」标识）。
  await page.getByRole("button", { name: "重新生成" }).click();
  await expect(page.locator("[aria-live=polite]")).toHaveText("正在重新生成");
  await expect(page.locator("[aria-live=polite]")).toHaveText("已完成", { timeout: 15_000 });
  await expect(content.last()).toContainText("第二版渐进事件", { timeout: 15_000 });

  // 版本切换：2/2，左箭头看旧版（第一版内容），回最新。
  const switcher = page.getByRole("group", { name: "回答版本" });
  await expect(switcher).toBeVisible();
  await expect(switcher).toContainText("2/2");
  const footer = page.locator(".message--assistant .message-footer--with-versions");
  const footerActions = footer.locator(".message-actions");
  const [switcherBox, footerActionsBox] = await Promise.all([switcher.boundingBox(), footerActions.boundingBox()]);
  expect(switcherBox && footerActionsBox).toBeTruthy();
  expect(Math.abs((switcherBox!.y + switcherBox!.height / 2) - (footerActionsBox!.y + footerActionsBox!.height / 2))).toBeLessThan(2);
  expect(switcherBox!.x).toBeLessThan(footerActionsBox!.x);
  await page.getByRole("button", { name: "上一个版本" }).click();
  // 旧版渲染在独立只读容器 .message__version，不含最新正文。
  await expect(page.locator(".message__version")).toContainText("渐进事件把后续内容写进同一条消息", { timeout: 5_000 });
  await expect(page.locator(".message__version")).not.toContainText("第二版");
  await page.getByRole("button", { name: "回到最新版本" }).click();
  await expect(content.last()).toContainText("第二版渐进事件");
  await expect(page.locator(".message__version")).toHaveCount(0);
  expect(browserIssues.issues, browserIssues.issues.join("\n")).toEqual([]);
});

test("重新编辑：改写问题后新回答直接替换旧回答，不显示版本切换", async ({ page }) => {
  const browserIssues = trackBrowserIssues(page);
  const taskEventRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/v1\/research-tasks\/[^/]+\/events(?:\?|$)/.test(request.url())) taskEventRequests.push(request.url());
  });
  // 正文已经可读、旧流的终态确认仍在途时，用户也可以立即编辑；
  // 新一轮复用同一 task id，必须主动建立第二条事件订阅。
  let releaseTerminalConfirmation!: () => void;
  let markTerminalConfirmationStarted!: () => void;
  const terminalConfirmationRelease = new Promise<void>((resolve) => { releaseTerminalConfirmation = resolve; });
  const terminalConfirmationStarted = new Promise<void>((resolve) => { markTerminalConfirmationStarted = resolve; });
  let heldTerminalConfirmation = false;
  await page.route(/\/v1\/research-tasks\/[^/?]+$/, async (route) => {
    if (route.request().method() !== "GET" || heldTerminalConfirmation) {
      await route.continue();
      return;
    }
    heldTerminalConfirmation = true;
    markTerminalConfirmationStarted();
    await terminalConfirmationRelease;
    await route.continue();
  });
  await pairAndOpen(page, "/research/new");
  await submitQuestion(page);
  const content = page.locator(".message--assistant .message__content");
  await expect(content.last()).toContainText("回答完毕", { timeout: 15_000 });
  await terminalConfirmationStarted;

  // 编辑用户消息：内联输入框改写问题，保存并重新生成。
  await page.getByRole("button", { name: "重新编辑" }).click();
  const textarea = page.getByLabel("修改问题");
  await textarea.fill("请解释本地优先研究（修改后）");
  const editedTask = await performAcceptedJsonAction<ResearchTaskRecord>(
    page,
    { method: "POST", pathname: /^\/v1\/research-messages\/[^/]+\/edit$/, status: 202 },
    () => page.getByRole("button", { name: "保存并重新生成" }).click(),
  );
  releaseTerminalConfirmation();

  await waitForTaskAttemptTerminalAndUi(page, editedTask, {
    status: "completed",
    liveMessage: "已完成",
    content: { locator: content.last(), text: "第二版渐进事件" },
  });
  // 用户消息显示新问题；回答为第二次生成内容（第二版），直接替换。
  await expect(page.getByText("请解释本地优先研究（修改后）", { exact: true })).toBeVisible();
  expect(taskEventRequests.length).toBeGreaterThanOrEqual(2);
  // 编辑场景不支持查看旧版本：无版本切换器。
  await expect(page.getByRole("group", { name: "回答版本" })).toHaveCount(0);
  expect(browserIssues.issues, browserIssues.issues.join("\n")).toEqual([]);
});
