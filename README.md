# Collector

Collector 是一款 Windows 本地优先的 AI 研究与学习应用。用户可以通过对话或导入材料开始研究，在连续正文中阅读、引用、追问、深入生长，并通过研究地图重新发现和组织已有认识。

## 运行

要求 Node.js 24+、npm 11+、Windows 10/11。

```powershell
npm.cmd install --cache .npm-cache
npm.cmd run launch
```

双击根目录的 `Collector.cmd` 与 `npm.cmd run launch` 等价。无需真实模型的确定性演示使用：

```powershell
npm.cmd run launch:mvp
```

开发与验证入口：

```powershell
npm.cmd run dev:api
npm.cmd run dev:web
npm.cmd run check
npm.cmd test
npm.cmd run test:web
npm.cmd run test:e2e
npm.cmd run gate
```

命令的真实行为以根 `package.json` 和脚本源码为准。

## 数据与安全

- 产品只监听 loopback 地址；WebUI 通过本机 HTTP 与渐进事件访问 API。
- 研究数据、文件和运行记录保存在本机数据目录。
- API Key、认证头、会话令牌和启动控制凭据不得进入 URL、浏览器持久化、普通日志或业务导出。
- 正文是可阅读内容的唯一事实源；索引、切片、引用定位和图谱投影均为派生数据。

## 现行文档

- [产品模块](docs/product/README.md)：已确认的产品含义、模块边界和跨模块不变量。
- [技术架构](docs/ARCHITECTURE.md)：稳定的技术依赖、运行边界和代码导航。
- [工程协作](docs/ENGINEERING.md)：实施、验证、并行、任务与提交规则。
- [人工验收](docs/ACCEPTANCE.md)：仅在用户主动触发时执行的低频体验验收。

仓库不维护手写进度总表。查询当前已经实现什么时，检查源码、共享契约、自动化测试和实际界面；查询历史过程时使用 Git 与已关闭的 GitHub Issues。
