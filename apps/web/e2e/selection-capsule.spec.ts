/**
 * 浮动胶囊与引用闭环端到端（修订一 #9，#11 收口边界场景）：假模型（E2E_MODEL=fake）确定性分析。
 * 覆盖：AI 回答选区 → 浮动胶囊出现在选区上方 → 点击【引用】完成引用（输入框呈现引用态）
 * → 死循环回归：聚焦输入框 / 输入文字 / 原生选区坍缩均不影响引用 → 模式一就地追问
 * → 模式二创建子节点并导航 → 点击选取以外区域关闭选区与胶囊、Escape 无关闭效果
 * → 刷新后 ?sel= 恢复引用态 → 键盘操作 → SQLite 一致 → 控制台与网络无异常。
 * 修订一 #11 补充：?sel= 恢复后浮动胶囊呈现在高亮标记上方、引用后焦点回归输入框、
 * 新选区切换胶囊；浮动胶囊键盘可达（聚焦【引用】、Enter 引用、Escape 无效）；
 * 窄屏（320×568）胶囊钳制视口、上方空间不足翻转至选区下方。
 */
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  apiJson,
  apiPortForPage,
  pairAndOpen,
  readDataDir,
  readResearchNodeTables,
  readResearchSelectionTables,
  selectAnswerText,
} from "./helpers";

const QUESTION = "什么是本地优先研究？";

async function submitFirstQuestion(page: Page, question = QUESTION): Promise<string> {
  await page.getByLabel("你的问题").fill(question);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  return page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
}

function watchConsole(page: Page): string[] {
  const issues: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") issues.push(message.text());
  });
  page.on("pageerror", (error) => issues.push(error.message));
  return issues;
}

test.describe("浮动胶囊与引用闭环（修订一 #9）", () => {
  test("选区 → 浮动胶囊 → 引用 → 聚焦输入框引用不消失（死循环回归）→ 在此追问 → SQLite 一致", async ({
    page,
  }) => {
    await pairAndOpen(page, "/research/new");
    // 配对前未带凭证的探测请求会返回 401 并被 Chromium 记为资源加载错误，属于预期流程
    const consoleIssues = watchConsole(page);
    const sessionId = await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    // 选中一段回答文字：浮动胶囊出现在选区上方，此时还没有引用态胶囊
    const selected = "本地优先会先把输入保存在本机";
    await selectAnswerText(page, selected);
    const floating = page.getByTestId("floating-selection-capsule");
    await expect(floating).toBeVisible();
    await expect(page.getByTestId("selection-capsule")).toHaveCount(0);
    // 旧面板不再出现
    await expect(page.getByTestId("selection-insight-panel")).toHaveCount(0);

    // 点击【引用】：浮动胶囊关闭，输入框区域呈现引用态（文本截取 + 移除按钮）
    await page.getByTestId("floating-capsule-cite").click();
    await expect(floating).toBeHidden();
    const capsule = page.getByTestId("selection-capsule");
    await expect(capsule).toBeVisible();
    await expect(capsule).toContainText(selected);

    // 死循环回归：聚焦输入框并输入文字——原生选区坍缩不影响引用
    const textarea = page.getByLabel("你的问题");
    await textarea.click();
    await textarea.fill("这段机制怎么工作？");
    await expect(capsule).toBeVisible();
    await expect(capsule).toContainText(selected);

    // 双模按钮可见；模式一：在此追问
    const askButton = page.getByRole("button", { name: "在此追问" });
    const growButton = page.getByRole("button", { name: "深入研究这段" });
    await expect(askButton).toBeVisible();
    await expect(growButton).toBeVisible();
    await askButton.click();

    // 消息进入当前节点对话流：用户消息出现在消息列表中，选区原文以引用格式嵌入
    await expect(page.locator(".message--user").last()).toContainText("这段机制怎么工作？", {
      timeout: 10_000,
    });
    await expect(page.locator(".message--user").last()).toContainText(selected);
    // AI 回答开始生成
    await expect(page.locator(".message--assistant").last()).toBeVisible({ timeout: 15_000 });
    // 引用态胶囊消失（发送后自动移除引用）
    await expect(capsule).toBeHidden();

    // SQLite：选区记录与节点消息一致
    const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
    const selections = readResearchSelectionTables(dbPath);
    expect(selections.selections.filter((r) => r.sessionId === sessionId)).toHaveLength(1);

    const nodes = readResearchNodeTables(dbPath);
    // 只有根节点，没有新增子节点（在此追问不产生新结构）
    expect(nodes.nodes.filter((n) => n.sessionId === sessionId)).toHaveLength(1);

    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });

  test("点击选取文字以外的屏幕区域关闭选区与浮动胶囊；Escape 无关闭效果", async ({ page }) => {
    await pairAndOpen(page, "/research/new");
    await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    await selectAnswerText(page, "本地优先会先把输入保存在本机");
    const floating = page.getByTestId("floating-selection-capsule");
    await expect(floating).toBeVisible();

    // Escape 无任何关闭效果
    await page.keyboard.press("Escape");
    await expect(floating).toBeVisible();

    // 点击选取文字以外的区域：原生选区坍缩，浮动胶囊关闭，且从未产生引用
    await page.locator(".session-header").click();
    await expect(floating).toBeHidden();
    await expect(page.getByTestId("selection-capsule")).toHaveCount(0);
    const collapsed = await page.evaluate(() => {
      const selection = window.getSelection();
      return !selection || selection.rangeCount === 0 || selection.isCollapsed;
    });
    expect(collapsed).toBe(true);
  });

  test("选区 → 引用 → 深入研究这段 → 创建子节点并导航 → 节点页呈现", async ({ page }) => {
    await pairAndOpen(page, "/research/new");
    const consoleIssues = watchConsole(page);
    const sessionId = await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    const selected = "本地优先会先把输入保存在本机";
    await selectAnswerText(page, selected);
    await page.getByTestId("floating-capsule-cite").click();
    await expect(page.getByTestId("selection-capsule")).toBeVisible();

    // 模式二：深入研究这段（不输入 query）
    await page.getByRole("button", { name: "深入研究这段" }).click();

    // 导航到子节点页
    await page.waitForURL(
      (url) => {
        const match = url.pathname.match(/^\/nodes\/([^/]+)$/);
        return Boolean(match && match[1] && match[1] !== sessionId);
      },
      { timeout: 10_000 },
    );
    // 子节点第一轮回答可见（假模型确定性文案）
    await expect(page.getByText(/这是深入研究第一轮/)).toBeVisible({ timeout: 15_000 });

    // SQLite：新增子节点
    const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
    const { nodes } = readResearchNodeTables(dbPath);
    const sessionNodes = nodes.filter((n) => n.sessionId === sessionId);
    expect(sessionNodes).toHaveLength(2); // 根 + 子
    const childNode = sessionNodes.find((n) => n.parentNodeId);
    expect(childNode).toBeTruthy();
    expect(childNode?.originSelectionId).toBeTruthy();

    expect(consoleIssues, consoleIssues.join(" | ")).toEqual([]);
  });

  test("选区 → 引用 → 深入研究这段（带 query）→ query 进入子节点请求", async ({ page }) => {
    await pairAndOpen(page, "/research/new");
    const sessionId = await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    await selectAnswerText(page, "本地优先会先把输入保存在本机");
    await page.getByTestId("floating-capsule-cite").click();
    await expect(page.getByTestId("selection-capsule")).toBeVisible();

    // 输入追问方向后再点击"深入研究这段"
    await page.getByLabel("你的问题").fill("把本地优先的边界讲透");
    await page.getByRole("button", { name: "深入研究这段" }).click();

    await page.waitForURL(
      (url) => {
        const match = url.pathname.match(/^\/nodes\/([^/]+)$/);
        return Boolean(match && match[1] && match[1] !== sessionId);
      },
      { timeout: 10_000 },
    );
    await expect(page.getByText(/这是深入研究第一轮/)).toBeVisible({ timeout: 15_000 });
  });

  test("重新选取另一段文字时引用更新为新选区", async ({ page }) => {
    await pairAndOpen(page, "/research/new");
    await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    await selectAnswerText(page, "本地优先会先把输入保存在本机");
    await page.getByTestId("floating-capsule-cite").click();
    const capsule = page.getByTestId("selection-capsule");
    await expect(capsule).toBeVisible();
    await expect(capsule).toContainText("本地优先会先把输入保存在本机");

    // 重新选取另一段文字（另一段落）：浮动胶囊再次出现，引用后输入框胶囊更新为新选区
    const second = "渐进事件把后续内容写进同一条消息";
    await selectAnswerText(page, second);
    await expect(page.getByTestId("floating-selection-capsule")).toBeVisible();
    await page.getByTestId("floating-capsule-cite").click();
    await expect(capsule).toContainText(second);
  });

  test("刷新后 ?sel= 恢复：只读定位提醒——高亮呈现、持续可见、不重开浮动胶囊（#48/#50）", async ({ page }) => {
    await pairAndOpen(page, "/research/new");
    const sessionId = await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    // 创建选区并引用
    await selectAnswerText(page, "本地优先会先把输入保存在本机");
    await page.getByTestId("floating-capsule-cite").click();
    await expect(page.getByTestId("selection-capsule")).toBeVisible();

    // 通过深入研究创建子节点（这样选区记录会在数据库中，来源返回可以恢复）
    await page.getByRole("button", { name: "深入研究这段" }).click();
    await page.waitForURL(
      (url) => {
        const match = url.pathname.match(/^\/nodes\/([^/]+)$/);
        return Boolean(match && match[1] && match[1] !== sessionId);
      },
      { timeout: 10_000 },
    );

    // 获取选区 id
    const selections = await apiJson<Array<{ id: string }>>(page, `/v1/research-sessions/${sessionId}/selections`);
    expect(selections.length).toBeGreaterThan(0);
    const selId = selections[0]!.id;

    // 返回根节点并携带 ?sel= 参数
    await page.goto(`/nodes/${sessionId}?sel=${selId}`);

    // #48：只读定位提醒——高亮标记呈现，不重开浮动胶囊、不自动创建引用
    await expect(page.locator("[data-selection-mark]")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("floating-selection-capsule")).toHaveCount(0);
    await expect(page.getByTestId("selection-capsule")).toHaveCount(0);
    await expect(page.getByTestId("selection-insight-panel")).toHaveCount(0);
    // #50：定位提醒持续高亮——超过原 1.6s 自动消失时长仍保持可见
    await page.waitForTimeout(2_000);
    await expect(page.locator("[data-selection-mark]")).toBeVisible();
  });

  test("刷新后 ?sel= 恢复：高亮持续可见，下一次框选解除并照常弹胶囊（#50）", async ({ page }) => {
    await pairAndOpen(page, "/research/new");
    const sessionId = await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    // 引用一次使选区持久化（引用即落库，无需创建子节点）
    await selectAnswerText(page, "本地优先会先把输入保存在本机");
    await page.getByTestId("floating-capsule-cite").click();
    await expect(page.getByTestId("selection-capsule")).toBeVisible();

    const selections = await apiJson<Array<{ id: string }>>(page, `/v1/research-sessions/${sessionId}/selections`);
    expect(selections.length).toBeGreaterThan(0);
    const selId = selections[0]!.id;

    // 携带 ?sel= 刷新：高亮标记呈现（定位提醒），不出现恢复浮动胶囊
    await page.goto(`/nodes/${sessionId}?sel=${selId}`);
    const mark = page.locator("[data-selection-mark]");
    await expect(mark).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("floating-selection-capsule")).toHaveCount(0);

    // #50：定位提醒持续高亮——超过原 1.6s 自动消失时长仍保持可见，不自动让位
    await page.waitForTimeout(2_000);
    await expect(mark).toBeVisible();

    // 下一次框选：定位高亮解除，浮动胶囊照常出现（胶囊只由新的手动选区触发）
    await selectAnswerText(page, "渐进事件把后续内容写进同一条消息");
    await expect(mark).toBeHidden();
    await expect(page.getByTestId("floating-selection-capsule")).toBeVisible();
    await expect(page.getByTestId("floating-selection-capsule")).toHaveCount(1);
    await page.getByTestId("floating-capsule-cite").click();
    await expect(page.getByTestId("selection-capsule")).toContainText("渐进事件把后续内容写进同一条消息");
  });

  test("引用态胶囊键盘操作：Escape 不移除，移除按钮可移除", async ({ page }) => {
    await pairAndOpen(page, "/research/new");
    await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    await selectAnswerText(page, "本地优先会先把输入保存在本机");
    await page.getByTestId("floating-capsule-cite").click();
    const capsule = page.getByTestId("selection-capsule");
    await expect(capsule).toBeVisible();

    // 聚焦引用态胶囊后按 Escape：无任何关闭效果（修订一 #9）
    await capsule.focus();
    await expect(capsule).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(capsule).toBeVisible();
    // 旧面板也不出现
    await expect(page.getByTestId("selection-insight-panel")).toHaveCount(0);

    // 显式移除：点击移除按钮
    await capsule.getByRole("button", { name: "移除引用" }).click();
    await expect(capsule).toBeHidden();
  });

  test("浮动胶囊键盘可达：聚焦【引用】、Enter 完成引用且焦点回归输入框；Escape 无效（修订一 #11）", async ({
    page,
  }) => {
    await pairAndOpen(page, "/research/new");
    await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    await selectAnswerText(page, "本地优先会先把输入保存在本机");
    const floating = page.getByTestId("floating-selection-capsule");
    await expect(floating).toBeVisible();

    // Escape 对浮动胶囊无效（复验修订一 #9 约束）
    await page.keyboard.press("Escape");
    await expect(floating).toBeVisible();

    // 【引用】是原生 button（处于 Tab 序列），聚焦后 Enter 触发引用
    const citeButton = page.getByTestId("floating-capsule-cite");
    await citeButton.focus();
    await expect(citeButton).toBeFocused();
    await page.keyboard.press("Enter");

    // 引用完成：输入框呈现引用态，焦点回归输入框（下一步即输入问题）
    const capsule = page.getByTestId("selection-capsule");
    await expect(capsule).toBeVisible();
    await expect(capsule).toContainText("本地优先会先把输入保存在本机");
    await expect(page.getByLabel("你的问题")).toBeFocused();
  });

  test("单字选区也有效：浮动胶囊 → 引用 → 在此追问完整走通（修订一 #10）", async ({ page }) => {
    await pairAndOpen(page, "/research/new");
    const sessionId = await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    // 选中单个字：不再有任何"选区太短"提示，浮动胶囊直接出现
    await selectAnswerText(page, "本");
    await expect(page.getByTestId("selection-quality-hint")).toHaveCount(0);
    await expect(page.getByTestId("floating-selection-capsule")).toBeVisible();

    // 引用单字选区
    await page.getByTestId("floating-capsule-cite").click();
    const capsule = page.getByTestId("selection-capsule");
    await expect(capsule).toBeVisible();
    await expect(capsule).toContainText("本");

    // 双模发送：在此追问完整走通
    await page.getByLabel("你的问题").fill("这个字指什么？");
    await page.getByRole("button", { name: "在此追问" }).click();
    await expect(page.locator(".message--user").last()).toContainText("这个字指什么？", {
      timeout: 10_000,
    });
    // 选区原文以引用格式嵌入（Markdown 块引用渲染后仍含原文）
    await expect(page.locator(".message--user").last()).toContainText("本");
    // 发送后引用态胶囊消失
    await expect(capsule).toBeHidden();

    // 选区记录落库
    const selections = await apiJson<Array<{ text: string }>>(page, `/v1/research-sessions/${sessionId}/selections`);
    expect(selections).toHaveLength(1);
    expect(selections[0]?.text).toBe("本");
  });
});

test.describe("窄屏钳制（修订一 #11）", () => {
  test.use({ viewport: { width: 320, height: 568 } });

  test("胶囊横向钳制在视口内，引用流程照常可用", async ({ page }) => {
    await pairAndOpen(page, "/research/new");
    await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    // 窄屏 320px：等左侧常驻窄 rail 收起到 64px 终态再建立选区。页面加载于窄屏时 rail 默认收起，
    // 但收起的多提交 React 更新与重排是异步的——高负载下选区矩形会按未收敛的宽布局量出，
    // 使相对选区定位的胶囊落出视口右缘（与 research-session 视口用例同一测量竞态根因）。
    await page.waitForFunction(
      () => {
        const drawer = document.querySelector(".drawer.side-drawer");
        if (!drawer) return true;
        return drawer.getBoundingClientRect().width <= 64;
      },
      undefined,
      { timeout: 10_000 },
    );
    // 再等正文档点位置跨两帧稳定（无残余重排/滚动），胶囊在选区时一次性读 rect+scrollY 定位，
    // 布局若在选区后才收敛，胶囊就按过期的 rect/scrollY 落位（纵向溢出 568 的同一竞态）。
    await page.waitForFunction(
      () =>
        new Promise<boolean>((resolve) => {
          const anchor = document.querySelector(".message--assistant");
          if (!anchor) return resolve(true);
          const first = anchor.getBoundingClientRect().top;
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              resolve(Math.abs(anchor.getBoundingClientRect().top - first) < 1);
            }),
          );
        }),
      undefined,
      { timeout: 10_000 },
    );

    await selectAnswerText(page, "本地优先会先把输入保存在本机");
    const floating = page.getByTestId("floating-selection-capsule");
    await expect(floating).toBeVisible();
    const box = await floating.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    expect(box!.y + box!.height).toBeLessThanOrEqual(568);

    await page.getByTestId("floating-capsule-cite").click();
    await expect(page.getByTestId("selection-capsule")).toBeVisible();
  });
});

test.describe("上方空间不足翻转（修订一 #11）", () => {
  // 极矮视口使整页内容高于视口：选区可被滚到顶端，上方空间不足 → 胶囊翻转至下方
  test.use({ viewport: { width: 320, height: 240 } });

  test("选区贴近视口顶部、上方空间不足时胶囊翻转至选区下方", async ({ page }) => {
    await pairAndOpen(page, "/research/new");
    await submitFirstQuestion(page);
    await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
      timeout: 15_000,
    });

    // 先把目标文字滚到视口顶端附近（留 4px），再建立选区触发捕获——
    // 定位计算在 mouseup 时进行，上方空间不足 → 翻转至选区下方
    const selectionRect = await page.evaluate((target) => {
      // 多张切片卡片各有一个 data-block-text 块，目标文字可能在任意一张，遍历所有块。
      const blocks = Array.from(document.querySelectorAll(".message--assistant [data-block-text]"));
      if (!blocks.length) throw new Error("未找到 AI 回答块");
      let foundNode: Text | null = null;
      let foundOffset = -1;
      for (const block of blocks) {
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
        while (walker.nextNode()) {
          const node = walker.currentNode as Text;
          const offset = node.data.indexOf(target);
          if (offset >= 0) {
            foundNode = node;
            foundOffset = offset;
            break;
          }
        }
        if (foundNode) break;
      }
      if (!foundNode || foundOffset < 0) throw new Error(`回答中未找到「${target}」`);
      const probe = document.createRange();
      probe.setStart(foundNode, foundOffset);
      probe.setEnd(foundNode, foundOffset + target.length);
      const before = probe.getBoundingClientRect();
      window.scrollBy({ top: before.top - 4, behavior: "instant" });
      const selection = window.getSelection();
      if (!selection) throw new Error("浏览器不支持 Selection");
      selection.removeAllRanges();
      selection.addRange(probe);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return probe.getBoundingClientRect();
    }, "本地优先会先把输入保存在本机");

    const floating = page.getByTestId("floating-selection-capsule");
    await expect(floating).toBeVisible();
    const box = await floating.boundingBox();
    expect(box).toBeTruthy();
    // 顶边在选区底边之下（翻转到下方），且仍不溢出视口
    expect(box!.y).toBeGreaterThanOrEqual(selectionRect.bottom - 4);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    expect(box!.y + box!.height).toBeLessThanOrEqual(568);
  });
});
