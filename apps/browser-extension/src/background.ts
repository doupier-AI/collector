import type { CaptureInput } from "@collector/capture-contracts";

const API_BASE_URL = "http://127.0.0.1:43110";
const RETRY_KEY = "collector:retry-queue";
const TOKEN_KEY = "collector:auth-token";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "collector-selection", title: "收集到知识库", contexts: ["selection"] });
  chrome.contextMenus.create({ id: "collector-page", title: "收集当前网页", contexts: ["page"] });
  chrome.alarms.create("collector-retry", { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => void retryPending());
chrome.alarms.onAlarm.addListener((alarm) => alarm.name === "collector-retry" && void retryPending());

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id || !tab.url) return;
  try {
    let input: CaptureInput;
    if (info.menuItemId === "collector-selection") {
      const selection = await chrome.tabs.sendMessage(tab.id, { type: "collector:get-selection" }).catch(() => null);
      input = {
        captureType: "browser_selection",
        content: selection?.content ?? info.selectionText ?? "",
        sourceUrl: tab.url,
        sourceTitle: tab.title,
        contextBefore: selection?.contextBefore,
        contextAfter: selection?.contextAfter,
        locator: selection?.locator ?? { kind: "browser", pageUrl: tab.url },
        clientCaptureId: newClientCaptureId("browser"),
        capturedAt: new Date().toISOString(),
      };
    } else {
      const page = await chrome.tabs.sendMessage(tab.id, { type: "collector:get-page" }).catch(() => null);
      input = {
        captureType: "browser_page",
        content: page?.content,
        sourceUrl: tab.url,
        sourceTitle: tab.title,
        locator: { kind: "browser", pageUrl: tab.url },
        clientCaptureId: newClientCaptureId("page"),
        capturedAt: new Date().toISOString(),
      };
    }
    await submitOrQueue(input);
  } catch (error) {
    await notify("采集失败", error instanceof Error ? error.message : "未知错误");
  }
});

async function submitOrQueue(input: CaptureInput): Promise<void> {
  try {
    await createCapture(input);
    await notify("已进入知识收件箱", input.sourceTitle ?? "采集成功");
  } catch {
    const queue = await getQueue();
    if (!queue.some((item) => item.clientCaptureId === input.clientCaptureId)) queue.push(input);
    await chrome.storage.local.set({ [RETRY_KEY]: queue });
    await notify("已离线保存", "后端可用后将自动重试");
  }
}

async function retryPending(): Promise<void> {
  const queue = await getQueue();
  if (!queue.length) return;
  const remaining: CaptureInput[] = [];
  for (const item of queue) {
    try { await createCapture(item); } catch { remaining.push(item); }
  }
  await chrome.storage.local.set({ [RETRY_KEY]: remaining });
}

async function getQueue(): Promise<CaptureInput[]> {
  const result = await chrome.storage.local.get(RETRY_KEY);
  return Array.isArray(result[RETRY_KEY]) ? result[RETRY_KEY] : [];
}

async function notify(title: string, message: string): Promise<void> {
  await chrome.notifications.create({ type: "basic", iconUrl: chrome.runtime.getURL("icon.svg"), title, message });
}

async function createCapture(input: CaptureInput): Promise<void> {
  const token = (await chrome.storage.local.get(TOKEN_KEY))[TOKEN_KEY];
  if (!token) throw new Error("Collector extension is not paired");
  const response = await fetch(`${API_BASE_URL}/v1/captures`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": input.clientCaptureId, "Authorization": `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`Capture API returned ${response.status}`);
}

function newClientCaptureId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
