# Agent 跨包回归测试

这里验证 Core 模型/工具循环与 API、权限、提示词、真实文件工具组合后的行为：流中断重试、参数纠错、文件保护、内容复用、Shell 分页、Job 等待时限及 ToolSearch 注册表接入。

测试使用离线响应、临时目录或注入的执行器，不需要模型凭据。工具自身的输入校验、搜索和 Job 参数适配测试保留在 `packages/tools/src/meta/__test__/tool-search.test.ts` 与 `packages/tools/src/job/__test__/job-tools.test.ts`。

运行 `pnpm test:agent-integration`；根 `pnpm test` 已包含此命令，普通 CI 的 Test 步骤会继续执行。两个工具测试由 `pnpm --filter @vykor/tools test` 覆盖。跨包测试直接运行，避免沿用 Runtime 包的缓存而遗漏 API 或工具变化。
