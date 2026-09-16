# 阶段 6B：SSE Connection、Cursor 与 Router 实现计划

> 先完成 controller 生产代码，阶段末统一测试。

**目标：** 将 snapshot-first、cursor、gap catch-up、reconnect、abort 和 generation fencing 与 UI 框架分离。

**架构：** 优先复用 packages/client syncEvents；平台 adapter 只负责生命周期和通知，不建第二套重连。

---

- [ ] 定义 SyncResource：sessions.getState、events.list/stream。
- [ ] 建立无 React/Electron 的 SessionSyncController 或复用 syncEvents + lifecycle wrapper。
- [ ] 输入 sessionId、AbortSignal、generation、retry policy。
- [ ] 输出 snapshot/state update、connection status、error。
- [ ] 确保每个 durable event 只 apply 一次。
- [ ] 旧 generation 的迟到 snapshot/event 全部丢弃。
- [ ] abort 不写用户错误，normal EOF 按现平台策略。
- [ ] reconnect 不清 durable state；gap 用 events.list 补齐。
- [ ] Router 按 session/scope 分发，不修改业务 record。
- [ ] 提交 refactor(client): extract platform sync controller。

统一测试使用可控 async generator 覆盖断流、gap、重复、abort、快速切 Session、daemon restart。
