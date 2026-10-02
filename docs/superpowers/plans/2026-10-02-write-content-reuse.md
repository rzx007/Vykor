# Write 内容复用 Implementation Plan

> **For agentic workers:** 按 `test-driven-development`、`verification-before-completion` 执行下列紧密关联任务。主代理在当前会话串行实现，子代理审核 spec 和最终代码；用户已要求连续推进，不另开执行选择或审批流程。

**Goal:** Write 失败后可以引用已经生成的完整内容，修正参数并通过正常权限流程执行，减少重新输出正文。

**Architecture:** 工具用可选 `inputReuse` 声明单个可复用参数；core 只读取现有消息历史，在执行准备中展开引用。Write 负责文件检查与落盘；不让 core 依赖 tools/services，不新增存储或服务。

**Tech Stack:** TypeScript、现有 QueryEngine/ToolRegistry、Node 文件 API、Vitest；无新增依赖。

**Spec:** [Write 内容复用 spec](../specs/2026-10-02-write-content-reuse-design.md)

## Global Constraints

- 不新增磁盘草稿、数据库表、全局缓存、后台任务、依赖或配置。
- 不自动重试，不推断覆盖意图，不把字符串 `"true"` 转为布尔值，不修复非法 JSON。
- 权限、预览、失败去重、hook、执行使用同一份展开后的有效输入。
- 不改写已经落盘的原始模型调用事件；不承诺跨压缩或重启保留引用。
- 不修改本轮之外的参数归一化、网络重试、Edit 算法、provider 或 UI。
- 用户已授权 spec → 审核修订 → 计划 → 实现连续推进；不自动发布、重启服务、提交或 push。
- 在当前工作区做有限改动，修改共享文件前确认最新状态，不覆盖其他会话的代码；新集成测试独立成文件。

## Task 1：执行前展开内容引用，并反馈可用来源

**Files:**

- Modify: `packages/core/src/types/tools.ts`
- Create: `packages/core/src/engine/tool-input-reuse.ts`
- Modify: `packages/core/src/engine/query-tool-preparation.ts`
- Modify: `packages/core/src/engine/query-engine.ts`
- Create: `packages/core/src/engine/query-tool-preparation.reuse.test.ts`
- Create: `packages/core/src/engine/tool-input-reuse.integration.test.ts`

**Interfaces:**

- `ToolDefinition.inputReuse?: { property: string; referenceProperty: string }`
- `prepareToolCalls(toolUses, failedToolCalls, toolRegistry, history: readonly Message[] = [])`
- `resolveToolInputReuse(tool: ToolDefinition, toolUse: ToolUseBlock, history: readonly Message[], batchIds: ReadonlySet<string>): Record<string, unknown>`；非法形式抛出不含正文的 Error，由 prepare 转成 `invalid_input/not_started`。
- `withToolInputReuseHint(tool: ToolDefinition | undefined, toolUse: ToolUseBlock, result: ToolExecutionResult, history: readonly Message[]): ToolExecutionResult`；追加短提示，保留所有原错误字段。

- [x] **Step 1：写执行准备回归，并观察缺失行为失败。** 使用当前真实 `prepareToolCalls`，不模拟它。

```ts
const tool = {
  name: "Write", description: "fixture",
  inputSchema: { type: "object", properties: {
    file_path: { type: "string" }, content: { type: "string" },
    content_from: { type: "string" }, overwrite: { type: "boolean" },
  }, required: ["file_path"] },
  inputReuse: { property: "content", referenceProperty: "content_from" },
  execute: async () => ({ content: [] }),
};
const history: Message[] = [
  { type: "assistant", content: "", toolUses: [
    { type: "tool_use", id: "source", name: "Write", input: {
      file_path: "a.txt", content: "complete body", overwrite: false,
    } },
  ] },
  { type: "tool_result", toolUseId: "source", content: [], isError: true },
];
const retry: ToolUseBlock = { type: "tool_use", id: "retry", name: "Write",
  input: { file_path: "b.txt", content_from: "source", overwrite: true } };
const prepared = prepareToolCalls([retry], undefined, registry, history);
expect(prepared.readyForPermission[0]?.toolUse.input).toEqual({
  file_path: "b.txt", content: "complete body", overwrite: true,
});
expect(history[0]).toMatchObject({ toolUses: [{ input: { overwrite: false } }] });
```

运行：在 `packages/core` 执行 `node node_modules/vitest/vitest.mjs run src/engine/query-tool-preparation.reuse.test.ts`。期望引用仍未展开、非法形式未拒绝，测试因此失败，而非导入错误。

- [x] **Step 2：实现一个小的历史查找与展开函数。** 扫描全部 assistant 工具调用，源 ID 必须全局唯一；查找源之后且当前批次之前的 tool_result。拒绝当前批次 ID、inputError、其他工具、非字符串正文、同时提供正文与引用、两者均缺失。只复制正文，不复制其他参数；展开后删除引用字段。无声明的工具直接返回原输入。

```ts
const effective = { ...toolUse.input, [property]: source.input[property] };
delete effective[referenceProperty];
return effective;
```

来源的唯一性与顺序判断放在同一个辅助函数，供失败提示复用；不创建来源仓库或缓存。不递归查引用链。

- [x] **Step 3：接入准备流程。** 归一化后调用展开；出错填该调用的失败结果，不进入权限。有效输入继续现有 schema 校验及失败记忆检查。QueryEngine 将现有 `this.messages` 传给 prepare，不改变其他执行步骤。

- [x] **Step 4：接入短提示并补集成回归。** 在结果格式化与写入内存历史之前，以当前历史加本次结果检查当前调用能否成为下一轮来源；仅对合法可引用失败追加提示。提示不复制正文，未知结果要求先检查状态，权限/策略拒绝不因此获得授权。过长的 ID 不截断成虚假 ID，提示过长则省略。

引擎集成使用确定的内存模型事件与无副作用工具：第一次提供长正文并返回失败，第二次只提供引用；断言两次有效输入的正文相同、模型第二次参数不含正文、失败提示含源 ID、不含正文。另测权限拒绝和失败去重，实际执行次数不增加。

- [x] **Step 5：验证 Task 1。** 运行新测试及现有参数归一化、失败记忆、工具反馈测试。

```powershell
node node_modules/vitest/vitest.mjs run src/engine/query-tool-preparation.reuse.test.ts src/engine/tool-input-reuse.integration.test.ts src/engine/tool-input-schema.test.ts src/engine/tool-failure-memory.test.ts src/engine/tool-result-feedback.test.ts
```

拒绝用实现自身函数计算期望值；错误测试断言 `readyForPermission` 为空、`failureKind=invalid_input`、`executionState=not_started`。覆盖空正文、跨工具重复 ID、错序结果、无结果、压缩后丢失、自引用与同批次引用，以及非复用工具行为不变。

## Task 2：Write 接口与真实文件回归

**Files:**

- Modify: `packages/tools/src/file/write.ts`
- Modify: `packages/tools/src/file/__test__/write.test.ts`
- Create: `packages/tools/src/file/__test__/write-content-reuse.integration.test.ts`
- Update: 本 spec/plan 的完成记录。

**Interfaces:**

- 消费 Task 1 的 `inputReuse` 和引擎准备逻辑。
- Write schema 增加字符串 `content_from`，保留其余字段，必填字段为 `file_path`。
- Write `execute` 仅消费字符串 `content`，发现自身 `content_from` 字段即拒绝。

- [x] **Step 1：写直接调用安全回归并观察失败。** 三组输入：没有正文、只有引用、正文和引用同时提供；使用路径 resolver 抛错的环境确认拒绝发生在文件访问前。保留空字符串创建成功用例。

```ts
const context = { cwd: "/work", environment: { paths: {
  resolve: async () => { throw new Error("must not access filesystem"); },
} } } as never;
const result = await fileWriteTool.execute({
  file_path: "a.txt", content: "body", content_from: "source",
}, context);
expect(result).toMatchObject({
  isError: true, failureKind: "invalid_input", executionState: "not_started",
});
```

- [x] **Step 2：更新 Write 声明与说明，添加执行入口检查。** 检查位于路径解析前；不新增通用 validator，不更改覆盖和 hash 行为。

```ts
inputReuse: { property: "content", referenceProperty: "content_from" },
// execute 入口
if (Object.hasOwn(input, "content_from") || typeof input.content !== "string") {
  return invalidInput("Write requires resolved string content; content_from must be resolved by the engine.");
}
```

- [x] **Step 3：真实文件集成验证。** 在 mkdtemp 临时目录里预先写入 `old`，注册真实 fileWriteTool，模型依次发原文 Write（覆盖失败）、短引用 Write（显式 overwrite 成功）、结束事件。读取实际文件确认完整正文，检查权限检查与 pre-tool hook 收到正文且不含引用字段；权限预览计算出的 after 与文件一致。

```ts
expect(await readFile(target, "utf8")).toBe(body);
expect(retryModelInput).not.toHaveProperty("content");
expect(effectivePermissionInput).toMatchObject({ content: body, overwrite: true });
expect(effectivePermissionInput).not.toHaveProperty("content_from");
```

补充错误 hash 不改文件、权限拒绝不改文件、内容为空合法、直接合法正文保持原行为。模型为本地确定事件 fixture，不访问实际模型，不操作用户任务文件。

- [x] **Step 4：验证并独立复审。** 范围工具测试、core/tools 类型检查、文档和架构检查；无需完整 monorepo 测试或 Desktop 构建。node_modules 受沙箱阻止时按实际错误申请命令提权，不安装依赖。

```powershell
# packages/tools
node node_modules/vitest/vitest.mjs run src/file/__test__/write.test.ts src/file/__test__/write-content-reuse.integration.test.ts src/file/__test__/preview.test.ts src/file/__test__/apply-patch.test.ts
# repository root
node node_modules/typescript/bin/tsc --noEmit -p packages/core/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p packages/tools/tsconfig.json
node scripts/check-docs.mjs
node scripts/architecture-boundaries.mjs
```

子代理只读审核本轮 diff、spec 与测试证据；主代理修正必要问题，运行受影响检查，然后在文档补充实际结果与限制。交付工作区改动，不执行提交、push 或服务重启。

## 顺序与进度

| 项目 | 检查结论 |
|---|---|
| Task 1 → Task 2 | Task 1 提供声明、展开与提示；Task 2 使用同样字段名称和流程，无接口冲突 |
| Task 1 内部 | 引用先展开再权限/失败记忆；提示与来源共用判断，符合 spec |
| Task 2 内部 | 模型 schema 允许引用，execute 只接受有效正文；禁止直接绕过，符合 spec |

- spec 初稿、子代理审核与修订：已完成。
- 实施计划：已编写并自检。
- 基线：现有 Write 测试 19/19 通过。
- Task 1：已实现。新 core 回归先出现 21 项预期失败，再与既有相关测试合计 58/58 通过；另运行现有引擎集成 73/73 通过。
- Task 2：已完成。新增真实 Write/直接调用回归先出现 6 项预期失败，接入后工具范围测试 82/82 通过。
- core/tools 类型检查、文档检查、架构边界检查与 `git diff --check`：通过。pnpm 启动器尝试联网获取自身失败，验证改用已安装的 Node/Vitest/TypeScript；未安装依赖。
- 最终只读子代理 `review_write_reuse_code`：审核通过，无 Critical、Important 或需修复的 Minor；未改动工作区或重复运行测试。
- 唯一范围用例合计 213 项通过（core 58 项、既有引擎集成 73 项、tools 82 项）。未使用真实模型测量实际节省时间，不宣称首次生成提速。
- 已完成工作区交付；未提交、push、构建 Desktop 或重启运行服务。新的接口需要运行包含本改动的版本才能使用。
