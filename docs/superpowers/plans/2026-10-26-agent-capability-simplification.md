# Agent 能力简化实施计划

**目标：** 减少 schema 入口与正文搬运，统一模型和手动执行的结果存储绑定。

**执行方式：** 按用户授权在当前会话顺序实施，先文档后代码，不提交、合并或推送，不修改其他工作树。

**方案：** [核心能力方案](../specs/2026-10-26-agent-core-capability-completion-design.md)。基线 `1ba5452f981cf2d4b6c1921214cd659871f46b21`。

**技术：** TypeScript、现有 Repository 内存状态、SQLite、Vitest。无新增依赖和数据库结构。

## 全局约束

- 请求只接受显式 outputSchema；旧 Input/Run 快照保留读取兼容，不迁移数据。
- owner、session、Run 状态、revision、signal、来源检查保持生效。
- 子 Run 顺序：最终工具集合 → await run.started → 绑定 → started 确认 → 模型。
- 原始结果先保存再交付；取消不丢已保存结果；SubmitResult 必须真实执行。
- 保留旧工作树未跟踪且已撤回的 S2.1 计划。

## Task 1：收敛 schema 请求与记录读取

**文件与职责：** domain-contracts `inputs/metadata.ts` 拒绝隐式请求；protocol 请求解析及 client `resources/session` 对齐显式字段；server `run-admission-work.ts` 分离请求校验与记录读取，准入/编辑/重放/执行使用相应入口。编辑和 resume 类型及 HTTP 路由补齐显式参数。

- [x] 先写失败用例：metadata/runMetadata schema 均拒绝；显式能力协商、64 KiB 限制和 steer 限制保持。
- [x] 覆盖编辑同一 ID 不同 schema 冲突；重放只能重复原合同；旧快照可读但冲突拒绝。
- [x] 实现 validateOutputSchemaRequest 只处理显式参数，受理时写快照；readStoredOutputSchema 只读记录。
- [x] 运行 protocol/client/server 定向用例，核对 HTTP 和应用入口，不用隐式字段作内部接线。

```ts
await admit({ items, outputSchema: { type: "string" } });
await expect(admit({ items, metadata: { outputSchema: { type: "string" } } })).rejects.toThrow();
expect(readStoredOutputSchema({ outputSchema: schema }, { outputSchema: schema })).toEqual(schema);
```

## Task 2：减少结果查询的数据搬运

**文件与职责：** services `tool-operations/tool-operation-repository.ts` 提供有限字段查询和单条文本读取；`tool-results/tool-result-reader.ts` 负责候选、授权后分页和引用；server 两个 tool 服务保留应用层安全校验。测试仍放所属目录的 `__test__/`。

- [x] 先写失败用例：安全检查不调用完整 list；未授权和分页外正文不可访问；read/search 只读取一次目标文本。
- [x] 增加 listSafetyStates，只返回 id/sessionId/runId/kind/state；保留会话树和结算失败判断。
- [x] 增加结果候选和单条文本查询；list 先授权再分页，仅为当前页生成引用。
- [x] read/search/retain 不再先 resolve 再重复 get；文本视图每次只生成一次。
- [x] totalChars 来自所选正文；保留换行、非文本占位与 UTF-16 计数。
- [x] 回归 SQLite 重开、memory 不落库、跨会话拒绝、来源撤销、owner/revision/取消失效及 S1 阻断。

```ts
const page = await view.list({ offset: 1, limit: 1 });
expect(page.items).toHaveLength(1);
expect(page.items[0]?.totalChars).toBe(300004);
```

## Task 3：统一存储绑定

**文件与职责：** agent-contracts `execution/execution.ts` 标记旧字段弃用；agent-runtime `kernel/tool-results.ts` 为唯一绑定函数，`agent.ts` 和 `framework-agent-run.ts` 使用它；Node 生产工厂保持最终工具集合绑定。更新模块 README。

- [x] 先验证手动执行的工厂绑定和最终工具范围；保留投影先于绑定的用例。
- [x] 删除手动 runTool 跳过准备分支；显式旧 store 在同一绑定函数适配。
- [x] 保留公开旧字段的一处兼容和必要等价检查，标注 deprecated，不新增框架。
- [x] 回归模型/手动收窄、来源替换、工厂不泄露、真实 daemon 子 Run 与取消交付。

保留等价判断的原因：SDK 包导出相应类型，README 和测试承诺旧存储完整等价时可用。直接删除影响外部宿主；本轮生产路径统一使用工厂，旧字段等待后续明确的破坏性版本删除。

## Task 4：验证与收尾

- [x] 定向测试 protocol requests、client structured-delivery、server admission/interactions/executor/results/operations、services operations/results、kernel binding/delivery、Node 补读、core 交付和 daemon 结果集成。
- [x] 运行受影响包类型与 Kernel 边界检查，不运行完整仓库测试。
- [x] 更新模块 README、基线入口说明和本轮验收记录。
- [x] 运行 pnpm check:retired-ui、pnpm check-docs、git diff --check。
- [x] 从方案生成现有 HTML，核对内嵌内容与 Markdown 一致。
- [x] 核对最终 Git 和旧工作树状态，记录删除分支、搬运减少、验证结果和保留复杂度。

HTML 生成流程（PowerShell，仓库根目录）：

```powershell
$designPath = Resolve-Path 'docs/superpowers/specs/2026-10-26-agent-core-capability-completion-design.md'
$draft = Get-Content -LiteralPath $designPath -Raw
$draft = [regex]::Replace($draft, '\]\((\.\.?/[^)]+)\)', {
  param($m)
  $targetPath = Join-Path (Split-Path $designPath) $m.Groups[1].Value
  $targetUri = [uri]$targetPath
  ']' + '(' + $targetUri.AbsoluteUri + ')'
})
$draft | node C:/Users/ruanz/.agents/skills/answer-me-with-html/scripts/am.mjs render - --no-open -o 'C:/Users/ruanz/.answer-me-with-html/pages/OpenHarness-ts-核心-Agent-能力补齐方案-20261026-125641.html'
```

正文只维护方案 Markdown；布局、颜色和图形由 CLI 生成。
