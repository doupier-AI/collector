import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { expect, test, type Page } from "@playwright/test";
import { apiJson, apiPortForPage, pairAndOpen, readDataDir, readResearchImportTables } from "./helpers";

// 本文件按字母序最后执行：e2e harness 在每个端口共享同一数据库，
// 这些场景会创建会话与附件，不能影响其他规格对空状态的假设。

interface SessionView {
  session: { id: string; title: string };
  attachments?: Array<{
    id: string;
    fileName: string;
    status: string;
    contentSnapshotId?: string;
  }>;
  importTasks?: Array<{ id: string; status: string; idempotencyKey: string }>;
}

const TXT_CONTENT = ["第一行：本地优先研究", "", "第二段：导入后保留行号", "", "第三段：可以在同一画布阅读"].join("\n");

/** 配对后通过真实 API 创建研究会话并进入会话页（上传属于会话内路径）。 */
async function openFreshSession(page: Page): Promise<string> {
  await pairAndOpen(page, "/research/new");
  const response = await page.request.post("/v1/research-sessions", {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: {},
  });
  expect(response.status()).toBe(201);
  const session = (await response.json()) as { id: string };
  await page.goto(`/nodes/${session.id}`);
  await expect(page.getByRole("button", { name: /添加附件（TXT、Markdown、DOCX、PDF/ })).toBeVisible();
  return session.id;
}

function watchConsole(page: Page): string[] {
  const issues: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") issues.push(message.text());
  });
  page.on("pageerror", (error) => issues.push(String(error)));
  return issues;
}

test("上传 TXT 后显示真实状态、完成并进入阅读视图，界面与 API、SQLite 一致", async ({ page }) => {
  const uploadRequests: Array<{ url: string; headers: Record<string, string> }> = [];
  page.on("request", (request) => {
    if (request.url().includes("/v1/research-sessions/") && request.url().endsWith("/imports")) {
      uploadRequests.push({ url: request.url(), headers: request.headers() });
    }
  });

  const sessionId = await openFreshSession(page);
  const consoleIssues = watchConsole(page);

  await page.locator('input[type="file"]').setInputFiles({
    name: "研究笔记.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(TXT_CONTENT, "utf8"),
  });

  // 附件立即出现，随后真实完成（排队/解析由 SSE 推进，不伪造状态）
  await expect(page.locator(".attachment__name", { hasText: "研究笔记.txt" })).toBeVisible();
  await expect(page.getByText("已导入")).toBeVisible({ timeout: 15_000 });

  // 上传请求符合契约：原始字节、编码文件名、浏览器 MIME、会话内幂等键
  expect(uploadRequests).toHaveLength(1);
  const headers = uploadRequests[0].headers;
  expect(headers["x-file-name"]).toBe(encodeURIComponent("研究笔记.txt"));
  expect(headers["content-type"]).toContain("text/plain");
  expect(headers["idempotency-key"]).toBeTruthy();

  // 阅读入口进入同一画布阅读视图，按行号锚点渲染
  await page.getByRole("button", { name: "阅读" }).click();
  await expect(page).toHaveURL(new RegExp(`/research/${sessionId}/reading/[^/]+$`));
  await expect(page.getByRole("heading", { name: "研究笔记.txt" })).toBeVisible();
  await expect(page.getByText("第 1 行")).toBeVisible();
  await expect(page.getByText(/第一行：本地优先研究/)).toBeVisible();
  await expect(page.getByText("第 5 行")).toBeVisible();

  // 界面、API 与 SQLite 一致
  const view = await apiJson<SessionView>(page, `/v1/research-sessions/${sessionId}`);
  expect(view.attachments).toHaveLength(1);
  expect(view.attachments![0].fileName).toBe("研究笔记.txt");
  expect(view.attachments![0].status).toBe("ready");
  expect(view.attachments![0].contentSnapshotId).toBeTruthy();
  expect(view.importTasks![0].status).toBe("completed");
  expect(JSON.stringify(view)).not.toMatch(/objectPath|object_key|storageKey/);

  const content = await apiJson<{ blocks: Array<{ text: string }> }>(
    page,
    `/v1/research-content/${view.attachments![0].contentSnapshotId}`,
  );
  expect(content.blocks.length).toBeGreaterThanOrEqual(3);

  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  const tables = readResearchImportTables(dbPath);
  const sessionAttachments = tables.attachments.filter((row) => row.sessionId === sessionId);
  const sessionTasks = tables.importTasks.filter((row) => row.sessionId === sessionId);
  const sessionSnapshots = tables.snapshots.filter((row) => row.sessionId === sessionId);
  expect(sessionAttachments).toHaveLength(1);
  expect(sessionAttachments[0].status).toBe("ready");
  expect(sessionTasks).toHaveLength(1);
  expect(sessionTasks[0].status).toBe("completed");
  expect(sessionTasks[0].idempotencyKey).toBe(headers["idempotency-key"]);
  expect(sessionSnapshots).toHaveLength(1);
  expect(sessionSnapshots[0].recordJson).toContain("第一行：本地优先研究");

  expect(consoleIssues).toEqual([]);
});

test("拖放上传完成，刷新与关闭重开后附件与阅读内容一致恢复", async ({ page, context }) => {
  const sessionId = await openFreshSession(page);
  const consoleIssues = watchConsole(page);

  const dataTransfer = await page.evaluateHandle(
    ({ name, content, type }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([content], name, { type }));
      return transfer;
    },
    { name: "拖放笔记.md", content: "# 拖放标题\n\n拖放正文", type: "text/markdown" },
  );
  await page.locator(".page").dispatchEvent("dragenter", { dataTransfer });
  await expect(page.getByText("松开鼠标，把文件导入这场研究")).toBeVisible();
  await page.locator(".page").dispatchEvent("drop", { dataTransfer });

  await expect(page.locator(".attachment__name", { hasText: "拖放笔记.md" })).toBeVisible();
  await expect(page.getByText("已导入")).toBeVisible({ timeout: 15_000 });

  // 刷新：附件与导入状态从服务端视图恢复
  await page.reload();
  await expect(page.locator(".attachment__name", { hasText: "拖放笔记.md" })).toBeVisible();
  await expect(page.getByText("已导入")).toBeVisible();

  // 关闭重开：新页面进入同一会话，状态一致
  const reopened = await context.newPage();
  await reopened.goto(`/nodes/${sessionId}`);
  await expect(reopened.locator(".attachment__name", { hasText: "拖放笔记.md" })).toBeVisible();
  await expect(reopened.getByText("已导入")).toBeVisible();

  // 阅读视图路由直接刷新，内容从稳定快照恢复
  const view = await apiJson<SessionView>(reopened, `/v1/research-sessions/${sessionId}`);
  await reopened.goto(`/research/${sessionId}/reading/${view.attachments![0].contentSnapshotId}`);
  await expect(reopened.getByRole("heading", { name: "拖放笔记.md" })).toBeVisible();
  await expect(reopened.getByRole("heading", { name: "拖放标题", level: 2 })).toBeVisible();
  await reopened.reload();
  await expect(reopened.getByRole("heading", { name: "拖放标题", level: 2 })).toBeVisible();

  expect(consoleIssues).toEqual([]);
});

test("内容与格式不符的文件被服务端拒绝并提示，不创建附件", async ({ page }) => {
  const sessionId = await openFreshSession(page);

  // 纯文本内容声明为 DOCX：服务端上传校验稳定返回 422
  await page.locator('input[type="file"]').setInputFiles({
    name: "损坏.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: Buffer.from("这不是真正的 DOCX 内容", "utf8"),
  });

  await expect(page.getByText("文件内容与声明的格式不符，请确认文件没有损坏。")).toBeVisible();
  await expect(page.locator(".attachment__name")).toHaveCount(0);

  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  const tables = readResearchImportTables(dbPath);
  expect(tables.attachments.filter((row) => row.sessionId === sessionId)).toHaveLength(0);
  expect(tables.importTasks.filter((row) => row.sessionId === sessionId)).toHaveLength(0);
});

test("解析失败显示稳定原因，重试后仍失败保持可重试状态", async ({ page }) => {
  const sessionId = await openFreshSession(page);
  const consoleIssues = watchConsole(page);

  // 带 ZIP 魔数但结构损坏的 DOCX：通过上传校验，解析稳定失败
  await page.locator('input[type="file"]').setInputFiles({
    name: "损坏.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: Buffer.from("PK\x03\x04 这不是真正的 DOCX 压缩包", "utf8"),
  });

  await expect(page.locator(".attachment__name", { hasText: "损坏.docx" })).toBeVisible();
  await expect(page.getByText("无法解析这个文件，可能已损坏或不含可读文本。")).toBeVisible({ timeout: 15_000 });

  const retryButton = page.getByRole("button", { name: "重试" });
  await expect(retryButton).toBeVisible();
  await retryButton.click();
  // 重试保留同一任务与附件，再次稳定失败，不新增附件
  await expect(page.getByText("无法解析这个文件，可能已损坏或不含可读文本。")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "重试" })).toBeVisible();
  await expect(page.locator(".attachment__name")).toHaveCount(1);

  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  const tables = readResearchImportTables(dbPath);
  const sessionAttachments = tables.attachments.filter((row) => row.sessionId === sessionId);
  const sessionTasks = tables.importTasks.filter((row) => row.sessionId === sessionId);
  expect(sessionAttachments).toHaveLength(1);
  expect(sessionTasks).toHaveLength(1);
  expect(sessionTasks[0].status).toBe("failed");
  expect(sessionTasks[0].retryable).toBe(1);

  expect(consoleIssues).toEqual([]);
});

test("进行中的导入可以取消，SQLite 记录取消终态", async ({ page }) => {
  const sessionId = await openFreshSession(page);
  const consoleIssues = watchConsole(page);

  // 生成 150 页 PDF，让解析窗口足够点击取消
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 150; index += 1) {
    const pdfPage = document.addPage([300, 300]);
    pdfPage.drawText(`Collector cancel probe page ${index + 1}`, { x: 20, y: 250, size: 12, font });
  }
  const pdfBytes = await document.save({ useObjectStreams: false });

  await page.locator('input[type="file"]').setInputFiles({
    name: "长篇.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(pdfBytes),
  });

  const cancelButton = page.getByRole("button", { name: "取消" });
  await cancelButton.waitFor({ state: "visible", timeout: 10_000 });
  cancelButton.click();
  await expect(page.locator(".attachment__state", { hasText: "已取消" })).toBeVisible({ timeout: 15_000 });

  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  await expect
    .poll(
      () => {
        const tables = readResearchImportTables(dbPath);
        return tables.importTasks.find((row) => row.sessionId === sessionId)?.status;
      },
      { timeout: 10_000 },
    )
    .toBe("cancelled");

  expect(consoleIssues).toEqual([]);
});

test("不支持的文件类型在前端被拦截，不发起上传请求", async ({ page }) => {
  let uploadAttempted = false;
  page.on("request", (request) => {
    if (request.url().endsWith("/imports")) uploadAttempted = true;
  });

  await openFreshSession(page);
  await page.locator('input[type="file"]').setInputFiles({
    name: "程序.exe",
    mimeType: "application/x-msdownload",
    buffer: Buffer.from("MZ", "utf8"),
  });

  await expect(page.getByText(/仅支持 TXT、Markdown、DOCX、PDF/)).toBeVisible();
  expect(uploadAttempted).toBe(false);
});

test("键盘完成附件上传、进入阅读视图并返回会话", async ({ page }) => {
  const sessionId = await openFreshSession(page);
  const consoleIssues = watchConsole(page);

  // 键盘激活附件按钮 → 打开系统文件选择（filechooser）
  const attachButton = page.getByRole("button", { name: /添加附件（TXT、Markdown、DOCX、PDF/ });
  await attachButton.focus();
  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.keyboard.press("Enter"),
  ]);
  await fileChooser.setFiles({
    name: "键盘.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("键盘上传内容", "utf8"),
  });

  await expect(page.getByText("已导入")).toBeVisible({ timeout: 15_000 });

  // 键盘进入阅读视图并返回
  await page.getByRole("button", { name: "阅读" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/research/${sessionId}/reading/[^/]+$`));
  await expect(page.getByText("键盘上传内容")).toBeVisible();

  const backLink = page.getByRole("link", { name: "返回研究会话" });
  await backLink.focus();
  await expect(page.evaluate(() => document.activeElement?.textContent)).resolves.toContain("返回研究");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/nodes/${sessionId}$`));

  expect(consoleIssues).toEqual([]);
});

test("阅读视图在 320/768/1024/1440 视口无横向溢出并留截图", async ({ page }) => {
  const sessionId = await openFreshSession(page);

  await page.locator('input[type="file"]').setInputFiles({
    name: "视口.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 视口验证标题\n\n第一段：在不同宽度下阅读保持稳定，不出现横向滚动。\n\n- 列表项一\n- 列表项二\n\n```\nconst code = '代码块';\n```", "utf8"),
  });
  await expect(page.getByText("已导入")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "阅读" }).click();
  await expect(page.getByRole("heading", { name: "视口验证标题", level: 2 })).toBeVisible();

  mkdirSync("e2e-artifacts", { recursive: true });
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    // 先等待外壳完成宽/窄布局切换，再测量，避免读取到过渡状态
    if (width < 900) {
      // 窄屏：左侧栏为常驻窄 rail（收起态可见）
      // （#56 已移除右侧常驻标记栏，标记改为会话 ⋯ 菜单内的按需弹窗，无标记区可断言）
      await expect(page.getByRole("navigation", { name: "内容导航" }).getByRole("button", { name: "展开侧栏" })).toBeVisible();
    } else {
      await expect(page.getByRole("navigation", { name: "内容导航" })).toBeVisible();
    }
    // 等外壳完成宽/窄布局切换、正文重排收敛进视口再量：窄屏 rail 收展与网格收缩需一帧，
    // 立即量会捕到切换前的瞬时 scrollWidth（对齐 research-session 视口用例的收敛模式）。
    // 先等左侧栏到达该断点结构目标宽（窄屏收起 rail=64px / 宽屏展开≥MIN），再轮询 scrollWidth——
    // 高负载下 React 多提交更新与重排未收敛时会读到中间过渡帧（264px 内联宽刚清除、布局未重算）。
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
    expect(metrics.scrollWidth, `阅读视口 ${width}px 不应横向溢出`).toBeLessThanOrEqual(metrics.clientWidth + 1);
    await page.screenshot({ path: `e2e-artifacts/reading-viewport-${width}.png`, fullPage: true });
  }
});

// ---------------------------------------------------------------------------
// 文件发起研究：开始页直接上传文件创建会话 → 阅读页提问 → 返回会话验证
//   - 开始页 ChatComposer 现在提供 onImportFile，附件按钮可见
//   - 开始页拖放文件创建研究（drop overlay 文案独立：松开鼠标，开始研究这个文件）
// ---------------------------------------------------------------------------

test("从开始页上传文件创建研究并导入，进入阅读视图后可从阅读页 ChatComposer 提问", async ({ page }) => {
  // 先清数据让 HomeRoute 没有已有会话，落在开始页
  await pairAndOpen(page, "/research/new");
  const consoleIssues = watchConsole(page);

  // 上传 TXT 文件 → 创建会话 → 导入 → 自动导航到会话页
  await page.locator('input[type="file"]').setInputFiles({
    name: "直接研究.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("第一条：文件直接发起研究\n\n第二条：不需要先输入问题\n\n第三条：Chat 与文件是并列入口", "utf8"),
  });

  // 导航到统一节点页（根节点），附件列表可见
  await expect(page).toHaveURL(/\/nodes\/[^/]+$/, { timeout: 15_000 });
  const sessionId = new URL(page.url()).pathname.split("/")[2] ?? "";
  expect(sessionId).not.toBe("");

  // 导入完成后进入阅读
  await expect(page.getByText("已导入")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "阅读" }).click();
  await expect(page).toHaveURL(/\/research\/[^/]+\/reading\/[^/]+$/, { timeout: 10_000 });

  // 阅读页 ChatComposer 可见，发送一个消息
  const textarea = page.getByLabel("你的问题");
  await expect(textarea).toBeVisible();
  await textarea.fill("这篇文章有几条内容？");
  await page.getByRole("button", { name: "发送" }).click();

  // 返回研究节点页验证消息已在列表中
  await page.getByRole("link", { name: "返回研究会话" }).click();
  await expect(page).toHaveURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  await expect(page.locator(".message-list")).toBeVisible();

  expect(consoleIssues.filter((msg) => !msg.includes("pdfjs")).filter((msg) => !msg.includes("canvas"))).toEqual([]);
});

test("开始页拖放文件创建研究", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  const consoleIssues = watchConsole(page);

  // 使用 JS 构造 DataTransfer 事件后 dispatch
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["# 从开始页拖入\n\n拖放开始。"], "拖放开始.md", { type: "text/markdown" }));
    const el = document.querySelector(".page--start");
    if (!el) return;
    el.dispatchEvent(new DragEvent("dragenter", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    // 短等后 drop
    setTimeout(() => {
      el.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, 100);
  });

  // 等待导航（文件处理完成后跳转到研究节点页）
  await expect(page).toHaveURL(/\/nodes\/[^/]+$/, { timeout: 15_000 });
  await expect(page.getByText("已导入")).toBeVisible({ timeout: 15_000 });

  expect(consoleIssues).toEqual([]);
});

const LONG_TXT_CONTENT = Array.from(
  { length: 12 },
  (_, index) => `第${index + 1}段开头句：这是导入长文章节解析的第${index + 1}段确定性正文，用于验证 AI 异步补齐章节锚点与导航点击跳转。`.repeat(4),
).join("\n\n");

test("导入长文：正文立即可读，AI 章节解析异步补齐章节导航并可在刷新后恢复", async ({ page }) => {
  test.setTimeout(60_000);
  const sessionId = await openFreshSession(page);
  const consoleIssues = watchConsole(page);

  await page.locator('input[type="file"]').setInputFiles({
    name: "长文文章.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(LONG_TXT_CONTENT, "utf8"),
  });
  await expect(page.getByText("已导入")).toBeVisible({ timeout: 15_000 });

  // 导入完成即可读：阅读视图正文与块锚点立即可用，不等待章节解析
  await page.getByRole("button", { name: "阅读" }).click();
  await expect(page).toHaveURL(new RegExp(`/research/${sessionId}/reading/[^/]+$`));
  await expect(page.getByRole("heading", { name: "长文文章.txt" })).toBeVisible();
  await expect(page.getByText("第 1 行")).toBeVisible();
  await expect(page.getByText(/第1段开头句/).first()).toBeVisible();

  // 章节导航异步补齐：AI 章节锚点按 T01 契约落在既有块上
  const nav = page.getByTestId("reading-chapter-nav");
  await expect(nav).toHaveAttribute("data-chapter-source", "ai", { timeout: 15_000 });
  await expect(nav).toContainText("章节由 AI 通读全文生成");
  await expect(nav.getByRole("button", { name: "第1章" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "第2章" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "第3章" })).toBeVisible();

  // 宽屏导航与正文处于同一网格层，不再是固定悬浮卡片；条目使用圆点 + 章节名。
  const navLayout = await nav.evaluate((element) => {
    const style = getComputedStyle(element);
    const firstItem = element.querySelector<HTMLElement>(".chapter-nav__item");
    const dot = firstItem ? getComputedStyle(firstItem, "::before") : null;
    return {
      position: style.position,
      borderTopWidth: style.borderTopWidth,
      boxShadow: style.boxShadow,
      backgroundColor: style.backgroundColor,
      dotContent: dot?.content,
      dotRadius: dot?.borderRadius,
    };
  });
  expect(navLayout.position).toBe("sticky");
  expect(navLayout.borderTopWidth).toBe("0px");
  expect(navLayout.boxShadow).toBe("none");
  expect(navLayout.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(navLayout.dotContent).not.toBe("none");
  expect(navLayout.dotRadius).toBe("50%");
  const [mainBox, navBox] = await Promise.all([
    page.locator(".reading-page__main").boundingBox(),
    nav.boundingBox(),
  ]);
  expect(mainBox && navBox).toBeTruthy();
  expect(navBox!.x).toBeGreaterThanOrEqual(mainBox!.x + mainBox!.width);

  // 点击中间章节：精确跳转到既有块，滚动真实发生且该线保持高亮
  await page.evaluate(() => window.scrollTo(0, 0));
  await nav.getByRole("button", { name: "第2章" }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 5_000 }).toBeGreaterThan(0);
  await expect(nav.getByRole("button", { name: "第2章" })).toHaveClass(/chapter-nav__item--active/);

  // 刷新后状态一致：锚点与来源状态由持久化记录恢复，不重复解析
  await page.reload();
  await expect(page.getByRole("heading", { name: "长文文章.txt" })).toBeVisible();
  const reloadedNav = page.getByTestId("reading-chapter-nav");
  await expect(reloadedNav).toHaveAttribute("data-chapter-source", "ai", { timeout: 15_000 });
  await expect(reloadedNav.getByRole("button", { name: "第1章" })).toBeVisible();

  // 界面、API 与 SQLite 一致
  const view = await apiJson<SessionView>(page, `/v1/research-sessions/${sessionId}`);
  const content = await apiJson<{ chapterParse?: { source?: string; chapters: Array<{ blockOrdinal: number; title: string }> } }>(
    page,
    `/v1/research-content/${view.attachments![0].contentSnapshotId}`,
  );
  expect(content.chapterParse?.source).toBe("ai");
  expect(content.chapterParse?.chapters).toHaveLength(3);
  // 假模型按 [Bn] 编号取首/中/尾三块：B0、B6（12 块的中间）、B11。
  expect(content.chapterParse!.chapters.map((chapter) => chapter.blockOrdinal)).toEqual([0, 6, 11]);

  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  const tables = readResearchImportTables(dbPath);
  const chapterTasks = tables.chapterTasks.filter((row) => row.sessionId === sessionId);
  expect(chapterTasks).toHaveLength(1);
  expect(chapterTasks[0].status).toBe("completed");
  expect(chapterTasks[0].retryable).toBe(0);
  const record = JSON.parse(chapterTasks[0].recordJson) as { source?: string; chapters?: unknown[] };
  expect(record.source).toBe("ai");
  expect(record.chapters).toHaveLength(3);

  expect(consoleIssues).toEqual([]);
});

test("短于长文阈值的导入内容不触发章节解析、无章节导航", async ({ page }) => {
  const sessionId = await openFreshSession(page);
  const consoleIssues = watchConsole(page);

  await page.locator('input[type="file"]').setInputFiles({
    name: "短文.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(TXT_CONTENT, "utf8"),
  });
  await expect(page.getByText("已导入")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "阅读" }).click();
  await expect(page).toHaveURL(new RegExp(`/research/${sessionId}/reading/[^/]+$`));
  await expect(page.getByRole("heading", { name: "短文.txt" })).toBeVisible();
  await expect(page.getByText(/第一行：本地优先研究/)).toBeVisible();

  // 界面无章节导航，API 视图无 chapterParse，数据库无章节任务
  await expect(page.getByTestId("reading-chapter-nav")).toHaveCount(0);
  const view = await apiJson<SessionView>(page, `/v1/research-sessions/${sessionId}`);
  const content = await apiJson<{ chapterParse?: unknown }>(page, `/v1/research-content/${view.attachments![0].contentSnapshotId}`);
  expect(content.chapterParse).toBeUndefined();
  const dbPath = join(await readDataDir(apiPortForPage(page)), "collector.sqlite");
  const tables = readResearchImportTables(dbPath);
  expect(tables.chapterTasks.filter((row) => row.sessionId === sessionId)).toHaveLength(0);

  expect(consoleIssues).toEqual([]);
});
