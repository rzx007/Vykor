# Goal 判断与扩展边界改进实现计划

> 状态：当前实施记录。任务 1 至 5 的代码与自动化验证已完成；Desktop 手动交互复验待进行。
> 面向 AI 代理的工作者：使用 executing-plans 按任务执行；只有用户明确选择子代理执行时才调度子代理。进度用复选框记录。

**目标：** 修正完成与进展判断，收拢 Goal 专用代码，验证 agent-runtime 独立运行，并让维护冲突可定位。

**结构：** 保留现有 SessionGoalService、持久 Run、事务和会话队列。先改评估契约，再改状态结算；随后把本轮 Goal 提示和工具移入可选扩展，core 只消费通用运行能力。

**技术栈：** TypeScript、Vitest、现有 SQLite SessionStore、React Desktop。

依据：[Goal 复盘](../../session-goals-retrospective.md)、[目标设计](../../session-goals-design.md)。继续在主分支工作，不创建兼容层，不修改无关改动。本计划仅安排实施，不代表任务已经通过验证。

## 范围与交付顺序

1. 完成评估与证据覆盖。
2. 进展、阻塞和有效等待。
3. Goal 可选扩展与 core 边界。
4. 维护冲突诊断与失败恢复。
5. Desktop 展示与相关验证。

完整 Token 预算、子代理成本归集不在本轮；现有自动续跑次数上限继续生效，文案明确它不是成本预算。若维护问题再次稳定复现且阻塞使用，任务 4 可以提前。

每项只改职责相关文件，不顺带拆分整个引擎或引入新的插件框架。新增接口必须有真实调用者。

## 任务 1：完成评估与证据覆盖（已完成）

**文件：**

- 修改 `packages/protocol/src/session-goals.ts`、`session-goals.test.ts`：评估契约与解析。
- 修改 `packages/agent-runtime/src/goal-assessment-tool.ts`、`goal-assessment-tool.test.ts`：工具输入与运行绑定。
- 新建 `packages/server/src/application/session/goal-assessment-policy.ts`：完成判断与引用校验，不负责投递 Run。
- 修改 `packages/server/src/application/session/session-goal-service.ts`：调用判断结果。
- 修改 `packages/server/src/application/session/__test__/session-goal-service.test.ts`：真实持久状态测试。
- 修改 `packages/server/src/application/agent/__test__/daemon-agent-event-projector.test.ts`：新契约投影测试。

建议的评估增量结构如下，直接替换旧格式，不双读：

```ts
type GoalRequirementAssessment = {
  requirement: string
  source: string // 原目标正文中的要求，或所引用规格的具体条目
  status: "satisfied" | "incomplete" | "needs_user"
  evidenceRefs: GoalEvidenceRef[]
}

// 加入 GoalAssessment；完成建议必须提供非空 requirements。
type GoalCompletionAudit = {
  requirements: GoalRequirementAssessment[]
  remainingWork: string[]
}
```

- [ ] 增加拒绝空要求、缺少引用、残留工作、未满足要求、旧版本引用的测试。
- [ ] 修改工具 schema、协议解析与事件测试夹具。模型只提供证据 ID 和条目描述；目标、版本和 Run 仍由宿主绑定。
- [ ] 从 service 提取引用来源校验到 policy；完成必须满足全部列出要求、没有剩余工作且引用有效。语义上是否覆盖原始目标仍由模型审查，不能把结构通过称为证明全部完成。
- [ ] 扩充目标提示：从原目标和引用文件逐项提取要求，说明检查范围，不允许用单个通过测试代替整个目标；说明证据 ID 对应工具调用 ID。
- [ ] 不完整且有下一步的完成建议转为继续推进；主观要求进入用户验收；格式或引用错误暂停并给出具体原因。只在现有续跑额度与保护允许时继续。
- [ ] 验证普通非完成评估无需填写无关的完成字段。

关键判定示例：

```ts
const eligible = audit.requirements.length > 0
  && audit.remainingWork.length === 0
  && audit.requirements.every(item =>
    item.status === "satisfied" && item.evidenceRefs.length > 0)
// eligible 还必须与宿主的引用有效性检查同时通过。
// 模型漏列要求仍是语义风险，提示和验收用例必须覆盖这个边界。
```

**验收：** “实现、测试、文档”只完成测试时不完成；虚构证据不完成；确实需要主观验收时显示等待用户。不要为了通过测试让测试直接写入服务端判定结果。

## 任务 2：统一进展、阻塞和有效等待（已完成）

**文件：**

- 修改任务 1 的协议、工具、policy、service 和测试。
- 修改 `packages/services/src/session-runtime/store.ts`、`__test__/session-goals.test.ts`：保存连续阻塞原因与等待状态。
- 在 `packages/services/src/session-runtime/migrations/` 新增下一个未使用序号的 Goal 状态迁移；同步当前 schema。保留用户数据，不重置数据库，不添加旧评估兼容读取。
- 新建 `packages/server/src/application/session/goal-wait-verifier.ts` 及对应 `__test__/goal-wait-verifier.test.ts`：从宿主读取句柄真实状态。
- 修改 `packages/server/src/application/daemon-application.ts`：注入等待验证能力。

```ts
type GoalProgressAssessment = {
  kind: "progress" | "waiting" | "no_progress"
  summary: string
  blockerKey?: string
}
type GoalWaitCheck =
  | { state: "running"; checkedAt: number }
  | { state: "completed" }
  | { state: "failed"; reason: string }
  | { state: "missing" }
  | { state: "unknown"; reason: string }
```

- [ ] 测试模型首次提交 blocked、同一原因连续三轮、原因变化、恢复后重新计数。
- [ ] `continue` 和 `blocked` 共用同一个连续无进展判断；需要用户答复走 waiting_user，不通过反复续跑催用户回答。
- [ ] 不再仅靠工具输出 JSON 是否不同判断进展。模型说明变化及其对下一步的影响，宿主校验引用；时间戳变化本身不能算完成工作。
- [ ] 等待验证先覆盖已有持久 Run 和 live-child 目录中的任务；校验会话归属、真实存活状态和 deadline。其他未知句柄明确返回 missing/unknown，不宣称全部后台工具都已支持。
- [ ] 真实 running 等待保留 active，按 1、2、4、8、16、30 秒上限退避复查，不启动空转模型回合；等待期间检查暂停、取消和版本变化，释放或取消定时器。
- [ ] completed/failed/missing 唤醒一次已有 Run 队列进行评估；临时查询异常记为 unknown，在截止时间前复查，不重启外部工作。达到 deadline 后暂停并说明原因。
- [ ] 单个 goal/revision 最多一个等待观察者；重启仍采用现有 active 目标转 paused 策略，不自动复活旧句柄。
- [ ] 使用虚拟时钟验证退避、到期、暂停清理、重复通知去重，不在测试中真实等待。

**验收：** 真等待不误计无进展；不同时间戳不能无限续跑；未验证的等待不会保活；用户暂停后不再触发下一轮。

## 任务 3：把 Goal 专用行为移出 core（已完成）

**文件：**

- 修改 `packages/core/src/types/runtime.ts`、`engine/query-engine.ts`、`engine/goal-context.test.ts`。
- 修改 `packages/agent-runtime/src/agent.ts`、`framework-agent-run.ts`、`extensions.ts`、`default-runtime-tools.ts`。
- 新建 `packages/agent-runtime/src/goal-extension.ts`：构造目标提示和绑定当前 Run 的评估工具，复用任务 1 的工具。
- 修改 `packages/server/src/application/session/session-run-executor.ts`：宿主装配 Goal 扩展。
- 修改 `packages/agent-runtime/src/framework-agent-run-input.test.ts`、`scripts/verify-pack.mjs`。

本轮只需要一个通用的每次运行配置，不建立完整的扩展生命周期框架：

```ts
type AgentRunContribution = {
  systemGuidance?: string
  tools?: readonly ToolDefinition[]
}
```

- [ ] core 的 execution 删除 goal 字段；执行引擎读取通用 systemGuidance 与本轮工具集合。
- [ ] Goal 扩展闭包持有 goalId/revision/objective，工具执行时结合宿主 Run scope 上报。目标正文仍明确为用户数据，不能扩大权限。
- [ ] 本轮工具采用隔离视图，与已有工具合并但禁止重名覆盖，不通过全局 registry 注册后再注销实现隔离。
- [ ] 移除 QueryEngine 按字符串 `GoalAssessment` 的可见性和权限特判。只有宿主注册的无外部副作用控制工具可使用显式内部权限策略；插件不能自行声明绕过批准。
- [ ] 保留服务端状态、事务和自动续跑位置，不移进 agent-runtime。同步修改全部调用点，不保留旧 goal 参数适配层。
- [ ] 用普通运行 → 目标运行 → 普通运行测试提示和工具隔离，补异常结束与重名冲突场景。
- [ ] 扩充 verify-pack：隔离消费者不安装 server/services，以本地假模型执行普通回合和一个工具，不请求真实模型、不依赖 daemon。

**验收：** core 无 Goal 专用逻辑；普通消费者可独立运行；错误与中断不遗留工具；权限边界没有因移除字符串特判而扩大。

## 任务 4：维护冲突可定位、失败后可重试（已完成）

**文件：**

- 修改 `packages/server/src/application/control/daemon-operation-gate.ts`、`__test__/daemon-operation-gate.test.ts`。
- 修改 `packages/server/src/application/control/daemon-control-service.ts`、`session/session-maintenance-service.ts`、`session/session-application-service.ts`：传入维护操作名称并记录开始和释放。
- 修改 `packages/server/src/application/session/__test__/session-maintenance-service.test.ts`。
- 修改 `packages/server/src/http/routes/session-goal.ts`，必要时复用现有应用错误返回机制。
- 修改 `apps/desktop/src/renderer/src/stores/desktop-session/goal-actions.ts`、`goal-actions.test.ts`。

- [ ] 为维护记录增加 operationId、operationName、startedAt，保留现有 session/cwd/global 范围；冲突错误携带具体占用信息。
- [ ] 所有释放仍在 finally 中完成，日志能用同一 operationId 关联开始与释放；关闭中的错误与维护冲突分开。
- [ ] 前端显示“正在压缩上下文，请稍后重试”等可理解原因，技术标识放日志；错误可关闭，目标草稿和附件保留。
- [ ] 创建请求失败后重试保持既有 requestId 幂等规则。
- [ ] 验证维护正常结束、抛错、重复 release，以及创建目标被阻挡后重试成功。不新增强制清锁接口。

**验收：** 可以从错误和日志定位持有者；不再仅靠退出 Electron 推断维护锁已经释放。

## 任务 5：Desktop 展示、验证和文档同步（自动化完成，手动复验待进行）

**文件：**

- 修改 `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/goal-banner.tsx`、`__test__/goal-banner.test.tsx`。
- 修改 `apps/desktop/src/renderer/src/stores/desktop-session/goal-actions.ts`、`goal-actions.test.ts`。
- 更新 `docs/session-goals-design.md`、`docs/session-goals-retrospective.md`，只把实际验证通过的事项标记完成。

- [ ] Banner 展示等待、受阻、暂停的具体原因；详情展示要求满足情况、证据与剩余工作，长文本可截断后展开。
- [ ] 明确显示“自动续跑次数/上限”，不称 Token 预算，不使用虚构 Token 或耗时数据。
- [ ] 用户回答和批准后沿用既有恢复路径，验证问题 ID、版本、重复点击与切换会话隔离。
- [ ] 最后集中运行下列相关测试与类型检查；每项失败只修相关问题，改动后仅重跑受影响范围。

```powershell
pnpm --filter @vykor/protocol exec vitest run src/session-goals.test.ts
pnpm --filter @vykor/core exec vitest run src/engine/goal-context.test.ts
pnpm --filter @vykor/agent-runtime exec vitest run src/goal-assessment-tool.test.ts src/framework-agent-run-input.test.ts src/agent.test.ts
pnpm --filter @vykor/services exec vitest run src/session-runtime/__test__/session-goals.test.ts
pnpm --filter @vykor/server exec vitest run src/application/session/__test__/session-goal-service.test.ts src/application/session/__test__/goal-wait-verifier.test.ts src/application/agent/__test__/daemon-agent-event-projector.test.ts src/application/control/__test__/daemon-operation-gate.test.ts src/application/session/__test__/session-maintenance-service.test.ts
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/stores/desktop-session/goal-actions.test.ts src/renderer/src/components/desktop/conversation-page/composer/__test__/goal-banner.test.tsx
pnpm --filter @vykor/protocol --filter @vykor/core --filter @vykor/agent-runtime --filter @vykor/services --filter @vykor/server check-types
pnpm --filter @vykor/agent-runtime test:pack
pnpm --filter @vykor/desktop build
node scripts/check-docs.mjs
```

- [ ] Desktop 手动验证一次完整目标、一次部分完成、一次有效等待、一次维护拒绝后重试，以及暂停/恢复和普通输入。不把只通过静态检查表述为实际界面验证。
- [ ] 汇总改动、实际执行命令、剩余限制。按任务分组提交；不把文档完成当作实现完成。

## 覆盖与执行规则

| 复盘问题 | 对应任务 |
| --- | --- |
| 完成证据未覆盖全部要求 | 1、5 |
| 进展与阻塞规则不一致、真实等待缺失 | 2、5 |
| core 专用分支、独立运行缺乏充分验证 | 3 |
| 轮数与预算混淆 | 5；完整 Token 预算另立需求 |
| maintenance 根因不可定位 | 4 |

用户此前要求优先完成任务、只跑相关测试，按此执行：不做每一步重复全量构建，不增加流程性审查。涉及状态与权限的修改先确定回归场景，最后集中验证。每完成一个任务更新复选框及实际结果，遇到新问题记录证据，不用局部通过代替整体完成。
