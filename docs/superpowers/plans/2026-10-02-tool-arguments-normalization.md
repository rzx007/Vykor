# 工具 arguments 包装统一处理 Implementation Plan

> 状态：实现、验证与子代理复审已完成，待提交和 push；用户已授权交付。
> **For agentic workers:** 按任务逐项实施并使用 test-driven-development；步骤采用 checkbox 跟踪。执行方式为当前会话 inline，子代理负责 spec 审核及交付前代码复审。

**Goal:** 在统一执行前入口安全处理最多 8 层 arguments 包装，权限与失败记忆使用同一份有效参数。

**Architecture:** 仅修改现有归一化函数和准备流程。提取原有字段别名块为文件内私有函数，让原输入和每个包装候选复用它；准备流程按“归一化 → 校验 → 失败记忆 → 权限”排列。

**Tech Stack:** 现有 TypeScript、Vitest、QueryEngine；无新增依赖。

**Spec:** [已审核 Spec](../specs/2026-10-02-tool-arguments-normalization-design.md)。

## Global Constraints

- 最多拆 8 层，只处理自身唯一可枚举键为 `arguments` 的非数组对象。
- 正式 `arguments` 参数、顶层组合 schema / `$ref`、原输入已合法时不拆业务输入。
- 失败时回退原输入的别名归一化结果；不修改任何原始对象。
- 不新增日志、DTO、历史副本、配置、工具实现或依赖。
- 不构建 Desktop、不重启服务、不执行原会话命令；只暂存本会话明确拥有的文件。
- 提交安排在执行与复审结束后；不提前提交 spec，不强推。
- 当前分支 `main` 与远端基线 `1907c185` 一致；保持现有工作区和其他会话的分支状态，遇到相同文件的新改动先核对归属。

## Task 1：归一化及执行保护（一个不可分割的交付）

**Files:**

- Modify: `packages/core/src/engine/tool-input-schema.ts`
- Modify: `packages/core/src/engine/query-tool-preparation.ts`
- Test: `packages/core/src/engine/tool-input-schema.test.ts`
- Test: `packages/core/src/engine/integration.test.ts`
- Update: `docs/model-network-retry-design.md` 的当前入口说明与 `docs/README.md` 的 spec/plan 链接。

**Interfaces:** `normalizeToolInput(schema: Record<string, unknown> | undefined, input: unknown): unknown` 和 `validateToolInput(schema, input): string | null` 不变；私有别名函数只复用原有处理。`prepareToolCalls` 返回结构不变。

- [x] **1. 添加归一化回归用例并观察失败。**

至少覆盖两层/8 层、9 层、内层别名、类型错误、包装字符串/数组、内外额外字段、声明 arguments、组合 schema、合法开放 schema、原始对象不变以及循环有限返回。使用如下独立预期，不从生产函数计算预期：

```ts
const shellSchema = { type: "object", properties: { command: { type: "string" } }, required: ["command"] };
const wrapped = { arguments: { arguments: { command: "Write-Output probe" } } };
expect(normalizeToolInput(shellSchema, wrapped)).toEqual({ command: "Write-Output probe" });
expect(wrapped).toEqual({ arguments: { arguments: { command: "Write-Output probe" } } });
```

包层数测试用本地测试函数迭代建立包装；8 层应通过、9 层按同一严格 Shell schema 拒绝。保留现有别名测试。运行（cwd `packages/core`）：

```powershell
node ../../node_modules/vitest/vitest.mjs run src/engine/tool-input-schema.test.ts
```

预期新嵌套用例在旧实现上失败，旧用例通过；记录输出后才写实现。

- [x] **2. 添加引擎集成用例并观察失败。**

复用 `integration.test.ts` 中 `createMockStreamClient`，工具在内存中执行，不启动 Shell。权限与执行各收集真实收到的参数，断言授权后的执行只发生一次；deny 和不合法输入时执行为 0，不合法时权限为 0。分别覆盖一层合法包装（抓取失败记忆顺序）和两层合法包装，第一轮工具返回失败，第二轮只变包装，第三轮模型结束；期望第二个 `tool_use_end` 为 `policy/not_started` 且 `recoveryGuard` 为 `repeated_failed_call`。

```ts
const inputs = [{ command: "Write-Output probe" }, { arguments: { arguments: { command: "Write-Output probe" } } }];
// 用 inputs 生成两轮 tool_use_start；第三轮 complete=end_turn。
// execute 中 ++executions 并返回 { isError: true, failureKind: "command", ... }。
expect(executions).toBe(1);
expect(toolEnds[1].result).toMatchObject({ failureKind: "policy", executionState: "not_started", metadata: { recoveryGuard: "repeated_failed_call" } });
```

另补此前失败过的不合法包装仍得到 `invalid_input` 的验证，不把参数错误归为可执行失败。运行：

```powershell
node ../../node_modules/vitest/vitest.mjs run src/engine/integration.test.ts
```

- [x] **3. 最小实现。**

保留原有别名处理内容，提取到私有函数后复用；函数体按下面控制流实现，不增加替代入口：

```ts
const normalized = normalizePropertyAliases(schema, input);
if (validateToolInput(schema, normalized) === null) return normalized;
if (Object.hasOwn(properties, "arguments") || ["anyOf", "oneOf", "allOf", "$ref"].some(key => key in schema)) return normalized;
let candidate = input;
for (let depth = 0; depth < 8; depth++) {
  const keys = Object.keys(candidate);
  if (keys.length !== 1 || keys[0] !== "arguments" || !isRecord(candidate.arguments)) break;
  candidate = candidate.arguments;
  const result = normalizePropertyAliases(schema, candidate);
  if (validateToolInput(schema, result) === null) return result;
}
return normalized;
```

`normalizePropertyAliases` 在本文件定义，参数为 schema 和非数组对象，返回该对象或原有别名复制后的对象。外层沿用现有 schema、properties 和 input 类型检查。将 `query-tool-preparation.ts` 的完整失败记忆判断块从工具查找前移动到归一化/校验之后，内容不改；invalid JSON 和未知工具仍先返回。

- [x] **4. 验证、同步当前说明、代码复审。**

```powershell
# cwd packages/core
node ../../node_modules/vitest/vitest.mjs run src/engine/tool-input-schema.test.ts src/engine/integration.test.ts src/engine/recovery-evidence.test.ts src/engine/tool-failure-memory.test.ts src/engine/model-retry.integration.test.ts
node ../../node_modules/typescript/bin/tsc --noEmit
# cwd packages/api
node ../../node_modules/vitest/vitest.mjs run src/providers/tool-input-recovery.test.ts src/providers/upstream-retry.integration.test.ts
# cwd repository root
node scripts/check-docs.mjs
git diff --check
```

当前说明记录最多 8 层、歧义/组合 schema 保守拒绝、权限与失败记忆在归一化之后；只添加既有文档入口。子代理对照 spec 审核这两个源码文件及两个测试文件，修复有证据的重要缺口后 scoped 复审，不增加未请求的大重构。

- [ ] **5. 完成后分开提交并 push。**

先复核上一轮跨模块错误修复：运行 `model-retry.test.ts`、`model-retry.integration.test.ts`、`buffered-model-retry.test.ts`，仅暂存 `model-retry.ts` 与其集成测试，单独提交。当前统一包装改动、已审核 spec、计划与说明单独提交，不混入别人的文件。提交前检查 `git diff --cached --stat`；正常执行提交 hook，不执行 Desktop build。

```powershell
git status --short
git diff --cached --stat
git ls-remote --heads origin main
git push origin main
git ls-remote --heads origin main
```

如果远端已前进，先只读检查分叉，不强推、不重置工作区；合并需要冲突决策时报告并请求方向。push 成功后确认远端 SHA 与本地 HEAD 一致，再向用户报告哈希、验证和未进行的运行时操作。

## 执行记录

基线：schema/失败记忆/证据 20 项，引擎集成 68 项通过；远端 main 为 `1907c185`。Spec 的审核修订已在计划创建前完成。

实现前新测试产生 13 个预期失败（schema 8、引擎 5）；实现后 schema 29、引擎 73、证据 5、失败记忆 2、重试集成 18，共 127 项通过。Core 类型检查通过。实现仅扩展原有别名函数复用和包装遍历、移动失败记忆检查顺序。

代码复审发现 P3：隐藏的不可枚举 arguments 不能替代唯一可枚举键。新增回归先观察失败，再将判断收紧为唯一键名必须为 arguments；组合 schema 测试也改为要求 command，确保覆盖真正的停止条件。修订不扩大接口或模块范围。

最终 scoped 复审通过。Core 128 项、API 25 项，共 153 项相关测试通过；core 类型和 368 个 Markdown 文件检查通过。上一轮跨模块错误修复的独立重试测试 40 项通过。没有构建 Desktop、启动真实 Shell 命令或重启服务。
