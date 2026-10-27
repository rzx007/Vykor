# 子 agent 执行核心

| 文件 | 用途 |
| --- | --- |
| `child-agent.ts` | `AgentChildManager`，创建、运行、等待、继续和关闭直接子 agent |
| `child-registry.ts` | `AgentChildRegistry`，登记子 agent、保留创建额度并按 ID 查询 |
| `child-environment.ts` | 工作目录申请与释放的接口，以及复用当前目录的实现 |
| `child-activity.ts` | 从可信事件中累计子运行进度，保留有长度限制的部分结果 |

父 agent 通过子管理器提交创建请求，先保留额度，再申请目录和创建子实例；子运行事件更新登记表中的活动记录，结果交给等待者。登记表由同一棵 agent 树共享，直接子实例和目录租约由管理器负责释放。

`spawnSystemChild` 允许宿主经独立参数提供本次输出合同，再交给 `resolveChild` 创建子实例。合同不写入可序列化的创建输入或事件。系统子 Agent 没有普通工具；内部交付工具由合同添加，结果回执沿用现有子结果返回路径。

Git 工作目录创建和本机配置继承放在 [Node 子管理](../../node/children/README.md)。本层只依赖注入的环境与创建接口。测试放在同层 `__test__/`，整体父子生命周期也由 `../__test__/` 覆盖。


## 共用执行核心（阶段 A）

每个已接纳 run 在 requests 保留真实 handle、receipt、许可、时间与唯一结果；同轮 steer 输入只引用该记录。currentRequest 只是当前指针。readRun/waitRun 固定 runId；interruptRun 只接纳匹配轮次的停止请求，等待确认应调用 waitRun。

阶段 B 使用 `reserveIdentity` 保留深度与累计身份数，用 `acquireRun` 原子申请运行许可。真实 invocation 与准备清理都结束后归还许可；保存错误保留 `projectionError`，资源清理错误保留 `cleanupUnconfirmed` 与原资源。requests 上限 256，只淘汰已保存结果及其输入别名；明确未接纳的输入不永久占位。初始化/恢复阶段也先把许可挂到原准备记录，撤销确认后才释放。
