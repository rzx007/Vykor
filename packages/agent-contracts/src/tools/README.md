# 工具接口与结果数据

定义工具如何被注册、被调用和返回结果，并提供 MCP 结果数据的校验与公开视图。MCP 是外部工具连接协议，这里只处理它传回的数据。

| 文件 | 用途 |
| --- | --- |
| [tools.ts](tools.ts) | 工具定义、调用上下文、注册表、发现接口和结果 |
| [operations.ts](operations.ts) | 含可信运行作用范围和工具绑定的宿主工具安全接口 |
| [tool-data.ts](tool-data.ts) | 纯内容块、完整结果、操作票据和派发回执，以及 MCP 数据校验与公开过滤 |
| [tool-names.ts](tool-names.ts) | 名称去空格、去重，以及 `Bash` 到 `Shell` 的名称统一 |
| [shell-output.ts](shell-output.ts) | 有大小限制的 Shell 输出采集、分页读取和搜索接口 |

公开入口为 `@vykor/agent-contracts`；`@vykor/agent-contracts/tool-data` 还可直接访问结果数据函数。导出分别见 [../index.ts](../index.ts) 和 [../../package.json](../../package.json)。

存储和领域记录从 `tool-data` 子入口导入纯数据，避免依赖 ToolContext 的执行环境与宿主函数。原消息、工具和操作入口继续转导出这些数据类型，已有调用方不需要更改导入。

消费方注册 `ToolDefinition`，由自己的受检执行流程构造上下文并调用 `execute`。MCP 响应可先用 `parseMcpCallResultData` 校验复制，再用 `mcpResultModelText` 生成反馈文本；`publicToolResult` 去除应用私有字段。展示提示不授予执行权限。

工具注册表、执行记录和 Shell 输出正文由消费方持有，解析函数只使用本次调用的临时计数。新增工具契约或数据辅助函数放本目录，测试放 [__test__](__test__/)。具体工具执行实现放对应功能包。

`AgentToolSafety` 将操作记录 Gate 和强制规则 Gate 成对传给执行上下文。流程为准备、授权、取得派发回执、调用、结算；`operationId` 与父操作身份进入 ToolContext。这里只定义接口，独立 SDK 不自动创建数据库；持久化由宿主实现。
