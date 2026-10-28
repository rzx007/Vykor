# Node Agent 组装与操作

| 文件 | 用途 |
| --- | --- |
| `agent-options.ts` | 对外配置、能力覆盖和交互回调类型 |
| `agent-composition.ts` | 创建工作目录绑定，组装模型、工具、子管理器、插件与记忆 |
| `agent.ts` | `DefaultNodeAgent` 与宿主操作，准备运行、应用配置并协调应用工具调用 |
| `default-agent.ts` | `createDefaultNodeAgent()` 默认工厂，创建并连接执行核心和本机资源 |
| `__test__/` | agent 操作、默认装配、公开 API 和运行结束后的子任务测试 |

默认工厂先建立共享目录与执行资源，再调用组装函数生成会话和运行资源，最后返回 agent。提交入口准备本次工具与插件范围后，交给执行核心创建运行。

`host.resolveSessionHost(sessionId)` 读取同一棵根 Agent 树中已经存在的实际 Node 宿主；根会话返回自身，子会话从原子记录读取实例。查询不会创建或恢复实例，暂停和已关闭的会话返回空值。正在关闭但仍有调用未退出时保留实际宿主，`jobs` 继续允许读取、等待和取消，`jobs.send` 统一拒绝新输入。调用方使用返回宿主的 `jobs`，保留该会话的直接子范围和工具授权上限；`jobs.send` 在这个实际宿主捕获工具身份。

宿主提供的 `executionEnvironment` 是按实际会话调用的异步工厂，收到 `sessionId`、`cwd` 和已应用审批模式的 `settings`；返回的环境必须绑定该目录。Node 在创建工具前核对目录，随后让该会话的运行资源持有环境。`ownsExecutionEnvironment: true` 对每次返回的租约生效，初始化失败和正常关闭都只释放一次。

agent 实例持有配置、会话引用和插件应用操作状态；查询历史仍由引擎持有，后台资源由运行资源对象管理。新增对外 agent 操作放在本目录，具体本机能力放入相应分类。测试专用装配辅助代码放在本层 `__test__/`，供其他分类测试复用。


每个默认 Node Agent 持有一个有容量上限的内存结果存储，在相同会话的后续 Run 中继续提供有权读取的历史结果。`toolResults(scope, tools)` 配置可替换成宿主已有存储；Node 准备时交出绑定工厂，执行核心在提交选项进一步收窄后，才把实际执行的工具集合交给工厂。宿主工厂优先于默认内存实现，拒绝或失败时不会回退到内存绕开权限。Run 释放后默认存储停止接受原 Run 的调用，正文仍可由新 Run 重新按权限读取。`__test__/tool-result-reading.test.ts` 通过真实 Agent 和内置工具验证跨 Run 补读、宿主覆盖、模型和手动入口收窄及来源替换。


## 共用执行核心（阶段 A）

DefaultNodeAgent.host.jobs 保留共同执行来源；jobs:false 只关闭模型工具。Terminal 与 Shell 覆盖使用按实际会话返回低层 provider/admission 端口的工厂，归档通过 jobArchiveForSession 只读接入。不保留直接借用父端口的旧接线形式。

普通权限与审批通过后，执行入口调用当前 Run 的 `checkToolDispatch`，核对 owner、会话、Run、输入归属、cwd、最终工具绑定和运行修订。检查失败终止本 Run；工具普通错误与 unknown 只反馈本次调用，不限制其他新调用，也不自动重试。实际调用 Promise 一直跟踪到工具真正结束。

宿主可提供 `bindToolDispatch(scope, tools)` 工厂；框架在可靠 Run 启动后用最终工具集合生成检查。模型、手动、嵌套及子 Run 共用入口，替换 preparation 不能删除顶层宿主工厂。子 Run 重新绑定自己的范围。独立 SDK 不需要数据库。
