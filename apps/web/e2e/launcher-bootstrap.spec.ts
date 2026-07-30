import { expect, test } from "@playwright/test";
import { readLauncherControlToken } from "./helpers";

test("启动器一次性入口自动配对，URL 不含令牌且 Cookie 不可被页面读取", async ({ page }, testInfo) => {
  const baseUrl = String(testInfo.project.use.baseURL);
  const apiPort = Number(new URL(baseUrl).port);
  const launcherToken = await readLauncherControlToken(apiPort);
  const bootstrapResponse = await fetch(`${baseUrl}/v1/launcher/bootstrap`, {
    method: "POST",
    headers: { Authorization: `Bearer ${launcherToken}`, "Content-Type": "application/json" },
    body: "{}",
  });
  expect(bootstrapResponse.status).toBe(201);
  const bootstrap = await bootstrapResponse.json() as { url: string };
  const bootstrapUrl = new URL(bootstrap.url);
  expect(bootstrapUrl.hostname).toBe("127.0.0.1");
  expect(bootstrapUrl.search).toBe("");
  expect(bootstrapUrl.hash).toBe("");

  const consoleProblems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") consoleProblems.push(message.text());
  });
  page.on("pageerror", (error) => consoleProblems.push(error.message));
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));

  await page.goto(bootstrap.url);
  await expect(page).toHaveURL(`${baseUrl}/`);
  await expect(page.getByRole("heading", { name: "从一个问题开始" })).toBeVisible();
  await expect(page.getByLabel("配对码")).toHaveCount(0);
  expect(await page.evaluate(() => document.cookie)).not.toContain("collector_session");

  const sessions = await page.request.get("/v1/research-sessions");
  expect(sessions.status()).toBe(200);
  expect(consoleProblems).toEqual([]);
  const productRequests = requests.filter((value) => {
    const url = new URL(value);
    return url.port === String(apiPort);
  });
  expect(productRequests.length).toBeGreaterThan(0);
  expect(productRequests.every((value) => new URL(value).origin === baseUrl)).toBe(true);
});
