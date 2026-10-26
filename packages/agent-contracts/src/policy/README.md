# 权限与 Hook 回调契约

统一工具权限请求、人工或自动判定结果，以及运行前后的 Hook 回调接口。Hook 是宿主在指定事件发生时调用的扩展动作。

| 文件 | 用途 |
| --- | --- |
| [permissions.ts](permissions.ts) | 授权模式、工作模式、审批证据、权限请求与判定接口 |
| [hooks.ts](hooks.ts) | 可用 Hook 事件、阻止结果和执行器接口 |
| [required-policy.ts](required-policy.ts) | 宿主强制规则：授权和实际派发前分别检查，返回版本与允许结果 |

两者经 [../index.ts](../index.ts) 从 `@vykor/agent-contracts` 导出；权限定义也通过 `@vykor/agent-contracts/permissions` 单独公开。

消费方检查工具请求，返回允许、拒绝或询问用户的结果；宿主需要询问时，再交换 `AgentPermissionRequest` 和 `AgentPermissionDecision`。Hook 执行器接收事件与上下文，返回是否阻止。这里定义数据和接口，不运行审批策略或扩展命令。

权限记录、当前模式、Hook 注册和执行状态由消费方保存。新增此类定义放本目录，测试建议放同层 `__test__/`。

强制规则独立于普通 Hook：宿主通过 `AgentToolSafety.requiredPolicy` 提供检查能力，检查拒绝、抛错或超时均不允许工具派发。执行层默认等待上限为 5 秒，规则状态与版本由宿主持有。
