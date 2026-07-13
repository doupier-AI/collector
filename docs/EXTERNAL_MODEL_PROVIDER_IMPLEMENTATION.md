# 外部模型供应商实施与验证

日期：2026-07-13  
状态：已实施，等待真实凭证人工验收

## 1. 产品边界

- Collector 不下载、部署或运行本地模型。
- 用户可以保存多个外部供应商 Profile，但任意时刻只有一个活动 Profile。
- DeepSeek 与 OpenAI、Anthropic、OpenRouter、阿里云百炼及自定义端点使用同一套配置、凭证、路由、用量和错误处理流程。
- Fake Provider 仅供自动化测试，不进入设置页或生产运行路径。

## 2. 分阶段实施

| 阶段 | 实施内容 | 验证门槛 | 状态 |
| --- | --- | --- | --- |
| 1. 契约与注册表 | Provider Definition、Profile、能力声明、OpenAI 与 Anthropic 协议适配 | 注册表校验、请求翻译、响应与 token 映射单测 | 完成 |
| 2. 持久化与凭证 | SQLite Profile、活动 Profile、通用凭证文件、旧 DeepSeek 配置迁移 | 重启持久化、四种 safeStorage 组合、清除数据一致性 | 完成 |
| 3. 运行时路由 | Profile 解析为 Model Gateway；WorkflowRun 冻结无密钥路由 | 切换活动供应商后，排队任务仍使用原路由 | 完成 |
| 4. 用量与预算 | 按 provider/model 聚合；未知定价显式标记 | 未知费用不计作零费用，严格预算停止新 AI 工作流 | 完成 |
| 5. 产品入口 | Electron IPC 三层同步；供应商列表、编辑、测试、启用、删除 | TypeScript 构建、IPC/DOM 检查、完整重启 GUI smoke | 完成 |
| 6. 兼容退出 | 旧 Key 与设置一次迁移；移除 DeepSeek 专用 UI/IPC/运行参数 | 旧数据迁移幂等，新安装不自动创建 DeepSeek Profile | 完成 |

## 3. 内置与自定义供应商

内置定义固定官方 Base URL，模型字段允许用户覆盖：

- DeepSeek：OpenAI Chat Completions；
- OpenAI：OpenAI Chat Completions；
- OpenRouter：OpenAI Chat Completions；
- Anthropic：原生 Messages；
- Alibaba Cloud Model Studio：OpenAI-compatible 北京公共端点。

自定义配置分为 OpenAI-compatible 与 Anthropic-compatible。保存和测试前必须通过：绝对 URL、HTTPS、无内嵌账号密码、非 localhost/本地域名、DNS 结果全部为公网地址。请求禁止跟随重定向。

## 4. 数据与失败语义

- SQLite 不保存 API Key，只保存 `credentialConfigured`。
- 工作流路由包含 Profile ID、供应商、协议、模型、Base URL 指纹和配置版本，不包含凭证。
- 删除仍被未完成工作流引用的 Profile 会被拒绝。
- 修改路由字段会增加配置版本；仅改显示名不增加版本；轮换 Key 使用同一路由版本。
- 无价格表的调用记录为 `costStatus=unknown`。预算启用时出现未知费用，状态为 `unknown`，后续 AI 工作流等待人工处理。
- 供应商失败不得覆盖最近成功快照或已发布专题文档版本。

## 5. 验证清单

自动化：

```powershell
npm.cmd test
powershell -ExecutionPolicy Bypass -File .agents\skills\collector-engineering\scripts\check-project.ps1
```

桌面验收必须完全退出 Electron 后重启，并使用隔离实例：

1. 新增两个不同供应商并分别测试连接；
2. 启用 A 创建工作流，切换 B，确认该工作流仍显示并使用 A 的冻结路由；
3. 修改和清空 Key，确认三态保存语义正确；
4. 重启后确认 Profile、活动项与凭证状态一致；
5. 验证自定义 HTTP、localhost、私网和重定向端点被拒绝；
6. 清除业务数据后确认供应商 Profile、凭证和授权保持一致；
7. 检查 Renderer 控制台、Main 日志、SQLite 和导出包均不出现 Key。

真实 API 测试需要用户自行提供凭证，不纳入离线 CI。若某供应商模型或价格变化，只更新注册表定义和相应契约测试，不在领域服务中增加品牌分支。
