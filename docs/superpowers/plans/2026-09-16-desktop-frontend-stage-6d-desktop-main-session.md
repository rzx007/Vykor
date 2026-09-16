# 阶段 6D：Desktop Main SessionService 拆分实现计划

> 批量拆分生产服务，IPC surface 保持。

**目标：** 将 1152 行 SessionService 拆成 daemon connection、subscription 和 operations，旧服务作为兼容组合。

---

- [ ] 列 SessionService public 方法和 IPC handler 调用表。
- [ ] 提取 DaemonConnectionService：registry、spawn/connect/verify、client refresh。
- [ ] 提取 SessionSubscriptionService：sync controller、generation、abort、IPC snapshot/event/status。
- [ ] 提取 SessionOperations：Session/Prompt/Permission/Goal/Job Resource 调用。
- [ ] SessionService 构造一次三个服务并转发旧 public 方法。
- [ ] client refresh 时旧 subscription 全部 abort。
- [ ] daemon restart 后创建新 Client，从 snapshot 重建。
- [ ] IPC channel/payload/error 不变。
- [ ] platform window/tray/file/terminal 依赖不进入共享 Client。
- [ ] 提交 refactor(desktop): split main session service。

统一测试覆盖 connect/start/restart/timeout、快速订阅切换、close、IPC compatibility 和 Resource routing。
