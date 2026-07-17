# Collector 功能链路与 AI 依赖

状态：2026-07-17 共识基线。本文记录当前 MVP 的用户主链路、依赖等级与恢复路径。

## 图例

- `基础能力`：模型状态独立于该能力，始终可用；
- `AI 增强`：AI 提高效率或质量，基础路径持续可用；
- `AI 核心`：AI 负责交付该结果，界面保存现场并提供恢复操作；
- `文件解析`：确定性文件解析与渲染负责交付；
- `稳定锚点`：内容快照、段落、页码或文本位置负责来源返回。

## 当前主功能链路

```mermaid
flowchart TD
  classDef base fill:#E8F5E9,stroke:#2E7D32,color:#1B5E20,stroke-width:1.5px;
  classDef aiplus fill:#FFF8E1,stroke:#F9A825,color:#6D4C00,stroke-width:1.5px;
  classDef aicore fill:#FDECEC,stroke:#C62828,color:#7F0000,stroke-width:1.5px;
  classDef recovery fill:#ECEFF1,stroke:#546E7A,color:#263238,stroke-dasharray: 5 5;
  classDef parser fill:#E3F2FD,stroke:#1565C0,color:#0D47A1,stroke-width:1.5px;
  classDef anchor fill:#EDE7F6,stroke:#6A1B9A,color:#4A148C,stroke-width:1.5px;

  LAUNCH["用户双击 Collector<br/>基础能力"] --> LOCAL["启动本机服务并打开默认浏览器<br/>本地运行时"]
  LOCAL --> START{"用户如何开始？"}

  subgraph CHAT["一、从 Chat 开始"]
    C1["用户用自然语言表达当前关注内容<br/>基础能力"] --> C2["AI 生成回答或结构化内容<br/>AI 核心"]
    C2 -.->|需要恢复| C2F["保存用户输入，提供重试或切换模型<br/>恢复路径"]
    C2F -.-> C2
    C2 --> READ
  end

  subgraph IMPORT["二、从导入文档开始"]
    D1["导入 TXT / Markdown / DOCX / 文本型 PDF<br/>基础能力"] --> D2["立即显示处理状态和取消入口<br/>基础能力"]
    D2 --> D3["确定性解析并生成内部阅读视图<br/>文件解析"]
    D3 -.->|需要恢复| D3F["保留原文件、说明状态、提供手动粘贴或取消<br/>恢复路径"]
    D3 --> READ
    D3F -->|手动粘贴| READ
  end

  START -->|直接对话| C1
  START -->|导入文件| D1

  subgraph READING["三、统一阅读与选区"]
    READ["阅读当前内容：AI 回答、导入文档或分支内容<br/>基础能力"] --> PASS["理解当前内容并生成短概念候选<br/>AI 增强"]
    PASS --> WEAK["精确校验后从上到下显示弱标记<br/>稳定锚点"]
    WEAK -.->|解释术语| HOVER["悬停或点击后按需生成解释<br/>AI 核心"]
    READ --> SELECT["用户手动选中文字<br/>基础能力"]
    WEAK --> SELECT
    SELECT --> VALID{"选区质量状态<br/>确定性校验优先"}
    VALID -->|建议调整| INVALID["说明选区质量并给出调整建议<br/>基础能力"]
    INVALID --> READ
    VALID -->|可分析| POPOVER["就近打开固定字段窗口和加载占位<br/>基础能力"]
    POPOVER --> ANALYZE["逐段或逐字段补入概括、成本、时间、前置知识与上下文关系<br/>AI 核心"]
    ANALYZE -.->|需要恢复| ANALYZEF["保留原始选区和操作区，展示评估状态<br/>恢复路径"]
    ANALYZE --> CHOICE
    ANALYZEF --> CHOICE
  end

  subgraph ACTION["四、选区决策"]
    CHOICE{"用户选择下一步<br/>基础能力"}
    CHOICE -->|结束本次操作| CLOSE["回到当前内容<br/>基础能力"]
    CLOSE --> READ
    CHOICE -->|稍后再学| LATER["保存选区、来源、上下文和用户优先级<br/>基础能力"]
    LATER --> LIST["在侧边栏目集中展示<br/>基础能力"]
    LIST --> RESURFACE["根据用户设置、时间和当前相关性进行弱重现<br/>可解释规则"]
    RESURFACE -->|用户查看| RETURN["返回来源内容和原选区<br/>稳定锚点"]
    RETURN -.->|使用保存快照| RETURNF["展示保存原文和粗粒度位置<br/>恢复路径"]
    RETURN --> POPOVER
    RETURNF --> POPOVER
    CHOICE -->|深入研究| DEEP
  end

  subgraph BRANCH["五、深入研究"]
    DEEP["先保存来源关系与空分支<br/>基础能力"] --> DEST{"选择研究去向<br/>基础能力"}
    DEST -->|依附当前内容| B1["建立研究分支<br/>基础能力"]
    DEST -->|独立研究会话| B2["推荐少量研究方向<br/>AI 增强"]
    B2 -.->|用户路径| B2F["用户直接输入研究方向<br/>基础能力"]
    B2 --> B3["用户确认方向<br/>基础能力"]
    B2F --> B3
    B1 --> B4["生成第一轮研究内容<br/>AI 核心"]
    B3 --> B4
    B4 -.->|需要恢复| B4F["保留分支、方向和来源关系，提供重试<br/>恢复路径"]
    B4 --> BREAD["进入研究会话并保留来源返回入口<br/>基础能力"]
    B4F -.-> B4
    BREAD --> READ
  end

  class C1,D1,D2,READ,SELECT,INVALID,POPOVER,CHOICE,CLOSE,LATER,LIST,DEEP,DEST,B1,B2F,B3,BREAD base;
  class PASS,B2 aiplus;
  class C2,HOVER,ANALYZE,B4 aicore;
  class C2F,D3F,ANALYZEF,RETURNF,B4F recovery;
  class D3 parser;
  class WEAK,RETURN anchor;
  class LAUNCH,LOCAL base;
```

## 动态意图来源

AI 每次分析选区时，按当前可用信息组合判断：

1. 最近的用户明确表达；
2. 当前研究会话的必要上下文；
3. 当前正在阅读的内容；
4. 选区附近段落；
5. 用户已经明确执行的深入研究、稍后再学和优先级操作。

界面根据实际使用范围说明本次判断依据。

## 本地观测链路

Collector 为每次用户操作生成稳定关联 ID，并在本机串联保存：

```text
界面操作
→ 研究会话、当前内容与选区
→ 后台任务和处理步骤
→ 模型请求、流式回复与工具调用
→ 搜索查询、页面读取与引用选择
→ 用户可见结果、耗时、用量和错误
```

观测数据保留实际模型会话内容和搜索链路，排除供应商凭证、认证头和本地会话令牌。记录可以按会话、任务、错误和时间查看及导出，并在数据清理时与对应业务数据一起清理。

## 用户可见交付条件

- 双击启动后在默认浏览器打开本地 WebUI；
- WebUI 刷新后恢复已保存会话、阅读位置和任务状态；
- Chat 和导入文档作为并列入口；
- AI 回答、导入文档和研究分支使用同一套阅读与选区交互；
- 选区窗口立即显示固定结构、加载状态和主要操作；
- 稍后再学由用户设置优先级，并提供可解释的弱重现；
- 深入研究保存与来源内容和选区的双向关系；
- AI 弱标记聚焦短概念，以低注意力密度从上到下显示；
- 来源返回只在锚点可靠时高亮，并始终提供保存快照；
- AI 核心能力保存现场并提供重试或切换模型。
- 产品事件、模型会话与联网搜索形成可查看和导出的本地关联轨迹。
