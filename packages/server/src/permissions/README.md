# 权限请求与配置管理

处理权限请求等待、回复、作用范围，以及权限和隔离配置检查。

## 入口与流程

权限控制器和存储代理创建请求、等待决定，再把回复交给运行；配置管理函数校验权限与隔离设置，返回可展示结果。

普通工具请求可以复用“本会话允许”。工具内部针对具体来源、安装候选或其他确切操作的请求使用 `confirmation: "once"`：它不会复用已有的工具级会话授权，批准回复也只能保存为单次授权。此标记由 `sessionPermissionRequest` 转交，并与具体参数一同保存；自动审查和父子会话的存储路由仍按原规则处理。

自动审查从已保存的审批请求读取操作说明，例如浏览器站点、按钮名称和敏感操作提示，并通过 `evidence.context` 的 `reference` 类型提供给审查器。这些说明属于外部或工具参考信息，不能提供用户授权；`userInstruction` 仍由对应运行的原始用户输入或已核实的应用操作产生。

自动审查接受运行时捕获的 `builtin` 和 `agent` 注册来源；`agent` 表示宿主通过 Node 的 `options.tools` 接入的工具，例如内置浏览器，并非模型自行声称的身份。这只允许进入审查，具体操作仍由审查结果决定；未知来源、插件和 MCP 工具继续转人工，已核实的插件应用操作沿用原来的单独核验流程。同名工具不能仅凭名称取得可信来源。

`approval-context.ts` 还提供紧邻用户回复的完整助手提案、当前及紧邻前轮运行已完成的内置及宿主注册工具结果，以及本轮同配置下较早的确切批准记录。浏览器观察结果因此可以帮助审查器理解元素编号对应的页面和按钮。它们都只是风险与回复指代的参考，不能独立授权或扩展“允许本次”的范围。收集时排除别的会话、不相关运行、委派运行、未来记录和插件或 MCP 等其他来源的工具结果；每条参考最多 4000 字符，结果正文最多 3500 字符，总参考预算 12000 字符，最多各取三条结果和批准记录。不能完整纳入的参考会明确标为缺失，不发送半段资料并假装完整。历史用户要求仍由完整请求的长度限制保护。

多轮对话审查还会通过 `userInstructionHistory` 带上当前输入之前的用户指令，按输入顺序保留授权及后来的限制，避免用户回复“好”后丢掉前文。历史只取当前会话中已经成为用户消息的持久输入，不读取父会话、未来输入、尚未投递的排队输入或代理消息；分叉会话使用自己已复制的历史。自动目标续跑、隐藏系统输入和插件生成输入不能作为新的人类授权。当前指令保留 16000 字符限制；包括历史在内的完整审查请求超过 65536 字符时转为人工确认，不截掉可能影响授权的内容。

分叉复制时留下的 `approvalInstructionSource: "external"` 继续排除外部输入，避免删除插件专属字段后把它误认成人类指令。本轮或历史输入只要带有 `sensitiveInput: true` 或旧 `autoReviewSensitive: true`，整次请求转为人工确认，不向另一个模型发送这些内容，也不删掉该条后使用剩余记录批准。

审批服务无法核实指令或来源、遇到敏感输入、资料超限、审查不可用或返回无效结果时，固定后备理由通过 `responseText()` 跟随宿主系统语言，当前提供中文和英文。语言选择只影响应用生成的说明，审批决定、风险、授权及请求元数据保持原语义；审查器已返回的理由、原始用户指令和操作说明均原样保留。

## 状态归属

请求和决定通过权限存储保存，等待者与取消监听保存在控制器中，配置由配置服务管理。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [approval-review-service.ts](./approval-review-service.ts) | `ApprovalReviewServiceInput`、`PermissionApprovalReviewServiceOptions`、`createPermissionApprovalReviewService` |
| [approval-context.ts](./approval-context.ts) | 从宿主记录收集有来源和范围限制的助手提案、工具结果及旧批准参考 |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |
| [permission-broker.ts](./permission-broker.ts) | `PermissionReplyStatus`、`PermissionDecisionScope`、`PermissionAskInput`、`PermissionApprovalReviewHook` 等 |
| [permission-controller.ts](./permission-controller.ts) | `PermissionControllerWaitInput`、`PermissionController` |
| [session-approval.ts](./session-approval.ts) | `sessionPermissionRequest` |
| [settings-management.ts](./settings-management.ts) | `inspectPermissionConfiguration`、`checkPermissionConfiguration`、`validatePermissionConfiguration`、`validateIsolationConfiguration` |

## 测试与维护

权限请求协调与应用侧配置检查放在这里；工具自身的访问校验留在工具目录。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
