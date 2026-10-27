# 终端契约与事件订阅

| 文件 | 用途 |
| --- | --- |
| [index.ts](index.ts) | `@vykor/terminal` 汇总入口 |
| [contracts.ts](contracts.ts) | 会话、创建与控制请求、输出快照和事件，也由 `@vykor/terminal/contracts` 公开 |
| [provider.ts](provider.ts) | `TerminalProvider`、`TerminalConnection`、等待请求及 Agent 打开终端接口 |
| [events.ts](events.ts) | `TerminalEventBus` 和监听函数类型 |

消费方实现 `TerminalProvider`，接收创建、写入、调整大小、读取、等待和信号请求，再返回会话或输出数据。`AgentTerminalHost` 仅约定 Agent 打开终端的入口，后续观察与控制使用 Jobs 接口。这里不实现进程启动和输出缓存。

`TerminalEventBus.subscribe` 返回取消订阅函数，`emit` 同步依次调用监听函数，`clear` 移除全部监听。事件订阅器只持有监听函数集合；终端状态、输出序号和进程资源由具体提供方管理。

本包职责单一，新增数据定义放 `contracts.ts`，提供方接口放 `provider.ts`，事件分发逻辑放 `events.ts`。测试建议放同层 `__test__/`。


## 共用执行核心（阶段 A）

TerminalProvider.get 按 ID 定点查询；list 只用于列举。Jobs 使用同一 TerminalSessionInfo，不定义另一份终端数据。
