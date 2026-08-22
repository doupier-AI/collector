# 研究学习材料解析候选对比

> 对应 Wayfinder 研究票据：[issue #121](https://github.com/doupier-AI/collector/issues/121)。
>
> 调研日期：2026-08-23。资料只使用候选项目的官方文档、官方仓库、原始论文和许可证原文。本文是候选与基准建议，**不是**对正式解析后端、依赖或产品行为的决定。

## 结论先行

Collector 当前的解析器适合轻量、可复制文字的 TXT、Markdown、DOCX 和 PDF：它本地运行、启动快、没有额外模型下载，但 PDF 只得到按页拼接的文字和页码，不能可靠表达双栏阅读顺序、扫描件、表格、公式、图片或矩形位置。[当前 PDF 实现](../../../apps/api/src/parsers.ts) 使用 PDF.js 的 `getTextContent()` 按页面拼接文字；[当前 DOCX 实现](../../../apps/api/src/research-import.ts) 用 Mammoth 的 HTML 转换结果生成段落块。这个判断也与现行产品基线一致：文本型 PDF 只提供正文快照与页码锚点，不复原版式。

本轮不应预选“替换者”。进入固定样本基准的短名单应为：

1. **现有 Collector 路径**：始终保留为轻量、零模型下载的对照和失败降级基线。
2. **Docling**：优先检验其统一文档对象、结构化导出和元素级来源定位，最贴近“可追溯 RAG”的目标；其代码为 MIT，但模型/依赖与资源仍需逐项实测。
3. **MinerU**：优先检验中文、扫描件、公式、复杂论文版式；能力覆盖广，但它不是无条件的开源即插即用方案：有自定义许可证附加条件，且官方最低配置为 16GB RAM、2–20GB 磁盘并可能需要 2–8GB VRAM。
4. **Unstructured**：作为“元素 + 元数据 + 可选高分辨率/OCR”路径的对照，重点检验其坐标、层级与失败退化；它是 Python 运行时，表格/OCR 路径的模型与资源不能由核心 Apache-2.0 许可证推断。
5. **MarkItDown**：作为轻量多格式 Markdown 转换的对照，不把它当成复杂论文版式的默认答案。官方明确其产物主要面向文本分析工具，未承诺高保真阅读还原；OCR/图像理解依赖可选插件或外部模型。

RAGFlow/deepdoc 与 RAG-Anything只用来提醒后续架构应当把“原始文件、结构化块、媒体资产、定位信息、检索切片”分层保存；它们不是 Collector 的候选运行时，也不进入本轮比较。

## 当前基线与评价口径

Collector 的可读正文是唯一事实源，派生定位或结构失败不能阻塞阅读。因此候选输出不能只比较“导出了多少 Markdown”，还必须比较能否保存为稳定的结构化内容块，并让引用回到原始文件。

| 维度 | 现有 Collector 基线 | 本次候选必须证明的改善 |
| --- | --- | --- |
| 可复制 PDF | PDF.js 每页抽取文字、压缩空白，输出页码锚点 | 阅读顺序与段落/标题关系不被破坏，能解释错误页 |
| 扫描 PDF | 无 OCR，通常得到空内容 | 明确检出、OCR、置信/失败分类与诚实降级 |
| DOCX / Markdown | Mammoth 生成 HTML 后提取标题、段落、列表、表格行；Markdown 有行和块锚点 | 不退化现有标题、表格与来源返回能力 |
| 定位 | PDF 仅 `pageNumber`；Markdown 行范围；DOCX 段落序号 | 需要页面坐标框（bbox）且保留坐标系、页尺寸、元素/字符范围和原文校验信息 |
| 任务行为 | 导入任务已有任务记录、幂等键、失败状态和可重试恢复 | 批处理、重跑、部分失败和版本更新能接入同一任务语义；不得把一次解析结果静默覆盖另一版本 |

为避免把“看起来像正文”的 Markdown 误认为来源事实，后续接口至少应能表达：输入文件内容哈希、解析器及版本、块类型、可读文本或结构载荷、稳定块 ID、页码、bbox/坐标系（若有）、父级/标题路径、媒体资产引用、失败分类。字段形状留给后续决策，不在本文预先确定。

## 候选能力与集成对比

“支持”表示官方资料明确列出能力，并不等于对 Collector 的样本已经验证。“待实测”表示官方资料没有给出可转用的、与本机 Windows 产品相同的质量或资源证据。

| 路径 | 中英与可复制/扫描 PDF | 版式与结构 | 定位和输出 | 批处理、失败与本地集成 | Windows、资源与离线 |
| --- | --- | --- | --- | --- |
| **当前 Collector** | 可复制 PDF 仅文本层；扫描 PDF 无 OCR | 不重建双栏阅读顺序；DOCX/Markdown 有基本标题/段落/列表/表格块 | PDF 页码；Markdown 行；DOCX 段落；内部 `ResearchContentBlock` | 已有本机任务、重试和恢复；无需额外服务 | Node 24 路径；CPU；无模型下载；资源最低 |
| **MinerU** | 官方称支持扫描/乱码 PDF 自动 OCR、109 种 OCR 语言，适合把中英文都纳入样本 | 单/多栏与复杂布局、标题、表格 HTML、公式 LaTeX、图片/图表、跨页表格均为官方声明 | Markdown、JSON、按阅读顺序 JSON、丰富中间格式和可视化结果；本轮需确认其输出是否稳定保留每个元素页码/bbox | CLI、Python/Go/TypeScript SDK、REST API、Docker；官方有异步任务 API、流式落盘和并发能力，但其幂等语义须实测 | 官方列 Windows；Python 3.10–3.13（Windows 为 3.10–3.12）；pipeline 可 CPU。官方最低 RAM 16GB、磁盘 20GB（pipeline）/2GB（VLM 客户端），VRAM 4GB/8GB/2GB 随后端而异；模型可预下载并设本地源 |
| **Docling** | PDF、图像、DOCX 等输入，OCR 是可配置流水线能力；中英文、扫描页的实际质量待固定样本 | 官方称统一 `DoclingDocument` 含标题、段落、公式、表格、图片，提供阅读顺序与版面分析 | 可导出 Markdown、JSON、HTML；`ProvenanceItem` 有页码、bbox、字符范围，表格单元格也可含 bbox | Python API/CLI；应通过一个受控子进程或本机服务边界接入。批任务、失败分类、重跑与增量更新必须实测而非从转换 API 推断 | 官方说明可离线，只需预先保存模型工件并指向路径；Python 运行时和首次模型下载存在。官方资料未给本任务可直接采用的 Windows/CPU/GPU/RAM/VRAM/磁盘基线，全部纳入 #124 |
| **Unstructured** | PDF 有 `fast`、`hi_res`、`ocr_only` 等策略；OCR 语言可配置。可复制/扫描中英文表现待实测 | 输出元素类型与父子层级；`hi_res` 可推断表结构。公式、图片的研究论文质量不能由“元素”能力推断 | 元素 JSON；元素元数据可含页码、bbox 坐标、层级、图片路径/MIME。分块会丢失部分元素级来源，需先保留原元素 | Python 本地库；官方将开源库定位为原型起点。批处理、幂等和部分失败需由 Collector 任务层提供并测试 | Python 3.9+；官方给出 Windows `uv` 安装路线。`hi_res`/OCR 依赖推理组件和模型，官方未给可转用资源基线；离线模型缓存、CPU/GPU、下载大小进入 #124 |
| **MarkItDown** | PDF/DOCX 等转 Markdown；图片 OCR/描述依赖可选 OCR 插件与配置的视觉模型，不能视为默认离线 OCR | 目标是保留标题、列表、表格、链接等 Markdown 结构；官方同时说明它不一定适合人类高保真阅读 | 主输出为 Markdown 文本；未见与 Docling/Unstructured 同等级、面向 PDF 元素的页+bbox 契约 | Python 库/CLI，按文件调用；必须由 Collector 外层提供文件哈希、幂等、超时、取消、隔离和失败分类 | Python 3.10+；可选依赖按格式安装。官方未公布本机资源基线；若 OCR/图像描述接外部模型，就不满足无网络默认要求 |

### 候选的官方证据

- MinerU 的 [官方仓库](https://github.com/opendatalab/MinerU) 说明其 PDF/图像/DOCX/PPTX/XLSX 输入、Markdown/JSON 输出、扫描件 OCR、表格 HTML、公式 LaTeX、图片、阅读顺序与 Windows/CPU/GPU 运行方式；同页给出后端的 RAM、VRAM、磁盘和 Python 版本表。其 [模型来源文档](https://opendatalab.github.io/MinerU/usage/model_source/) 明确 Hugging Face / ModelScope / 本地模型三种来源与首次下载后的本地使用方式；其[原始论文](https://arxiv.org/abs/2409.18839)是早期方法背景，不替代当前版本的产品文档。
- Docling 的 [支持格式文档](https://docling-project.github.io/docling/usage/supported_formats/) 说明它以统一文档表示处理多种格式；[文档对象参考](https://docling-project.github.io/docling/reference/docling_document/) 定义了文本、公式、表格、图片及 `ProvenanceItem(page_no, bbox, charspan)`；[离线 FAQ](https://docling-project.github.io/docling/faq/) 说明模型工件预存后可离线运行；[技术报告](https://arxiv.org/abs/2408.09869)说明其版面和表格模型背景。
- Unstructured 的 [分区策略文档](https://docs.unstructured.io/open-source/concepts/partitioning-strategies) 列出 PDF 的 `auto`、`fast`、`hi_res`、`ocr_only`；[元素与元数据文档](https://docs.unstructured.io/open-source/concepts/document-elements) 定义元素、层级、页码与 bbox 坐标；[表格提取文档](https://unstructured.readthedocs.io/en/latest/best_practices/table_extraction_pdf.html) 要求 `hi_res` 才推断 PDF 表格结构；[开源快速开始](https://docs.unstructured.io/open-source/introduction/quick-start) 将其定位为本地 Python 原型起点。
- MarkItDown 的 [官方仓库](https://github.com/microsoft/markitdown) 和[支持格式文档](https://microsoft-markitdown.mintlify.app/formats/overview)列出 PDF、Word、图片等及 Markdown 目标；仓库的安全说明要求调用者限制不受信任输入，且 OCR 插件以调用者提供的视觉模型工作。

## 许可证、模型与供应链边界

许可证结论只针对指定仓库当前文本；任何正式采用前必须锁定到具体版本、解析器后端、模型工件和分发方式，并让法律/发行负责人复核。

| 候选 | 主代码许可证 | 直接影响 | 模型与第三方依赖的待核验项 |
| --- | --- | --- | --- |
| 当前 Collector | 已有 Node 依赖路径，不在本票据重判 | 不新增运行时 | PDF.js、Mammoth 及其现行锁定版本仍随现有依赖审计 |
| MinerU | [MinerU Open Source License 原文](https://github.com/opendatalab/MinerU/blob/master/LICENSE.md)：基于 Apache-2.0，附加条款要求在线服务显著标识；MAU 超过 1 亿或月收入超过 2,000 万美元时需另取商业许可 | 即使只作为本机产品候选，也必须评估将来线上功能是否触发标识义务；不得称为“纯 Apache-2.0” | 主许可证**不**覆盖模型和所有依赖的可分发性。逐项锁定 pipeline/VLM 后端、OCR、公式、表格、版面模型及其权重卡、pypdfium2/Paddle 等依赖；验证本地缓存与安装包能否合法分发 |
| Docling | [MIT 许可证原文](https://raw.githubusercontent.com/docling-project/docling/main/LICENSE) | 主代码的整合限制较低 | Docling 的版面、表格、OCR 模型及模型下载来源须按实际启用工件逐项核验；不能把 MIT 外推到权重和可选 OCR 引擎 |
| Unstructured | [Apache-2.0 许可证原文](https://raw.githubusercontent.com/Unstructured-IO/unstructured/main/LICENSE.md) | 主代码允许商用整合并有 NOTICE/保留声明义务 | `hi_res`、OCR、表格和图像路径会带来额外推理包、模型或二进制；按最终 `partition_pdf` 策略和依赖锁逐项核验 |
| MarkItDown | [官方仓库标注 MIT](https://github.com/microsoft/markitdown) | 主代码的整合限制较低 | 可选格式转换器、OCR 插件与用户配置的视觉模型/服务分别核验；外部视觉模型会改变隐私、费用与离线承诺 |

特别提醒：MinerU 在 2026 年将仓库许可从 AGPLv3 改为上述自定义许可，不能用历史 AGPL 印象做决定；同样也不能因为它“支持 Windows”就断言它适合 Collector 的轻量本地启动体验。[许可证原文](https://github.com/opendatalab/MinerU/blob/master/LICENSE.md) 与[官方部署资源表](https://github.com/opendatalab/MinerU)是本结论的依据。

## 建议的基准短名单与运行方式

### #122：固定样本与人工金标准

以下五条路径进入同一套匿名公开或确定性生成样本；不使用用户私人材料。

| 组别 | 运行路径 | 用途 |
| --- | --- | --- |
| 基线 | 当前 PDF.js / Mammoth / Markdown | 显示新增复杂运行时到底带来哪些可见改善，也验证原有简单文件不回归 |
| 结构与定位重点 | Docling（本地、预下载模型与离线重跑各一次） | 验证块、表格/公式/图片和页+bbox 来源契约是否完整 |
| 复杂论文重点 | MinerU pipeline（CPU）与资源允许时的高准确后端 | 验证中英扫描、双栏、公式、跨页表格与本地资源上限 |
| 元素管线重点 | Unstructured `fast` 与 `hi_res`/OCR | 观察策略切换是否能诚实处理简单文本和复杂扫描件 |
| 轻量多格式对照 | MarkItDown 标准 PDF/DOCX 转换 | 验证以 Markdown 为主的速度、结构和失败边界，不把可选外部 OCR 当默认能力 |

人工金标准至少分别标注：逐块阅读顺序、标题层级、页码与可见矩形、表格单元格和跨页关系、公式的可读形式、图片/图表资产及题注、脚注/参考文献归属、扫描/OCR 错误、不可解析/加密/损坏文件的预期失败。该资产属于 [#122](https://github.com/doupier-AI/collector/issues/122)，本文不创建样本或评分结果。

### #124：质量、资源与任务语义

在同一 Windows 机器、固定候选版本、固定模型缓存状态下，至少测量：

- 冷/热 p50、p95、吞吐、峰值 RAM/VRAM、磁盘占用、首次下载体积与时间；CPU 与可用 GPU 分开记录。
- 文本保真、阅读顺序、标题、表格、公式、图片、页+bbox 定位命中率；不能把不同项目的官方 benchmark 直接横比。
- 单文件、多文件、重复同字节文件、同名改内容、取消、超时、部分失败、解析器崩溃、断网/离线重跑、缓存损坏和重启恢复。
- 输出版本是否由输入哈希 + 解析器版本 + 配置哈希唯一确定；若候选本身不提供幂等，必须由 Collector 的既有导入任务层提供。

这些数据与“是否足以引入 Python 子进程/本机服务”的取舍由 [#124](https://github.com/doupier-AI/collector/issues/124) 解决。本文没有、也不应伪造资源数字或质量排名。

## 需由后续票据裁决的未知项

| 未知项 | 为什么不能在文档研究中决定 | 所属票据 |
| --- | --- | --- |
| 何种样本和人工评分才代表论文、教材、技术报告的真实价值 | 是用户可见质量标准，必须看固定样本和金标准，而非厂商功能列表 | [#122](https://github.com/doupier-AI/collector/issues/122) |
| 哪个候选在当前 Windows 设备上达到可接受的准确、时间、内存、显存、磁盘和离线成本 | 官方声明与不同设备/版本不可直接横比，需隔离实测 | [#124](https://github.com/doupier-AI/collector/issues/124) |
| MinerU 具体后端、模型权重、OCR/公式/表格组件的许可证与再分发权限 | 取决于实际锁定版本和启用功能；仓库主许可证不足以回答 | #124 先出实际组件清单，随后进入解析架构决策 |
| 是否把 bbox、表格单元格、公式和图片提升为长期共享契约 | 这是跨 API、存储、阅读和来源返回的产品/架构决定，需先有样本证据 | #122、#124 后的“决定解析后端、结构化文档块与本地部署边界”票据 |
| Python 怎样隔离于 Node 24 产品：每次子进程、常驻 loopback 服务、还是可选外部服务 | 影响启动、升级、崩溃恢复、安装包、隐私和观测，不能由解析器 README 决定 | #124 后的架构决策票据 |

## 本地优先风险与架构参考

### Collector 需要守住的风险边界

- **启动与下载不能劫持阅读。** 高能力候选的首次依赖/模型下载必须显式、可查看、可取消；没有模型、离线或子进程失败时，简单文本路径仍需完成导入并如实说明能力降级。
- **不把原文件交给隐式云服务。** MarkItDown 的可选视觉模型和任何远程 MinerU/Docling/Unstructured 部署都不是本地默认。若以后提供远程选项，必须是用户可见、逐次授权的不同路径。
- **子进程是故障边界，不是数据库边界。** Python 解析器只能接收临时受控输入并返回结构化结果；SQLite、认证、文件权限、幂等、取消、恢复和来源版本继续由现有 API/导入任务掌管。
- **保留原件和版本。** Markdown 是阅读投影，不应成为表格、公式、图片或 bbox 的唯一事实；重解析生成新版本，旧引用仍要能说明自己指向何处或诚实标为失效。
- **控制资源与磁盘。** MinerU 的官方最低配置已足以影响普通 Windows 用户；任何候选都需要队列并发上限、大小/页数限制、超时、缓存位置、下载预算和清理策略，不能在首次导入时无提示消耗大量资源。
- **隔离不受信任文件。** MarkItDown 官方提醒转换器以当前进程权限进行 I/O。解析输入必须继续经过现有文件大小、格式和压缩包防护；新运行时不得获得宽泛用户目录或网络凭证访问权。

### 仅作架构参考的外部项目

[RAGFlow 官方仓库](https://github.com/infiniflow/ragflow) 展示了“文档解析、可解释切片、检索、多路召回和重排”可分层组合，并强调可追溯引用；其完整自托管服务需要 Docker、搜索/存储组件和至少 16GB RAM，因此不应直接搬入 Collector。

[RAG-Anything 官方仓库](https://github.com/HKUDS/RAG-Anything) 代表多模态 RAG 的研究方向：文本以外的表格、公式、图片要保留为独立可检索对象。它只支持本研究中的“结构化块和媒体资产不应被压成纯文本”这一架构提醒；不构成采用其框架、知识图谱或部署方式的建议。

## 资料索引

- [Collector 当前 PDF 解析](../../../apps/api/src/parsers.ts)、[Collector 当前导入/DOCX 解析](../../../apps/api/src/research-import.ts)、[共享内容锚点契约](../../../packages/capture-contracts/src/index.ts)
- [MinerU 官方仓库](https://github.com/opendatalab/MinerU)、[MinerU 许可证原文](https://github.com/opendatalab/MinerU/blob/master/LICENSE.md)、[MinerU 模型来源](https://opendatalab.github.io/MinerU/usage/model_source/)、[MinerU 2024 原始论文](https://arxiv.org/abs/2409.18839)
- [Docling 官方仓库](https://github.com/docling-project/docling)、[支持格式](https://docling-project.github.io/docling/usage/supported_formats/)、[DoclingDocument 与 provenance](https://docling-project.github.io/docling/reference/docling_document/)、[离线 FAQ](https://docling-project.github.io/docling/faq/)、[MIT 原文](https://raw.githubusercontent.com/docling-project/docling/main/LICENSE)、[技术报告](https://arxiv.org/abs/2408.09869)
- [Unstructured 官方仓库](https://github.com/Unstructured-IO/unstructured)、[PDF 分区策略](https://docs.unstructured.io/open-source/concepts/partitioning-strategies)、[元素/坐标元数据](https://docs.unstructured.io/open-source/concepts/document-elements)、[PDF 表格](https://unstructured.readthedocs.io/en/latest/best_practices/table_extraction_pdf.html)、[Apache-2.0 原文](https://raw.githubusercontent.com/Unstructured-IO/unstructured/main/LICENSE.md)
- [MarkItDown 官方仓库](https://github.com/microsoft/markitdown)、[支持格式](https://microsoft-markitdown.mintlify.app/formats/overview)
- [RAGFlow 官方仓库](https://github.com/infiniflow/ragflow)、[RAG-Anything 官方仓库](https://github.com/HKUDS/RAG-Anything)
