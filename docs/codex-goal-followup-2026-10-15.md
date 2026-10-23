# Codex Goal 复查：准备关卡与真实失败原因

> 状态：历史研究快照，记录 2026-10-15 的调查证据，不代表后续实现。

日期：2026-10-15。针对“默认不限预算，仍在执行前因调查次数用完而失败”的复查。此次只调查并保存证据，未修改运行代码、真实数据库或现有 Goal spec。

## 结论

**不能把我们目前的“独立只读准备批次 + 5 次模型调用 + 4 次调查工具 + 提交并冻结条件后才执行”描述为 Codex 的实现。**这些是本项目 C 阶段加上的工程设计。当前安装包的公开协议、前端请求及内置续跑提示，支持的是“保存并激活目标、宿主续跑、执行过程中核对目标、完成或真正受阻后报告状态”。

没有原生反编译或受控运行证据，仍不能断言 Codex 后端绝对没有任何内部准备或工具限制。准确结论是：**本次未取得支持同款前置关卡的证据；我们自己的这条关卡已经造成可复现失败。**

最新截图还有一个独立且确定的代码错误：准备阶段过滤掉了宿主提供的 Read，导致模型收到 `Unknown tool: Read`。上次只把模型次数从 2 增加到 5，没有修复这个错误，也没有消除调查额度直接终止任务的问题。

## 1. 实际分析的版本和证据范围

本机原先指定的旧目录已不存在；当前目标为：

```text
C:/Program Files/WindowsApps/OpenAI.Codex_26.1007.9446.0_x64__2p2nqsd0c76g0/app/resources/
```

- `codex.exe` SHA-256：`e98c516f1c8935789aabe9122ee7e05ec4c3efd1ba6acf179242e031c495b99e`。与初次报告的后端摘要不同，已重新核对。
- ASAR 摘要、成员路径、字节位置及成员摘要保存在 [前端证据](research/codex-goal/2026-10-15-frontend-followup.json)。
- 运行该后端的 `app-server generate-ts --experimental --out <新临时目录>`，仅导出协议；未创建真实 Codex Goal 或发送模型任务。选定定义见 [协议证据](research/codex-goal/2026-10-15-protocol-followup.json)。
- 原生文件使用精确字节检索和可读模板提取，属于普通文件工具证据，**不是反编译结果，也不是 REA Evidence**。记录见 [原生证据](research/codex-goal/2026-10-15-native-followup.json)。

REA 的原生分析当前不可用：Ghidra 未配置，IDA 未配置，Hopper 不支持当前 Windows 主机。因此没有取得后端函数控制流、调用栈或隐藏计数器的证明。

REA 全包分析首次报告完整性冲突：一个 unpacked 串口 `bindings.node` 的声明摘要和实际摘要不同。随后采用 record-and-continue 保留异常，但全包分析耗时过长，主动停止；查询证据账本未得到该次完整分析记录，不能引用为已分析完毕。

为控制范围，改为从原 ASAR 原样提取一个 2748 字节的 Goal 缩略图成员，单独交 REA 分析，成功解析 1 个 JS 文件。其导入模块未一并分析；205 项语义未知仍保留。该证据只支持界面成员自身的字段读取和状态显示，不用于证明后端调度。

- 成员：`webview/assets/registered-65d3e6c78c19.js`，提取身份见 [成员记录](research/codex-goal/2026-10-15-rea-member.json)。
- REA parent：`ev_e32e934543d0864b98ee553b9f99c7451d3c4cf24ff47e1d5fee650d9672a264`。
- REA summary：`ev_7d492691b7c130ba280867d06de62e0387f95c2999c0d37c6e7a27a150fbc225`。完整摘要与限制见 [REA 记录](research/codex-goal/2026-10-15-rea-summary.json)。

## 2. Codex 中重新确认了什么

| 问题 | 直接观察 | 可以得出的结论与边界 |
| --- | --- | --- |
| 目标从哪里开始 | `.vite/build/src-DCNiwad_.js` 的目标设置函数调用 `thread/goal/set`，提交 `threadId`、`objective`、`status: active` | 此可见入口直接设置 active；没有在这段前端链路中先调用独立条件准备接口。不能据此前端证明后端全部步骤 |
| 对外有什么持久字段 | 导出 `ThreadGoal` 包含正文、状态、可空 Token 预算、已用 Token、耗时和时间戳 | 对外 DTO 没有 `phase: preparing`、准备次数、调查次数或冻结要求集合。仅限导出的协议边界 |
| 状态有哪些 | `active / paused / blocked / usageLimited / budgetLimited / complete` | 准备阶段不是这份公开协议的 Goal 状态；不能把本项目的 preparing 归为已复原行为 |
| 谁推进下一回合 | 新二进制仍完整包含初次 N05、N10、N11 的日志字面量，涉及 idle continuation、输入派发与恢复 | 支持宿主续跑的设计判断；精确调度顺序、锁和自动恢复细节仍未反编译 |
| 预算默认是否必须有限 | `ThreadGoal.tokenBudget` 可空；工具说明要求只有明确请求预算才设置 | 用户未指定预算时不应凭空设定 Token 预算；这不表示服务商或宿主没有其他限制 |
| 怎么判断完成 | 完整续跑模板要求从原始目标及引用材料推导条件，逐项核对当前权威证据 | 这是执行过程中及完成前的模型审查契约，不是“先读几次文件并冻结 DoD 后才准执行”的证明 |
| 遇到困难怎么处理 | 模板要求还有安全可行操作就继续；同一真正阻塞至少连续三轮，且确实无法推进时才 blocked | 硬调查额度直接失败不是该模板表达的阻塞判断。该模板不证明所有计数由后端强制实现 |

完整续跑模板在二进制中的文件偏移为 **263569122**，原始范围 6507 字节；可读版统一了换行，见 [续跑模板](research/codex-goal/2026-10-15-continuation.txt)。它还明确要求跳过琐碎任务的计划开销，不能把更新计划当作实际进展。

在该二进制全文件中，`preparation_limit`、`preparedRequirements`、`preparation episode`、`GoalAssessment` 的精确字节检索均无匹配。这只是对这些拼写的有限负向结果：名称可能不同，不能据此证明内部绝无同类结构。

## 3. 我们这次为什么失败

真实数据库通过 SQLite `mode=ro` 检查，子代理同时复核了源码链：

| 项目 | 记录 |
| --- | --- |
| 会话 | `a74f1b9d-d522-4e5a-b9ab-bf8a79b1eda1` |
| Goal | `b8eeabfb-a7f9-4b54-88c9-f72b2993e6e2` |
| Run | `988fcb78-9222-4cbe-a156-9897b6b8a300` |
| 工作目录 | `D:/code/personal-project/OpenHarness-ts`，本次正确 |
| 用户限制 | `maxAutoTurns = 0`，`tokenBudget = NULL`，不限 |
| 实际调用 | 4 次模型调用，已记账 34521 Tokens |
| 准备调查 | 成功预留 4 次；随后工具调用被内部调查上限拒绝 |
| 最终状态 | Run failed；Goal paused/preparing；停止码 run_error |

调用顺序为：Glob、Grep → 两次 Read 返回 Unknown tool → 两次 Grep 成功 → 两次 Grep 被额度拦截。Read 未进入执行，因此没有消耗这 4 次调查预留，但浪费了模型往返并迫使模型改用更多搜索。

Read 装配错误的入口和结果：

1. [daemon-application.ts](../packages/server/src/application/daemon-application.ts)（调查时第 600 行）用支持附件的宿主 Read 覆盖标准 Read，并标记 `trustedToolOverrides: ["Read"]`。
2. [default-runtime-tools.ts](../packages/agent-runtime/src/node/runtime/default-runtime-tools.ts)（调查时第 68 行）却把覆盖后的来源登记为 `kind: agent`。
3. [run-capability-view.ts](../packages/agent-runtime/src/node/plugins/run-capability-view.ts)（调查时第 81 行）的准备工具过滤仅保留 `kind: builtin`，把这个可信宿主 Read 也丢掉。
4. [query-tool-preparation.ts](../packages/core/src/engine/tools/query-tool-preparation.ts)（调查时第 47 行）找不到工具后直接返回 `Unknown tool: Read`，尚未进入参数校验，所以不是 offset 或 path 填错。
5. [attachment-read-tool.ts](../packages/server/src/application/attachments/tools/attachment-read-tool.ts)（调查时第 32 行）本来可以把普通路径委托给标准文件读取器。

随后 [goal-transactions.ts](../packages/services/src/goals/goal-transactions.ts)（调查时第 212 行）的 4 次工具上限抛错，[session-goal-service.ts](../packages/server/src/application/session/session-goal-service.ts)（调查时第 88 行）把它转换为执行限制错误，最终作为准备 Run 失败结算。

因此，“默认预算未生效”和“本次仍然选错项目”都不是这次故障的解释。项目里现有准备 runtime 测试使用纯 builtin Read，未覆盖生产中的可信宿主 Read 覆盖，这是之前测试通过而真实使用失败的具体缺口。

## 4. 建议收敛方向，不再只调数字

以下是本项目建议，不宣称复原了 Codex 原生内部代码。本次没有实施这些建议：

1. **先修复可信宿主 Read 被过滤的问题。**只承认宿主已核实的覆盖身份，不能为修复而允许任意 `agent` 或插件同名工具进入准备环境。验证应使用和生产一致的附件 Read 装配。
2. **取消“所有目标必须先完成一轮独立调查”的产品前提。**明确目标应尽快执行；需要用户选择时再提出具体问题。若仍保留内部条件整理，应只承担提取原始条件的职责，不提前验证、穷举或执行目标，也不因一次整理失败把明确任务整体报错。
3. **将准备额度触达变为可恢复结果。**已有条件足够时提交；确实缺少信息时说明缺什么；工具装配错误按真实错误报告。不能捕获所有异常后都解释为“额度已用完”，更不能要求用户为内部接线错误补预算。
4. **保留已有可靠性成果。**目标版本、变更审计、用户预算、用量账本、具体任务等待、完成证据和停滞检测仍有价值；无需重写 Goal 或把全部 C 阶段推倒。

## 5. 本次问题覆盖

- 目标如何提交并激活：已回答到前端和导出协议边界。
- 是否存在与本项目相同的强制准备关卡：没有支持证据；后端内部绝对不存在与否仍未解决。
- 是否存在 4 次调查或 5 次模型的 Codex 原生上限：未取得支持证据，不能归因于 Codex。
- 新截图为什么失败：已回答，真实记录与生产装配源码相互印证。
- 是否实测 Codex 在同一目标下的执行行为：未做；本次没有运行真实模型任务，也没有验证原生调度的完整控制流。

本次修改仅为研究记录和证据文件；未运行项目测试，不声称任何运行故障已经修复。
