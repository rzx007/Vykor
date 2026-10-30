# 生命周期概念

[lifecycle.md](./lifecycle.md) 解释请求从应用到 daemon 再回到状态视图的过程，以及 Session、Input、Run、Message、Permission、Job 的关系。入口来自首页及快速开始，供读者在专题指南之前理解状态归属。

新增内容只解释公开 SDK 的运行模型。服务端保存记录，SDK 合并快照和事件，应用保存交互状态；内部模块设计、应用业务和部署细节留在仓库文档。方法调用和可运行代码放 `guides/` 或 `examples/`，避免在概念页重复整份示例。
