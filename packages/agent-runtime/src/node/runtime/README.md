# 运行资源组装

| 文件 | 用途 |
| --- | --- |
| `default-runtime.ts` | `createVykorRuntime()`，应用配置和能力限制，组装查询引擎与工具 |
| `tool-authorization.ts` | 捕获每次工具调用的批准方式、设置和命令环境，保留到该次调用结束 |
| `node-runtime-builder.ts` | `NodeRuntimeBuilder`，记录组装结果和资源归属 |
| `node-runtime-resources.ts` | `NodeRuntimeResources`，保存引擎、注册表、连接、运行能力和关闭入口 |
| `runtime-integrations.ts` | 接入 MCP、插件、技能等能力，处理连接来源与执行环境 |
| `cleanup-stack.ts` | 登记清理动作，在初始化失败或关闭时按顺序释放资源 |
| `__test__/` | 默认运行资源、接入、所有权、清理和运行事件适配测试 |

agent 组装层调用 `createVykorRuntime()`，构造器收集各项能力，返回带有查询引擎的资源对象。每次运行从这些资源中准备自己的能力范围，关闭时只释放当前对象拥有的资源。

组装工具权限时，`default-runtime.ts` 将执行环境的 `shellDescriptor.family` 交给 `PermissionChecker`，与前台和后台 Shell 实际使用的解释器保持一致。没有执行环境的旧调用路径复用默认 Shell 执行器所用的 `resolveHostShellLauncher()` 进程缓存。模型输入中的方言字段不参与判断；环境存在但缺少实际解释器描述时保持未知，不能回退猜测成宿主 Shell。`__test__/shell-permission-context.test.ts` 覆盖这些接线和后段拒绝规则。

受信任的内置 `AskUser` 在权限检查后直接显示问题，等待用户回答，不再先弹出“允许提问”的工具审批。明确禁止、工具范围和计划模式限制仍优先执行；同名的外部替换工具不继承此放行。`__test__/ask-user-permission.test.ts` 覆盖普通审批、自动审查及上述限制。

受信任的内置 `JobList`、`JobRead` 和 `JobWait` 直接观察当前会话已有任务，不再为每次读取和等待调用审批模型；任务来源仍核对会话归属。明确禁止与工具范围检查继续优先，计划模式仍受可信只读工具范围限制；同名外部替换工具不继承批准。`JobSend` 和 `JobCancel` 保留原审批规则。`__test__/job-permission.test.ts` 覆盖审批模式、计划限制、禁止规则及工具替换边界。

状态集中保存在 `NodeRuntimeResources` 和清理栈中。新增资源组装与释放规则放在这里；agent 操作、子管理、模型配置、工具和记忆分别放在相邻分类。测试辅助的运行适配器留在同层 `__test__/`。

宿主通过 `readApprovalMode(sessionId)` 提供当前会话的批准方式。每次工具开始检查权限时，`tool-authorization.ts` 用 `AsyncLocalStorage`（让一条异步调用链保留自己的状态）捕获模式、设置和环境。权限检查、等待批准、执行及事后 hook 共用这次捕获；同批串行排队的调用在开始时才捕获，嵌套调用另取新选择。模式切换不会改写已经捕获的调用。

工具工厂和命令 hook 持有随当前调用读取的设置对象。新调用退出完全访问后恢复原沙箱和网络设置；已经运行的进程不追溯更改。宿主批准请求也收到捕获的 `approvalMode`。计划模式的只读上限、明确禁止项和本次 Run 的工具范围继续优先执行。

独立的命令 hook 也捕获自己的策略。MCP 新建进程通过同一个动态进程端口读取调用内环境；继承父注册工具的子会话，通过 Core 提供的 `ToolContext.canUseNetwork` 使用自己捕获的网络规则。

每轮读取实际请求配置后，default-runtime 调用宿主可选 validateModelSelection，复查当前模型目录与权限，再准备客户端与派发。目录容量元数据可保持创建快照，授权校验使用现有 settings/catalog reader 读取当前值，不把旧 root 配置当永久许可。

完整 `systemPrompt` 优先并原样交给模型，默认提示词提供统一沟通规则。

宿主提供 `resolveModelImageSupport` 时，每轮按实际选择的供应商、模型和 API 格式读取图片能力，随请求快照交给查询引擎。切换模型后的下一次请求因此会重新处理历史图片；未提供该查询的自定义客户端保留原有行为。
