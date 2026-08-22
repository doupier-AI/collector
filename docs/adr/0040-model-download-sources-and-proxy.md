---
status: accepted
---

# 语义模型下载源扩展 ModelScope 镜像并支持可选下载代理

2026-08-22 用户确认。实际使用中 huggingface.co 直连长期被阻断，hf-mirror.com 可达性随时间波动，两者同时不可达时标准/轻量档模型完全无法下载，且下载器无连接超时导致每个文件挂约 20 秒才失败、报错不指明网络原因，用户看到的是"卡死在 0 字节后下载失败"。

## 决策

- 允许的模型下载源在 huggingface.co、hf-mirror.com 之上增加 modelscope.cn 镜像。镜像安全性不基于信任主机，而基于逐文件与 ADR-0039 固定的 SHA-256/字节数完全一致（2026-08-22 逐文件核对：17 个资产中 16 个一致；`Xenova/bge-m3/config.json` 镜像内容不同，保留 HF 专用源）。每个镜像 URL 固定到该文件实际所在的 ModelScope commit。
- 下载源顺序为国内优先（hf-mirror.com → modelscope.cn → huggingface.co），首个成功的源在本次安装内保持优先（粘性源），避免每个文件重复支付不可达源的连接超时。
- 每个源尝试有界：响应头 20 秒内未到达即失败换源，传输中 60 秒无数据即判停滞换源。全部源均不可达时如实报告 `model-source-unreachable`，明确列出源并指引检查网络或配置代理，不再伪装成笼统的"下载失败"。
- 语义搜索设置提供"下载代理"：仅作用于模型下载请求（undici ProxyAgent 按请求注入，不改变全局网络行为，不影响聊天/研究等任何其他联网功能）；地址保存在本机 SQLite（`semantic_search_settings.download_proxy_url`，迁移 v40）；状态回显隐藏代理凭据；非法取值回退直连。

## Why

Collector 的主要用户网络无法直连 huggingface.co，这是长期现实而非偶发故障；单一镜像又引入了单点不可达。三级源 + 快速失败把"网络不可达"从不可诊断的挂起变成一句话可理解的失败；可选代理覆盖本机已有 Clash 等代理工具的用户。内容安全始终由固定摘要承担，扩展主机不降低完整性保证。

## Consequences

- 新增运行时依赖 `undici`（ProxyAgent）；SQLite 迁移 v40；共享契约新增 `set-download-proxy` 命令与状态 `downloadProxy` 字段（隐藏凭据）。
- 镜像 revision 与排除清单固定在 `apps/api/src/semantic-search/model-manifests.ts`，是该映射的唯一技术事实源；上游镜像文件若变化，固定摘要会使该文件自动回退其他源，不会安装错误内容。
- 代理是模型下载专用出口，不是产品级网络通道；聊天与研究模型的联网行为不变。
- 真实探针（`scripts/probe-model-download.mjs`）验证：直连路径 28.8s 完整安装轻量档（95,292,085 字节，与清单一致）；本地 CONNECT 代理路径 39.2s 完整安装且断言全部流量经代理隧道。
