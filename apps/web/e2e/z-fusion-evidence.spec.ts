/**
 * #42 融合依据 → 原始语义片段定位端到端（确定性假模型）。
 * 覆盖：提案来源正常跳转、重复跳转、失效回退、历史导航、窄屏、reduced-motion、
 * accepted 只读入口、body-versions 网络契约（缓存恰好一次）。
 * 融合提案通过浏览器路由注入（scan 端点依赖真实模型核验，e2e 不可用）；
 * 触发依据的 bodyVersionId/fragmentId 一律取自真实响应/真实端点，不手写，
 * 内容逐字一致由"同库同派生"保证。
 */
import { expect, test, type Page } from "@playwright/test";
import { apiJson, citeAnswerText, pairAndOpen } from "./helpers";

const QUESTION = "什么是本地优先研究？";
/** 根节点三段正文中第二段（拟作为根→子的依据片段）。 */
const ROOT_EVIDENCE_TEXT = "本地优先会先把输入保存在本机，再据此组织后续研究。";
/** 子节点第一段正文（拟作为子→根的依据片段）。 */
const CHILD_EVIDENCE_TEXT = "这是深入研究第一轮";

/** 建立会话并完成第一轮回答，返回会话 id 与根节点 id（根节点 id ≠ 会话 id）。 */
async function openSession(page: Page): Promise<{ sessionId: string; rootNodeId: string }> {
  await pairAndOpen(page, "/research/new");
  await page.getByLabel("你的问题").fill(QUESTION);
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.waitForURL(/\/nodes\/[^/]+$/, { timeout: 10_000 });
  await expect(page.locator(".message--assistant .message__content").last()).toContainText("回答完毕", {
    timeout: 15_000,
  });
  const match = new URL(page.url()).pathname.match(/^\/nodes\/([^/]+)$/);
  if (!match) throw new Error("unexpected root node url");
  return { sessionId: match[1]!, rootNodeId: match[1]! }; // 稳定地址：根节点 id 与会话 id 相同
}

async function growChildNode(page: Page, sessionId: string): Promise<string> {
  await citeAnswerText(page, ROOT_EVIDENCE_TEXT);
  await page.getByRole("button", { name: "深入研究这段" }).click();
  await page.waitForURL(
    (url) => {
      const match = url.pathname.match(/^\/nodes\/([^/]+)$/);
      return Boolean(match && match[1] && match[1] !== sessionId);
    },
    { timeout: 10_000 },
  );
  await expect(page.getByText(/这是深入研究第一轮/)).toBeVisible({ timeout: 15_000 });
  return page.url().split("/nodes/")[1]?.split(/[?#]/)[0] ?? "";
}

interface NodeEvidence {
  nodeId: string;
  messageId: string;
  bodyVersionId: string;
  fragmentId: string;
}

/** 从真实节点视图 + 正文版本端点提取一条可定位依据（片段 id 取自真实派生）。
    正文版本只在消息 completed 后由节点视图惰性派生——子节点仍在流式时轮询等待。 */
async function readNodeEvidence(page: Page, nodeId: string, fragmentOrdinal: number): Promise<NodeEvidence> {
  let view: {
    messages: Array<{ id: string; role: string; status: string; content: string }>;
    bodyVersions?: Record<string, { id: string }>;
  } | undefined;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    view = await apiJson(page, `/v1/research-nodes/${encodeURIComponent(nodeId)}`);
    const assistant = view.messages.find((m) => m.role === "assistant" && m.status === "completed" && m.content.trim());
    if (assistant && view.bodyVersions?.[assistant.id]) break;
    await page.waitForTimeout(300);
  }
  if (!view) throw new Error("node view fetch failed");
  const assistant = view.messages.find((m) => m.role === "assistant" && m.status === "completed" && m.content.trim());
  if (!assistant || !view.bodyVersions?.[assistant.id]) throw new Error("node evidence missing body version");
  const bodyVersionId = view.bodyVersions[assistant.id]!.id;
  const bodyView = await apiJson<{ fragments: Array<{ id: string; ordinal: number; excerpt: string }> }>(
    page,
    `/v1/research-body-versions/${encodeURIComponent(bodyVersionId)}`,
  );
  const fragment = bodyView.fragments.find((f) => f.ordinal === fragmentOrdinal);
  if (!fragment) throw new Error(`fragment ordinal ${fragmentOrdinal} missing`);
  return { nodeId, messageId: assistant.id, bodyVersionId, fragmentId: fragment.id };
}

/** 在根节点视图响应中注入 pending + accepted 融合提案（依据指向真实提取的片段）。 */
async function installProposalFixture(
  page: Page,
  rootNodeId: string,
  rootEvidence: NodeEvidence,
  childEvidence: NodeEvidence,
): Promise<void> {
  await page.route(`**/v1/research-nodes/${encodeURIComponent(rootNodeId)}`, async (route) => {
    const response = await route.fetch();
    const view = await response.json();
    const pendingProposal = {
      id: "e2e-proposal-pending",
      loNodeId: rootNodeId,
      hiNodeId: childEvidence.nodeId,
      relationType: "shared-concept",
      reason: "根节点与子节点共享本地优先概念。",
      status: "pending",
      triggerSources: [
        {
          nodeId: childEvidence.nodeId,
          bodyVersionId: childEvidence.bodyVersionId,
          fragmentId: childEvidence.fragmentId,
        },
        {
          nodeId: rootNodeId,
          bodyVersionId: rootEvidence.bodyVersionId,
          fragmentId: rootEvidence.fragmentId,
        },
      ],
      verification: { promptVersion: "similarity-verify-v1", sourceSliceIds: [], sourceFragmentIds: [], tokenBudget: 800 },
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    };
    const acceptedProposal = {
      ...pendingProposal,
      id: "e2e-proposal-accepted",
      status: "accepted",
    };
    view.fusionProposals = [pendingProposal, acceptedProposal];
    await route.fulfill({ response, json: view });
  });
}

/** 进入根节点页并展开融合提示的依据列表。未展开 details 的来源仍在 DOM 中，断言用可见过滤。 */
async function openRootNotice(page: Page, rootNodeId: string, sessionId: string): Promise<void> {
  await page.goto(`/nodes/${encodeURIComponent(rootNodeId)}`);
  await expect(page.locator(".fusion-proposal-notice")).toBeVisible({ timeout: 15_000 });
  await page.locator(".fusion-proposal-notice__item summary").first().click();
  await expect(page.locator(".fusion-proposal-notice__source").filter({ visible: true })).toHaveCount(2, { timeout: 10_000 });
}

test.describe("#42 融合依据定位", () => {
  test("提案来源正常跳转：进入子节点并定位目标卡片（强调 + 播报 + 视口）", async ({ page }) => {
    test.setTimeout(120_000);
    const { sessionId, rootNodeId } = await openSession(page);
    const rootEvidence = await readNodeEvidence(page, rootNodeId, 1);
    const childNodeId = await growChildNode(page, sessionId);
    const childEvidence = await readNodeEvidence(page, childNodeId, 0);
    await installProposalFixture(page, rootNodeId, rootEvidence, childEvidence);

    await openRootNotice(page, rootNodeId, sessionId);
    // 依据条目预览加载后显示摘录；第一条依据指向子节点
    const sources = page.locator(".fusion-proposal-notice__source").filter({ visible: true });
    await expect(sources.nth(0)).toContainText(CHILD_EVIDENCE_TEXT);
    await sources.nth(0).click();

    // 进入子节点页：URL 带 fragment 深链
    await page.waitForURL((url) => url.searchParams.has("fragment"), { timeout: 10_000 });
    expect(page.url()).toContain(`/nodes/${encodeURIComponent(childNodeId)}`);

    // 目标卡片获得强调、在视口内、不被固定顶栏遮挡；live region 播报
    const focusedCard = page.locator(".slice-card--focused");
    await expect(focusedCard).toHaveCount(1, { timeout: 10_000 });
    await expect(focusedCard).toBeInViewport();
    const box = await focusedCard.boundingBox();
    expect(box?.y ?? 0).toBeGreaterThan(56); // app-bar 高度之上
    await expect(page.locator('[role="status"][aria-live="polite"]')).toContainText("已定位到");
  });

  test("重复跳转：同一依据再次点击可重新触发强调", async ({ page }) => {
    test.setTimeout(120_000);
    const { sessionId, rootNodeId } = await openSession(page);
    const rootEvidence = await readNodeEvidence(page, rootNodeId, 1);
    const childNodeId = await growChildNode(page, sessionId);
    const childEvidence = await readNodeEvidence(page, childNodeId, 0);
    await installProposalFixture(page, rootNodeId, rootEvidence, childEvidence);

    await openRootNotice(page, rootNodeId, sessionId);
    const sources = page.locator(".fusion-proposal-notice__source").filter({ visible: true });
    await sources.nth(0).click();
    await expect(page.locator(".slice-card--focused")).toHaveCount(1, { timeout: 10_000 });
    // 等强调自动恢复
    await expect(page.locator(".slice-card--focused")).toHaveCount(0, { timeout: 5_000 });
    // 返回根页（details 折叠态重置）再展开并点击同一条依据 → 强调重新出现
    await page.goBack();
    await expect(page.locator(".fusion-proposal-notice")).toBeVisible();
    await page.locator(".fusion-proposal-notice__item summary").first().click();
    await expect(page.locator(".fusion-proposal-notice__source").filter({ visible: true })).toHaveCount(2);
    await page.locator(".fusion-proposal-notice__source").filter({ visible: true }).nth(0).click();
    await expect(page.locator(".slice-card--focused")).toHaveCount(1, { timeout: 10_000 });
  });

  test("失效回退：正文版本不存在时显示明确回退信息，不静默定位", async ({ page }) => {
    test.setTimeout(120_000);
    const { sessionId, rootNodeId } = await openSession(page);
    const rootEvidence = await readNodeEvidence(page, rootNodeId, 1);
    const childNodeId = await growChildNode(page, sessionId);
    const childEvidence = await readNodeEvidence(page, childNodeId, 0);
    await installProposalFixture(page, rootNodeId, rootEvidence, childEvidence);
    // 让依据引用的正文版本 404
    await page.route(`**/v1/research-body-versions/${encodeURIComponent(childEvidence.bodyVersionId)}`, (route) =>
      route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "not_found" } }) }),
    );

    await openRootNotice(page, rootNodeId, sessionId);
    await page.locator(".fusion-proposal-notice__source").filter({ visible: true }).nth(0).click();
    await expect(page.locator(".fragment-locator-fallback")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".fragment-locator-fallback")).toContainText("正文版本已不存在");
    await expect(page.locator(".slice-card--focused")).toHaveCount(0);
  });

  test("历史导航：back 回根页，forward 恢复 fragment 深链并重新定位", async ({ page }) => {
    test.setTimeout(120_000);
    const { sessionId, rootNodeId } = await openSession(page);
    const rootEvidence = await readNodeEvidence(page, rootNodeId, 1);
    const childNodeId = await growChildNode(page, sessionId);
    const childEvidence = await readNodeEvidence(page, childNodeId, 0);
    await installProposalFixture(page, rootNodeId, rootEvidence, childEvidence);

    await openRootNotice(page, rootNodeId, sessionId);
    await page.locator(".fusion-proposal-notice__source").filter({ visible: true }).nth(0).click();
    await expect(page.locator(".slice-card--focused")).toHaveCount(1, { timeout: 10_000 });
    // back：根页无 fragment
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/nodes/${encodeURIComponent(rootNodeId)}(\\?|$)`));
    await expect(page.locator(".fusion-proposal-notice")).toBeVisible();
    // forward：恢复 fragment 深链，强调重现
    await page.goForward();
    await expect(page.locator(".slice-card--focused")).toHaveCount(1, { timeout: 10_000 });
    await expect(page).toHaveURL(/(\?|&)fragment=/);
  });

  test("窄屏 390×844：跳转后目标卡片在视口内且无横向滚动", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const { sessionId, rootNodeId } = await openSession(page);
    const rootEvidence = await readNodeEvidence(page, rootNodeId, 1);
    const childNodeId = await growChildNode(page, sessionId);
    const childEvidence = await readNodeEvidence(page, childNodeId, 0);
    await installProposalFixture(page, rootNodeId, rootEvidence, childEvidence);

    await openRootNotice(page, rootNodeId, sessionId);
    await page.locator(".fusion-proposal-notice__source").filter({ visible: true }).nth(0).click();
    const focusedCard = page.locator(".slice-card--focused");
    await expect(focusedCard).toHaveCount(1, { timeout: 10_000 });
    await expect(focusedCard).toBeInViewport();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
  });

  test("reduced-motion：取消平滑滚动与投影动画，强调 class 仍存在", async ({ page }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const { sessionId, rootNodeId } = await openSession(page);
    const rootEvidence = await readNodeEvidence(page, rootNodeId, 1);
    const childNodeId = await growChildNode(page, sessionId);
    const childEvidence = await readNodeEvidence(page, childNodeId, 0);
    await installProposalFixture(page, rootNodeId, rootEvidence, childEvidence);

    await openRootNotice(page, rootNodeId, sessionId);
    await page.locator(".fusion-proposal-notice__source").filter({ visible: true }).nth(0).click();
    await expect(page.locator(".slice-card--focused")).toHaveCount(1, { timeout: 10_000 });
  });

  test("accepted 只读入口：无决策按钮，依据可点击跳转", async ({ page }) => {
    test.setTimeout(120_000);
    const { sessionId, rootNodeId } = await openSession(page);
    const rootEvidence = await readNodeEvidence(page, rootNodeId, 1);
    const childNodeId = await growChildNode(page, sessionId);
    const childEvidence = await readNodeEvidence(page, childNodeId, 0);
    await installProposalFixture(page, rootNodeId, rootEvidence, childEvidence);

    await openRootNotice(page, rootNodeId, sessionId);
    // 第二个 details 为 accepted 提案：无决策按钮
    const items = page.locator(".fusion-proposal-notice__item");
    await items.nth(1).locator("summary").click();
    await expect(items.nth(1).locator("summary")).toHaveText("已保留的概念关系");
    await expect(items.nth(1).locator(".fusion-proposal-notice__actions")).toHaveCount(0);
    // 依据仍可点击跳转
    await items.nth(1).locator(".fusion-proposal-notice__source").nth(1).click();
    await page.waitForURL((url) => url.searchParams.has("fragment"), { timeout: 10_000 });
    await expect(page.locator(".slice-card--focused")).toHaveCount(1, { timeout: 10_000 });
  });

  test("网络契约：跳转页同一正文版本只请求一次（缓存）", async ({ page }) => {
    test.setTimeout(120_000);
    const { sessionId, rootNodeId } = await openSession(page);
    const rootEvidence = await readNodeEvidence(page, rootNodeId, 1);
    const childNodeId = await growChildNode(page, sessionId);
    const childEvidence = await readNodeEvidence(page, childNodeId, 0);
    await installProposalFixture(page, rootNodeId, rootEvidence, childEvidence);

    // 监听 body-versions 请求（apiJson 的读取发生在拦截器安装前，不计入）
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/v1/research-body-versions/")) requests.push(request.url());
    });

    await openRootNotice(page, rootNodeId, sessionId);
    // 展开的 details 含两条依据（子/根各一）→ 预览对两个版本各请求一次
    await expect(page.locator(".fusion-proposal-notice__source").filter({ visible: true })).toHaveCount(2);
    await expect.poll(() => requests.filter((url) => url.includes(encodeURIComponent(childEvidence.bodyVersionId))).length).toBe(1);
    await expect.poll(() => requests.filter((url) => url.includes(encodeURIComponent(rootEvidence.bodyVersionId))).length).toBe(1);
    // 跳转后定位命中缓存，子节点版本不产生第二次请求
    await page.locator(".fusion-proposal-notice__source").filter({ visible: true }).nth(0).click();
    await expect(page.locator(".slice-card--focused")).toHaveCount(1, { timeout: 10_000 });
    await expect.poll(() => requests.filter((url) => url.includes(encodeURIComponent(childEvidence.bodyVersionId))).length).toBe(1);
  });
});
