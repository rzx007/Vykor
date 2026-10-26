# 已保存工具结果的只读视图

`ToolResultReader` 读取 S1 工具操作记录已有的完整结果，不创建新表或第二份正文。入口是 [tool-result-reader.ts](./tool-result-reader.ts)，公开导出见 [index.ts](./index.ts)。

宿主先以 session 和 run 保留已完成操作的引用；后续通过引用读取或检索。引用绑定操作及实际尝试，重启后可以从相同记录重新计算；某次操作重试后，旧尝试引用不会误指向新结果。`list` 可以找回历史引用。尚未派发、尚未完成、未知结果或没有已保存正文的记录不产生完整引用，已经保存的确定错误结果可以读取。

完整正文必须有明确的 `executionState: completed`，并处于确定完成的操作状态。`not_started` 拒绝反馈、`unknown` 以及旧记录缺少执行状态时均不推断完整正文；已经执行完的只读查询即使返回错误，只要保存的状态明确为 completed，仍可补读错误内容。当前 S1 执行器在正常结果保存前补齐 completed，不依靠缺失字段推断成功。

来源从 S1 的 `toolIdentity.source` JSON 中读取。函数身份和实现版本用于原操作安全核验，不是读取历史正文的前提；当前来源权限由 Server 再次检查。本模块首先限定精确会话，不按路径、调用 ID 或任意元数据查找。图片只返回类型提示，私有 MCP 数据不进入文本视图。

状态仍归 `SessionStore.toolOperations`；memory 会话随存储关闭丢弃。分页、边界和字面搜索使用 agent-contracts 的纯文本规则。新增持久读取规则放在本目录，权限和运行生命周期规则放在 Server 的 `tool-result-service.ts`。

测试在 [__test__/tool-result-reader.test.ts](./__test__/tool-result-reader.test.ts)，覆盖真实 SQLite 重新打开、超过 256 KB 的尾部、伪造引用、未知操作和 memory 会话。
