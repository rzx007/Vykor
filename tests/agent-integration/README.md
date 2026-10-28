# Agent 跨包回归测试

这里验证 Core 模型/工具循环与 API、权限、提示词、真实文件工具组合后的行为：流中断重试、参数纠错、文件保护、内容复用、Shell 分页、Job 等待时限及 ToolSearch 注册表接入。

`__test__/approval-review.integration.test.ts` 验证定时任务输入经过独立审查、用户指令核实和审批存储后，能在审查输出截断并重试成功时解除 BackgroundShellCreate 的等待，且不留下待人工确认的请求。

`__test__/result-delivery.integration.test.ts` 通过真实 SQLite、Kernel、QueryEngine 和宿主操作服务，检查结构错误及实际文件校验失败都在工具派发前拒绝，没有工具尝试或未知写入；补齐文件后可以取得经过校验的交付回执。它也验证取消仍在等待宿主核验的运行后，迟到的通过结果不会再次派发工具。

测试使用离线响应、临时目录或注入的执行器，不需要模型凭据。工具自身的输入校验、搜索和 Job 参数适配测试保留在 `packages/tools/src/meta/__test__/tool-search.test.ts` 与 `packages/tools/src/job/__test__/job-tools.test.ts`。

`__test__/durable-tool-operations.integration.test.ts` 启动独立 Node worker 和真实临时 SQLite，在三个已知提交位置强制杀进程，再以新 owner 重开数据库。测试分别核对派发意图、未知结果与已确认回执，并用独立效果文件确认没有重复写入；它不验证 S2 的模型检查点续跑。夹具位于 `__test__/fixtures/`。

`__test__/s1-tool-safety-pipeline.integration.test.ts` 将真实 Shell、Core 工具循环和 SQLite 操作服务接在一起：超时及部分输出进入下一次模型请求，可信只读检查可继续，未知写入仍拦截新 ID 的危险调用；读取成功本身不解除保护。真实迟到回执可以恢复后续写入，但不会重复交付原工具结果。回执保存失败仍走致命错误通道。

运行 `pnpm test:agent-integration`；根 `pnpm test` 已包含此命令，普通 CI 的 Test 步骤会继续执行。两个工具测试由 `pnpm --filter @vykor/tools test` 覆盖。跨包测试直接运行，避免沿用 Runtime 包的缓存而遗漏 API 或工具变化。


`__test__/shared-job-composition.integration.test.ts` 是阶段 A 双入口验收：每种模式覆盖真实 child 多轮和旧轮取消、无关来源 list 故障、唯一 Shell 归属、原生 PTY 退出、单步骤 Workflow。共享夹具放在 `__test__/fixtures/task-lifecycle-fixture.ts`。另用真实原生 PTY 验证 daemon 没有 live root 时仍使用显式 Terminal provider，连续读取不会关闭宿主资源。

`__test__/child-run-settlement.integration.test.ts` 验证阶段 B：24 轮复用与 24 新身份、64/65 累计上限、8 真实调用并发、停止与清理屏障、终态保存补偿、旧轮隔离、256 条保存/未保存留存、拒绝输入和 steer 别名、Shell 原终态补存。原因表逐一比较 live 结果、原终态事件和恢复后的持久输出；模型/工具执行计数确认没有重放。更窄的真实工厂启动 ACK 丢失、准备撤销与重复取消清理回归放在 Runtime 的 `node/children/__test__/child-run-settlement.test.ts`。

`__test__/workflow-child-lifecycle.integration.test.ts` 是阶段 C 的真实 SDK/daemon 验收，使用同一默认工厂、ChildManager、实际 handle 和临时 SQLite。覆盖每模式 3×12 顺序 worker、8 并发/第 9 个核心拒绝、取消/deadline 的真实 Read 与清理屏障、查询失败不替代、ACK 失败不重叠、重复 Workflow 取消确认原清理、旧 attempt、同 tick send/suspend、历史/cwd/授权恢复、保留活动及空闲后代、实际未决审批和动态模型目录撤销。

受控模型只替换网络响应；Read 包装执行原实际 Read 后等待，继续沿用 S1 工具身份与未知写入保护。期望核心接纳拒绝在真实 JobList 运行范围内探测，不把失败的写工具当成功。没有手写 child/handle、固定成功 Promise 或 mock 默认工厂。

S1 的真实 Shell 超时回归使用宿主可执行的 Node 命令，观察实际输出后再推进超时计时；临时目录清理等待进程的 close 事件，工具返回 timeout 不作为停止确认。
