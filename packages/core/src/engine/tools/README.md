# 工具管理与执行

处理工具从注册、向模型展示，到检查参数、获取权限、执行和返回结果的完整过程。

| 文件 | 用途 |
| --- | --- |
| `tool-registry.ts` | 保存工具定义、校验注册，按可见范围生成运行和模型使用的工具集合 |
| `tool-discovery.ts` | 在本次运行内发现和启用工具 |
| `tool-definition-identity.ts` | 为同一工具定义提供稳定标记，供绑定和授权校验使用 |
| `tool-input-schema.ts` | 规范工具输入并按参数定义检查 |
| `tool-input-reuse.ts` | 从历史成功调用中复用允许复用的输入 |
| `query-tool-preparation.ts` | 解析和检查输入，区分可执行调用与应直接返回的错误 |
| `query-tool-permissions.ts` | 处理权限、执行前后的回调，以及工具状态事件 |
| `query-tool-limits.ts` | 工具超时和输出大小限制 |
| `tool-execution-context.ts` | 为工具组装当前执行环境与可见工具集合 |
| `checked-tool-execution.ts` | `executeCheckedTools()` 串联准备、授权、分组执行和结果交付 |
| `tool-failure-memory.ts` | 记录失败输入和证据版本，识别未发生变化的重复失败 |
| `tool-result-feedback.ts` | 将执行结果、失败提示和文件事实整理成模型可读取的内容 |
| `__test__/` | 上述规则与引擎中的工具执行集成测试 |

`QueryEngine` 将模型生成的工具调用交给 `executeCheckedTools()`。输入检查通过后才进行授权与执行，输出结果返回引擎写入消息历史，供下一轮模型使用。

工具定义保存在 `ToolRegistry` 实例中；发现状态、失败记忆和授权上下文跟随本次运行。文件读写、命令执行等具体工具实现放在 `@vykor/tools` 等提供方包中。新增工具执行规则放在本目录，测试放在同层 `__test__/`。
