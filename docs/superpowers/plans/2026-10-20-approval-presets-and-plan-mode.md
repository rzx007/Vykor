# 三档授权与独立计划模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将三档授权和计划模式分开，完成当前会话从用户选择到工具实际执行的闭环。

**Architecture:** 会话记录保存独立的授权档位与工作模式，运行时把它们转换为真实执行限制。需要授权的操作复用现有持久请求，由用户或无工具的独立模型请求决定；完全访问使用当前会话策略，不修改全局沙箱。

**Tech Stack:** TypeScript、React、Zustand、Electron IPC、现有 daemon / SessionStore、Vitest。

**Spec:** [设计草案](../specs/2026-10-20-approval-presets-and-plan-mode-design.md)。设计仍为草案；本计划不表示实现已完成。

## Global Constraints

- 授权菜单提供“请我批准 / 帮我批准 / 完全访问权限”。
- 计划模式由 `@ / +` 唤起，并作为独立的当前会话状态显示。
- 已有 `/plan` 继续作为同一个开关的快捷入口。
- 用户开启的计划模式不能被模型调用 `ExitPlanMode` 自行解除。
- 不在本次范围内实现原生 Windows 的新系统沙箱后端。
- 旧自动批准不静默升级成完全访问。
- 界面样式由用户查看反馈，不启动预览或截图。
- 不修改已有的插件 mention 未提交改动，不进行无关目录重构。
- 每项先建立有效失败用例，再实现并运行该项测试；不会把完整菜单提前接到占位行为上。
- Tasks 1–5 在同一开发分支分步准备，不作为独立发行版。旧发布契约在 Task 6 原子切换并删除；不得在运行中的半套新旧持久字段之间猜测优先级。

## Task 1: 独立模式协议、持久化与工具限制

**Files:**
- Create: `packages/protocol/src/permissions/approval-mode.ts`。
- Modify: `packages/protocol/src/runtime/runtime-config.ts`、`packages/protocol/src/requests/requests.ts`、`packages/protocol/src/index.ts`。
- Modify: `packages/core/src/types/settings.ts`、`packages/agent-contracts/src/permissions.ts`；最终设置格式及 `packages/core/src/config/permission-settings.ts` 的严格切换随 Task 6 一起完成。
- Modify: `packages/agent-runtime/src/node/runtime/agent-options.ts`、`packages/agent-runtime/src/node/runtime/default-runtime.ts`、`packages/server/src/daemon/daemon-agent.ts`。
- Test: `packages/protocol/src/runtime-config.test.ts`、`packages/core/src/config/permission-settings.test.ts`、`tests/agent-behavior/scoped-modes.test.ts`。

**Interfaces:**

```ts
export type ApprovalMode = "ask" | "auto_review" | "full_access";
export type WorkMode = "execute" | "plan";
// SessionRuntimeConfig 新增 approvalMode 和 workMode。
// 最终移除 session 的 permissionMode；Task 6 同步切换现行消费者和存量转换。
```

- Consumes: 现有 `readSessionRuntimeConfig`、`patchSessionRuntimeMetadata` 和 `PermissionChecker`。
- Produces: 独立的会话字段；工作模式为 `plan` 时，任何授权档位都受可信只读限制。

- [ ] 在已有协议 fixture 中添加两个字段的读写、非法值和保留另一个字段的测试。关键断言：

```ts
const next = patchSessionRuntimeMetadata(
  { runtime: { model: "offline", approvalMode: "auto_review", workMode: "execute" } },
  { workMode: "plan" },
);
expect(next.runtime).toMatchObject({ approvalMode: "auto_review", workMode: "plan" });
```

- [ ] 在真实运行 fixture 中加入 `full_access + plan` 的写文件拒绝用例，以及 `ExitPlanMode` 不能解除用户计划限制的用例；检查目标文件确实不存在。
- [ ] 运行协议、配置和 scoped-modes 对应测试，确认失败反映尚未支持的新行为。
- [ ] 实现字段校验、会话到 runtime 的传递和只读限制。现有模型临时计划状态与用户工作模式分开，用户工作模式优先；退出临时计划只能恢复当前用户选择。
- [ ] 重跑本项测试；检查提示词、工具可见范围、钩子限制与检查器一致。

**Validation:**

```powershell
pnpm --filter @vykor/protocol exec vitest run src/runtime-config.test.ts
pnpm --filter @vykor/core exec vitest run src/config/permission-settings.test.ts
pnpm exec vitest run --config tests/agent-behavior/vitest.config.ts tests/agent-behavior/scoped-modes.test.ts
```

## Task 2: 桌面计划开关与会话恢复

**Files:**
- Modify: `apps/desktop/src/shared/session-types.ts`、`apps/desktop/src/main/features/session/session-operations.ts`。
- Modify: `apps/desktop/src/renderer/src/stores/desktop-session/{types,initial-state,session-actions,session-view-actions,start-session-action,goal-actions,helpers,bootstrap-actions}.ts`。
- Modify: `apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx`。
- Modify: `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/composer.tsx`、`controls.tsx`、`composer-command-catalog.ts`。
- Modify: `apps/desktop/src/renderer/src/components/desktop/tools/side-chat/side-chat-panel.tsx`。
- Test: 现有 `session-actions.test.ts`、`goal-actions.test.ts`、`composer-native-commands.test.tsx`、`composer-command-catalog.test.ts`，以及侧边聊天同级 `__test__`。

**Interfaces:**
- Consumes: Task 1 的 `ApprovalMode`、`WorkMode`、会话 patch。
- Produces: `selectWorkMode(mode: WorkMode)` 只修改新聊天本地状态；`updateSessionWorkMode(sessionId: string, mode: WorkMode): Promise<void>` 持久更新已有会话；Composer 独立的 `workMode` 和 `onSelectWorkMode` 参数。

- [ ] 用已有 store fixture 添加以下断言：新聊天选择计划不调用 `setDefaultPermissionMode`；A/B 聊天恢复各自工作模式；退出计划保持 `auto_review`；模式更新失败不继续依赖新模式的发送。
- [ ] 用现有 Composer fixture 添加 `@/+` 计划项只调用工作模式回调、`/plan` 文案随工作模式变化的断言。
- [ ] 运行这些新增测试并确认失败。
- [ ] 接入独立回调与可移除模式标记；主聊天、侧边聊天、目标创建首条消息传同一组状态。新聊天工作模式不放进正文或全局默认。
- [ ] 模式更新完成前阻止依赖它的发送；失败保留正文和原工作模式。发送清空正文不清空已持久化的计划状态。
- [ ] 重跑上述测试，并运行桌面 `typecheck:node`、`typecheck:web`；不启动 UI 预览。

**Validation:**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/stores/desktop-session/session-actions.test.ts src/renderer/src/stores/desktop-session/goal-actions.test.ts src/renderer/src/components/desktop/conversation-page/composer/__test__/composer-native-commands.test.tsx src/renderer/src/components/desktop/conversation-page/composer/__test__/composer-command-catalog.test.ts
pnpm --filter @vykor/desktop run typecheck:node
pnpm --filter @vykor/desktop run typecheck:web
```

## Task 3: 独立、无工具的审批审查

**Files:**
- Create: `packages/protocol/src/permissions/approval-review.ts` 及 `approval-review.test.ts`。
- Create: `packages/agent-runtime/src/node/review/approval-reviewer.ts` 及 `approval-reviewer.test.ts`。
- Modify: `packages/agent-runtime/src/node/runtime/default-runtime-provider.ts`、`packages/agent-runtime/src/index.ts`、`packages/protocol/src/index.ts`。

**Interfaces:**

```ts
export interface ApprovalReviewResult {
  decision: "approve" | "ask_user" | "deny";
  risk: "low" | "medium" | "high" | "unknown";
  authorization: "explicit" | "task_implied" | "missing";
  reason: string;
}
export interface ApprovalReviewInput {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  runtimeRevision: number;
  inputId: string;
  evidence: string;
}
export interface ApprovalReviewer {
  review(input: ApprovalReviewInput, signal: AbortSignal): Promise<ApprovalReviewResult>;
}
```

- Consumes: `StreamingMessageClient.streamMessage` 和现有 provider / credential 解析。
- Produces: 无工具审查请求及严格结果解析；调用方传入可信、已脱敏的 evidence，不能采用工具输入自报的批准。

- [ ] 写结果解析测试：合法结果、非法 decision、空理由、超过 1000 字符的理由、工具调用响应均被准确处理，非法结果不得返回 approve。
- [ ] 用假的流式客户端捕获实际请求，断言没有工具、模型参数来自当前会话、最大输出为 1024 tokens；工具输出被标为资料而非授权。
- [ ] 添加取消与 30 秒超时的虚拟计时测试，确认中止传到客户端，晚到响应不返回批准。
- [ ] 运行新增测试确认失败，再实现审查器及构造入口。复用 provider 解析，不从 server 深层导入 agent-runtime 私有文件，也不新建可执行工具的代理。
- [ ] 重跑新增测试和 agent-runtime 类型检查；本项不用真实在线模型或新 API key。

**Validation:**

```powershell
pnpm --filter @vykor/protocol exec vitest run src/approval-review.test.ts
pnpm --filter @vykor/agent-runtime exec vitest run src/approval-reviewer.test.ts
pnpm --filter @vykor/agent-runtime run check-types
```

## Task 4: 接入持久授权请求与用户反馈

**Files:**
- Create: `packages/server/src/permissions/approval-review-service.ts`。
- Create: `packages/server/src/permissions/__test__/approval-review-service.test.ts`。
- Modify: `packages/server/src/permissions/permission-broker.ts`、`packages/server/src/application/daemon-application.ts`。
- Modify: `packages/services/src/permissions/permission-records.ts` 和现有授权记录 / 事件类型。
- Modify: `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/` 中现有授权卡片展示入口。
- Test: `packages/server/src/permissions/__test__/permission-broker.test.ts`、现有 `permission-card.test.ts`。

**Interfaces:**
- Consumes: Task 3 的 `ApprovalReviewer`；当前会话模式、修订号、准确工具来源和用户证据由宿主提供。
- Produces: 授权请求附加 `review` 记录，包含请求 ID、配置修订、审查状态、风险、授权判断、理由、起止时间；正常授权终态继续沿用现有类型。

- [ ] 在现有 broker fixture 中注入假的审查器，分别证明 approve 才能执行、ask_user 等待人、deny 不执行、异常与超时转人、取消后迟到 approve 无效；补充立即返回的审查器与人工抢先回复用例，证明没有丢失 waiter 或重复结算。
- [ ] 添加两项边界测试：自动批准一次 Write 后不能自动批准不同路径的下一次 Write；`AskUser` 和要求用户明确同意的应用授权不交给审查器。
- [ ] 运行新增测试确认失败。
- [ ] 在请求持久化并建立结算机制以后调用审查服务；已完成请求和重复回调不重复执行。审查器只决定尚需授权且未被禁止的具体操作。补传 inputId、cwd、agentId，通过持久输入记录构造用户证据，不能相信主代理 reason 中的自报授权。
- [ ] 自动批准不写 `decision: session`；超时转人工保持 pending，取消或重启走已有 expired 流程。授权或工作模式变更使旧修订的待执行请求失效。
- [ ] 授权卡片显示自动审查状态与简短理由，不混用“完成后代码检查”状态；重跑服务端和卡片测试。

**Validation:**

```powershell
pnpm --filter @vykor/server exec vitest run src/permissions/__test__/approval-review-service.test.ts src/permissions/__test__/permission-broker.test.ts src/permissions/__test__/permission-controller.test.ts
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/message/__test__/permission-card.test.ts
```

## Task 5: 当前会话完全访问的真实执行范围

**Files:**
- Modify: `packages/sandbox/src/{policy,types,path-validator,shell}.ts`。
- Modify: `packages/agent-runtime/src/node/runtime/default-runtime.ts`、`packages/agent-runtime/src/node/runtime/default-runtime-sandbox.ts`。
- Modify: 文件工具、终端、PTY、后台 Shell 的现有执行策略传递点，仅补齐本策略所需参数。
- Test: `packages/sandbox/src/policy.test.ts`、`packages/sandbox/src/execution-environment.test.ts`、`tests/agent-behavior/scoped-modes.test.ts`。

**Interfaces:**
- Consumes: 当前会话的 `approvalMode`、`workMode` 和强制策略。
- Produces: 会话级解析后的执行策略；只影响当前执行，不能写全局沙箱设置。

- [ ] 添加不同会话同进程的策略测试：一方 full_access 不影响另一方；plan 优先；强制 deny 优先；配置对象保持不变。
- [ ] 使用假的进程启动器验证文件、Shell、PTY 和后台任务采用同一个会话策略；验证缺少可靠隔离时自动审查不会凭 cwd 自动批准未知命令。
- [ ] 运行新增失败用例后实现策略解析及传递。特别处理当前 path-validator 在 policy off 时提前返回，防止扩大普通边界同时绕过强制 deny。
- [ ] 在被支持的实际执行环境中验证一个工作区外读写和一个联网操作；未执行的平台只报告静态或模拟验证，不宣称系统隔离通过。
- [ ] 重跑相关测试，确认 `full_access + plan` 写入仍被拒绝。

**Validation:**

```powershell
pnpm --filter @vykor/sandbox exec vitest run src/policy.test.ts src/execution-environment.test.ts
pnpm exec vitest run --config tests/agent-behavior/vitest.config.ts tests/agent-behavior/scoped-modes.test.ts
```

## Task 6: 数据升级、共用入口与发布检查

**Files:**
- Modify: 现有设置读取升级入口、`packages/services/src/database/migrations.ts` 及项目现行会话数据升级机制。
- Modify: `apps/cli/src`、`apps/frontend/src`、`packages/commands/src`、`packages/server/src/application/schedule/scheduled-task-executor.ts` 中现有模式消费者。
- Modify: 桌面授权设置页、一般设置快捷项和三档菜单。
- Modify: `docs/permission-flow.md`、`docs/composer-capabilities-requirements.md`。

**Interfaces:**
- Consumes: Tasks 1–5 的完整行为和设计第 7 节转换表。
- Produces: 受控的一次性存量转换，现行协议不再写旧字段；所有共用入口采用新模式。

- [ ] 创建旧设置与旧会话 fixture，验证 default、plan、full_auto 的转换；原禁止规则保持，旧历史不伪造自动审查记录。
- [ ] 运行失败用例后接入现行升级机制，不在普通请求里接受两套长期格式。
- [ ] 用 `rg` 清点旧值消费者并逐一更新；定时任务原 read_only 映射为工作模式 plan，其授权档位仍独立。
- [ ] 功能接通后统一启用三档菜单，完全访问描述准确说明当前环境范围；保留已有默认值或执行明确的数据转换。
- [ ] 运行各改动模块测试和类型检查，再执行文档与架构检查。完整测试套件仅在出现跨模块未解决风险时额外运行。
- [ ] 实施完成后进行独立代码审查，重点检查计划限制、自动自批、子代理继承、迟到结果、配置切换和全局策略泄漏。用户查看界面样式反馈。

**Final Checks:**

```powershell
pnpm check-docs
pnpm check:architecture
git diff --check
```

## 实施记录（2026-10-20）

上述复选项保留为实施前的工作清单；实际交付和验证以本节为准。按用户要求优先编码，集中测试，没有逐条重复运行完整测试套件。

- Task 1–2：完成授权与工作模式拆分，桌面主聊天、侧边聊天、目标会话和 @ / + 计划入口已接通，保留 /plan 快捷开关。
- Task 3–4：完成无工具模型审查、可信用户证据、超时转人工、取消与配置修订检查、授权记录和卡片反馈。自动批准仅作用于当前操作。
- Task 5：完成会话独立的完全访问策略；明确禁止规则与计划限制仍生效。子代理收紧授权时恢复原沙箱，并保存收紧结果。
- Task 6：完成 CLI、TUI、设置、定时任务和文档更新。旧数据在统一读取入口归一化，后续模式变更写入新字段；未新增数据库迁移。
- 已通过协议、权限、沙箱、运行时、服务端、客户端命令、CLI、桌面与 TUI 的相关测试。自动审查使用假的模型客户端验证；未调用在线模型。
- 已完成独立代码审查，修复计划模式被模型退出、子代理权限继承、迟到审查结果以及模式保存时编辑重发等问题。
- 平台限制：没有执行跨平台真实系统隔离、在线模型审查或界面样式验证；Windows 缺少可靠命令隔离时转人工审批。界面由用户运行后查看。
- 文档检查发现仓库已有的失效链接，未扩展到无关文档修复。

### 职责与依赖复核

- 审批业务服务仅接收协议类型和审查函数；模型服务商、凭据解析与底层审查器保留在运行时内部，对外只提供配置好的审查器工厂。
- 修正异步送审继续读取原始请求对象的问题，使用 broker 保存的参数快照，工具注册事实在入口捕获。
- 扩展现有架构检查：用 TypeScript 语法解析读取包声明和源码导入，检查包依赖是否形成闭环。包含类型、副作用、动态和相对路径跨包导入，忽略注释与字符串中的伪导入。
- 包依赖扫描未发现循环；与改造前的 1,451 个文件对比，未增加或扩大文件循环。此次没有扩大到仓库既有的包内文件循环清理。

- 后续收敛：移除 core 对协议函数和审查数据的转导出，agent-runtime 显式声明 protocol 依赖并直接引用公共入口。core 原有的 protocol 依赖及自身所需的共享类型不变。
