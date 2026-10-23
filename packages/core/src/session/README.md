# 会话包装

`agent-session.ts` 提供 `AgentSession` 和 `createAgentSession()`，为一个查询引擎绑定会话 ID，并提供统一的消息与历史操作入口。

构造时使用传入的会话 ID，或生成新的 ID，再调用引擎的 `setSessionId()`。`submitMessage()` 将内容、取消信号和运行上下文交给引擎，原样返回事件流；`getHistory()` 和 `clear()` 转发历史读取与清空操作。

本层只保存会话 ID 和引擎引用，消息历史仍由 `QueryEngine` 管理。会话落盘、恢复和运行调度由调用方负责。新增会话层的薄包装放在这里，查询循环规则放在 `../engine/`。

通过 `@vykor/core` 使用公开 API。测试放在同层 `__test__/agent-session.test.ts`。
