# Goal 实现复盘与调整方向

> 状态：当前。日期：2026-09-12。本文提出的完成审查、进展判断、扩展边界、维护诊断和 Desktop 展示已实施并通过相关自动化验证；完整 Token 预算仍不在本轮范围。本文补充 [会话目标设计](./session-goals-design.md)。

## 1. 结论与范围

目标持久化、首次运行、自动续跑和 Desktop 交互继续沿用原有运行机制。本轮补强完成判断、进展判断以及 Goal 与通用执行引擎的边界，没有更换持久 Run 与会话队列。

本次依据官方说明、指定版本的 Codex 开源代码以及 Vykor 当前源码进行复盘。实现后已运行相关单元测试、类型检查、agent-runtime 独立打包消费者验证和 Desktop 生产构建。尚未完成本轮 Desktop 手动交互复验。Codex 桌面截图只用于确认产品交互，不用于推断内部实现。

## 2. Codex 调研依据

源码基线：[openai/codex，c4017a87aacc7558002b7cb510025e967c1d765e](https://github.com/openai/codex/tree/c4017a87aacc7558002b7cb510025e967c1d765e)。以下结论仅对应这个版本。

| 主题 | 已核实行为 | 依据 |
| --- | --- | --- |
| 产品定义 | 跨回合推进持久目标，目标应包含可验证的停止条件；支持查看、暂停、恢复和清除 | [官方说明](https://learn.chatgpt.com/use-cases/follow-goals) |
| 扩展边界 | `ext/goal` 通过线程、回合、工具和用量生命周期接入 | [extension.rs](https://github.com/openai/codex/blob/c4017a87aacc7558002b7cb510025e967c1d765e/codex-rs/ext/goal/src/extension.rs) |
| 续跑入口 | 空闲时检查目标，并通过 `start_turn_if_idle` 尝试续跑；读目标到启动期间持有目标状态保护，支持续跑延后记录 | [runtime.rs](https://github.com/openai/codex/blob/c4017a87aacc7558002b7cb510025e967c1d765e/codex-rs/ext/goal/src/runtime.rs) |
| 模型接口 | 提供 `create_goal`、`get_goal`、`update_goal`；创建必须有明确授权，预算不是默认推断项 | [spec.rs](https://github.com/openai/codex/blob/c4017a87aacc7558002b7cb510025e967c1d765e/codex-rs/ext/goal/src/spec.rs) |
| 完成审查 | 要求模型从原始目标推导要求，逐项检查当前证据，不得用局部检查支持整体完成 | [continuation.md](https://github.com/openai/codex/blob/c4017a87aacc7558002b7cb510025e967c1d765e/codex-rs/ext/goal/templates/goals/continuation.md) |
| 阻塞与等待 | 提示模型区分进展、已核实的等待、无进展；同一阻塞连续出现至少三轮后才报告受阻，恢复后重新审查 | 同上；这是提示约束，不代表每项均由服务端机械验证 |
| 用量与状态 | 保存 Token 预算、使用量和耗时；扩展归集后代代理 Token 使用量；状态区分暂停、受阻、预算耗尽与使用限制 | [ThreadGoal.ts](https://github.com/openai/codex/blob/c4017a87aacc7558002b7cb510025e967c1d765e/codex-rs/app-server-protocol/schema/typescript/v2/ThreadGoal.ts)、[ThreadGoalStatus.ts](https://github.com/openai/codex/blob/c4017a87aacc7558002b7cb510025e967c1d765e/codex-rs/app-server-protocol/schema/typescript/v2/ThreadGoalStatus.ts)、上述 extension.rs |

Codex 的完成审查依赖模型结合证据判断，不能理解为一个自动证明任意目标已经完成的验证器。我们不必复制其 Rust 模块、数据库布局或全部状态名称。

## 3. 应保留的现有实现

- 创建目标时，目标、首次输入和运行意图在事务中保存，随后投递持久 Run。
- 请求 ID 防止重复提交，版本号防止旧运行修改新目标。
- 当前运行释放会话队列后再结算目标，用户输入优先于待执行的自动续跑。
- 暂停、取消会撤销对应续跑，并等待运行停止。
- `GoalAssessment` 的目标、版本和运行标识由宿主绑定，服务端检查事件归属。
- Goal 正文独立持久化，不只依靠聊天历史保存。

对应入口：[SessionGoalService](../packages/server/src/application/session/session-goal-service.ts)、[SessionRunEngine](../packages/server/src/application/session/session-run-engine.ts)、[事件投影](../packages/server/src/application/agent/daemon-agent-event-projector.ts)。

## 4. 问题与建议

### 4.1 完成证据只能证明来源，不能证明覆盖全部要求

当前 `settleRun` 接受模型的 `complete` 建议后，只要存在证据引用且全部引用通过 `verifiedEvidence`，就可以完成目标。后者检查当前目标版本、当前 Run、工具成功状态与输出，不检查目标所有成功条件的覆盖关系。

例如目标要求实现、测试和文档三项，引用一次成功读取文件的结果，并不能证明三项都完成。现有机制防止部分伪造与旧证据误用，但不能被描述为完整机器验收。

调整建议：保留引用来源校验，让完成评估列出具体要求、对应证据、满足情况和剩余工作；提示必须从原始目标及引用规格推导要求，不得缩小范围。服务端校验结构与引用，能够确定性验证的条件按实际结果判断；语义覆盖仍需模型审查，主观验收交给用户。

不要求立即新增独立的成功条件编辑器或通用验收平台。评估结构如何表达要求，留到实施计划中确定。

验收场景：只有部分要求完成、引用无关成功工具、引用旧版本结果、没有证据、需要用户验收时，均不能直接宣称全部完成。

### 4.2 无进展与受阻规则不一致

当前模型报告 `blocked` 可以直接进入受阻；报告 `continue` 时，则根据成功工具的名称、输入和输出组合是否出现过，累计三轮无进展。

不同输出不一定代表进展，重复检查也不一定没有价值。正在运行的真实外部任务可能需要等待；当前外部等待分支转为暂停，尚未实现设计文档所述的有效句柄等待流程。

调整建议：统一受阻入口，区分实际进展、经核实的等待、无进展。有效等待应指向当前仍存活的具体进程、运行或任务；不能只凭旧消息或锁文件判断。连续阻塞按同一原因累计，恢复后重新开始判断。不可恢复错误可以直接停止，但应与连续无进展区分。

验收场景：变化的时间戳不能清零无进展计数；有效等待不误判为受阻；失效句柄不能无限等待；模型首次声称受阻不能绕过约定的连续判断。

### 4.3 独立运行与能力边界需要分别验证

当前 `goal` 为可选字段，未发现 Goal 引入 `agent-runtime` 到 `server/services` 的反向依赖。这支持普通运行仍能独立使用的结构判断。

但是 [QueryEngine](../packages/core/src/engine/query-engine.ts) 包含目标提示、`GoalAssessment` 工具可见性与权限放行的专用分支。通用引擎已理解具体目标能力，后续扩展容易继续增加特判。

调整建议：将 Goal 提示、评估工具与生命周期行为收拢到可选扩展；core 提供通用的本轮上下文、工具注入和运行生命周期接口。持久状态与跨回合调度仍由宿主负责。受信任控制工具的权限处理也应有明确通用契约，不能简单放行所有工具。

不直接照搬 Codex 的完整扩展框架；先检查现有扩展入口，补足 Goal 实际需要的能力。

验收场景：在隔离消费者中安装并执行普通任务，不安装或启动 server/services，不配置 Goal 存储；未启用 Goal 时不出现 Goal 工具与提示；目标运行结束后不污染下一次普通运行。已有单元测试与类型检查不能替代独立安装包验证。

### 4.4 自动续跑次数不是 Token 预算

当前 `maxAutoTurns` 与 `autoTurnsUsed` 限制自动续跑次数，不限制单轮模型调用、耗时或子代理消耗。应继续称为“自动续跑上限”，不能在界面和文档中等同于成本预算。

后续若增加预算，应明确 Token 口径、根代理与子代理归集、失败和中断计费、超限停止时机以及重启后的记账。预算耗尽、服务商使用限制和用户暂停应至少拥有可区分的原因，不必立即复制 Codex 的所有状态。

### 4.5 maintenance 报错尚未定位根因

[DaemonOperationGate](../packages/server/src/application/control/daemon-operation-gate.ts) 在普通请求与维护屏障冲突时拒绝请求。这个错误证明当时存在冲突，不能据此断言维护锁残留。

此前结束 Electron 进程后，没有核实实际 daemon 的进程身份、维护操作和释放结果，因此“已释放”的结论没有充分证据。关闭进程也不能替代根因修复。

调整建议：记录维护操作类型、范围、开始时间、所属操作标识和释放结果；错误提示给出具体维护原因。先确认持有者与异常路径，再修复释放问题，不添加无条件清锁或任意超时释放机制。

验收场景：维护期间拒绝目标创建且草稿可重试；维护成功或失败均释放保护；用户可以知道当前在等待什么；不会在维护仍运行时强行放行写入。

## 5. 调整顺序

| 阶段 | 工作 | 完成条件 |
| --- | --- | --- |
| 一 | 完成评估与进展判断 | 补足要求与证据关系；统一受阻规则；验证部分完成、有效等待和重复无进展场景 |
| 二 | 收拢 Goal 扩展边界 | core 去除 Goal 专用分支；保持既有持久 Run 调度；通过普通运行独立安装包验证 |
| 三 | 用量与维护诊断 | 明确轮数和预算区别；按需增加用量控制；维护冲突可定位、可验证释放 |

已复现且持续阻塞使用的维护问题应提前处理，不必等待第三阶段。各阶段只运行与修改相关的测试，最后验证目标创建、续跑、暂停、恢复、用户插话、失败重试与普通运行。

实施记录见 [Goal 判断与扩展边界改进实现计划](./superpowers/plans/2026-09-12-goal-hardening.md)。没有增加旧评估双读或兼容层，也没有扩展站点等无关功能。
