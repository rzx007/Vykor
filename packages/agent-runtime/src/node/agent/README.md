# Node Agent 组装与操作

| 文件 | 用途 |
| --- | --- |
| `agent-options.ts` | 对外配置、能力覆盖和交互回调类型 |
| `agent-composition.ts` | 创建工作目录绑定，组装模型、工具、子管理器、插件与记忆 |
| `agent.ts` | `DefaultNodeAgent` 与宿主操作，准备运行、应用配置并协调应用工具调用 |
| `default-agent.ts` | `createDefaultNodeAgent()` 默认工厂，创建并连接执行核心和本机资源 |
| `__test__/` | agent 操作、默认装配、公开 API 和运行结束后的子任务测试 |

默认工厂先建立共享目录与执行资源，再调用组装函数生成会话和运行资源，最后返回 agent。提交入口准备本次工具与插件范围后，交给执行核心创建运行。

agent 实例持有配置、会话引用和插件应用操作状态；查询历史仍由引擎持有，后台资源由运行资源对象管理。新增对外 agent 操作放在本目录，具体本机能力放入相应分类。测试专用装配辅助代码放在本层 `__test__/`，供其他分类测试复用。

`VykorAgentConfiguration.toolSafety` 是可选的宿主能力；缺少操作记录或强制规则其中一项时，默认工厂在创建本机资源前拒绝配置。Node 准备结果将它交给执行核心，子配置沿用同一对象。默认 SDK 不创建操作数据库。实际运行的宿主登记还包含捕获的工具定义身份和执行环境信息，供宿主核对来源；它们不进入模型上下文。

每个默认 Node Agent 持有一个有容量上限的内存结果存储，在相同会话的后续 Run 中继续提供有权读取的历史结果。`toolResults(scope, tools)` 配置可替换成宿主已有存储；Node 准备时交出绑定工厂，执行核心在提交选项进一步收窄后，才把实际执行的工具集合交给工厂。宿主工厂优先于默认内存实现，拒绝或失败时不会回退到内存绕开权限。Run 释放后默认存储停止接受原 Run 的调用，正文仍可由新 Run 重新按权限读取。`__test__/tool-result-reading.test.ts` 通过真实 Agent 和内置工具验证跨 Run 补读、宿主覆盖、模型和手动入口收窄及来源替换。


## 共用执行核心（阶段 A）

DefaultNodeAgent.host.jobs 保留共同执行来源；jobs:false 只关闭模型工具。Terminal 与 Shell 覆盖使用按实际会话返回低层 provider/admission 端口的工厂，归档通过 jobArchiveForSession 只读接入。不保留直接借用父端口的旧接线形式。
