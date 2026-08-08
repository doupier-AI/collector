import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { apiJson, apiPortForPage, citeCurrentSelection, pairAndOpen, readDataDir, readResearchLaterTables, readResearchNodeTables, readResearchSelectionTables } from "./helpers";

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
  await page.waitForURL(/\/research\/(?!new$)[^/]+\/node\/[^/]+$/, { timeout: 10_000 });
  const sessionId = page.url().split("/research/")[1]?.split("/")[0] ?? "";

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

test("未配置模型：选区仍然保存并出现胶囊，分析在后台失败但不影响用户操作", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await pairAndOpen(page, "/research/new");

  // 无模型下走导入阅读内容建立选区（导入不依赖模型）
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

  // 浮动胶囊【引用】后引用态胶囊出现（修订一 #9：不再弹旧分析面板，分析在后台静默进行）
  const capsule = await citeCurrentSelection(page);
  await expect(capsule).toContainText("无模型也要保留选区原文");
  await expect(page.getByTestId("selection-insight-panel")).toHaveCount(0);

  // 选区已经落库（不因分析失败而丢失）
  const selections = await apiJson<SelectionView[]>(page, `/v1/research-sessions/${created.id}/selections`);
  expect(selections).toHaveLength(1);
  expect(selections[0]?.text).toBe("无模型也要保留选区原文");
  expect(selections[0]?.status).toBe("active");

  // 分析任务在后台失败（SQLite 核对）
  // 等待选区任务完成（后台分析是异步的）
  await expect
    .poll(
      async () => {
        const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
        const tables = readResearchSelectionTables(dbPath);
        const taskRows = tables.selectionTasks.filter((row) => row.sessionId === created.id);
        return taskRows.length > 0 && taskRows[0]?.status !== "queued" && taskRows[0]?.status !== "running";
      },
      { timeout: 15_000, intervals: [200, 500, 1000] },
    )
    .toBe(true);

  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  const tables = readResearchSelectionTables(dbPath);
  const taskRows = tables.selectionTasks.filter((row) => row.sessionId === created.id);
  expect(taskRows).toHaveLength(1);
  expect(taskRows[0]?.status).toBe("failed");
  expect(taskRows[0]?.retryable).toBe(1);
  const taskRecord = JSON.parse(taskRows[0]?.recordJson ?? "{}") as { error?: { code?: string } };
  expect(taskRecord.error?.code).toBe("model_not_configured");

  // 胶囊仍在（分析失败不影响引用）
  await expect(capsule).toBeVisible();
});

test("未配置模型：分析失败仍可通过胶囊发起深入研究，来源关系保留、第一轮失败可重试", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await pairAndOpen(page, "/research/new");

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

  // 浮动胶囊【引用】后（修订一 #9），一键深入研究
  await citeCurrentSelection(page);
  await page.getByRole("button", { name: "深入研究这段" }).click();

  // 子节点视图：来源关系先于生成保存，第一轮失败给出原因与重试
  await page.waitForURL(
    (url) => {
      const match = url.pathname.match(/^\/research\/([^/]+)\/node\/([^/]+)$/);
      return Boolean(match && match[1] === created.id && match[2] && match[2] !== created.id);
    },
    { timeout: 10_000 },
  );
  const sourceBar = page.getByTestId("selection-source-bar");
  await expect(sourceBar).toContainText("无模型也要能发起深入研究并保留来源");
  await expect(page.getByText("内容已保存，暂时无法生成回答")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/还没有配置可用模型/)).toBeVisible();

  // 子节点与来源选区不因生成失败而丢失
  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  const nodeTables = readResearchNodeTables(dbPath);
  const childNodes = nodeTables.nodes.filter((row) => row.sessionId === created.id && row.parentNodeId !== null);
  expect(childNodes).toHaveLength(1);
  expect(childNodes[0]?.sessionId).toBe(created.id);
  expect(childNodes[0]?.parentNodeId).toBe(created.id);
  const selectionTables = readResearchSelectionTables(dbPath);
  expect(selectionTables.selections.filter((row) => row.sessionId === created.id)).toHaveLength(1);

  // 重试第一轮：无模型下仍失败，但来源条与失败卡保持可用，不新增节点
  await page.getByRole("button", { name: "重试" }).click();
  await expect(page.getByText("内容已保存，暂时无法生成回答")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("selection-source-bar")).toBeVisible();
  const afterRetry = readResearchNodeTables(dbPath);
  expect(afterRetry.nodes.filter((row) => row.sessionId === created.id && row.parentNodeId !== null)).toHaveLength(1);

  // 返回原文：阅读页按锚点高亮原选区
  await sourceBar.getByRole("link", { name: "← 返回原文" }).click();
  await expect(page).toHaveURL(new RegExp(`/research/${created.id}/reading/[^/]+\\?sel=`));
  await expect(page.locator("[data-selection-mark]")).toHaveText("无模型也要能发起深入研究并保留来源", {
    timeout: 10_000,
  });
});

test("未配置模型：标记保存后可在列表查看并返回原选区，不依赖 AI", async ({ page }) => {
  test.setTimeout(45_000);
  await pairAndOpen(page, "/research/new");

  const createResponse = await page.request.post("/v1/research-sessions", {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: {},
  });
  const created = (await createResponse.json()) as { id: string };
  await page.goto(`/research/${created.id}`);
  await page.locator('input[type="file"]').setInputFiles({
    name: "无模型标记.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("无模型下也要保存这条标记笔记", "utf8"),
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

  await page.getByTestId("floating-capsule-mark").click();
  const input = page.getByTestId("mark-note-input");
  await expect(input).toBeVisible();
  await input.focus();
  await input.fill("无模型也要保存笔记");
  await page.mouse.click(12, 12);
  await expect(page.getByTestId("mark-note-editor")).toHaveCount(0);

  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  const items = readResearchLaterTables(dbPath).laterItems.filter((row) => row.sessionId === created.id);
  expect(items).toHaveLength(1);
  const item = items[0];
  expect(item).toBeDefined();
  const record = JSON.parse(item?.recordJson ?? "{}") as { note?: string };
  expect(record.note).toBe("无模型也要保存笔记");

  // 标记列表展示原选区、笔记、来源节点与时间，并可返回原文
  const marksPanel = page.getByRole("complementary", { name: "标记" });
  await expect(marksPanel).toBeVisible();
  await expect(marksPanel).toContainText("无模型下也要保存这条标记笔记");
  await expect(marksPanel).toContainText("无模型也要保存笔记");
  await expect(marksPanel).toContainText("来源节点：无模型标记.txt");
  await page.getByTestId(`mark-open-${item!.id}`).click();
  await expect(page).toHaveURL(new RegExp(`/research/${created.id}/reading/[^/]+\\?sel=`));
  await expect(page.locator("[data-selection-mark]")).toHaveText("无模型下也要保存这条标记笔记", { timeout: 10_000 });
  // #48：返回定位是只读临时提醒——不重开浮动胶囊、不进入引用态
  await expect(page.locator('[data-testid="floating-selection-capsule"]')).toHaveCount(0);
  await expect(page.getByTestId("selection-capsule")).toHaveCount(0);
  // #48：定位提醒短暂存在——高亮约 1.6 秒后自动消失
  await expect(page.locator("[data-selection-mark]")).toBeHidden({ timeout: 5_000 });

  // 刷新后列表与高亮仍由持久化记录恢复，且不会自动进入引用态
  await page.reload();
  await expect(marksPanel).toContainText("无模型也要保存笔记");
  await expect(page.locator('[data-testid="floating-selection-capsule"]')).toHaveCount(0);
  await expect(page.getByTestId("selection-capsule")).toHaveCount(0);
});
