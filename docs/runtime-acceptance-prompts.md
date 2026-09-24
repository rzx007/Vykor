# 真实运行验收提示词

> 状态：当前人工验收入口。这里的用户输入用于连接真实模型、工具和 daemon 后做冒烟验证；自动化契约测试见 [契约与测试索引](./contract-test-index.md)。

## 这份文档解决什么问题

单元测试能证明代码分支符合预期，但不能证明当前机器上的模型、Provider、权限、工具、MCP、后台进程和持久化目录已经正确连在一起。

下面每个用例都提供一段可以直接发送给模型的用户输入。验收时不要只看模型最后说“完成了”，还要检查实际产生的 Run、Tool、Child、Job、Permission 或 Workflow 记录。

这不是模型能力排行榜。模型可能采用不同步骤，只要没有违反用例限制，并且关键记录和最终状态正确，就算通过。

## 开始前

1. 使用一个可以丢弃改动的测试仓库，先确认工作区干净。
2. daemon、模型和 Provider 已经可以正常启动。
3. 使用普通权限模式；测试权限拒绝时再切换到 `plan`。
4. 不在提示词里放真实密码、令牌、生产地址或客户数据。
5. 每轮记下 Session ID、Run ID 和开始时间，方便从 TUI、Run Inspector 或数据库记录中核对。
6. 文中的 `ACCEPTANCE-日期-序号` 应替换成每次运行唯一的标记，例如 `ACCEPTANCE-20260823-01`。

建议先跑“最小验收集”，再按产品能力选择扩展用例：

```text
最小验收集：A1、A2、A3、A4、A7、A9
Coordinator / Workflow：再跑 A5、A6
长期运行与恢复：再跑 A8、A10、A11
外部接入：按配置跑 A12、A13、A14
```

## 怎样判定通过

所有用例都遵守以下规则：

- 用户输入只产生一个明确归属的 durable Input。
- 每个被创建的 Run、Tool、Child、Job、Permission 和 Workflow 都有稳定 ID。
- 已结束的记录进入明确终态，不长期停在 `pending` 或 `running`。
- 模型口头声称调用了工具不算证据；必须能看到对应工具记录和结果。
- 失败和拒绝也必须有终态及原因，不能伪装成成功。
- daemon 重启后仍能查到已经落盘的会话和运行记录。
- 测试产生的临时文件、后台任务、Schedule 和测试配置在验收后清理。

## A1：只读理解项目

验证：基础模型调用、Read/Glob/Grep 工具、Tool 记录、Run 正常收尾。

直接发送：

```text
请对当前仓库做一次只读检查，标记为 ACCEPTANCE-日期-01。

要求：
1. 必须实际使用文件列表、文本搜索和文件读取工具，不要只根据已有上下文猜测。
2. 找出工作区入口 package.json、docs/README.md，以及 Agent Runtime 和 daemon 的主要入口文件。
3. 用不超过 8 条要点说明：用户输入从产品入口到 Run 完成，大致经过哪些层。
4. 不修改文件，不运行安装命令，不访问网络。
5. 最后一行输出：ACCEPTANCE-日期-01 DONE。
```

通过时应看到：

- 一个 root Run 进入 `completed`。
- 至少有文件枚举、搜索、读取三类真实 Tool 记录。
- Tool 都有开始和结束记录，没有遗留的 `running` part。
- `git status` 没有新增改动。

## A2：写入、读取、执行、清理闭环

验证：文件工具、Shell、权限、工具结果投影和临时文件清理。

只在可丢弃的测试仓库中发送：

```text
请完成一次可回滚的工具闭环，标记为 ACCEPTANCE-日期-02。

步骤必须按顺序执行：
1. 在 .vykor/scratchpad/ 下创建 acceptance-smoke.txt，只写一行 ACCEPTANCE-日期-02。
2. 重新读取这个文件并确认内容完全一致。
3. 使用本机 shell 计算文件字节数，并报告实际数字。
4. 删除刚创建的 acceptance-smoke.txt。
5. 再检查一次，确认该文件已经不存在。

不要修改其他文件，不要使用网络，不要提交 Git。
最后列出每一步实际使用的工具和结果；如果任何一步失败，要明确说失败，不要假装完成。
```

通过时应看到：

- Write、Read、Shell 或等价工具都有 durable Tool 记录。
- 如果出现权限询问，Permission 有明确 decision。
- 临时文件最终不存在。
- Tool 失败时有结构化失败原因；全部成功时 root Run 为 `completed`。

## A3：失败工具也要正确收尾

验证：Tool 失败不会留下运行中记录，模型可以看到失败并给出诚实结论。

直接发送：

```text
这是一次失败路径验收，标记为 ACCEPTANCE-日期-03。

请使用 shell 执行一个确定会以退出码 7 结束的本机命令。不要重试，不要换成成功命令，也不要修改文件。执行后告诉我：
- 实际退出码；
- 这次失败是否被你正确观察到；
- 你没有完成任何业务改动。

最后输出 ACCEPTANCE-日期-03 OBSERVED_FAILURE。
```

通过时应看到：

- Shell Tool 进入失败终态，退出码是 7。
- Tool 不停留在 `running`。
- 模型没有把失败命令描述成成功。
- root Run 可以在解释完失败后正常 `completed`；工具失败和 Run 失败不是一回事。

## A4：后台 Job 的创建、等待和结果

验证：后台进程、统一 Jobs 接口、等待和进程终态。

直接发送：

```text
请做一次后台 Job 验收，标记为 ACCEPTANCE-日期-04。

启动一个本机后台命令：先等待约 2 秒，再输出 ACCEPTANCE-日期-04 BACKGROUND_OK，然后以退出码 0 结束。

要求：
1. 必须作为后台 Job 启动，不要以前台 shell 代替。
2. 记下返回的 Job ID。
3. 使用 Job 的读取或等待能力等它结束。
4. 返回 Job ID、最终状态、退出码和实际输出。
5. 不创建长期运行进程，不修改仓库文件。
```

通过时应看到：

- 后台执行有 Job ID，并与当前 Session 关联。
- Job 从运行中进入 `completed`，输出可读，退出码为 0。
- JobWait 或等价等待不会把已结束 Job 删除。
- daemon 关闭时没有遗留测试进程。

## A5：并行 Child Agent

验证：Child 创建、并行执行、父子关系、结果回收和 Child 终态。使用 Coordinator 模式运行。

直接发送：

```text
请使用 3 个 Child Agent 并行做一次只读检查，标记为 ACCEPTANCE-日期-05。

三个任务分别是：
1. 只读总结 packages/agent-runtime 的公开入口。
2. 只读总结 packages/server 的 durable Session/Run 入口。
3. 只读检查 docs/README.md 是否能索引到生命周期、数据模型和测试索引。

要求：
- 三个任务彼此独立，应同时派发，不要串行假装并行。
- 每个 Child 都不能修改文件、访问网络或再创建 Child。
- 等三个 Child 都结束后再汇总。
- 汇总中列出每个 Child 的 ID、任务、最终状态和一句结论。
```

通过时应看到：

- 三个 Child 有不同 ID，并共享正确的 parent/root 关系。
- 同一时间存在多个 active Child，证明不是模型口头描述的“并行”。
- Child Run、Task 和父 Run 都进入明确终态。
- 关闭 Session 后没有仍归属于该 Session 的活动 Child。

## A6：Child 预算拒绝无限扩张

验证：深度、活动数或累计创建数限制由 Runtime 强制执行，不靠提示词自觉。

开始前，把测试 Agent 的 `childBudget.maxActiveChildren` 临时设为 2。不要在日常配置上长期保留这个测试值。

直接发送：

```text
这是 Child 预算验收，标记为 ACCEPTANCE-日期-06。

请同时创建 3 个 Child Agent，每个等待 10 秒后返回自己的序号。不要串行执行，不要主动减少数量，也不要让已有 Child 再创建 Child。

如果 Runtime 拒绝其中一个创建请求，请原样报告拒绝原因，不要关闭已有 Child 后绕过限制重试。最后列出成功创建数量、被拒绝数量和所有已创建 Child 的最终状态。
```

通过时应看到：

- 同时活动上限为 2，第三个创建请求被明确拒绝。
- 被拒绝的请求有可理解的预算原因。
- 模型没有通过“关闭一个再创建一个”绕过本用例。
- 两个已创建 Child 最终收尾；测试后恢复原 `childBudget` 配置。

## A7：权限拒绝不是运行悬挂

验证：Permission 请求、用户拒绝、Tool 终态和 Run 后续回答。先切换到 `plan` 或其他会询问写权限的模式。

直接发送：

```text
请在 .vykor/scratchpad/ 下创建 permission-denied.txt，内容为 ACCEPTANCE-日期-07。除此之外不要做任何操作。
```

权限界面出现后选择“拒绝”，再发送：

```text
请说明刚才的写入是否真的发生。不要再次申请权限，不要换用 shell 绕过，也不要声称文件已经创建。
```

通过时应看到：

- Permission 请求和拒绝 decision 都已持久化。
- 对应 Tool 进入 denied/failed 终态，不停留在等待中。
- 文件不存在。
- 模型承认操作未执行，并且 Run 能正确结束。

## A8：运行中追加输入

验证：steer，也就是 Run 还在执行时追加新要求；追加内容应归属当前 Run，而不是悄悄创建第二个并发 Run。

先发送：

```text
请只读分析 docs 目录中关于 Runtime、Durable Application、Client 三层边界的文档，标记为 ACCEPTANCE-日期-08。分析前先读取相关文档，最后给出一份详细对照表。
```

在模型仍执行时立即追加：

```text
补充要求：对照表增加“状态保存在哪里”和“结果从哪里返回”两列，并把最终总结限制在 12 条以内。
```

通过时应看到：

- 两条 Input 都有 durable 记录。
- 第二条输入以 steer 归属原来的 active Run，正常情况下不创建第二个并发 root Run。
- 模型在后续 turn 中采用补充要求。
- 两条输入的 delivery receipt 都结算，原 Run 最终进入终态。

## A9：自动个性化与长期记忆

验证：成功 Run 后的维护链、显式记忆提取，以及新 Session 是否能读回。使用虚构信息，不要写真实凭据。

在 Session A 发送：

```text
请记住这个项目的测试约定：测试机固定写作 ssh qa@192.0.2.10，发布前检查命令固定写作 pnpm acceptance:check。192.0.2.10 是文档保留的虚构地址，不是真实机器。请复述一次，不要执行这些命令。
```

等 Run 完成后执行：

```text
/remember
```

新建 Session B，再发送：

```text
不读取 Git 文件，也不要搜索仓库。根据你已经保存的项目信息，测试机写法和发布前检查命令分别是什么？如果没有记住，请直接说不知道，不要猜。
```

通过时应看到：

- Session A 的 root Run 先进入 `completed`，之后的维护失败也不能改变它的终态。
- Personalization 或 Project Memory 中出现虚构测试约定，但不应保存任何密钥。
- Session B 能通过注入的规则或检索到的记忆回答；如果模型明确说不知道，应检查维护告警和 Memory 配置，不能仅凭期待判通过。
- 测试结束后删除这两条虚构记忆，避免污染日常使用。

## A10：Compact 后保持当前任务

验证：Session Memory checkpoint、Compact 和压缩后的任务连续性。

先发送：

```text
接下来的验收任务代号是 ACCEPTANCE-日期-10。三个硬约束是：只读、不访问网络、最后必须输出蓝色雨伞。请先检查 docs/README.md 的目录层级，再告诉我你已经理解，但暂时不要给最终总结。
```

进行几轮普通只读问答后执行：

```text
/compact
```

然后发送：

```text
现在完成刚才的验收任务：说明文档目录有几层，并复述任务代号和三个硬约束。
```

通过时应看到：

- Compact 前的成功 Run 已生成 Session Memory checkpoint。
- Compact 操作有明确结果，历史消息没有形成损坏的 Tool 配对。
- Compact 后模型仍能复述任务代号和三个约束，最后包含“蓝色雨伞”。
- Session 与后续 Run 都能正常继续，不需要创建一个假恢复 Session。

## A11：中断、重启和显式恢复

验证：interrupt、daemon restart recovery 和 `/resume`；旧 Run 必须保持中断态。

先发送一个会持续一段时间的任务：

```text
请启动一个约 30 秒的只读检查，每隔几秒检查一次 docs 目录文件数量，最后报告结果。标记为 ACCEPTANCE-日期-11。不要创建或修改文件。
```

运行期间执行中断，确认收尾后重启 daemon。回到同一个 Session，执行：

```text
/resume
```

从列表选择刚才的 Run，或执行 `/resume <run-id>`。

通过时应看到：

- 旧 Run 和仍在执行的 Tool/Job/Child 进入 `interrupted` 或对应终态。
- daemon 重启后 Session、Input、旧 Run 和 transcript 仍然存在。
- 系统不会把旧 Run 从 `interrupted` 改回 `running`。
- `/resume` 创建新的执行归属并重放原始输入，新旧 Run 可以明确区分。

## A12：Workflow 的依赖和汇总

验证：Workflow DAG、并发节点、依赖结果、持久化状态和最终汇总。使用 Coordinator 模式。

直接发送：

```text
请用 Workflow 执行一次只读架构核对，标记为 ACCEPTANCE-日期-12。

建立 4 个节点：
- runtime：读取 Agent Runtime 架构文档并给出 3 条职责。
- application：读取 Daemon Application 架构文档并给出 3 条职责。
- client：读取 Client Sync 文档并给出 3 条职责。
- summary：必须依赖前三个节点，整理三层边界和一条完整请求链。

前三个节点应并行，summary 只能在前三个都结束后运行。所有节点只读，不访问网络，不修改文件。最后返回 Workflow ID、每个节点状态和 summary 结果。
```

通过时应看到：

- 一个持久化 Workflow 和四个稳定节点 ID。
- 前三个节点可以并发；summary 的开始时间晚于三个依赖终态。
- 节点输出实际进入 summary 输入，不是父模型重新猜测。
- Workflow、节点、Child 和父 Run 都进入明确终态。

## A13：严格 MCP 配置与真实调用

验证：MCP 连接、工具发现和调用。只在已经配置测试 MCP server 时执行，把占位符替换成真实名称。

开始前确认 MCP 配置明确包含 `type`，并且只包含对应 transport 的字段。然后发送：

```text
请使用 MCP 服务器 <SERVER_NAME> 的 <TOOL_NAME> 完成一次只读调用，参数是 <SAFE_ARGUMENTS>。必须实际调用 MCP 工具，不要用本地工具代替。返回 server 名、tool 名、调用是否成功和结果摘要；不要输出认证 Header、环境变量或令牌。
```

通过时应看到：

- MCP connection 明确记录 `stdio`、`http` 或 `sse` transport。
- 调用记录使用正确的 server/tool 名并进入终态。
- 缺少 `type`、空 `command`/`url` 或混合两类 transport 字段时，连接应直接失败，不能猜测。
- 日志和模型输出中没有认证信息。

## A14：Bot/Channel 的幂等消息

验证：同一条外部消息不会重复运行，回复通过原 Channel 返回。只在测试 Bot 和测试群中执行。

从 Bot 所在平台发送：

```text
ACCEPTANCE-日期-14：请只回复当前项目名称、当前 Session ID，以及字符串 BOT_OK。不要调用写工具。
```

然后使用测试平台或适配器的重放能力，把同一个外部 message ID 再投递一次。不要手工发送一条内容相同但 ID 不同的新消息。

通过时应看到：

- 第一次消息创建一个 durable Input 和一个 Run。
- 相同外部 message ID 的重投不会创建第二个业务 Run。
- 回复发回原 Channel，并与原消息或会话正确关联。
- 发送失败时进入明确的 retry/failed 状态，不能把未送达记录成成功。

## A15：Schedule 创建、立即运行和清理

验证：Schedule 的持久化、触发、Scheduled Run 和结果记录。只在测试项目执行。

直接发送：

```text
请创建一个一次性测试 Schedule，名称为 ACCEPTANCE-日期-15，计划在 10 分钟后运行。任务内容是：只读读取 docs/README.md 的一级标题，并返回 ACCEPTANCE-日期-15 SCHEDULE_OK。创建后告诉我 Schedule ID 和下次运行时间，但先不要等待 10 分钟。
```

随后发送：

```text
请立即运行刚才 ID 为 <SCHEDULE_ID> 的 Schedule，等待这次运行结束，返回 Scheduled Run ID、最终状态和输出。完成后删除这个 Schedule，并确认它不再出现在列表中。
```

通过时应看到：

- Schedule 和立即运行产生的 Scheduled Run 使用不同的稳定 ID。
- Scheduled Run 关联实际 Session/Run，并进入明确终态。
- 删除 Schedule 不会抹掉已经发生的运行审计记录。
- 测试 Schedule 最终不再触发。

## 验收记录模板

每次可以复制下面的表格到 Issue、PR 或验收记录中：

```markdown
| 用例 | 产品入口 | Session ID | Run/Job/Workflow ID | 结果 | 证据或问题 |
|---|---|---|---|---|---|
| A1 | TUI | | | PASS/FAIL | |
| A2 | TUI | | | PASS/FAIL | |
| A3 | CLI --print | | | PASS/FAIL | |
| A4 | TUI | | | PASS/FAIL | |
| A5 | Coordinator | | | PASS/FAIL | |
| A7 | Desktop | | | PASS/FAIL | |
| A9 | TUI | | | PASS/FAIL | |
```

问题记录至少包含：

- 实际用户输入和使用的产品入口；
- Session ID、Run ID，以及相关 Tool/Child/Job/Workflow ID；
- 期望终态和实际终态；
- daemon 是否重启过；
- 可以公开的错误类别和时间点；
- 不包含 prompt 正文、令牌或工具敏感参数的日志片段。

## 相关权威文档

- [架构总览](./architecture-overview.md)：先确认各产品共用的主链。
- [Daemon Application Architecture](./daemon-application-architecture.md)：核对 Input、Run、steer、interrupt、resume 和运行后维护。
- [Agent Lifecycle Contract](./agent-lifecycle-contract.md)：判断各种记录是否正确收尾。
- [Durable Execution Data Model](./durable-execution-data-model.md)：核对 ID、关系、版本和终态字段。
- [Agent Child Session Flow](./agent-child-session-flow.md)：核对 Child 和预算。
- [Jobs Protocol](./jobs-protocol.md)：核对后台进程和统一 Job 状态。
- [Memory System](./memory-system.md)：核对 checkpoint、长期记忆和 Dream。
- [Permission Flow](./permission-flow.md)：核对权限请求和拒绝。
- [Coordinator 硬调度器调用链](./coordinator-hard-scheduler-flow.md)：核对 Workflow DAG。
- [Channels Flow](./channels-flow.md)：核对 Bot/Channel 幂等和回复。
- [Scheduled Tasks Flow](./scheduled-tasks-flow.md)：核对 Schedule 和 Scheduled Run。

