# 阶段 6F：兼容集成与统一验收实现计划

> 完成所有调用方后一次性测试、集中修复、统一审查。

**目标：** 收口 Hook/SessionService/Store 兼容入口，删除重复 helper，完成阶段 6。

---

- [ ] 迁移 Frontend/Desktop 调用方到新 controller/service/feature。
- [ ] 保留 useServerSync 返回、SessionService public、Zustand action 与 IPC 兼容。
- [ ] 删除无调用重复 merge、listener、cursor 和 retry helper。
- [ ] 检查没有视觉/CSS/文案改动。
- [ ] 架构规则覆盖 Electron/renderer/frontend/client 方向。
- [ ] 更新状态文档：0–6 完成，7 未开始。
- [ ] 记录 useServerSync、SessionService、session-actions 前后行数。
- [ ] 运行 Client、Frontend、Desktop 全量测试。
- [ ] 运行 Server HTTP/CLI 兼容测试。
- [ ] 运行 pnpm check-types、architecture、docs、diff。
- [ ] 集中修复全部真实失败，再完整重跑一次。
- [ ] 统一代码审查，一次性修复 Critical/Important。
- [ ] 提交 chore: complete desktop frontend state reorganization。

验收：一个 event 一个对账入口；connection/cursor 与 UI 分离；平台状态所有权明确；协议、IPC、视觉和公开 API 不变。
