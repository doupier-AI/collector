import type { AgentRunRecord, InboxItem, TopicWorkspace } from "@collector/capture-contracts";

const bridge = window.collector?.workspace;
if (!bridge) throw new Error("Collector workspace bridge is unavailable");
const list = document.querySelector<HTMLElement>("#collection-list")!;
const detail = document.querySelector<HTMLElement>("#detail")!;
const search = document.querySelector<HTMLInputElement>("#search")!;
const title = document.querySelector<HTMLElement>("#collection-title")!;
let data: Awaited<ReturnType<typeof bridge.load>> = { inbox: [], topics: [], relations: [] };
let mode: "inbox" | "topics" = "inbox";
let selectedId: string | undefined;

document.documentElement.dataset.collectorWorkspace = "ready";
document.querySelector("#nav-inbox")!.addEventListener("click", () => switchMode("inbox"));
document.querySelector("#nav-topics")!.addEventListener("click", () => switchMode("topics"));
document.querySelector("#refresh")!.addEventListener("click", () => void load());
document.querySelector("#new-capture")!.addEventListener("click", () => bridge.openCapture());
document.querySelector("#open-settings")!.addEventListener("click", () => bridge.openSettings());
search.addEventListener("input", renderList);
void load();

async function load() {
  try {
    data = await bridge.load();
    document.querySelector("#inbox-count")!.textContent = String(data.inbox.length);
    document.querySelector("#topic-count")!.textContent = String(data.topics.length);
    renderList();
    if (selectedId) await renderSelected();
  } catch (error) { showError(error); }
}
function switchMode(next: typeof mode) {
  mode = next; selectedId = undefined; search.value = "";
  title.textContent = next === "inbox" ? "收件箱" : "主题";
  document.querySelector("#nav-inbox")!.classList.toggle("active", next === "inbox");
  document.querySelector("#nav-topics")!.classList.toggle("active", next === "topics");
  renderList(); showEmpty();
}
function renderList() {
  list.replaceChildren();
  const query = search.value.trim().toLowerCase();
  if (mode === "inbox") {
    const items = data.inbox.filter((item) => captureLabel(item).toLowerCase().includes(query));
    for (const item of items) list.append(listButton(item.capture.id, captureLabel(item), item.capture.content || item.capture.sourceUrl || "文件采集", `${item.capture.captureType} · ${item.capture.status}`));
    if (!items.length) list.append(emptyList("没有匹配的采集内容"));
  } else {
    const topics = data.topics.filter((topic) => topic.title.toLowerCase().includes(query));
    for (const topic of topics) list.append(listButton(topic.id, topic.title, topic.origin === "ai_suggestion" ? "来自 AI 建议" : "用户创建", topic.status));
    if (!topics.length) {
      const box = emptyList("还没有主题"); const create = button("创建主题", "button primary", () => void createTopic()); box.append(create); list.append(box);
    }
  }
}
function listButton(id: string, heading: string, copy: string, meta: string) {
  const node = document.createElement("button"); node.className = `list-item${selectedId === id ? " active" : ""}`;
  node.append(el("strong", heading), el("p", copy), el("span", meta, "list-meta"));
  node.addEventListener("click", () => { selectedId = id; renderList(); void renderSelected(); }); return node;
}
async function renderSelected() {
  if (!selectedId) return showEmpty();
  if (mode === "inbox") {
    const item = data.inbox.find((entry) => entry.capture.id === selectedId);
    if (item) renderCapture(item);
  } else renderTopic(await bridge.getTopic(selectedId));
}
function renderCapture(item: InboxItem) {
  detail.replaceChildren();
  const header = div("detail-header"); const head = div();
  head.append(el("span", "CAPTURE", "eyebrow"), el("h2", item.capture.sourceTitle || captureLabel(item)));
  const badges = div("badges"); for (const value of [item.capture.captureType, `证据 ${item.capture.evidenceGrade}`, item.capture.preflight.processingLevel, item.capture.status]) badges.append(el("span", value, "badge"));
  header.append(head, badges); detail.append(header, el("div", item.capture.content || item.capture.sourceUrl || "内容保存在原始文件中。", "body-copy"));
  detail.append(section("引用片段", item.fragments.map((fragment) => card(fragment.text, `#${fragment.ordinal} · ${locatorText(fragment.locator)}`))));
  detail.append(section("知识条目", item.knowledgeItems.map((knowledge) => card(knowledge.content, `${knowledge.kind} · ${knowledge.origin}`))));
  detail.append(section("模型运行", (item.agentRuns ?? []).map((run) => renderRun(run, item))));
  const deepPending = (item.agentRuns ?? []).some((run) => run.processingLevel === "L3" && ["queued", "running"].includes(run.status));
  const deepButton = button(deepPending ? "深度分析已排队" : "运行深度分析", "button", async () => {
    if (!confirm("将使用 deepseek-v4-pro，成本高于标准整理。继续？")) return;
    await bridge.deepAnalysis(item.capture.id); await load();
  }); deepButton.disabled = deepPending || Boolean(item.capture.aiProcessingDisabled);
  detail.append(section("深度处理", [deepButton]));
  detail.append(section("审核建议", item.reviewProposals.map((proposal) => {
    const node = card(`${proposal.relationType} · ${proposal.rationale}`, `${Math.round(proposal.confidence * 100)}% · ${proposal.decision || "待审核"}`, "proposal");
    if (!proposal.decision) { const actions = div("actions"); for (const [label, decision] of [["接受","accepted"],["拒绝","rejected"],["稍后","deferred"]] as const) actions.append(button(label,"button",async()=>{await bridge.decide(proposal.id,decision);await load();})); node.append(actions); } return node;
  })));
  const relations = data.relations.filter((relation) => relation.sourceCaptureId === item.capture.id || relation.targetCaptureId === item.capture.id);
  detail.append(section("正式关系", relations.map((relation) => { const node=card(relation.relationType,`${relation.status} · v${relation.version}`); if(relation.status==="active")node.append(button("撤销","button danger",async()=>{await bridge.revoke(relation.id);await load();})); return node; })));
}
function renderRun(run: AgentRunRecord, item: InboxItem) {
  const style = run.status === "succeeded" ? "run-success" : run.status === "failed" ? "run-failed" : "run-active";
  const cost = run.estimatedCostUsd === undefined ? "cost n/a" : `$${run.estimatedCostUsd.toFixed(6)}`;
  const node = card(`${run.provider} / ${run.model}`, `${run.status} · ${run.latencyMs || 0}ms · ${run.inputTokens || 0}/${run.outputTokens || 0} tokens · ${cost}`, style);
  if (run.errorMessage) node.append(el("p", `${run.errorCode}: ${run.errorMessage}`));
  if (run.output) {
    const output = run.output as { summary?: string; topicSuggestions?: Array<{ title: string; text: string; fragmentIds: string[] }> };
    if (output.summary) node.append(el("p", output.summary));
    for (const suggestion of output.topicSuggestions ?? []) {
      const action = button(`创建主题：${suggestion.title}`, "button", async () => { const topic=await bridge.createSuggestedTopic({ title:suggestion.title,sourceCaptureId:item.capture.id,sourceAgentRunId:run.id,evidenceFragmentIds:suggestion.fragmentIds }); mode="topics";selectedId=topic.id;await load(); });
      node.append(action);
    }
  }
  return node;
}
function renderTopic(workspace: TopicWorkspace) {
  detail.replaceChildren(); const hero=div("topic-hero"); const heading=div(); heading.append(el("span","TOPIC","eyebrow"),el("h2",workspace.topic.title));
  const actions=div("actions"); actions.append(button("重命名","button",async()=>{const value=prompt("主题名称",workspace.topic.title);if(value?.trim()){await bridge.updateTopic(workspace.topic.id,{title:value.trim()});await load();}}),button(workspace.topic.status==="active"?"归档":"恢复","button",async()=>{await bridge.updateTopic(workspace.topic.id,{status:workspace.topic.status==="active"?"archived":"active"});await load();})); hero.append(heading,actions); detail.append(hero);
  const available=data.inbox.filter((item)=>!workspace.captures.some((member)=>member.capture.id===item.capture.id));
  if(available.length){const add=button("添加采集内容","button primary",async()=>{const id=prompt(`输入 Capture ID：\n${available.slice(0,5).map((item)=>`${item.capture.id}  ${captureLabel(item)}`).join("\n")}`);if(id){await bridge.addTopicMember(workspace.topic.id,id.trim());await load();}});detail.append(section("成员管理",[add]));}
  detail.append(section(`成员 · ${workspace.captures.length}`,workspace.captures.map((item)=>{const node=div("card member");const copy=div("member-copy");copy.append(el("strong",captureLabel(item)),el("p",(item.capture.content||item.capture.sourceUrl||"文件采集").slice(0,180)));node.append(copy,button("移除","button danger",async()=>{await bridge.removeTopicMember(workspace.topic.id,item.capture.id);await load();}));return node;})));
  detail.append(section(`正式关系 · ${workspace.relations.length}`,workspace.relations.map((relation)=>card(relation.relationType,`${relation.sourceCaptureId}${relation.targetCaptureId?` → ${relation.targetCaptureId}`:""}`))));
}
async function createTopic(){const value=prompt("主题名称");if(!value?.trim())return;const topic=await bridge.createTopic(value.trim());selectedId=topic.id;await load();}
function captureLabel(item: InboxItem){return item.capture.sourceTitle || item.capture.content?.replace(/\s+/g," ").slice(0,72) || item.capture.sourceUrl || item.capture.note || "文件采集";}
function locatorText(locator: InboxItem["fragments"][number]["locator"]){if(!locator)return"无定位";if(locator.kind==="file")return `${locator.fileName}${locator.pageNumber?` · 第 ${locator.pageNumber} 页`:""}`;if(locator.kind==="text")return `第 ${locator.startLine}-${locator.endLine} 行`;if(locator.kind==="browser")return locator.pageUrl;return locator.sourceLabel||"用户提供";}
function section(heading:string,nodes:HTMLElement[]){const root=div("section");const top=div("section-title");top.append(el("h3",heading));root.append(top,...nodes);if(!nodes.length)root.append(el("p","暂无内容","card-meta"));return root;}
function card(copy:string,meta:string,className=""){const node=div(`card ${className}`);node.append(el("div",meta,"card-meta"),el("p",copy));return node;}
function button(label:string,className:string,action:()=>void|Promise<void>){const node=document.createElement("button");node.type="button";node.className=className;node.textContent=label;node.addEventListener("click",()=>void action());return node;}
function div(className=""){const node=document.createElement("div");node.className=className;return node;}
function el<K extends keyof HTMLElementTagNameMap>(name:K,text:string,className=""){const node=document.createElement(name);node.className=className;node.textContent=text;return node;}
function emptyList(copy:string){return el("div",copy,"empty-list");}
function showEmpty(){detail.innerHTML='<div class="empty-state"><span class="empty-glyph">⌘</span><h2>选择一条内容</h2><p>查看原文、引用、模型运行和审核建议。</p></div>';}
function showError(error:unknown){detail.replaceChildren(el("div",error instanceof Error?error.message:"加载失败","empty-state"));}

export {};
