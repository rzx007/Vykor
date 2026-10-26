---
title: OpenHarness-ts 核心 Agent 能力补齐方案
subtitle: 保留安全与交付，简化参数入口、结果查询和存储绑定
template: doc
theme: paper
lang: zh
date: 2026-10-26
---

# OpenHarness-ts 核心 Agent 能力补齐方案

> 基线：`1ba5452f981cf2d4b6c1921214cd659871f46b21`，已合并并推送到 main。本轮先文档后实现，不提交、合并或推送。

> 当前进度：简化实现和限定范围验证完成，见[简化验收](../reviews/2026-10-26-agent-capability-simplification.md)。工作区改动尚未提交。

## A 当前目标与边界

日常任务重开后，需要继续读取历史结果，并保持工具执行安全。
近期放弃完整 S2 跨进程恢复；不引入恢复调度、Workflow 持久化或持久审批。
本方案替换早期面向无人值守长任务的设计，只简化已实现能力。

| 已实现能力 | 本次保留行为 |
|---|---|
| S1 工具执行安全 | 未知写操作阻断；owner、revision、Run 状态和来源检查 |
| 长结果补读 | 当前授权范围内列举、分页、字面检索；SQLite 重开后可读 |
| 工具式结构化交付 | 真实 SubmitResult、schema 校验、可选宿主校验和交付回执 |

不处理 S2/S3、SDK 超容量降级、Operation/Attempt 正文去重。
不扩大只读工具分类，不新增未知操作界面或桌面交付展示。
旧工作树中已撤回的 S2.1 计划保持原样，不纳入本次修改。

## B 请求入口与记录读取

HTTP、客户端、编辑和重放请求只接受显式 `outputSchema`。
`metadata.outputSchema` 和 `runMetadata.outputSchema` 是记录快照，不再是请求参数。
新请求使用隐式入口时明确报错，避免静默丢失约束。

```flow LR
HTTP 或客户端 -> 显式 outputSchema: 新请求
显式 outputSchema -> 请求校验: 支持范围与 64 KiB 上限
请求校验 -> Input 与 Run 快照: 受理时写入
Input 与 Run 快照 -> 记录读取: 兼容旧数据并核对冲突
记录读取 -> outputContract: 执行配置
outputContract -> SubmitResult: 真实工具执行与校验
SubmitResult -> 交付回执: 成功后收尾
```

请求处理与记录读取使用不同函数。
请求校验只处理显式字段，受理时写入快照。
记录读取允许从旧快照取得 schema，同时核对 Input 与 Run 是否冲突。
底层 schema 支持范围与大小校验共用，避免规则漂移。
旧数据不迁移，Input、Run 的快照字段继续保留。


编辑产生新 Input 与新 Run，可以显式指定新 schema。
同一编辑请求 ID 重投时，schema 不同仍然冲突。

重放和 resume 沿用原 Input 合同；显式 schema 只能重复原合同。
普通任务不能通过重放追加合同，结构化任务也不能被降级。
steer 和活跃子 Run 继续拒绝改变合同。
客户端检查服务端能力；HTTP 与应用入口都拒绝隐式参数。

## C 安全判断只读取状态

`ToolOperationService.assertUnblocked` 继续判断同一会话树中的未知写入。
Repository 的有限查询只返回 ID、session、Run、kind 和 state。
查询不复制输入、结果正文、Attempt 或完整 Operation。

Server 保留会话祖先、Run 终态和结算失败判断。
Repository 保留存储状态和原有派发保护。
只读操作、迟到回执和未知写入的处理规则不变。
Operation 和 Attempt 继续保存现有审计正文。

## D 结果查询先授权，再分页

Repository 增加结果候选查询与单条文本读取。
候选只含引用身份、工具名称、来源、Run 和调用身份。
只有已完成且可读取的 Operation 才成为候选。

```flow LR
ToolResult list -> 候选元数据: 同一 session
候选元数据 -> 当前工具来源授权: 排除撤销工具与内置读取器
当前工具来源授权 -> 分页: 校验 offset 与 limit
分页 -> 当前页正文: 逐条读取
当前页正文 -> 结果引用: 计算 totalChars
ToolResult read 或 search -> 单条候选: 引用与 session
单条候选 -> 单条授权: 当前工具及来源
单条授权 -> 单次正文读取: 文本和引用用于分页或检索
```

`ToolResultRef.totalChars` 保持 UTF-16 字符位置契约。
长度来自当前页结果的 `toolResultText` 文本视图。
非文本块使用现有占位文本，块间换行也计入长度。
list 仍读取当前页完整正文，read/search 仍生成单条完整文本。
不承诺零正文读取，也不隐藏全量长度扫描。
未授权和分页外结果不生成文本、不计算长度、不复制正文。

read/search 每次只查一条候选、授权一次、读取一次正文。
retain 核对保存记录、Run、调用身份和来源后返回引用。
查询继续在现有事务和 owner 校验下完成。
不新增缓存、服务层、表或通用查询框架。

SQLite 当前会加载既有状态；本次不改启动加载方式。
列表仍扫描候选元数据，以确定授权后的数量与分页边界。
这是沿用现有内存状态的成本，不是正文扫描。

## E 存储绑定统一走工厂

生产路径由 `PreparedAgentRun.bindToolResults(finalTools)` 创建存储。
模型执行和手动 `runTool` 共用绑定函数。
工厂收到最终工具集合，工具上下文只收到绑定后的存储。

```flow LR
准备 Run -> 确定最终工具集合: 收窄权限
确定最终工具集合 -> await run.started: 持久化投影
await run.started -> 绑定结果存储: 最终工具集合
绑定结果存储 -> 确认 started: 绑定完成
确认 started -> 请求模型: 开始执行
手动 runTool -> 准备 Run: 取得安全与存储能力
```

子 Run 必须保持上述启动顺序。
手动执行沿用宿主 scope，不新增模型 Run 启动事件。
手动执行不再因显式 store 与安全能力齐全而跳过准备。

SDK 包公开导出 PreparedAgentRun 和 runTool 选项。
README 与测试已明确预绑定存储的可用条件，构成兼容约束。
本轮将 `PreparedAgentRun.toolResults` 和手动 `options.toolResults` 标记弃用。
旧调用在唯一绑定函数中适配，不新增适配框架。
Prepared 旧存储仍核对工具名称、来源、定义和调用函数。

这段等价检查暂不能删除，否则收窄权限后可能读取越权历史。
手动显式 store 保留可信宿主已绑定语义；新代码使用准备工厂。
当前仓库生产路径不依赖这两个旧字段。

## F 状态归属与不可破坏的顺序

| 状态 | 所有者 | 入口与返回 |
|---|---|---|
| schema 参数与合同冲突 | Server 应用用例 | 受理、编辑、重放；创建记录前拒绝错误 |
| Input/Run 合同快照 | 现有会话存储 | 受理时保存，执行入口读取 |
| 操作状态与审计正文 | ToolOperationRepository | S1 保存和核对，结果读取器提供只读视图 |
| owner、Run、revision 与来源授权 | Server 结果服务 | 每次访问校验，返回当前允许的数据 |
| SDK 历史结果 | Agent 的有界内存存储 | 工厂按 Run 和最终工具集合绑定 |
| 运行取消与交付事件 | Kernel/core | 已保存结果继续交付，终态不重开 |

原始工具结果先保存，随后生成引用并交付。
取消可以拒绝新的补读，但不能丢掉已完成、已保存结果。
跨 session 访问继续拒绝，父子和同名工具都不能绕过。
来源替换后，旧结果只能由当前被授权的原来源读取。

SubmitResult 必须真实执行；普通文本不能冒充成功交付。
schema 合法不能代替可选宿主业务验收。

## G 实施与验收

按[简化计划](../plans/2026-10-26-agent-capability-simplification.md)先收敛参数，再减少查询搬运，最后统一绑定并回归。
原[交付计划](../plans/2026-10-26-result-reading-and-structured-delivery.md)和[验收](../reviews/2026-10-26-result-reading-and-structured-delivery.md)保留为基线记录。
本轮结果记入[简化验收](../reviews/2026-10-26-agent-capability-simplification.md)。

覆盖显式参数、隐式拒绝、编辑冲突、重放继承和旧快照读取。
覆盖安全检查无正文复制、授权后分页和单次正文读取。
覆盖历史重开、跨会话拒绝、取消交付和真实 daemon 子 Run。
按风险运行定向测试、相关类型检查和文档检查。

HTML 由 answer-me-with-html CLI 从本文生成。
本文是唯一内容源；生成时只转换本地链接，不维护第二份正文。
