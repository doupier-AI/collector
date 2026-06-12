const API_BASE_URL = "http://127.0.0.1:43110";
const TOKEN_KEY = "collector:auth-token";

const form = document.querySelector<HTMLFormElement>("form")!;
const code = document.querySelector<HTMLInputElement>("#code")!;
const status = document.querySelector<HTMLElement>("#status")!;

void refresh();
form.addEventListener("submit", (event) => { event.preventDefault(); void pair(); });

async function refresh() {
  const token = (await chrome.storage.local.get(TOKEN_KEY))[TOKEN_KEY];
  status.textContent = token ? "已配对，可以使用网页右键采集。" : "尚未配对。请从桌面端生成配对码。";
}

async function pair() {
  const value = code.value.trim();
  if (!/^\d{6}$/.test(value)) { status.textContent = "请输入 6 位配对码。"; return; }
  status.textContent = "正在配对...";
  try {
    const response = await fetch(`${API_BASE_URL}/v1/pairings/exchange`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: value }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.token) throw new Error(payload.error?.message ?? "配对失败");
    await chrome.storage.local.set({ [TOKEN_KEY]: payload.token });
    code.value = "";
    status.textContent = "配对成功，可以使用网页右键采集。";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "配对失败";
  }
}

export {};
