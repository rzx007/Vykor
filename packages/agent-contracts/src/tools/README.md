# 工具接口与结果数据

定义工具如何被注册、被调用和返回结果，并提供 MCP 结果数据的校验与公开视图。MCP 是外部工具连接协议，这里只处理它传回的数据。

| 文件 | 用途 |
| --- | --- |
| [tools.ts](tools.ts) | 工具定义、调用上下文、注册表、发现接口和结果 |
| [tool-data.ts](tool-data.ts) | 执行结果分类、MCP 数据复制校验、模型反馈文本及公开结果过滤 |
| [tool-names.ts](tool-names.ts) | 名称去空格、去重，以及 `Bash` 到 `Shell` 的名称统一 |
| [shell-output.ts](shell-output.ts) | 有大小限制的 Shell 输出采集、分页读取和搜索接口 |

公开入口为 `@vykor/agent-contracts`；`@vykor/agent-contracts/tool-data` 还可直接访问结果数据函数。导出分别见 [../index.ts](../index.ts) 和 [../../package.json](../../package.json)。

消费方注册 `ToolDefinition`，由自己的受检执行流程构造上下文并调用 `execute`。MCP 响应可先用 `parseMcpCallResultData` 校验复制，再用 `mcpResultModelText` 生成反馈文本；`publicToolResult` 去除应用私有字段。展示提示不授予执行权限。

工具注册表、执行记录和 Shell 输出正文由消费方持有，解析函数只使用本次调用的临时计数。新增工具契约或数据辅助函数放本目录，测试放 [__test__](__test__/)。具体工具执行实现放对应功能包。
