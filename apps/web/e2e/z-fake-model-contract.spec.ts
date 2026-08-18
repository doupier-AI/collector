/**
 * 确定性假模型响应形态契约（helpers.ts 顶部清单的机器化部分）。
 *
 * 只断言对上层 spec 写法有契约意义的稳定结构：普通回答完成词、长文触发词/节标题/无完成词、
 * aria-live 完成播报、深入研究两段式。不逐字锁死假模型文案；节奏（1500/400/250ms）与
 * 「流式与 writeBody 逐字节一致」属实现细节或 harness 内部保证，不在契约内；
 * 弱标记形态由 term-markers/term-preview 覆盖，跨运行确定性由 z-visual-baseline 自身承担。
 *
 * 本文件失败 = 假模型行为漂移：应先于各功能 spec 排查本文件，失败信息直接指明哪条形态变了；
 * 修改 api-harness.mjs 的假模型分支后，先跑本文件确认漂移面，再跑受影响功能 spec。
 *
 * z- 前缀（与套件尾段约定一致）：本文件会创建会话/轮次/运行记录，必须排在依赖空态或计数的
 * 顺序敏感 spec（launcher-bootstrap、research-session 空态、run-record-export）之后运行；
 * 文件内所有断言只作用于自建会话，对邻居顺序不敏感。
 */
import { expect, test, type Page } from "@playwright/test";
import { deriveMessageBlocks, isLongText } from "@collector/capture-contracts";
import { QUESTION, apiJson, citeAnswerText, pairAndOpen } from "./helpers";

interface NodeViewLite {
  messages: Array<{ role: string; status: string; content: string }>;
}

/** 已完成的 AI 消息正文列表（按落库顺序）。 */
async function assistantContents(page: Page, nodeId: string): Promise<string[]> {
  const view = await apiJson<NodeViewLite>(page, `/v1/research-nodes/${encodeURIComponent(nodeId)}`);
  return view.messages.filter((message) => message.role === "assistant" && message.status === "completed").map((message) => message.content);
}

/** 等已完成的 AI 消息达到指定条数（后续轮次的完成等待；aria-live 只在首轮从空变为「已完成」）。 */
async function waitAssistantCount(page: Page, nodeId: string, count: number): Promise<void> {
  await expect.poll(async () => (await assistantContents(page, nodeId)).length, { timeout: 15_000 }).toBe(count);
}

async function submitQuestion(page: Page, question: string): Promise<string> {
  await page.getByLabel("你的问题").fill(question);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  return page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
}

/** 等待跳转到子节点页并返回新节点 id。 */
async function waitForChildNodeUrl(page: Page, sessionId: string): Promise<string> {
  await page.waitForURL(
    (url) => {
      const match = url.pathname.match(/^\/nodes\/([^/]+)$/);
      return Boolean(match && match[1] && match[1] !== sessionId);
    },
    { timeout: 10_000 },
  );
  return page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
}

test("普通回答契约：三段结构、含完成词「回答完毕」、非长文节标题形态", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  const nodeId = await submitQuestion(page, QUESTION);
  await expect(page.locator("[aria-live=polite]")).toHaveText("已完成", { timeout: 15_000 });

  const contents = await assistantContents(page, nodeId);
  expect(contents, "普通回答契约：首轮应有一条完成回答").toHaveLength(1);
  const content = contents[0]!;
  expect(content, "普通回答契约：含完成词，spec 可等「回答完毕」").toContain("回答完毕");
  expect(deriveMessageBlocks(content), "普通回答契约：三段结构").toHaveLength(3);
  expect(content, "普通回答契约：不得带长文节标题").not.toMatch(/^## /m);
  expect(isLongText(content), "普通回答契约：不得触发长文路径（走轮次卡片而非节卡）").toBe(false);
});

test("长文契约：三个触发词各产三节「## 长文第N节」、正文无完成词、aria-live 播报完成", async ({ page }) => {
  // 三轮长文生成（每轮约 2s 确定性产出），放宽整测超时。
  test.setTimeout(60_000);
  await pairAndOpen(page, "/research/new");
  // 首轮即长文：aria-live 从空变为「已完成」，证明长文完成信号走播报而非正文完成词。
  const nodeId = await submitQuestion(page, "请写一篇关于本地优先软件的长文分析");
  await expect(page.locator("[aria-live=polite]")).toHaveText("已完成", { timeout: 15_000 });
  await waitAssistantCount(page, nodeId, 1);

  for (const [index, question] of ["请给一份长篇说明", "整理成一份报告"].entries()) {
    await page.getByLabel("你的问题").fill(question);
    await page.getByRole("button", { name: "发送" }).click();
    await waitAssistantCount(page, nodeId, index + 2);
  }

  const contents = await assistantContents(page, nodeId);
  expect(contents, "长文契约：长文/长篇/报告三个触发词各完成一轮").toHaveLength(3);
  for (const [index, content] of contents.entries()) {
    const label = `长文契约（第 ${index + 1} 轮）`;
    expect(content.match(/^## 长文第\d节$/gm), `${label}：三节「## 长文第N节」标题`).toHaveLength(3);
    expect(content, `${label}：正文不得含「回答完毕」，spec 勿等该词`).not.toContain("回答完毕");
    expect(isLongText(content), `${label}：正文须达长文阈值（节卡与章节导航前提）`).toBe(true);
  }
});

test("深入研究契约：第一轮两段结构、末段含完成词「回答完毕」", async ({ page }) => {
  await pairAndOpen(page, "/research/new");
  const sessionId = await submitQuestion(page, QUESTION);
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
    timeout: 15_000,
  });

  await citeAnswerText(page, "本地优先会先把输入保存在本机");
  await page.getByRole("button", { name: "深入研究这段" }).click();
  const nodeId = await waitForChildNodeUrl(page, sessionId);
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
    timeout: 15_000,
  });
  // 卡内流式文本早于 completed 落库，按完成条数等持久化后再读正文。
  await waitAssistantCount(page, nodeId, 1);

  const contents = await assistantContents(page, nodeId);
  expect(contents, "深入研究契约：子节点第一轮应有一条完成回答").toHaveLength(1);
  const content = contents[0]!;
  expect(deriveMessageBlocks(content), "深入研究契约：两段结构").toHaveLength(2);
  expect(content, "深入研究契约：末段含完成词，spec 可等「回答完毕」").toContain("回答完毕");
  expect(content, "深入研究契约：不得带长文节标题").not.toMatch(/^## /m);
});
