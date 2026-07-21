import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { apiJson, apiPortForPage, pairAndOpen, readDataDir, readResearchBranchTables, readResearchLaterTables, readResearchSelectionTables } from "./helpers";

const QUESTION = "没有模型时也要保存这句话";

interface TaskView {
  id: string;
  status: string;
  retryable: boolean;
  updatedAt: string;
  error?: { code: string; message: string };
}

test("未配置模型：输入保留、显示失败原因与重试，重试不新增第二条 AI 占位", async ({ page }) => {
  test.setTimeout(45_000);
  await pairAndOpen(page, "/research/new");

  await page.getByLabel("你的问题").fill(QUESTION);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/research\/(?!new$)[^/]+$/, { timeout: 10_000 });
  const sessionId = page.url().split("/research/")[1];

  // 用户输入仍在会话中，AI 区域显示失败卡与可理解原因
  await expect(page.getByText(QUESTION, { exact: true })).toBeVisible();
  await expect(page.getByText("内容已保存，暂时无法生成回答")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/还没有配置可用模型/)).toBeVisible();
  await expect(page.locator(".message--assistant")).toHaveCount(1);

  const task = await apiJson<TaskView>(page, `/v1/research-sessions/${sessionId}`).then(
    (view) => (view as { tasks: TaskView[] }).tasks[0],
  );
  expect(task.status).toBe("failed");
  expect(task.retryable).toBe(true);
  expect(task.error?.code).toBe("model_not_configured");

  // 点击重试：后端重新排队后仍失败，界面仍是失败态，且不出现第二条 AI 消息
  await page.getByRole("button", { name: "重试" }).click();
  await expect
    .poll(
      async () => {
        const latest = await apiJson<TaskView>(page, `/v1/research-tasks/${task.id}`);
        return latest.status === "failed" && latest.updatedAt !== task.updatedAt;
      },
      { timeout: 15_000, intervals: [200, 500, 1000] },
    )
    .toBe(true);

  await expect(page.getByText("内容已保存，暂时无法生成回答")).toBeVisible();
  await expect(page.locator(".message--assistant")).toHaveCount(1);
  await expect(page.getByText(QUESTION, { exact: true })).toBeVisible();
});

interface SelectionView {
  id: string;
  text: string;
  status: string;
}

test("未配置模型：选区仍然保存，分析失败给出原因与可重试，原文与结束操作不受影响", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await pairAndOpen(page, "/research/new");

  // 无模型下没有 AI 回答，选区目标走导入阅读内容（导入不依赖模型）
  const createResponse = await page.request.post("/v1/research-sessions", {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: {},
  });
  const created = (await createResponse.json()) as { id: string };
  await page.goto(`/research/${created.id}`);
  await page.locator('input[type="file"]').setInputFiles({
    name: "无模型笔记.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("无模型也要保留选区原文", "utf8"),
  });
  await expect(page.getByText("已导入")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "阅读" }).click();
  await expect(page).toHaveURL(new RegExp(`/research/${created.id}/reading/[^/]+$`));
  await expect(page.getByText("第 1 行")).toBeVisible();

  await page.evaluate(() => {
    const textElement = document.querySelector(".reading__block [data-block-text]");
    if (!textElement?.firstChild) throw new Error("未找到阅读块");
    const node = textElement.firstChild as Text;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, node.data.length);
    const selection = window.getSelection();
    if (!selection) throw new Error("浏览器不支持 Selection");
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });

  // 窗口打开：原文立即可见；分析失败给出原因
  const panel = page.getByTestId("selection-insight-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".selection-panel__quote")).toHaveText("无模型也要保留选区原文");
  await expect(panel.getByText("选区已保存，分析暂时没有完成")).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByText("未配置可用的 AI 模型。选区已保存，配置模型后可以重试分析。")).toBeVisible();

  // 选区已经落库（不因分析失败而丢失）
  const selections = await apiJson<SelectionView[]>(page, `/v1/research-sessions/${created.id}/selections`);
  expect(selections).toHaveLength(1);
  expect(selections[0]?.text).toBe("无模型也要保留选区原文");
  expect(selections[0]?.status).toBe("active");

  // 重试分析：无模型下仍失败，但原文、失败原因与结束操作始终可用
  await panel.getByRole("button", { name: "重试分析" }).click();
  await expect(panel.getByText("选区已保存，分析暂时没有完成")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "结束", exact: true })).toBeEnabled();

  // 任务记录为可重试失败（只读 SQLite 核对）
  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  const tables = readResearchSelectionTables(dbPath);
  const taskRows = tables.selectionTasks.filter((row) => row.sessionId === created.id);
  expect(taskRows).toHaveLength(1);
  expect(taskRows[0]?.status).toBe("failed");
  expect(taskRows[0]?.retryable).toBe(1);
  const taskRecord = JSON.parse(taskRows[0]?.recordJson ?? "{}") as { error?: { code?: string } };
  expect(taskRecord.error?.code).toBe("model_not_configured");

  await page.getByRole("button", { name: "结束", exact: true }).click();
  await expect(panel).toBeHidden();
});

test("未配置模型：分析失败仍可发起深入研究，分支与来源关系保留、第一轮失败可重试", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await pairAndOpen(page, "/research/new");

  // 无模型下走导入阅读内容建立选区（复用上一条测试的路径）
  const createResponse = await page.request.post("/v1/research-sessions", {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: {},
  });
  const created = (await createResponse.json()) as { id: string };
  await page.goto(`/research/${created.id}`);
  await page.locator('input[type="file"]').setInputFiles({
    name: "无模型深入研究.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("无模型也要能发起深入研究并保留来源", "utf8"),
  });
  await expect(page.getByText("已导入")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "阅读" }).click();
  await expect(page).toHaveURL(new RegExp(`/research/${created.id}/reading/[^/]+$`));
  await expect(page.getByText("第 1 行")).toBeVisible({ timeout: 15_000 });

  await page.evaluate(() => {
    const textElement = document.querySelector(".reading__block [data-block-text]");
    if (!textElement?.firstChild) throw new Error("未找到阅读块");
    const node = textElement.firstChild as Text;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, node.data.length);
    const selection = window.getSelection();
    if (!selection) throw new Error("浏览器不支持 Selection");
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });

  // 分析失败，但深入研究操作持续可用
  const panel = page.getByTestId("selection-insight-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("选区已保存，分析暂时没有完成")).toBeVisible({ timeout: 15_000 });
  await panel.getByRole("button", { name: "深入研究" }).click();
  const chooser = page.getByTestId("deep-research-chooser");
  await expect(chooser).toBeVisible();
  await panel.getByRole("button", { name: "开始深入研究" }).click();

  // 分支视图：来源关系先于生成保存，第一轮失败给出原因与重试
  await page.waitForURL(new RegExp(`/research/${created.id}/branch/[^/]+$`), { timeout: 10_000 });
  const sourceBar = page.getByTestId("selection-source-bar");
  await expect(sourceBar).toContainText("无模型也要能发起深入研究并保留来源");
  await expect(page.getByText("内容已保存，暂时无法生成回答")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/还没有配置可用模型/)).toBeVisible();

  // 分支与来源选区不因生成失败而丢失
  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  const branchTables = readResearchBranchTables(dbPath);
  expect(branchTables.branches).toHaveLength(1);
  expect(branchTables.branches[0]?.sessionId).toBe(created.id);
  const selectionTables = readResearchSelectionTables(dbPath);
  expect(selectionTables.selections.filter((row) => row.sessionId === created.id)).toHaveLength(1);

  // 重试第一轮：无模型下仍失败，但来源条与失败卡保持可用，不新增分支
  await page.getByRole("button", { name: "重试" }).click();
  await expect(page.getByText("内容已保存，暂时无法生成回答")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("selection-source-bar")).toBeVisible();
  const afterRetry = readResearchBranchTables(dbPath);
  expect(afterRetry.branches).toHaveLength(1);

  // 返回原文：阅读页按锚点高亮原选区
  await sourceBar.getByRole("link", { name: "← 返回原文" }).click();
  await expect(page).toHaveURL(new RegExp(`/research/${created.id}/reading/[^/]+\\?sel=`));
  await expect(page.locator("[data-selection-mark]")).toHaveText("无模型也要能发起深入研究并保留来源", {
    timeout: 10_000,
  });
});

test("未配置模型：分析失败仍可保存稍后再学，栏目呈现并能返回原选区", async ({ page }) => {
  test.setTimeout(60_000);
  await pairAndOpen(page, "/research/new");

  // 无模型下走导入阅读内容建立选区（导入与保存均不依赖模型）
  const createResponse = await page.request.post("/v1/research-sessions", {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: {},
  });
  const created = (await createResponse.json()) as { id: string };
  await page.goto(`/research/${created.id}`);
  await page.locator('input[type="file"]').setInputFiles({
    name: "无模型稍后再学.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("无模型也要能保存稍后再学", "utf8"),
  });
  await expect(page.getByText("已导入")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "阅读" }).click();
  await expect(page).toHaveURL(new RegExp(`/research/${created.id}/reading/[^/]+$`));
  await expect(page.getByText("第 1 行")).toBeVisible({ timeout: 15_000 });

  await page.evaluate(() => {
    const textElement = document.querySelector(".reading__block [data-block-text]");
    if (!textElement?.firstChild) throw new Error("未找到阅读块");
    const node = textElement.firstChild as Text;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, node.data.length);
    const selection = window.getSelection();
    if (!selection) throw new Error("浏览器不支持 Selection");
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });

  // 分析失败，但稍后再学操作持续可用
  const panel = page.getByTestId("selection-insight-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("选区已保存，分析暂时没有完成")).toBeVisible({ timeout: 15_000 });
  await panel.getByRole("button", { name: "稍后再学" }).click();
  const form = page.getByTestId("later-form");
  await expect(form).toBeVisible();
  // 预填确定性默认概括（不依赖 AI）
  await expect(panel.getByLabel("概括")).toHaveValue("无模型也要能保存稍后再学");
  await panel.locator("label.later-star").filter({ hasText: "4 星" }).click();
  await panel.getByRole("button", { name: "保存" }).click();
  await expect(page.getByTestId("later-saved")).toBeVisible();

  // 右栏即时呈现该项目，稍后再学落库一致
  const summary = "无模型也要能保存稍后再学";
  await expect(page.locator(".later-item", { hasText: summary })).toBeVisible();
  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  const laterItems = readResearchLaterTables(dbPath).laterItems.filter((row) => row.sessionId === created.id);
  expect(laterItems).toHaveLength(1);
  expect(laterItems[0]?.status).toBe("pending");
  expect(laterItems[0]?.priority).toBe(4);
  const selectionTables = readResearchSelectionTables(dbPath);
  const sessionSelections = selectionTables.selections.filter((row) => row.sessionId === created.id);
  expect(laterItems[0]?.selectionId).toBe(sessionSelections[0]?.id);

  // 点击项目返回阅读页原选区并自动重开窗口
  await page.locator(".later-item", { hasText: summary }).locator(".later-item__open").click();
  await expect(page).toHaveURL(new RegExp(`/research/${created.id}/reading/[^/]+\\?sel=`), { timeout: 10_000 });
  await expect(page.locator("[data-selection-mark]")).toHaveText(summary, { timeout: 10_000 });
  await expect(page.getByTestId("selection-insight-panel")).toBeVisible();
});
