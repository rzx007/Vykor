# Agent 跨包回归测试

这里验证 Core 模型/工具循环与 API、权限、提示词、真实文件工具组合后的行为：流中断重试、参数纠错、文件保护、内容复用、Shell 分页、Job 等待时限及 ToolSearch 注册表接入。

`__test__/approval-review.integration.test.ts` 验证定时任务输入经过独立审查、用户指令核实和审批存储后，能在审查输出截断并重试成功时解除 BackgroundShellCreate 的等待，且不留下待人工确认的请求。

`__test__/result-delivery.integration.test.ts` 通过真实 SQLite、Kernel、QueryEngine 和宿主操作服务，检查结构错误及实际文件校验失败都在工具派发前拒绝，没有工具尝试或未知写入；补齐文件后可以取得经过校验的交付回执。它也验证取消仍在等待宿主核验的运行后，迟到的通过结果不会再次派发工具。

测试使用离线响应、临时目录或注入的执行器，不需要模型凭据。工具自身的输入校验、搜索和 Job 参数适配测试保留在 `packages/tools/src/meta/__test__/tool-search.test.ts` 与 `packages/tools/src/job/__test__/job-tools.test.ts`。

`__test__/durable-tool-operations.integration.test.ts` 启动独立 Node worker 和真实临时 SQLite，在三个已知提交位置强制杀进程，再以新 owner 重开数据库。测试分别核对派发意图、未知结果与已确认回执，并用独立效果文件确认没有重复写入；它不验证 S2 的模型检查点续跑。夹具位于 `__test__/fixtures/`。

运行 `pnpm test:agent-integration`；根 `pnpm test` 已包含此命令，普通 CI 的 Test 步骤会继续执行。两个工具测试由 `pnpm --filter @vykor/tools test` 覆盖。跨包测试直接运行，避免沿用 Runtime 包的缓存而遗漏 API 或工具变化。


`__test__/shared-job-composition.integration.test.ts` 是阶段 A 双入口验收：每种模式覆盖真实 child 多轮和旧轮取消、无关来源 list 故障、唯一 Shell 归属、原生 PTY 退出、单步骤 Workflow。共享夹具放在 `__test__/fixtures/task-lifecycle-fixture.ts`。另用真实原生 PTY 验证 daemon 没有 live root 时仍使用显式 Terminal provider，连续读取不会关闭宿主资源。
