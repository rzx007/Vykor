# Agent 跨包回归测试

这里验证 Core 模型/工具循环与 API、权限、提示词、真实文件工具组合后的行为：流中断重试、参数纠错、文件保护、内容复用、Shell 分页、Job 等待时限及 ToolSearch 注册表接入。

`__test__/context-compaction.integration.test.ts` 连接真实 Codex / OpenAI 客户端与 Core，只替换网络响应，覆盖流内超长恢复、工具定义限制不压缩历史及摘要输出上限。它还连接真实 SQLite 目标用量账本，验证无限预算时恢复后逐次记账、显式预算下未知用量仍暂停。

文件工作流与内容复用回归分别验证调用状态和实际文件内容：框架在调用前拒绝时保持 `not_started`；工具已被调用后，其自报的 `not_started` 由共同入口归为 `unknown`。真实 Write/Edit 的调用次数、文件未被错误覆盖、内容复用重新检查权限及显式纠正后成功的断言同时保留，不能仅凭执行状态推断文件是否改写。

`__test__/approval-review.integration.test.ts` 验证定时任务输入经过独立审查、用户指令核实和审批存储后，能在审查输出截断并重试成功时解除 BackgroundShellCreate 的等待，且不留下待人工确认的请求。

`__test__/mcp-discovery-continuation.integration.test.ts` 将实际 `McpToolCall` 与 Core 循环连接，验证同一批次搜索加载工具后，下一次调用可以重新检查权限；同时覆盖权限拒绝、同名非 MCP 来源和不存在的目标。只替换模型响应与目标执行，不手写转发工具。

`__test__/result-delivery.integration.test.ts` 通过真实 SQLite、Kernel、QueryEngine 和宿主派发前检查，检查结构错误及实际文件校验失败都在工具派发前拒绝，实际工具执行次数为零；补齐文件后可以取得经过校验的交付回执。它也验证取消仍在等待宿主核验的运行后，迟到的通过结果不会再次派发工具。

测试使用离线响应、临时目录或注入的执行器，不需要模型凭据。工具自身的输入校验、搜索和 Job 参数适配测试保留在 `packages/tools/src/meta/__test__/tool-search.test.ts` 与 `packages/tools/src/job/__test__/job-tools.test.ts`。



`__test__/job-safety.integration.test.ts` 使用默认工具注册表、独立结果存储和真实后台 Node 进程，验证 Browser 返回错误后 JobWait 仍等待实际完成，JobRead 与 JobList 返回实际输出。还通过单个实际 Node Run 串联 Browser → JobList/JobRead/JobWait → Shell 文件效果 → 最终报告，并覆盖 Shell 权限拒绝。脚本和完成信号均在临时目录。

运行 `pnpm test:agent-integration`；根 `pnpm test` 已包含此命令，普通 CI 的 Test 步骤会继续执行。两个工具测试由 `pnpm --filter @vykor/tools test` 覆盖。跨包测试直接运行，避免沿用 Runtime 包的缓存而遗漏 API 或工具变化。


`__test__/shared-job-composition.integration.test.ts` 是阶段 A 双入口验收：每种模式覆盖真实 child 多轮和旧轮取消、无关来源 list 故障、唯一 Shell 归属、原生 PTY 退出、单步骤 Workflow。共享夹具放在 `__test__/fixtures/task-lifecycle-fixture.ts`。另用真实原生 PTY 验证 daemon 没有 live root 时仍使用显式 Terminal provider，连续读取不会关闭宿主资源。

`__test__/child-run-settlement.integration.test.ts` 验证阶段 B：24 轮复用与 24 新身份、64/65 累计上限、8 真实调用并发、停止与清理屏障、终态保存补偿、旧轮隔离、256 条保存/未保存留存、拒绝输入和 steer 别名、Shell 原终态补存。原因表逐一比较 live 结果、原终态事件和恢复后的持久输出；模型/工具执行计数确认没有重放。更窄的真实工厂启动 ACK 丢失、准备撤销与重复取消清理回归放在 Runtime 的 `node/children/__test__/child-run-settlement.test.ts`。

普通返回错误和未知结果不阻断后续新调用。实际 Browser 错误后的 Shell 派发与普通权限拒绝见 Server 的 `application/__test__/unknown-outcome-default.test.ts`，Job 读取和等待见 `job-safety.integration.test.ts`。

`__test__/workflow-child-lifecycle.integration.test.ts` 是阶段 C 的真实 SDK/daemon 验收，使用同一默认工厂、ChildManager、实际 handle 和临时 SQLite。覆盖每模式 3×12 顺序 worker、8 并发/第 9 个核心拒绝、取消/deadline 的真实 Read 与清理屏障、查询失败不替代、ACK 失败不重叠、重复 Workflow 取消确认原清理、旧 attempt、同 tick send/suspend、历史/cwd/授权恢复、保留活动及空闲后代、实际未决审批和动态模型目录撤销。

受控模型只替换网络响应；Read 包装执行原实际 Read 后等待，保留正常权限、当前宿主检查和真实调用收尾。期望核心接纳拒绝在真实 JobList 运行范围内探测，不把失败的写工具当成功。没有手写 child/handle、固定成功 Promise 或 mock 默认工厂。

`__test__/child-native-execution.integration.test.ts` 通过真实 SDK / daemon 工厂和实际 child handle，验证子 Shell 的会话归属、不同 cwd 和 SQLite 输出，以及子 Terminal 的打开、读取、取消和实际退出；用户手动 PTY 的已知 ID 也不能由同会话 child 控制，定点拒绝不依赖 list 成功。

`__test__/workflow-timeout.integration.test.ts` 验证顶层时限进入同一 coordinator，并等待真实 Read 与清理完成。生命周期的 deadline 用例使用受控计时器，先确认实际 Read 进入再推进期限；另测模型尚未返回时到期，明确验证 Read 未派发，避免无限等待一个不会发生的 Read 门闩。查询失败跨过期限仍保持原 child / run，不产生额外尝试。

child-run-settlement 的预算反馈贯通用例沿真实默认工厂运行：达到轮次上限、分别保存报告与错误、JobWait 读取、显式新输入接纳、旧轮重放保护、关闭后按旧 target 读取归档。既有保存失败原因表同时核对 Task／Run 错误，调用计数确认恢复没有重放模型或工具。受控网络响应不能证明真实模型一定会说明全部缺项。

`__test__/child-environment-ownership.integration.test.ts` 使用真实 SDK / daemon 加载器、SQLite、两层 child handle 和原生 Shell 核对各会话目录、有效审批设置及独立租约；同一子会话卸载恢复后重新申请租约，关闭时各释放一次。

同文件还通过真实 DaemonApplication、默认 Node 工厂和 child handle 验证宿主目录与环境内执行目录不同时的派发检查：权限校验使用宿主目录，工具实际收到环境内目录。该用例注入目录映射，不要求测试机安装 WSL，也不冒充真实 WSL 进程验收。

`__test__/nested-session-jobs.integration.test.ts` 从实际子会话经 HTTP 共用的 `app.jobs` 读、等、取消和继续输入孙级任务。覆盖其他来源列表故障、并发旧轮输入、严格工具身份与权限上限、跨树拒绝、暂停后只读归档，以及关闭未确认时保留实际 stopping 查询。
