# 阶段 6E：Desktop Renderer Store 收口实现计划

> 先完成 feature action 重组，最后统一 Store 测试。

**目标：** 让 durable SessionView 只有一个 snapshot/event 入口，feature actions 只修改自己的 operation/draft/view 状态。

---

- [ ] 建立 durable reconcile action：applySnapshot/applyEvent 或等价单入口。
- [ ] 所有 IPC snapshot/event 只经过该入口。
- [ ] session-actions 删除重复 Message/Run/Task merge。
- [ ] prompt actions 只管理 admission、optimistic token、draft/edit。
- [ ] project/goal/attachment actions 只改本 feature。
- [ ] notification observer 只观察，不重新应用 event。
- [ ] selectors 保持纯函数。
- [ ] runtime cleanup 区分 live/view/operation 与 durable reset。
- [ ] 旧 store actions 保留转发，避免组件全量改写。
- [ ] 更新 store README 所有权和事件流程。
- [ ] 提交 refactor(desktop): unify renderer durable reconciliation。

统一测试覆盖 store integration、prompt/project/goal/attachment、optimistic rollback、旧 cursor、restart 和 selectors。
