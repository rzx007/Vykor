# 工具接口与结果数据

定义工具如何被注册、被调用和返回结果，并提供 MCP 结果数据的校验与公开视图。MCP 是外部工具连接协议，这里只处理它传回的数据。

| 文件 | 用途 |
| --- | --- |
| [tools.ts](tools.ts) | 工具定义、调用上下文、注册表、发现接口和结果 |
| [tool-data.ts](tool-data.ts) | 纯内容块、完整结果、结果引用与分页数据，以及 MCP 数据校验与公开过滤 |
| [result-data.ts](result-data.ts) | 宿主绑定的结果访问能力；引用和分页数据转导出自纯数据入口 |
| [result-text.ts](result-text.ts) | 无存储状态的文本视图、UTF-16 分页、字面检索和边界检查 |
| [tool-names.ts](tool-names.ts) | 名称去空格、去重，以及 `Bash` 到 `Shell` 的名称统一 |
| [shell-output.ts](shell-output.ts) | 有大小限制的 Shell 输出采集、分页读取和搜索接口 |

公开入口为 `@vykor/agent-contracts`；`@vykor/agent-contracts/tool-data` 还可直接访问结果数据函数。导出分别见 [../index.ts](../index.ts) 和 [../../package.json](../../package.json)。

存储和领域记录从 `tool-data` 子入口导入纯数据，避免依赖 ToolContext 的执行环境与宿主函数。原消息、工具和操作入口继续转导出这些数据类型，已有调用方不需要更改导入。

消费方注册 `ToolDefinition`，由自己的受检执行流程构造上下文并调用 `execute`。MCP 响应可先用 `parseMcpCallResultData` 校验复制，再用 `mcpResultModelText` 生成反馈文本；`publicToolResult` 去除应用私有字段。展示提示不授予执行权限。

工具注册表、执行记录和 Shell 输出正文由消费方持有，解析函数只使用本次调用的临时计数。新增工具契约或数据辅助函数放本目录，测试放 [__test__](__test__/)。具体工具执行实现放对应功能包。



普通权限与审批通过后，执行入口调用当前 Run 的 `checkToolDispatch`，核对 owner、会话、Run、输入归属、cwd、最终工具绑定和运行修订。检查失败终止本 Run；工具普通错误与 unknown 只反馈本次调用，不限制其他新调用，也不自动重试。实际调用 Promise 一直跟踪到工具真正结束。

宿主可提供 `bindToolDispatch(scope, tools)` 工厂；框架在可靠 Run 启动后用最终工具集合生成检查。模型、手动、嵌套及子 Run 共用入口，替换 preparation 不能删除顶层宿主工厂。子 Run 重新绑定自己的范围。独立 SDK 不需要数据库。
