# 审批减频与敏感资料保护实现计划

> **For agentic workers:** 按相互独立的任务并行实现，最后统一审查和验证；用户已授权本次修复。

**Goal:** 减少重复审批，并阻止历史或本次凭据原文进入独立审查请求。

**Architecture:** 复用当前权限检查、持久会话记录和独立审批模型。可信任务观察走现有宿主归属检查；其余操作使用标明来源的临时参考资料，再在模型发送边界检查和脱敏。

**Tech Stack:** TypeScript、Vitest、现有 SessionStore。

**Spec:** [设计说明](../specs/2026-11-03-approval-review-noise-and-secrets-design.md)。

## Global Constraints

- 保留已有 AskUser 修复和用户自己的桌面版本改动，不添加 Shell/CLI 整体放行或新授权缓存。
- 禁止规则、工具范围、计划模式、配置修订与会话归属检查保持先行。
- 测试只用合成凭据，不向真实模型重放用户资料。

## Task 1：可信 Jobs 与执行指导

**Files:** `packages/agent-runtime/src/node/runtime/default-runtime.ts`、同目录 `__test__/job-permission.test.ts`、`packages/tools/src/shell/shell.ts`、`packages/prompts/src/index.ts`、`packages/prompts/src/prompt-segments-assembly.ts` 及对应 README。

**Interfaces:** 在已有 `resolveAutoApproveTools` 中加入来源核实过的 `JobList/JobRead/JobWait`；不改变工具参数和执行接口。

- [x] 新增权限行为测试，先确认可信 Jobs 被不必要询问的失败。
- [x] 最小实现：`for (const name of ["JobList", "JobRead", "JobWait"]) if (trustedBuiltinToolNames?.has(name)) merged.add(name);`。
- [x] 调整 PowerShell 与独立检查指导；不修改动态语法分析或虚构执行超时字段。
- [x] 运行新测试、已有 runtime/Jobs 测试及相关包类型检查。

## Task 2：独立审查请求的凭据保护

**Files:** `packages/agent-runtime/src/node/review/approval-secrets.ts`、`approval-reviewer.ts`、相邻测试与 README。

**Interfaces:** 内部 `prepareApprovalReviewInput(input): ApprovalReviewInput | undefined`；保留 reviewer 的 `hasApprovalSecrets` 导出。

- [x] 用合成裸凭据、标签赋值和历史禁止句建立失败用例，断言实际模型收到的文本及零请求情形。
- [x] 克隆输入；当前指令/本次参数命中凭据则返回 `undefined`；历史及参考片段替换已识别凭据，保留其余文本，整体再检查。
- [x] 只序列化准备后的快照：`const reviewContent = JSON.stringify(prepared);`，首次与重试复用，不回显敏感错误。
- [x] 检查常见普通哈希、路径、UUID 不误判，运行审查器测试及 runtime 类型检查。

## Task 3：补齐有来源边界的审查参考

**Files:** `packages/server/src/permissions/approval-context.ts`、`session-approval.ts`、相邻测试与 README；`packages/agent-runtime/src/node/review/approval-reviewer.ts` 的政策说明由主代理在 Task 2 后合并。

**Interfaces:** 使用已有 `ApprovalReviewEvidence.context` 的 `reference/tool_output` 类型，不新增公开协议字段。独立辅助函数从宿主记录构造这些片段。

- [x] 先测试“检查渠道 → 助手提案 → 好”的资料组合，检查外会话/未来/未完成/外部来源和过长片段。
- [x] 收集紧邻回复的完整助手提案、相关运行已完成的可信内置工具结果、同运行较早的确切批准记录；保留来源和缺失说明，不将它们提升为授权。
- [x] 接到 `sessionPermissionRequest`，仍使用请求快照、取消与配置修订检查。
- [x] 运行 permissions 相关测试，补离线整合测试确保当前或历史凭据不会到达模拟模型。

## Task 4：统一验收

- [x] 按实际改动运行 server、runtime、tools、prompts 的相关测试与类型检查。
- [x] 运行 `pnpm check:retired-ui`、`pnpm check-docs`、`git diff --check`，同步移动行的旧引用记录。
- [x] 独立审查新增权限范围、参考资料来源、凭据保护和参数一致性；解决确定问题。
- [x] 汇报实际通过的检查、可确定减少的审批及未打包状态，不声称模型判断永远无需人工确认。

## 执行记录

- 可信任务观察、原 runtime、Jobs、工具、提示组装和终端归属重点测试 186 项通过；审查器与凭据测试 96 项通过；服务器权限目录 86 项通过；离线审批整合测试 2 项通过。
- runtime、server、tools、prompts 类型检查通过。`check:retired-ui`、`check-docs` 与差异空白检查通过；独立审查中发现的厂商环境变量及 Basic 凭据遗漏已修复并复验。
- 额外检查 `packages/agent-runtime/src/node/jobs/__test__/child-job-source.test.ts` 的轮数失败状态场景仍失败：夹具默认允许 8 轮，模拟模型第二轮正常结束，却期望失败状态。用临时 Vitest 加载插件仅将 `default-runtime.ts` 替换为 HEAD `e1fa930c466312bbf18978b517defe5f8d11c6ff` 的原始源码，再运行仍得到相同断言失败，排除了新放行规则。未修改这个范围外测试，临时配置已删除。
- 提交前完成 Ponytail 复杂度审查，结论为 `Lean already. Ship.`。同步远端提交 `a9c20393` 中的既有轮数测试修复，再复验该测试；该修复不属于本次审批改动。
- 未向真实模型重放用户资料，未重新打包或部署。
