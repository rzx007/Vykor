# 工具结果存储

`ToolResultReader` 提供 retain/list/read/search，`ToolResultRepository` 管理不可变结果行。入口见 [tool-result-reader.ts](./tool-result-reader.ts) 和 [tool-result-repository.ts](./tool-result-repository.ts)。

已完整返回且 executionState 为 completed 的结果，先转换为正文视图，再通过 SessionStore 事务保存到唯一 tool_result 表。成功和错误都可保存；not_started、unknown、取消反馈及补读工具自身不保存。图片只留类型占位，私有 MCP 数据不进入正文。

宿主生成 result:<UUID>，保存 sessionId/runId/toolUseId、toolName、来源、正文、字符数与时间。列表先按会话和来源过滤并分页，仅返回元数据；read/search 授权后读取正文，字符位置按 UTF-16 计算。旧引用不解析。

状态属于 SessionStore.toolResults，使用原事务回滚、SQLite/memory 路由和会话删除。持久结果重开可读，memory 结果关闭丢弃。新增存储和分页规则放这里；宿主 owner、Run 与当前来源权限放 Server 的 tool-result-service.ts。测试放同层 __test__/。
