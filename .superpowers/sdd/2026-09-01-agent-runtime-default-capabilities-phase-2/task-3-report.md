# Phase 2 Task 3 报告：将 compact provider 改成上下文 API

## 实现结果

- core 的 `CompactAttachments`、`CompactAttachmentsProvider` 与 `setAttachmentsProvider` 已一次性改为 `CompactContext`、`CompactContextProvider` 与 `setCompactContextProvider`，没有保留兼容别名。
- `CompactService` 的 options、内部字段、prompt 参数和合并变量统一使用 context 命名；外部 context provider 获取失败会拒绝本次 compact，并用 `Error.cause` 保留原始错误。模型摘要等其他失败仍沿用原有 `simpleCompact` 兜底。
- agent-runtime 新增 `createCompactContextProvider()`，独立组合附件目录和 Session Memory。来源缺省、返回 `undefined`/`null` 或 Session Memory 返回空字符串时，不写入对应字段；来源错误原样向上传播。
- `VykorAgent` 公共方法改为 `setCompactContextProvider()`，旧 `setCompactAttachmentsProvider()` 已删除。组合 helper 从 agent-runtime 公共入口导出，供 Task 4 的 server 接线复用。
- 附件目录继续使用现有结构化 `CompactAttachmentCatalog`，没有按计划示例把它降成字符串；这是为了满足同一任务中“`CompactContext` 保留现有字段结构”的要求，并继续支持有界 catalog formatting。

## 修改文件

- `packages/core/src/engine/compact-service.ts`
- `packages/core/src/engine/query-engine.ts`
- `packages/core/src/types/runtime.ts`
- `packages/core/src/index.ts`
- `packages/core/src/engine/compact-service-advanced.test.ts`
- `packages/core/src/agent-session.test.ts`
- `packages/agent-runtime/src/compact-context.ts`
- `packages/agent-runtime/src/compact-context.test.ts`
- `packages/agent-runtime/src/agent.ts`
- `packages/agent-runtime/src/agent.test.ts`
- `packages/agent-runtime/src/index.ts`
- `.superpowers/sdd/2026-09-01-agent-runtime-default-capabilities-phase-2/task-3-report.md`

## RED/GREEN 证据

- RED：先新增 provider 组合、缺省/空值和来源错误测试。运行 `src/compact-context.test.ts` 时退出 1，准确失败为 `Cannot find module './compact-context.js'`，0 个测试被收集；失败原因是目标模块尚不存在。
- GREEN：实现组合 helper 和一次性 API 重命名后，core 定向测试 23/23 通过，agent-runtime 定向测试 17/17 通过。
- provider 错误回归明确断言 compact promise 被拒绝、摘要 client 未调用，且拒绝错误的 `cause` 是 provider 抛出的原始错误；没有放宽为仅检查错误文案。

## 验证结果

```powershell
..\..\node_modules\.bin\vitest.CMD run src/engine/compact-service-advanced.test.ts src/agent-session.test.ts
..\..\node_modules\.bin\vitest.CMD run src/compact-context.test.ts src/agent.test.ts
..\..\node_modules\.bin\tsc.CMD --noEmit -p tsconfig.json
rg -n "CompactAttachments|setAttachmentsProvider|setCompactAttachmentsProvider" packages apps -g "*.ts"
git diff --check
```

- core：2 个测试文件，23/23 通过；TypeScript 类型检查退出 0。
- agent-runtime：2 个测试文件，17/17 通过。首次在沙箱内运行 `agent.test.ts` 时，既有 Memory 测试因不能创建 `C:\Users\ruanz\.vykor\data\memory\...` 而得到 `EPERM`，Remember tool result 正确标记为 `isError: true`；允许测试写入其现有受管 Memory 目录后，相同代码与相同测试 17/17 通过，未修改 Memory 逻辑或放宽断言。
- agent-runtime 直接类型检查被未修改的 `packages/services/src/session-runtime/store.ts` 阻断：本地 TypeScript 无法解析 `drizzle-orm/better-sqlite3` 及其 `migrator` 子路径。
- server 直接类型检查另外准确报出 `agent-pool.ts` 仍导入已删除的 `CompactAttachments`；这是计划中的 Task 4 迁移点。
- 完整 `turbo check-types` 在进入下游迁移检查前，被本机 pnpm 启动器的 registry 签名验证/网络失败阻断。pre-commit hook 运行同一 `pnpm check-types`，因此本计划中间提交按任务约定使用 `--no-verify`。
- `git diff --check` 退出 0；仅输出现有 CRLF 转换提示。

## Task 4 旧名称清单

server 仍有旧 compact API 的文件如下，本任务没有修改：

- `packages/server/src/application/agent/agent-pool.ts`
- `packages/server/src/application/agent/__test__/agent-pool.test.ts`
- `packages/server/src/application/__test__/durable-agent-application.test.ts`
- `packages/server/src/application/daemon-application.ts`
- `packages/server/src/http/__test__/http.test.ts`

server 之外还有一个下游测试 mock，Task 4 做全仓零命中时也必须迁移：

- `apps/cli/src/print-session.integration.test.ts`

core 与 agent-runtime 对 `CompactAttachments|setAttachmentsProvider|setCompactAttachmentsProvider` 已零命中。

## 边界说明

- 没有迁移 server 或 CLI；没有为让全仓类型检查暂时通过而添加旧 API 别名。
- 没有改变 catalog entry、Session Memory、自动 recent files 或 work log 的数据结构和 prompt 内容。
- 用户 staged 文件 `apps/desktop/src/main/features/session/session-service.test.ts` 未修改、未取消暂存，也不会纳入 Task 3 提交。
- 提交只精确暂存本报告与上述 core/agent-runtime 文件，不使用 `git add .`、`git add apps` 或 `git commit -a`。
