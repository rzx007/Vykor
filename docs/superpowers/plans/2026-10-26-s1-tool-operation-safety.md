# S1 工具操作安全基础实施计划

> 状态：当前实施计划；先固定 S1 合同，再实现和验收。未勾选项不代表已经交付。
> 执行方式：按任务逐项实现，先写失败测试，再实现，最后核对需求和验证证据。

**目标：** 工具操作有稳定身份、派发前有可靠记录和强制检查；结果未知时停止危险重试，回执保存失败不能继续后续操作。

**职责：** agent-contracts 定义纯执行合同；core 管工具检查与实际调用；Kernel/Node 传递宿主能力；Services 负责同一 SQLite/memory 路由中的操作记录；Server 将现有 owner、会话与 Run 检查接入工具宿主。

**技术：** TypeScript、Vitest、Drizzle、现有 SessionStore / TransactionCoordinator / SQLite。

**设计依据：** [核心能力方案](../specs/2026-10-26-agent-core-capability-completion-design.md)，重点为 B2、E1 至 E4、F2 和 F4 的 S1。

## 全局约束

- 不引入数据库之外的服务、消息队列、环境变量或 CLI 开关。
- Kernel 不依赖 Services、Server、domain-contracts 或数据库。
- 独立 SDK 默认不创建数据库；宿主显式提供操作记录与强制规则这一对能力。
- daemon 默认接入 S1；memory 会话不向 SQLite 写入操作、尝试和 Execution 记录。
- S1 只建立 Execution 头记录和操作安全能力；检查点续跑在 S2，持久审批在 S3。
- 普通 Hook 继续保持原合同；强制规则不借用可选 Hook 的失败放行行为。
- 不承诺无法去重、查询的外部系统只发生一次；未知写操作不得通过新 Operation 或换工具绕过阻塞。
- 不迁移现有文件；新增分类提供 README，测试放在该分类的 `__test__/`。
- 保留其他会话的在途修改，不将它们混入 S1。

## 任务 1：执行合同与状态记录

**文件：** `packages/agent-contracts/src/tools/operations.ts`、`src/policy/required-policy.ts`、`src/execution/execution.ts`、对应公开入口；`packages/domain-contracts/src/executions/records.ts` 与公开入口。

**接口约定：**

```ts
type ToolOperationKind = "read_only" | "idempotent_write" | "non_replayable";
type ToolOperationState = "prepared" | "authorized" | "dispatching" |
  "confirmed" | "not_applied" | "unknown" | "rejected" | "cancelled";
```

AgentToolSafety 同时持有 operations 与 requiredPolicy。它通过 PreparedAgentRun / AgentExecutionContext 传入 core，子运行沿用同一可信宿主。
Operation 记录绑定 sessionId、runId、executionId、toolCallId、工具来源与版本、规范化输入及摘要、意图版本、操作类型、业务键、revision、结果及时间。
DispatchAttempt 单独保存实际尝试身份、派发时 owner、开始/结束时间、状态和回执；不覆盖旧尝试。

- [ ] 定义 prepare、authorize、dispatch、settle、reject 与只读 reconcile 合同；策略输入包含当前 scope、操作意图和检查阶段，输出含允许/拒绝及策略版本。
- [ ] 验证同一逻辑操作的重复准备只返回已有记录，参数/身份变化明确冲突；两次独立相同参数的操作仍有不同身份。
- [ ] 公开合同不携带数据库、凭据、宿主函数的序列化表示；未声明工具分类默认 non_replayable。

## 任务 2：Services 持久操作账本

**文件：** `packages/services/src/executions/`、`src/tool-operations/`；SessionState、MutationBuffer、ChatPersistenceRouter、读模型、SQLite 保存和删除路径；`src/session-runtime/schema.ts` 与生成增量。

**入口：** SessionStore.executions 与 SessionStore.toolOperations。写入复用 storage.atomic / assertWritable / rollback journal，禁止第二个数据库连接或 owner 表。

- [ ] 先写真实临时 SQLite 测试：重开后操作及结果保留；memory 会话关闭后没有记录；事务 commit 前失败时内存与数据库都回滚。
- [ ] 测试并实现准备去重、意图冲突、版本冲突、派发权只取得一次、独立 Attempt、终态不可逆、旧 owner 写入失败。
- [ ] 按 sessionId 路由三个新记录集合：execution、tool_operation、tool_dispatch_attempt；增加会话清理路径，未决操作不能被普通 retention 提前删除。
- [ ] 新启动将失去活体的 dispatching 标为 unknown；prepared/authorized 保留审计但不自动派发。S1 不恢复模型执行。
- [ ] 查询与 reconcile 仅接受授权宿主证据；工具错误文本不能证明 not_applied。结果重复保存必须相同，不允许用新结果覆盖旧回执。
- [ ] 生成迁移并运行 db:check、数据库测试与打包迁移基线检查。

测试示例：

```ts
it("does not dispatch twice after an ambiguous outcome", async () => {
  const first = await operations.prepare(intent);
  const authorized = await operations.authorize(first, "policy-v1");
  const attempt = await operations.dispatch(authorized);
  await operations.settle(attempt, unknownResult);
  await expect(operations.dispatch(authorized)).rejects.toThrow();
  expect(operations.listAttempts(first.operationId)).toHaveLength(1);
});
```

## 任务 3：core 统一检查与派发

**文件：** `packages/core/src/engine/tools/operation-execution.ts`、`checked-tool-execution.ts`、`query-tool-permissions.ts`、`query-tool-limits.ts`，对应 `__test__/`；必要时调整 query-engine 的结果交付。

**顺序：** 规范化输入 → 参数校验 → 准备操作 → 普通权限 → 强制规则 → 现有审批 → 派发前强制复核 → 保存 dispatching/Attempt → 实际调用 → 保存完整结果 → 普通事件和下一步。

- [ ] 先写强制检查拒绝、抛错、超时和缺少能力的失败测试，验证外部效果次数为 0；host-internal 和关闭 executableHooks 也不能绕过。
- [ ] 实现独立、有限超时的 RequiredPolicyGate 调用；等待期间取消立即停止派发。
- [ ] 派发前保存失败不调用工具；结果保存失败停止后续调用；每个并发结果分别结算。
- [ ] 同一已确认 Operation 复用完整保存结果，不实际调用；unknown 不自动重放写入；原批次其余已启动项仍需结算。
- [ ] 将 operationId、真实 toolAttemptId 和父操作关系放入 ToolContext；嵌套调用走同一管道，不复制外层操作的派发权。
- [ ] 非合作式工具超时后保留 unknown；捕获其合法迟到结果并交给宿主结算，不将它再次交付模型或重开 Run。
- [ ] 未提供 AgentToolSafety 的独立 SDK 沿用原执行行为；配置了不完整能力时明确失败。

测试示例：

```ts
it("does not invoke a tool when required policy fails", async () => {
  let effects = 0;
  const run = fixture({ execute: async () => { effects++; return success; },
    requiredPolicy: { check: async () => { throw new Error("unavailable"); } } });
  await run.execute();
  expect(effects).toBe(0);
  expect(run.savedOperation().state).toBe("rejected");
});
```

## 任务 4：Kernel / Node / daemon 接线

**文件：** Node agent 选项、组装和 prepare；Kernel 的 runTool；`packages/server/src/application/session/execution/tool-operation-service.ts`、daemon loader 与 application；启动恢复。

- [ ] 配置对象成对验证；AgentToolSafety 经 prepare 传入 root、child、手动 runTool 及维护工具上下文，独立 SDK 不访问 Services。
- [ ] daemon 以当前实际 session/run 身份建立 Execution 头记录，检查 owner、会话归属、Run 是否仍允许新派发。
- [ ] daemon 明确注入带版本的当前限制检查；原权限与审批仍经过现有管道，不能因增加强制规则而放宽权限。
- [ ] 建立可信工具分类入口，未声明默认 non_replayable；覆盖工具和代理不能继承同名内置工具的可信承诺。
- [ ] 有未知危险操作时阻止后续危险派发，授权的只读核对仍可进行；已取消/已结束 Run 可保存合法迟到审计回执，不能发起新调用。
- [ ] 操作和结果记录提交后再通知。启动仅核对/标记未知，不自动重试，不开放 S2 的继续入口。

## 任务 5：定向验收与文档收口

- [ ] core 验证拒绝、未知、结果提交失败、并发结算、嵌套入口和迟到回执。
- [ ] Services 验证真实 SQLite 重开、事务回滚、owner 失效、memory 隔离和命令去重。
- [ ] Server 验证真实工具效果次数、同参数独立操作、终态后回执及启动未知结算；跨进程测试使用独立效果文件/服务和真实 SQLite，不能只抛异常。
- [ ] C01 至 C10 按 S1 实际覆盖分支记录证据；依赖检查点继续的分支仍标为 S2 未验证，不将 S1 冒充全部 P0 已通过。
- [ ] 更新相关分类 README、权限流程、持久数据与生命周期说明，只把已经验证的 S1 行为写成当前实现。
- [ ] 运行受影响包类型检查、Kernel 依赖检查、SDK 打包检查、db:check 和必要打包基线。
- [ ] 运行 `pnpm check:retired-ui` 与 `pnpm check-docs`，检查最终差异；不提交、推送或发布。

实施记录保留实际命令、结果及未验证环境。跨平台验收未运行的平台明确列为未验证。
