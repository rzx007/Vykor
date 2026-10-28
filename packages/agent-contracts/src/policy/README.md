# 权限与 Hook 回调契约

统一工具权限请求、人工或自动判定结果，以及运行前后的 Hook 回调接口。Hook 是宿主在指定事件发生时调用的扩展动作。

| 文件 | 用途 |
| --- | --- |
| [permissions.ts](permissions.ts) | 授权模式、工作模式、审批证据、权限请求与判定接口 |
| [hooks.ts](hooks.ts) | 可用 Hook 事件、阻止结果和执行器接口 |

两者经 [../index.ts](../index.ts) 从 `@vykor/agent-contracts` 导出；权限定义也通过 `@vykor/agent-contracts/permissions` 单独公开。

消费方检查工具请求，返回允许、拒绝或询问用户的结果；宿主需要询问时，再交换 `AgentPermissionRequest` 和 `AgentPermissionDecision`。Hook 执行器接收事件与上下文，返回是否阻止。这里定义数据和接口，不运行审批策略或扩展命令。

权限记录、当前模式、Hook 注册和执行状态由消费方保存。新增此类定义放本目录，测试建议放同层 `__test__/`。


普通权限与审批通过后，执行入口调用当前 Run 的 `checkToolDispatch`，核对 owner、会话、Run、输入归属、cwd、最终工具绑定和运行修订。检查失败终止本 Run；工具普通错误与 unknown 只反馈本次调用，不限制其他新调用，也不自动重试。实际调用 Promise 一直跟踪到工具真正结束。

宿主可提供 `bindToolDispatch(scope, tools)` 工厂；框架在可靠 Run 启动后用最终工具集合生成检查。模型、手动、嵌套及子 Run 共用入口，替换 preparation 不能删除顶层宿主工厂。子 Run 重新绑定自己的范围。独立 SDK 不需要数据库。
