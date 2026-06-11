export const inboxPage = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Collector Inbox</title>
  <style>
    :root { font: 15px/1.55 "Segoe UI", sans-serif; color: #172033; background: #f4f6fa; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    header { position: sticky; top: 0; z-index: 2; display: flex; justify-content: space-between; align-items: center; padding: 18px max(24px, calc((100vw - 980px) / 2)); background: #ffffffed; border-bottom: 1px solid #dce3ed; backdrop-filter: blur(12px); }
    h1 { margin: 0; font-size: 22px; } header p { margin: 2px 0 0; color: #667085; }
    main { max-width: 980px; margin: 26px auto; padding: 0 24px 60px; }
    .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; color: #667085; }
    button { border: 1px solid #cbd5e1; border-radius: 8px; background: white; padding: 7px 11px; cursor: pointer; }
    .items { display: grid; gap: 14px; }
    article { background: white; border: 1px solid #dce3ed; border-radius: 12px; padding: 17px; box-shadow: 0 6px 20px #1720330a; }
    .meta { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 10px; color: #667085; font-size: 13px; }
    .tag { border-radius: 999px; padding: 2px 8px; background: #eef2ff; color: #3730a3; }
    .grade-A { background: #dcfce7; color: #166534; } .grade-D { background: #fee2e2; color: #991b1b; }
    .content { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0; }
    .source { color: #2563eb; text-decoration: none; overflow-wrap: anywhere; }
    .proposal { margin-top: 13px; padding-top: 12px; border-top: 1px solid #e5e7eb; }
    .proposal-actions { display: flex; gap: 7px; margin-top: 8px; }
    .empty, .error { padding: 50px 20px; text-align: center; color: #667085; background: white; border: 1px dashed #cbd5e1; border-radius: 12px; }
    .error { color: #b42318; }
  </style>
</head>
<body>
  <header><div><h1>Collector Inbox</h1><p>采集内容、证据等级与关系建议</p></div><button id="refresh">刷新</button></header>
  <main><div class="toolbar"><span id="summary">正在加载...</span></div><section class="items" id="items"></section></main>
  <script>
    const items = document.querySelector("#items");
    const summary = document.querySelector("#summary");
    document.querySelector("#refresh").addEventListener("click", load);

    async function load() {
      summary.textContent = "正在加载...";
      items.replaceChildren();
      try {
        const response = await fetch("/v1/inbox");
        if (!response.ok) throw new Error("HTTP " + response.status);
        const data = await response.json();
        summary.textContent = "共 " + data.length + " 条采集";
        if (!data.length) return showMessage("收件箱为空。请通过悬浮窗或浏览器扩展采集内容。", "empty");
        for (const item of data) items.append(renderItem(item));
      } catch (error) {
        summary.textContent = "加载失败";
        showMessage("无法读取收件箱：" + error.message, "error");
      }
    }

    function renderItem(item) {
      const article = document.createElement("article");
      const meta = element("div", "meta");
      meta.append(
        tag(item.capture.captureType),
        tag("证据 " + item.capture.evidenceGrade, "grade-" + item.capture.evidenceGrade),
        tag(item.capture.preflight.processingLevel),
        document.createTextNode(new Date(item.capture.createdAt).toLocaleString())
      );
      article.append(meta);
      if (item.capture.sourceTitle) article.append(element("strong", "", item.capture.sourceTitle));
      const text = item.capture.content || item.capture.note || "(仅保存来源或文件，尚无可显示正文)";
      article.append(element("div", "content", text));
      if (item.capture.sourceUrl) {
        const link = element("a", "source", item.capture.sourceUrl);
        link.href = item.capture.sourceUrl; link.target = "_blank"; link.rel = "noreferrer";
        article.append(link);
      }
      for (const proposal of item.reviewProposals) article.append(renderProposal(proposal));
      return article;
    }

    function renderProposal(proposal) {
      const box = element("div", "proposal");
      box.append(element("strong", "", "关系建议：" + proposal.relationType));
      box.append(element("div", "", proposal.rationale + " · 置信度 " + Math.round(proposal.confidence * 100) + "%"));
      if (proposal.decision) {
        box.append(element("div", "meta", "已处理：" + proposal.decision));
        return box;
      }
      const actions = element("div", "proposal-actions");
      for (const [label, decision] of [["接受", "accepted"], ["拒绝", "rejected"], ["暂缓", "deferred"]]) {
        const button = element("button", "", label);
        button.addEventListener("click", async () => {
          button.disabled = true;
          await fetch("/v1/review-proposals/" + proposal.id + "/decision", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision })
          });
          await load();
        });
        actions.append(button);
      }
      box.append(actions);
      return box;
    }

    function tag(text, extra = "") { return element("span", "tag " + extra, text); }
    function element(name, className = "", text = "") {
      const node = document.createElement(name);
      node.className = className;
      node.textContent = text;
      return node;
    }
    function showMessage(text, kind) { items.append(element("div", kind, text)); }
    load();
  </script>
</body>
</html>`;
