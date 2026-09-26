# 模型网络自动重试执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 状态：当前执行计划及完成记录。2026-09-26：代码、自动验收及整体审核完成，人工窗口观察未执行。
> 原始计划编制于 2026-09-25。下面的任务清单保留规格用途，实际完成情况以末尾收尾记录为准；未勾选项目不代表实现仍全部待办。

**Goal:** 网络波动后自动、有限次、可取消地重试当前模型调用，界面显示进度，最终回答不重复，已经完成的工具不重复执行。

**Architecture:** QueryEngine 统一负责一次模型调用的重试次数、等待和失败输出替换；提供商适配器负责单次请求、协议完成校验及错误归类。运行事件沿现有 FrameworkAgentRun → DaemonAgentEventProjector → SessionTranscriptProjection → SessionStore → Client 链路传播，重试状态写入现有 Run metadata，失败输出保留为被替代的记录。

**Tech Stack:** TypeScript、pnpm workspace、Vitest、现有 OpenAI/Anthropic SDK、fetch、AbortController、现有 SQLite SessionStore；Desktop React，TUI（可交互终端界面）使用 React/OpenTUI 和 Bun 测试。

**Spec:** [模型请求自动重试：Codex 调研与改进建议](../../model-network-retry-design.md)。实施前同时阅读本文和该文档。

**审核修订：** 已补齐服务端历史重建过滤（任务 5A）、压缩/记忆提取独立重试（任务 3A）、尝试用量完整性（任务 1、3、4、5、7、8）。这些是待执行任务，不表示功能已实现。

**2026-09-26 二次审核修订：** 对照 `4277205b..45891233` 新增功能，补齐输出上限冻结、截断提示提交顺序和 Desktop 合并快照验收。实现前重新核对 HEAD，后续改动以实际代码为准，但不能静默删减这些行为要求。

## 全局约束

- 不自动重新执行整项任务，不重跑已经完成的工具，不包含进程重启后的任务恢复。
- 请求失败与流中断分别计数，同时有总次数及恢复时间上限。
- 不新增重试依赖，不新增数据库表，不重新设计客户端重连。
- 不声称从断开的 token 续传；本期重新生成当前模型响应。
- 未确认完整的模型响应不得触发工具执行。
- 主动取消立即停止等待和请求；已结束运行不得被迟到事件恢复。
- 文档、代码说明和用户提示用通俗中文；运行日志不得写入密钥和完整请求正文。
- 失败请求的 token 用量未知时保持未知；已知消耗不能因重试被清零。
- 原始异常通过 `cause` 保留；只有序列化后的安全摘要进入客户端事件。
- 执行前保留当前工作区的用户修改。尤其 `query-engine.ts`、`integration.test.ts`、HTTP 测试等已有其他工作，不得整文件覆盖或回退。
- 每项任务先添加能反映故障的测试，再实现并运行对应检查。本文中的命令是未来执行命令，不代表已经运行或通过。

## 已核实的代码入口

以下路径均相对仓库根目录。新文件会明确标注“新增”。

| 部分 | 文件 | 当前职责及计划变化 |
|---|---|---|
| 模型调用接口 | `packages/core/src/types/client.ts` | `StreamingMessageClient` 和请求参数；补充单次请求时间限制 |
| 流事件 | `packages/core/src/types/events.ts` | `StreamEvent`；新增生成尝试开始、等待重试事件 |
| 引擎配置与 Agent 事件 | `packages/core/src/types/runtime.ts` | `QueryEngineOptions`、`AgentEventInput`；增加重试策略和事件映射 |
| 重试策略 | 新增 `packages/core/src/engine/model-retry.ts` | 纯策略计算、共享错误类型和可取消等待，不依赖 API 包 |
| 引擎 | `packages/core/src/engine/query-engine.ts` | 在当前模型调用边界重试，成功后才提交消息及执行工具 |
| 提供商适配器 | `packages/api/src/providers/openai.ts`、`anthropic.ts`、`codex.ts` | 收敛为单次调用，保留错误原因，验证完整响应 |
| API 错误及超时 | `packages/api/src/errors/index.ts`、`packages/api/src/providers/retry.ts` | 归一化错误和读取超时；移除被替代的等待逻辑前检查所有调用者 |
| 框架运行结果 | `packages/agent-runtime/src/framework-agent-run.ts` | 修正直接累加 `output`，映射新事件 |
| 服务端投影 | `packages/server/src/application/agent/daemon-agent-event-projector.ts` | 将生成尝试、重试状态写入会话记录 |
| 消息投影 | `packages/server/src/application/session/transcript-projection.ts` | 记录当前尝试所有 part，失败后标记被替代 |
| 数据写入 | `packages/services/src/runs/run-repository.ts`、`packages/services/src/conversations/incremental-output.ts`、`conversation-repository.ts` | 复用 Run metadata 和消息 metadata，保证缓冲数据与替换顺序 |
| 协议 | `packages/protocol/src/session.ts`、`capabilities.ts` | 重试 metadata 的类型与读取校验、协议版本 |
| 客户端 | `packages/client/src/state/reducer.ts`、`selectors.ts` | 去重、屏蔽被替代输出、读取重试状态 |
| Desktop | `apps/desktop/src/renderer/src/components/desktop/conversation-page/transcript/transcript.tsx` | 重试状态提示、隐藏失败尝试输出 |
| TUI | `apps/frontend/src/routes/session/Session.tsx`、`parts.tsx`、`apps/frontend/src/hooks/transcript.ts` | 同步展示状态与输出替换；该包并非 Web 页面 |
| 卡住检测 | `packages/server/src/application/session/run-stall-watchdog.ts`、`session-run-executor.ts` | 在有界等待重试期间避免提前判定运行无进展 |
| CLI | `apps/cli/src/print-session.ts`、`renderer.ts` | 正确处理不可撤回的终端输出及机器可读结果 |
| 服务端历史和公开文本 | `packages/server/src/application/agent/agent-transcript.ts`、`packages/server/src/session/transcript-text.ts` | 重建模型历史和提取公开文本时排除失效输出 |
| 辅助模型调用 | `packages/core/src/engine/query-engine.ts`、`packages/agent-runtime/src/memory-runtime.ts`、`packages/services/src/memory-extract.ts` | 压缩和记忆提取独立重试，成功后交付缓冲结果 |
| 用量完整性 | `packages/core/src/types/usage.ts`、`packages/core/src/engine/cost-tracker.ts` | 区分已知消耗与未知尝试，汇总不可冒充完整账单 |

实施时若调用链因并行工作发生变化，先用 `rg` 重新定位同名接口，再更新计划的路径，不移动或重构无关模块。

## 本期确定的行为和接口

### 重试预算

以下是本项目首版默认值，不是照搬 Codex 内部实现：

```ts
export interface ModelRetryPolicy {
  requestMaxRetries: number;
  streamMaxRetries: number;
  maxTotalRetries: number;
  recoveryBudgetMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  requestTimeoutMs: number;
  streamIdleTimeoutMs: number;
}

export const DEFAULT_MODEL_RETRY_POLICY: ModelRetryPolicy = {
  requestMaxRetries: 3,
  streamMaxRetries: 3,
  maxTotalRetries: 5,
  recoveryBudgetMs: 180_000,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  requestTimeoutMs: 60_000,
  streamIdleTimeoutMs: 300_000,
};
```

- 首次请求不计入重试次数；总计最多 6 次实际请求。
- 请求还未建立流时的故障计入 request；流建立后故障计入 stream，即使尚无可见文字。
- 首次可重试故障出现时启动 180 秒恢复窗口；期间的等待、连接和流读取都计入。收到部分文字不重置窗口和次数。
- 首次正常生成不受恢复窗口限制，仍受请求及流空闲超时限制。恢复窗口开始后，最早到期的截止时间优先。
- 正常响应完成并进入下一次模型调用，重试预算重新开始。工具回合数不因网络重试增加。
- 延迟为 `min(baseDelayMs * 2 ** totalRetries + random() * 250, maxDelayMs)`，其中 `totalRetries` 为已经发起的重试数。
- 实际等待取上述延迟与 `Retry-After` 的较大值；服务端要求等待超过恢复窗口时直接报预算耗尽，不能提前重试。
- `QueryEngineOptions.modelRetry?: Partial<ModelRetryPolicy>` 用于宿主配置和测试；本期不增加设置页。数值须校验为有限非负整数，超时值必须大于零；`maxTotalRetries: 0` 禁用自动重试。

### 错误与事件契约

在 core 定义并从 `packages/core/src/index.ts` 导出以下类型，避免 core 反向依赖 API 包：

```ts
export type ModelFailureKind =
  | "network" | "timeout" | "rate_limit" | "server"
  | "stream_incomplete" | "authentication" | "invalid_request"
  | "quota" | "protocol" | "unknown";

export interface ModelFailureInfo {
  kind: ModelFailureKind;
  phase: "request" | "stream";
  retryable: boolean;
  statusCode?: number;
  retryAfterMs?: number;
  requestId?: string;
}

export class ModelRequestFailure extends Error {
  constructor(message: string, readonly info: ModelFailureInfo, cause?: unknown) {
    super(message, { cause });
    this.name = "ModelRequestFailure";
  }
}

export interface GenerationIdentity {
  generationId: string; // 一次模型调用，重试时保持不变
  attempt: number;     // 从 1 开始，首次请求为 1
}

export interface ModelRetryState extends GenerationIdentity {
  retryNumber: number; // 下一次重试是第几次，从 1 开始
  maxRetries: number; // 本次生成允许的总重试上限
  reason: ModelFailureKind;
  nextRetryAt: number;
  recoveryDeadlineAt: number;
}
```

`StreamEvent` 新增两种事件：

```ts
type GenerationStartedEvent = GenerationIdentity & { type: "generation_started" };
type ModelRetryEvent = ModelRetryState & { type: "model_retry" };
```

`generation_started` 每次请求前发出，重试开始时作为撤换前一次输出的明确边界；`model_retry` 在等待前发出。成功仍使用现有 `complete`，失败和取消沿现有运行结束通路处理。文本等事件在有序流内归属最近的 `generation_started`；同一次生成不得并发消费两个尝试。

Agent 层分别映射为 `output.generation.started` 和 `model.retry.scheduled`，`data` 是去掉 `type` 的字段。`ModelRetryState` 属于 core；protocol 定义与之结构相同的 `SessionModelRetryState`，不新增 protocol → core 依赖，通过映射测试保证一致。

### 每次尝试的用量完整性

在 core 新增以下 StreamEvent，并映射为 Agent 事件 `model.attempt.finished`：

```ts
export interface ModelAttemptFinishedEvent extends GenerationIdentity {
  type: "model_attempt_finished";
  status: "completed" | "failed" | "interrupted";
  usageStatus: "complete" | "partial" | "unknown";
  usage?: UsageSnapshot; // 已知消耗；unknown 时省略，不能填 0 冒充已知
}
```

- 每次实际请求恰好结算一次，用 `(generationId, attempt)` 去重；失败、取消和最后一次耗尽也必须结算。结算在下一次重试状态或最终运行结束前发送。
- 适配器的 usage 表示本次请求累计快照；引擎保留最新有效快照，不能把同一次请求的累计值重复相加。usage 是否完整必须依据协议语义确定，不能只看是否非零。
- 原始 usage 事件由引擎消费，不直接转发。引擎结算时向 CostTracker 累加一次已知 usage，并发出 model_attempt_finished。Runtime 从该事件派生一次现有 usage.updated（仅 usage 存在时），同时发布 model.attempt.finished。整体审核后的实现决定：服务端只通过 model.attempt.finished 在同一事务内去重、更新已知数字与完整性，usage.updated 保留给实时观察者，不再次写用量。这样避免“结算已写入、数字尚未写入”的分离提交窗口，也不会在两条事件中重复计费。
- `UsageSnapshot` 增加可选 `usageIncomplete?: boolean`，表示数字仅是已知小计。`CostTracker` 增加 `markUsageIncomplete(): void`，在 partial/unknown 时设置标记；同一统计周期中后续成功不能清除它，只有原有 reset 能重置。旧记录没有该标记时不反推其历史用量完整。
- protocol 定义结构一致的 `SessionModelAttemptUsage`，字段为 generationId、attempt、status、usageStatus 和可选 usage；不引入 protocol → core 依赖。任务 5 将每次结算保存为已注册的持久事件 `session.model.attempt.finished`，payload 为 `{ runId, attemptUsage }`。
- `run.metadata.modelUsage` 保存 `{ incomplete: boolean, unknownAttempts: number, partialAttempts: number }`，供 snapshot/刷新恢复。通过已有事务将结算事件、完整性、run.metadata.usage 已知小计和现有 RunAttempt 数字一起提交，同键重复事件不再次累加。不新增账单表。
- Desktop/TUI/CLI 遇到 incomplete 显示“已知用量：…；部分请求用量未知”，不显示为完整总消耗。成本估计同样标记不完整，不从成功请求推算失败请求费用。

### 存储、展示与失效尝试

- `run.metadata.modelRetry` 保存当前等待状态；新尝试开始、成功、失败、取消时移除该字段，合并保留其他 metadata。
- `part.metadata.modelGeneration` 保存 `{ generationId, attempt, superseded: boolean }`。重试开始时将上一尝试的所有 part 标为 `superseded: true`，状态设为 `interrupted`，保留原始内容便于排障。
- 标记范围按当前生成的 part ID 集合，包含已因文字/思考切换而关闭的 part，不能仅处理 `activeTextPartId`。
- 重试等待期间可以保留残缺文字；下一尝试真正开始时替换。最终失败没有下一尝试时，将残缺输出明确标为 interrupted，不写入模型历史作为已完成回答。
- 新尝试使用新的 part ID；旧连接不得继续向新尝试写入。数据库、快照、增量事件及最终 `AgentRunResult.output` 必须一致。
- 本期不将一次 HTTP 请求映射为 `SessionRunAttemptRecord`。保留现有 RunAttempt 含义，用带 generationId/attempt 的运行事件追踪网络尝试。
- 使用现有 `session.run.updated` 和 `session.message.part.updated` 传播状态；不另建重试 SSE 通道。新增运行诊断事件如需持久化，须注册到现有 event-registry，不能绕过校验。
- 服务端读取历史与公开回复必须使用同一失效判定，不能只在客户端隐藏。新格式 part 的 `modelGeneration` 另含 `committed: boolean`：生成完整确认后为 true，此前为 false；重建模型历史排除 superseded 或未 committed 的新格式 part。旧格式没有该字段时保持原有兼容行为，不能凭 `status !== completed` 删除历史中的有效工具记录。

## 任务依赖与发布边界

```text
任务 0：基线与变更保护
  → 任务 1：错误、策略和事件契约
  → 任务 2：提供商单次调用与完整结束检查
  → 任务 3：引擎重试与输出边界
  → 任务 3A：压缩与记忆提取独立重试
  → 任务 4：框架运行结果与事件映射
  → 任务 5：持久记录与服务端投影
  → 任务 5A：服务端历史与公开文本过滤
  → 任务 6：客户端恢复与协议版本
  → 任务 7：Desktop / TUI / CLI 展示
  → 任务 8：端到端验收、文档和交付
```

任务可以分别提交，但任务 2～7 不能单独发布：移除旧重试后需要引擎接管，自动重发也需要界面正确替换输出。所有消费者通过检查后统一发布。提交前检查 diff，只暂存本任务文件中的相关改动；有混合修改时使用选择性暂存，不执行 `git add .`。

上述统一发布范围包含任务 3A、5A。任务 2 不能在辅助调用独立重试接好前上线，否则会丢失既有临时 HTTP 错误恢复能力。

## 任务 0：记录基线，保护现有修改

**文件：** 本计划；已有代码只读。

- [ ] 执行 `git status --short`，记录与本任务重叠的修改；不得恢复当前已删除的其他计划文件。
- [ ] 阅读设计文档及 `docs/agent-lifecycle-contract.md`、`docs/protocol-contract.md`、`docs/durable-execution-data-model.md` 中相关运行结束和版本规则。
- [ ] 定位所有模型调用者及直接累加输出的地方：

```powershell
rg -n 'streamMessage\(|text_delta|output\.text\.delta' packages/core/src packages/api/src packages/agent-runtime/src packages/services/src apps/cli/src
rg -n 'retryWithBackoff|abortableDelay|MAX_RETRIES|maxRetries' packages/api/src packages/core/src
```

- [ ] 跑基线：

```powershell
pnpm --filter @vykor/api exec vitest run src/providers/retry.test.ts src/providers/openai.test.ts src/providers/anthropic.test.ts src/providers/codex.test.ts
pnpm --filter @vykor/core exec vitest run src/engine/integration.test.ts
```

**验收：** 明确现有失败与本次新增失败；禁止把基线故障当成新增回归或未经说明直接改掉。

## 任务 1：建立共享错误、重试策略与事件类型

**新增：** `packages/core/src/engine/model-retry.ts`、`model-retry.test.ts`。
**修改：** `packages/core/src/types/events.ts`、`types/client.ts`、`types/runtime.ts`、`index.ts`。

**输入：** 原始时间和重试计数、`ModelRequestFailure.info`。
**输出：** 上文错误/事件类型，以及以下明确接口：

```ts
export interface RetryCounters { request: number; stream: number; total: number }
export function normalizeModelRetryPolicy(input?: Partial<ModelRetryPolicy>): ModelRetryPolicy;
export function nextModelRetryDelay(input: {
  failure: ModelFailureInfo;
  counters: RetryCounters;
  policy: ModelRetryPolicy;
  now: number;
  deadlineAt: number;
  random: number; // [0, 1)，由调用方传 Math.random()
}): number | undefined; // undefined = 不再重试
export function waitForModelRetry(ms: number, signal?: AbortSignal): Promise<void>;
```

- [ ] 编写并运行失败测试，使用可控时间和固定 random。至少覆盖总次数、分类次数、Retry-After、剩余时间不足、零次重试、无效配置和取消。

```ts
it("does not shorten the server retry delay to fit the recovery window", () => {
  expect(nextModelRetryDelay({
    failure: { kind: "rate_limit", phase: "request", retryable: true, retryAfterMs: 60_000 },
    counters: { request: 0, stream: 0, total: 0 },
    policy: DEFAULT_MODEL_RETRY_POLICY,
    now: 1_000, deadlineAt: 31_000, random: 0,
  })).toBeUndefined();
});
```

- [ ] 实现纯策略和取消等待。等待监听器在 resolve/reject 后清理；预先取消不得创建定时器。
- [ ] 在 `StreamMessageParams` 增加可选 `requestTimeoutMs`、`streamIdleTimeoutMs`；在 `QueryEngineOptions` 增加 `modelRetry`，添加事件与导出，不让 core 引用 API 包。
- [ ] 增加上文 ModelAttemptFinishedEvent 和 UsageSnapshot.usageIncomplete，更新 `types/usage.ts` 及 `ICostTracker` 实际声明；明确未知尝试没有 usage 数字，旧客户端类型在协议升级前不混用。
- [ ] 执行：

```powershell
pnpm --filter @vykor/core exec vitest run src/engine/model-retry.test.ts
pnpm --filter @vykor/core check-types
```

**验收：** 策略能独立测试；原有模型客户端仍可满足接口；此阶段不改变生产请求行为。
**建议提交：** `feat(core): define bounded model retry policy and events`。

## 任务 2：适配器提供可靠的单次请求

**修改：** `packages/api/src/providers/openai.ts`、`anthropic.ts`、`codex.ts`、`retry.ts`、`errors/index.ts`；对应 `providers/*.test.ts` 和 `errors/index.test.ts`。

**输入：** 请求参数、取消信号和可选超时。
**输出：** 一次实际请求的事件流，或带 phase/原因的 `ModelRequestFailure`；不在适配器内重新请求。

- [ ] 增加错误转换函数并测试其行为，保留现有鉴权、能力不匹配错误的公共兼容性：

```ts
// 位于 API errors/index.ts，从 core 导入 ModelRequestFailure。
export function toModelRequestFailure(
  error: unknown,
  phase: "request" | "stream",
  now = Date.now(),
): ModelRequestFailure;
```

  识别 `ECONNRESET`、`ECONNREFUSED`、`ETIMEDOUT`、`EAI_AGAIN`、Undici 连接/读取超时和 socket 断开；沿 cause 链查找且防止循环引用。证书错误、普通 TypeError、编程错误不统一归为可重试。`ENOTFOUND` 有界重试后明确提示地址或 DNS 问题；不得无限等待。

```ts
it("preserves a nested network cause without an HTTP status", () => {
  const cause = Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
  const original = new TypeError("fetch failed", { cause });
  const failure = toModelRequestFailure(original, "stream", 0);
  expect(failure.info).toMatchObject({ kind: "network", phase: "stream", retryable: true });
  expect(failure.cause).toBe(original);
});
```

- [ ] 解析 429 的结构化错误码，`insufficient_quota` 等额度耗尽不可重试；解析 Retry-After 秒数和日期，负数/非法值忽略。服务端流错误提取 error code，不仅保留字符串。
- [ ] SDK 构造明确设置 `maxRetries: 0`，移除三处适配器重试循环；验证实际请求计数为 1。此项与任务 3 同批交付，不单独上线。
- [ ] Codex：必须收到 `response.completed` 才可提交；`response.failed`、`response.incomplete`、`error`、提前 EOF 分别处理。`max_tokens` 等明确的正常受限完成不误判为网络错误。
- [ ] OpenAI Chat Completions：要求非空 `finish_reason`；不能把 iterator 正常退出自动当作成功。保留结束后的 usage chunk 处理；异常截断不提交工具。
- [ ] Anthropic：依照当前安装 SDK 的 `message_stop`/`finalMessage` 完成语义确认结束，测试缺失结束事件，不通过伪造 finalMessage 掩盖断流。
- [ ] 工具参数 JSON 无法解析时不得以 `{}` 执行工具；抛不可重试的 protocol 错误。三个适配器均在本次响应确认完整后输出待执行工具。
- [ ] 为连接阶段和读取阶段加入定时中止。所有超时通过内部 AbortController 取消底层连接；外部取消优先保留其原因，不转换成可重试超时；退出时清理 timer 和监听器。
- [ ] 空闲计时在每个实际接收到的协议事件/心跳上刷新，而非只在文本 delta 上刷新。Codex 在原始 SSE 读取层观察心跳；SDK 路径先核验当前版本能否暴露心跳，不能观察的注释心跳须在文档写明限制，不声称已支持。已进入恢复窗口时，心跳不能延长恢复截止时间。
- [ ] 执行适配器、错误、等待定向测试与类型检查：

```powershell
pnpm --filter @vykor/api exec vitest run src/errors/index.test.ts src/providers/retry.test.ts src/providers/openai.test.ts src/providers/anthropic.test.ts src/providers/codex.test.ts
pnpm --filter @vykor/api check-types
```

**验收：** HTTP 错误、网络异常、无完成事件的 EOF 可区分；每次调用最多一次实际请求；任何未完成响应都不执行工具。
**建议提交：** `fix(api): classify model failures and reject incomplete streams`。

## 任务 3：引擎统一重试当前模型调用

**新增：** `packages/core/src/engine/model-retry.integration.test.ts`。
**修改：** `packages/core/src/engine/query-engine.ts`；按需要更新既有 `integration.test.ts` 的测试客户端。

**输入：** 任务 1 策略、任务 2 单次调用接口。
**输出：** 有尝试边界的 StreamEvent；模型历史只包含成功响应；不重跑此前工具。

- [ ] 先写故障客户端，供测试精确控制一次失败和一次成功：

```ts
const streamMessage = vi.fn(async function* (): AsyncIterable<StreamEvent> {
  if (streamMessage.mock.calls.length === 1) {
    yield { type: "text_delta", delta: "残缺回答" };
    throw new ModelRequestFailure("connection reset", {
      kind: "network", phase: "stream", retryable: true,
    });
  }
  yield { type: "text_delta", delta: "完整回答" };
  yield { type: "complete", stopReason: "end_turn" };
});
```

  用现有 QueryEngine 测试构造方式注入该客户端，断言调用 2 次、产生 `generation_started(1) → model_retry → generation_started(2)`，最终历史只有“完整回答”。使用 fake timers 推进等待，不真实睡眠。

- [ ] 将重试循环包在一次 `streamMessage` 和消费范围外，不能包住 executeTools、权限请求、压缩和整个 Run。
- [ ] 在第一次请求前冻结完整请求参数：model/client/system/tools/messages、reasoningEffort、已解析的 maxOutputTokens（传入 API 时为 maxTokens）以及其他实际请求选项。重试期间不重新解析模型设置、不再次压缩、不消费 steer 输入，下一次正常模型回合再应用更新。保留当前 CompactService.setOutputReserve 与请求输出上限一致的行为；辅助摘要自己的输出预算不替代主生成预算。
- [ ] 每次尝试独立创建文本、思考、工具和完成标记；重试不调用整个 submitMessage，不追加第二条用户输入，不重复触发回合钩子。
- [ ] 外部取消与恢复截止时间组合成每次请求信号。旧 iterator 必须停止消费并关闭，晚到事件丢弃；不要单用 Promise.race 留下仍写数据的请求。
- [ ] 将错误 StreamEvent 视为本次调用失败，不能只转发后继续执行工具；未抛错但缺失 complete 同样判为 stream_incomplete。
- [ ] `complete` 先缓存，确认本次流合法结束后仅发出一次。长度受限的 length/max_tokens 不进入网络重试：保留可用正文，按既有规则在无工具调用时追加一次截断提示，然后才发最终 complete。禁止 complete 之后再追加属于同一次生成的提示文本；持久 committed 提交必须覆盖正文、思考与提示。工具事件在确认成功后再向外提交，完整有效调用仍按现有工具规则处理，截断参数不得执行。按照“每次尝试的用量完整性”一节结算，替换原来的直接 addUsage/转发路径，避免累计快照重复计费。
- [ ] 扩展 integration.test.ts 和 request-configuration.test.ts：分别测试首次长度受限、一次网络失败后长度受限，断言实际请求数为 1/2、提示一次且位于最终 complete 前；所有重试的 maxTokens、reasoningEffort 和 messages 一致；重试中改配置不改变本次请求，下一正常回合采用新值。压缩预留用 compact-service-advanced.test.ts 做回归，不因新重试入口绕过 setOutputReserve。
- [ ] 修改 `cost-tracker.ts` 并扩展/新增 `cost-tracker.test.ts`：未知失败后成功已知 100/20 时，数字为已知的 100/20 且 usageIncomplete=true；连续成功不清除标记；reset 后恢复初值；一次尝试收到 10/2、15/3 两份累计快照只计 15/3。
- [ ] 重试耗尽时抛最后一次错误，并附安全的次数/预算结束原因；仅外层现有运行收尾逻辑发出最终失败，等待阶段不发 run.failed。
- [ ] 补充测试：先成功调用工具再断线，工具计数保持 1；始终断网不超过 6 次请求；恢复期间持续收到部分文字不重置预算；等待及读取中取消；401 不重试；变更配置和 steer 不改变本次重试输入。
- [ ] 主生成使用原始单次适配器；compact/memory 在任务 3A 接入独立缓冲重试，不能把主生成包进辅助重试器。任务 3 完成不代表可独立发布。
- [ ] 执行：

```powershell
pnpm --filter @vykor/core exec vitest run src/engine/model-retry.test.ts src/engine/model-retry.integration.test.ts src/engine/integration.test.ts
pnpm --filter @vykor/core exec vitest run src/engine/cost-tracker.test.ts
pnpm --filter @vykor/core exec vitest run src/engine/request-configuration.test.ts src/engine/compact-service-advanced.test.ts
pnpm --filter @vykor/core check-types
```

**验收：** 正常历史、工具执行次数、预算和取消均满足契约；不只检查“第二次成功”。
**建议提交：** `feat(core): retry interrupted model generations safely`。

## 任务 3A：保留压缩和记忆提取的重试能力

**新增：** `packages/core/src/engine/buffered-model-retry.ts`、`buffered-model-retry.test.ts`。
**修改：** `packages/core/src/index.ts`、`packages/core/src/engine/query-engine.ts` 的 toCompactClient、`packages/agent-runtime/src/memory-runtime.ts`、`packages/services/src/memory-extract.ts`；扩展各自既有测试。

**输入：** 原始单次 StreamingMessageClient、StreamMessageParams、独立重试策略。
**输出：** 仅包含最终成功尝试的事件流；失败内容不会拼进压缩摘要或记忆 JSON。

```ts
export async function* streamBufferedModelWithRetry(
  client: StreamingMessageClient,
  params: StreamMessageParams,
  options?: {
    policy?: Partial<ModelRetryPolicy>;
    onAttemptFinished?: (event: ModelAttemptFinishedEvent) => void | Promise<void>;
  },
): AsyncIterable<StreamEvent>;
```

- [ ] 先写测试：原始客户端首次抛 429/503，第二次成功，调用者只拿到成功文本；首次产生半截 JSON 后断线，最终 JSON 不含旧前缀；401 不重试；等待/读取取消不发后续请求。
- [ ] 使用任务 1 的策略和等待函数，但每次辅助操作创建自己的 counters/deadline/generationId，不共享主生成计数。不再保留适配器或 SDK 的隐藏重试。
- [ ] 每次尝试缓冲事件，确认 complete 后再交付；失败丢弃整个缓冲。辅助调用明确禁止 tools 非空，使用现有 maxTokens 限制输出，不能用于主流式回答或工具执行。
- [ ] 每次尝试通过 onAttemptFinished 报告用量结算，成功返回流只包含成功内容及 complete，不再输出重复 usage。主引擎压缩将回调接到同一 CostTracker/执行事件通路；后台记忆提取将其写入宿主日志，没有所属 Run 时不得伪造 Run 或把它计入其他任务。
- [ ] 成功交付后再解析记忆 JSON、写记忆；重试不覆盖 reload/save 等外部写操作。确保记忆写入计数为 1。
- [ ] 压缩现有“输入过长后裁剪重试”保留：输入过长不可被网络重试器当成临时错误；裁剪后的新输入创建独立网络预算，原有裁剪次数上限保持不变。
- [ ] 排查其他直接 streamMessage 调用者，按实际用途接到主生成或辅助路径，不允许只关闭 SDK 重试而遗漏原有用户。
- [ ] 执行：

```powershell
pnpm --filter @vykor/core exec vitest run src/engine/buffered-model-retry.test.ts src/engine/integration.test.ts
pnpm --filter @vykor/agent-runtime exec vitest run src/memory-runtime.test.ts
pnpm --filter @vykor/services exec vitest run src/__test__/memory-extract.test.ts
```

**验收：** 辅助路径仍能恢复 429/503/断流，摘要与记忆不拼接残缺文本，写入只发生一次，主生成实际请求次数未增加。
**建议提交：** `fix(runtime): retain bounded retries for compaction and memory`。

## 任务 4：运行事件和最终结果同步替换

**修改：** `packages/agent-runtime/src/framework-agent-run.ts`、`stream-event-mapping.test.ts`。
**新增：** `packages/agent-runtime/src/framework-agent-run-retry.test.ts`。

**输入：** generation_started、model_retry 和现有流事件。
**输出：** Agent 事件及不含被替代文本的 `AgentRunResult.output`。

- [ ] 增加映射测试：

```ts
expect(streamEventToAgentEvent({
  type: "generation_started", generationId: "g1", attempt: 2,
})).toEqual({
  type: "output.generation.started", data: { generationId: "g1", attempt: 2 },
});
```

- [ ] 在新 generation 的首次尝试保存当前 `output.length` 为截断点；同 generation 的第二次及后续尝试只截断至该点，不清空此前成功回合的输出。
- [ ] 等待重试映射成 model.retry.scheduled，不能通过错误事件提前结束 Run；既有 toolActivity 仅包含确认成功的工具事件。
- [ ] model_attempt_finished 映射为 model.attempt.finished，并仅在 usage 存在时派生一次 usage.updated。未知结算不制造零值 usage.updated；事件测试覆盖失败结算在 run.failed/interrupted 前到达以及重复累计快照只结算一次。
- [ ] 测试两个模型回合：第一回合文字和工具保留，第二回合失败文字被替换。同时检查 run.completed.data.output、RunResult.output、历史三者一致。
- [ ] 增加长度受限响应的跨层测试：截断提示先于 output.turn.completed；提示只出现一次，最终 RunResult.output、实时 transcript、重载后的历史均一致，不新建未 committed 的尾部提示 part。
- [ ] 测试取消只产生一个 run.interrupted，耗尽只产生一个 run.failed，迟到成功不会覆盖终态；对无法处理生成替换的自定义流消费者更新 SDK 文档。
- [ ] 执行：

```powershell
pnpm --filter @vykor/agent-runtime exec vitest run src/stream-event-mapping.test.ts src/framework-agent-run-retry.test.ts
pnpm --filter @vykor/agent-runtime check-types
```

**验收：** 不依赖界面掩盖错误；程序调用 Agent API 获得的最终结果也正确。
**建议提交：** `feat(runtime): project model retry boundaries into run results`。

## 任务 5：持久化重试状态和被替代输出

**修改：** `packages/protocol/src/session.ts`、`index.ts`；`packages/server/src/application/agent/daemon-agent-event-projector.ts`；`packages/server/src/application/session/transcript-projection.ts`；`packages/services/src/runs/run-repository.ts`、`conversations/incremental-output.ts`、`conversation-repository.ts`（只补缺少的原子写入能力）。
**测试：** 上述服务端投影对应 `__test__` 文件，以及 `packages/services/src/runs/run-repository.test.ts`、`conversations/incremental-output.test.ts`。

**输入：** 新 Agent 事件。
**输出：** Run metadata、消息 part metadata 和既有 session 更新事件。

- [ ] 在 protocol 增加安全读取函数，后续客户端统一调用：

```ts
export function readSessionModelRetryState(
  metadata: Record<string, unknown>,
): SessionModelRetryState | undefined;
export function isSupersededModelPart(part: SessionMessagePartRecord): boolean;
```

  校验 generationId、整数 attempt/retryNumber、最大次数、有限时间戳和 reason；未知/非法 metadata 返回 undefined，不让坏数据破坏页面。

- [ ] 在投影状态增加当前 generationId、attempt、当前尝试所有 part ID 集合。text/reasoning/tool part 均带 modelGeneration metadata；没有边界事件的旧测试/外部事件继续按原逻辑处理。
- [ ] 新格式 part 初始化 committed=false，仅本次完整响应确认后改为 true；最终失败/取消不将残缺输出改成 committed。任务 5A 据此区分可见的残缺文字和可作为模型历史的有效内容。
- [ ] 注册 session.model.attempt.finished 及对应校验测试，使用现有事件记录按 `(runId, generationId, attempt)` 去重。事务内保存结算记录并更新 run.metadata.modelUsage；modelRetry 清理不能清除 modelUsage。重复投影、刷新、store 重开后 unknownAttempts/partialAttempts 不增加。
- [ ] 新增/扩展 `packages/protocol/src/session.test.ts`，测试 SessionModelAttemptUsage 的解析：unknown 不允许伪造 usage，partial/complete 必须有合法数字；旧记录无完整性数据时不推断为完整。
- [ ] model.retry.scheduled 合并写 `run.metadata.modelRetry` 并发布 `session.run.updated`，run.status 保持 running。
- [ ] 同一 generation 新尝试开始时，先 flush 旧 part 缓冲 delta，再在现有事务能力内标记旧 part 被替代、清除活动引用和重试 metadata，最后发布更新。重复应用同事件必须无副作用。
- [ ] 文本与思考交替时，上一尝试中已经关闭的 part 同样标记；不得改动上一个成功 generation 的 part 和工具结果。
- [ ] complete/failed/interrupted 清除 modelRetry；终态后忽略迟到重试事件。投影写入失败沿既有错误处理，不把数据库错误归为模型网络错误。
- [ ] 修改 `run-stall-watchdog.ts` 和 `session-run-executor.ts`，增加可选 `readModelRetryDeadline?(): number | undefined`，接线到安全解析后的 Run metadata。检测时仅当 `now < min(nextRetryAt, recoveryDeadlineAt)` 跳过停滞判断；不得无限刷新 lastActivityAt，截止后恢复原检测。新请求启动仍按原检测与模型请求超时共同约束。
- [ ] 在 `src/application/session/__test__/run-stall-watchdog.test.ts` 和 `session-run-executor.test.ts` 验证：较长的合法 Retry-After 等待不会提前被杀；过期或畸形 metadata 不能绕过检测；取消不受等待保护影响。
- [ ] 写入“旧 delta 尚未刷盘 → 新尝试开始 → 再 flush”的回归测试，确保旧文字不能复活；关闭并重开 store，检查被替代标记和等待状态仍可读取。
- [ ] 重试诊断记录复用现有 appendRuntimeEvent 路径；若新增具体事件类型，同步修改 `packages/services/src/session-runtime/event-registry.ts` 及其测试，记录 generationId/attempt/错误类别/等待时间/已知用量，不写完整 cause 对象。
- [ ] 执行：

```powershell
pnpm --filter @vykor/server exec vitest run src/application/agent/__test__/daemon-agent-event-projector.test.ts src/application/session/__test__/transcript-projection.test.ts
pnpm --filter @vykor/server exec vitest run src/application/session/__test__/run-stall-watchdog.test.ts src/application/session/__test__/session-run-executor.test.ts
pnpm --filter @vykor/services exec vitest run src/runs/run-repository.test.ts src/conversations/incremental-output.test.ts src/session-runtime/__test__/event-registry.test.ts
pnpm --filter @vykor/protocol check-types
pnpm --filter @vykor/server check-types
```

**验收：** 不依赖页面内存；不新增表；RunAttempt 含义未被改变；持久与实时结果一致。
**建议提交：** `feat(server): persist retry status and superseded generation output`。

## 任务 5A：过滤重建历史和公开文本中的失败尝试

**修改：** `packages/protocol/src/session.ts`、`index.ts`；`packages/server/src/application/agent/agent-transcript.ts`；`packages/server/src/session/transcript-text.ts`；按实际过滤结果调整 `export-session.ts`、`rewind.ts`。
**测试：** `packages/server/src/application/agent/__test__/agent-transcript.test.ts`；新增 `packages/server/src/session/__test__/transcript-text.test.ts`；扩展现有 `export-session.test.ts`、`rewind.test.ts`。

**输入：** 持久 part 的 superseded/committed 标记。
**输出：** 与实时引擎有效历史一致的模型输入；不含被替代文字的普通公开文本。

```ts
// 位于 protocol，供服务端和客户端共享判定；旧格式保持原语义。
export function isCommittedModelPart(part: SessionMessagePartRecord): boolean;
// 无 modelGeneration 的旧格式返回 true；新格式必须 committed=true 且未 superseded。
```

- [ ] 先写测试：同一消息包含 attempt 1 的失败文字/思考和 attempt 2 的成功文字/思考，buildAgentTranscript 只返回第二次内容；全失效 assistant 消息被省略；上一生成的成功工具与结果仍成对保留。
- [ ] 在 buildAgentTranscript 建立 byMessage 前统一过滤，而非只修改 textFromParts；覆盖 reasoningReplay、reasoningSegments、toolUses 和 tool_result。新格式未 committed 的最终失败尝试也不得进入模型历史，旧格式记录不被误删。
- [ ] publicTextFromParts/isPublicTextPart 排除 superseded part，普通导出及 rewind 预览不混入旧回答；公开摘要/记忆用途必须额外要求 committed。诊断导出仍允许显式读取原始 part，不能物理删除排障证据。
- [ ] 检查 `rg -n 'publicTextFromParts|buildAgentTranscript|isPublicTextPart' packages/server/src` 的全部消费者，分别验证公开展示与模型输入的区别，不能将“允许展示残缺回答”等同于“允许送回模型”。
- [ ] 在端到端任务新增持久化重试结果 → 释放并重新加载 Agent → 下一次提问，直接断言 mock 模型收到的 messages 不包含失效文本/思考，工具调用与结果配对不变。此测试是会话历史恢复，不是进程重启后继续未完成请求。
- [ ] 执行：

```powershell
pnpm --filter @vykor/server exec vitest run src/application/agent/__test__/agent-transcript.test.ts src/session/__test__/transcript-text.test.ts src/session/__test__/export-session.test.ts src/session/__test__/rewind.test.ts
```

**验收：** 界面、重载后的模型历史、公开回复不会恢复被替代内容；残缺回答可供用户查看但不会冒充完成历史；原始排障数据仍在。
**建议提交：** `fix(server): exclude failed generations from rebuilt history`。

## 任务 6：客户端恢复、去重和协议一致性

**修改：** `packages/client/src/state/reducer.ts`、`selectors.ts`、`state/index.ts` 和公开导出；`packages/protocol/src/capabilities.ts`、`capabilities.test.ts`。
**测试：** `packages/client/src/state/__test__/reducer.test.ts`、`sync.test.ts`；新增 `selectors.test.ts`。

**输入：** Run/part 更新、完整 snapshot、事件重放。
**输出：** 安全的重试状态和可展示消息，不重复应用旧 delta。

- [ ] 默认展示 selector 过滤 superseded part，并省略没有可见 part 的旧 assistant 空消息；保留原始 state 给排障使用，不删除原始记录。
- [ ] 在 reducer 中拒绝向已 superseded part 追加迟到 delta，保留既有事件序号去重。对当前 part 不误拦正常新事件。
- [ ] 对三条路径做同结果断言：直接实时消费；重试期间 snapshot 后接后续事件；重连重复回放旧事件。
- [ ] 测试 run.metadata 中其他字段未被清除；终态快照不能显示等待重试。
- [ ] modelUsage 在事件回放与 snapshot 中一致保留；客户端不根据重复结算事件自行累加未知计数，以服务端 Run metadata 为准。modelRetry 消失后仍可展示不完整用量说明。
- [ ] 因旧客户端不理解输出失效标记，协议版本从实施时当前版本增加 1（本计划核对时为 4，预计改为 5），同步更新握手测试和协议文档。不为旧客户端静默降级成重复输出。
- [ ] 执行：

```powershell
pnpm --filter @vykor/client exec vitest run src/state/__test__/reducer.test.ts src/state/__test__/sync.test.ts src/state/__test__/selectors.test.ts
pnpm --filter @vykor/protocol exec vitest run src/capabilities.test.ts
pnpm check:client-api
```

**验收：** 刷新、断线重连、重复事件不造成旧文字复活；不修改现有客户端重连算法。
**建议提交：** `feat(client): restore retry state and filter superseded output`。

## 任务 7：Desktop、TUI 和 CLI 展示

**Desktop 修改：** `apps/desktop/src/renderer/src/components/desktop/conversation-page/transcript/transcript.tsx`；新增同级 `../message/model-retry-notice.tsx` 及 `../message/__test__/model-retry-notice.test.tsx`。
**TUI 修改：** `apps/frontend/src/routes/session/Session.tsx`、`parts.tsx`、`apps/frontend/src/hooks/transcript.ts`、`sessionController.ts`；在现有状态传递链路中接入 retry 状态，对应现有测试。`Session` 当前只接收 items/assistantBuffer，新增可选 retry 属性并同步更新其调用方。
**CLI 修改：** `apps/cli/src/print-session.ts`、`renderer.ts`；`print-session.test.ts`、`print-session.integration.test.ts`、`renderer.test.ts`。

**Desktop 合并链路验收：** `apps/desktop/src/main/features/session/session-subscription-service.coalescing.test.ts`、`session-update-coalescer.test.ts`；必要时补充 `apps/desktop/src/renderer/src/stores/desktop-session/store.integration.test.ts`。生产接线复用 `session-subscription-service.ts` 和现有 coalescer，不新建逐事件 IPC。

**输入：** protocol 的安全读取函数及客户端选出的可见 part。
**输出：** 可见、可取消、不会误导用户的重试过程。

- [ ] 在现有任务状态区域展示以下文案，按 nextRetryAt 计算倒计时，最低为 0：

```text
连接中断，2 秒后重试（第 2/5 次）
正在重新连接（第 2/5 次）
```

  Desktop 状态区域使用 `role="status"`，避免每秒播报整个倒计时；TUI 使用原生 text/box 展示，不使用 DOM 属性。停止按钮或终端快捷键复用已有 Run 中断动作，不创建新的停止 API。

- [ ] 新尝试开始时隐藏等待提示；若需要显示“重新连接”，从当前生成事件/状态推导，不能保留已过期等待字段。成功与终态均清理计时器。
- [ ] Desktop 当前通过 parts 构造 transcript，必须确认路径实际调用 superseded 过滤；不能只改 client selector 就假定 Desktop 已接入。TUI 同样检查 `hooks/transcript.ts`，隐藏空消息壳，刷新后从 session bucket 恢复 retry 状态。
- [ ] 渲染测试传入等待中的 Run、恢复后的 Run、终态 Run；验证倒计时、停止动作、失败尝试隐藏及先前成功工具仍可见。
- [ ] 用 fake timers 在一个合并窗口内依次推送旧 part 失效、新尝试和成功状态，只交付最后一个 DesktopSessionView，断言被替代内容不可见、等待提示清除、用量不完整标记保留。测试组件不能依赖接收每个 generation_started/model_retry 中间事件。
- [ ] 再覆盖合并窗口内重连、取消和切换订阅：沿用现有立即发送 reconnecting、清理 pending timer 的语义，迟到窗口不得覆盖新会话；保留最新约 50ms 固定窗口合并，不绕过它恢复逐 token 全量发送。无需保证瞬间完成的重试状态每一帧都可见，保证最终状态与可恢复信息正确。
- [ ] 将既有用量展示接入 usageIncomplete/run.metadata.modelUsage，增加“已知用量：…；部分请求用量未知”文案及测试；CLI JSON 输出保留 incomplete 标记，不能只输出没有说明的成功请求 token 数。
- [ ] CLI 普通终端输出不可撤回：允许保留已经打印的文字，但在重试开始时明确打印“上一段输出中断，以下为重新生成”，重试提示写 stderr。不得声称终端历史文本已被清除。
- [ ] CLI 最终 JSON/text 汇总从有效持久消息构造，不能用已打印字符累计；流式机器输出必须带可识别的 generation/attempt 与替换事件，保证消费者能区分失效文本。更新输出格式说明和测试。
- [ ] 执行：

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/message/__test__/model-retry-notice.test.tsx
pnpm --filter @vykor/desktop exec vitest run src/main/features/session/session-subscription-service.coalescing.test.ts src/main/features/session/session-update-coalescer.test.ts src/renderer/src/stores/desktop-session/store.integration.test.ts
pnpm --filter @vykor/cli exec vitest run src/print-session.test.ts src/print-session.integration.test.ts src/renderer.test.ts
pnpm --dir apps/frontend exec bun test src/hooks/transcript.test.ts src/routes/session/Session.test.tsx
pnpm --filter @vykor/frontend check-types
pnpm --filter @vykor/desktop typecheck
```

  执行前确认本地 Bun 可用；若 Bun 缺失，报告 TUI 测试未运行，不以 Vitest 替代框架或声称通过。上述包名及 Desktop typecheck 命令已按当前 package.json 核对。

**验收：** 三种入口都不将重试阶段显示为已失败；Desktop/TUI 最终无重复；CLI 的不可撤回限制被明确呈现。
**建议提交：** `feat(ui): show cancellable model retry progress across clients`。

## 任务 8：端到端验收与交付

**新增：** `packages/server/src/application/__test__/model-retry-flow.test.ts`。
**修改：** `docs/model-network-retry-design.md`、`docs/contract-test-index.md`、`docs/protocol-contract.md`、本计划；CLI 输出说明放入 `docs/cli-experience-design.md`。

- [ ] 使用本地 mock 服务或注入式客户端，构造“半段回答 → 断流 → 下一请求成功”；通过真实运行、投影、持久记录和客户端 reducer，验证最终只保留成功回答，不请求真实模型。
- [ ] 端到端至少覆盖以下矩阵；每个用例对实际请求次数、最终状态、输出和工具计数作断言：

| 用例 | 请求/状态预期 | 数据预期 |
|---|---|---|
| 连接建立前失败一次 | 2 次请求，completed | 一份最终回答 |
| 文本、思考交替后断流 | 2 次请求，completed | 第一尝试所有 part 被替代 |
| 正常 EOF 但无完成事件 | 有界重试，不能假成功 | 不执行工具 |
| 已完成工具后下一次模型请求失败 | 只重试后一次调用 | 工具执行计数为 1 |
| 半截工具参数或非法 JSON | 按错误分类结束/重试 | 不以空参数执行 |
| request/stream 故障交替 | 各类及总预算均有效 | 最多 6 次实际请求 |
| Retry-After 超过剩余窗口 | 不发下一请求 | 明确预算耗尽 |
| 恢复中持续小段输出 | 到恢复截止时间停止 | 不无限延长运行 |
| 401、额度耗尽、参数错误 | 1 次请求 | 对应可操作错误说明 |
| 等待中/读取中取消 | interrupted | 不发后续请求，无迟到复活 |
| 重试期间刷新和重放 | 不改变服务端请求数 | 重试状态恢复、文字不重复 |
| 重试完成后释放并重载 Agent，再次提问 | 只发新提问对应请求 | 请求 messages 无旧文字/思考，工具结果仍配对 |
| 压缩或记忆提取先 429/503 再成功 | 各自独立预算，不放大主生成次数 | 摘要/JSON 无重复，记忆只写一次 |
| 投影失败 | 按现有投影失败流程结束 | 不额外重试模型 |
| Retry-After 长于卡住检测阈值 | 截止时间内不误杀，到期后恢复检测 | 保留取消能力 |
| 未知用量失败后已知用量成功 | 每次尝试只结算一次 | 成功已知小计保留，incomplete=true，unknownAttempts=1 |
| 同一尝试多份累计 usage、结算事件重放 | 不重复累加 | 最新快照只计一次，重开 store 后完整性不变 |
| 首次或重试后 length/max_tokens | 分别 1/2 次请求，不为长度上限再重试 | 正文、提示、complete 顺序正确，提示 committed 且重载一致 |
| 重试中改变输出上限或 effort | 当前生成请求参数不变 | 下一正常回合应用新值，压缩预留仍正确 |
| Desktop 一窗口内失效、重试、完成 | 只发送最新完整快照仍正确 | 无旧文字、残留等待提示或用量完整性丢失 |

- [ ] 定向运行端到端和运行状态测试：

```powershell
pnpm --filter @vykor/server exec vitest run src/application/__test__/model-retry-flow.test.ts src/application/__test__/durable-agent-application.test.ts
pnpm --filter @vykor/api --filter @vykor/core --filter @vykor/agent-runtime --filter @vykor/protocol --filter @vykor/services --filter @vykor/server --filter @vykor/client check-types
pnpm check-docs
git diff --check
```

- [ ] 若新增事件或 metadata 影响协议/架构门禁，再运行 `pnpm check:architecture`；不要为修改一处文案重复跑全仓测试。已有基线失败单独列出。
- [ ] 在 Desktop/TUI 用 mock 断流进行一次人工观察：提示可见、停止立即生效、旧文字被替换、重新连接仍正确。只跑单元测试不能替代此项展示验收。
- [ ] 更新设计文档状态、最终默认值、超时/心跳限制、compact/memory 范围、CLI 限制及错误排查字段。只有全部验收通过才把“尚未实现”改为“当前实现”。
- [ ] 单独验收本轮审核的三项：服务端重建历史过滤、辅助调用重试未退化、未知用量可持久化并展示；仅客户端测试通过不足以关闭这些问题。
- [ ] 交付说明列出实际通过的命令、未运行的项目及原因、协议版本变化，不把计划中的测试写成已通过。

**完成标准：** 上述矩阵均有测试或明确验证记录；所有生产消费者理解尝试替换；未动用户无关修改；代码、文档和发布版本一致。
**建议提交：** `test: verify model retry recovery end to end`。

## 回滚与限制

- 若需要暂时关闭新行为，通过宿主注入 `modelRetry: { maxTotalRetries: 0 }`，仍保留完整结束校验和错误报告；本期不额外增加公开设置入口。
- 回退整个版本时，客户端与服务端一同回退。由于保留了带失效标记的历史 part，旧客户端可能显示旧内容，因此不得直接用旧客户端读取新格式数据并声称兼容；回退前按协议和备份规则验证。
- 不删除被替代输出，不清空用户会话来实现回滚。
- 没有网络请求幂等或服务端续传保证：重发模型请求可能产生额外模型费用，但不得重复执行本地工具。
- 本计划采用恢复窗口上限优先策略，恢复中的长回答可能在 180 秒到期时中止；首版文档必须说明这一取舍，后续调整只改明确策略和相关测试。

## 计划自检记录

- [x] 请求错误、流中断、空闲超时、取消、Retry-After 和预算均有任务及验收用例。
- [x] 主引擎历史、Framework 最终 output、持久 part、客户端快照四处均有处理失效尝试的任务。
- [x] 计划要求工具仅在完整响应后执行，网络重试不重复权限或既有工具。
- [x] 已安排重试状态恢复、终态清理、迟到事件和卡住检测测试。
- [x] 新增函数、事件、字段均在计划中定义；示例是接口/测试锚点，不宣称完整实现。
- [x] 实施命令按包和文件限定；任务 2～7 统一发布；实现完成前不标记文档为已落地。
- [x] 审核发现的服务端历史遗漏、辅助调用保护退化、用量完整性缺失均已分配接口、文件、任务及验收用例。
- [x] 二次审核的截断提示顺序、输出上限冻结和 Desktop 合并快照兼容均已纳入任务与回归命令。

以上勾选仅表示文档覆盖自检完成，不表示功能、测试或任务已实施。

## 实施进度记录（2026-09-26）

接手补完后的测试与整体审核见[补完与审核记录](./2026-09-26-model-network-retry-verification.md)。以下为首次交接时的历史进度，最新状态以该记录及后续“接手收尾”一节为准。

本节记录实际执行结果，不替代上面的任务勾选。只有对应定向测试与类型检查通过的项目才标为已完成。

- **任务 0**：已执行。基线 `@vykor/api` 48 测试、`@vykor/core` integration 64 测试通过；协议版本实施时为 4。
- **任务 1**：已完成。新增 `packages/core/src/engine/model-retry.ts` 与 `model-retry.test.ts`（16 测试）；`types/events.ts`、`types/client.ts`、`types/runtime.ts`、`types/usage.ts`、`cost-tracker.ts`、`index.ts` 已更新；`pnpm --filter @vykor/core check-types` 通过。
- **任务 2**：已完成。`errors/index.ts` 增加 `toModelRequestFailure`/`parseRetryAfterMs`；三个适配器改为单次请求（SDK `maxRetries: 0`）、完整结束校验、超时生命周期；`errors/index.test.ts`、`retry.test.ts`、三个 provider 测试全部通过（70 测试）；`@vykor/api` 全量 150 测试通过。
- **任务 3**：已完成。`query-engine.ts` 在单次模型调用边界重试；新增 `model-retry.integration.test.ts`（12 测试）与 `cost-tracker.test.ts`（4 测试）；`integration.test.ts` 仅更新取消信号断言；`@vykor/core` 全量 290 测试通过。
- **任务 3A**：已完成。新增 `buffered-model-retry.ts` 与测试（6 测试）；`toCompactClient`、`memory-runtime.ts`、`memory-extract.ts` 接入独立缓冲重试；三处定向测试通过。
- **任务 4**：已完成。`framework-agent-run.ts` 增加事件映射与输出截断替换；`stream-event-mapping.test.ts` 扩展、新增 `framework-agent-run-retry.test.ts`（3 测试）；`@vykor/agent-runtime check-types` 通过。
- **任务 5**：已完成核心部分。`protocol/src/session.ts` 增加安全读取函数与 `session.model.attempt.finished` 注册；`transcript-projection.ts` 跟踪 generation part、被替代标记与 committed；`daemon-agent-event-projector.ts` 写入 `run.metadata.modelRetry`/`modelUsage` 并按 `(runId, generationId, attempt)` 去重；`run-stall-watchdog`/`session-run-executor` 接入重试截止时间。定向测试通过。
- **任务 5A**：已完成。`transcript-text.ts` 排除被替代 part、提供 committed 判定；`buildAgentTranscript` 在建立 byMessage 前统一过滤；新增 `transcript-text.test.ts`、扩展 `agent-transcript.test.ts`。
- **任务 6**：已完成。协议版本 4 → 5，相关握手/中间件/服务端测试同步更新；`selectors.ts`/`reducer.ts` 过滤被替代输出、拒绝迟到 delta；新增 `selectors.test.ts`、扩展 `reducer.test.ts`；`@vykor/client check-types` 通过。
- **任务 7**：部分完成。Desktop 新增 `model-retry-notice.tsx` 及测试并在 `transcript.tsx` 接线（3 测试通过，`@vykor/desktop typecheck` 通过）。CLI 与 TUI 的展示、以及合并快照/用量文案验收未完成。
- **任务 8**：未完成。端到端矩阵、文档最终状态、人工观察尚未执行。

首次交接的统一发布边界：当时任务 7、8 未完成，任务 2～7 尚不可作为一组发布。

## 接手收尾与整体审核（2026-09-26）

- 任务 7：CLI、TUI、Desktop 接线完成。普通 CLI 重试及用量提示写 stderr；JSON 最终正文排除失败尝试，stream-json 提供失效标记。TUI 和 Desktop 显示倒计时及用量不完整说明，Desktop 合并窗口测试覆盖只交付最终快照。
- 任务 8 自动验收：新增 model-retry-flow.test.ts，真实引擎/运行事件/SQLite/客户端链路共 8 项测试通过，包含在途取消、等待取消、重载后再请求、工具只执行一次、截断提示提交和投影失败隔离。其余预算、错误分类和辅助调用场景由对应定向测试覆盖。
- 整体审核：独立审核发现 5 项问题并全部修复，复审中发现的自动压缩执行上下文残留也已清理，新增同引擎手动压缩回归通过。结算事件成为持久用量唯一更新来源，usage.updated 只作观察通知，避免分离事务及重复计费。
- 门禁：严格协议版本验证同步为 5；事务入口复用后旧式存储调用数保持 123，不提高架构基线。公开 API、类型检查、文档及补丁格式检查记录于[验证报告](./2026-09-26-model-network-retry-verification.md)。
- 未执行：真实计费模型调用、完整全仓测试、宿主 Desktop/TUI 窗口人工点击观察。自动组件与真实 CLI daemon 测试不等同于人工观感验收；未将这项手工检查标为完成。
- 工作区原位保留所有改动，未提交、推送、合并或发布。上线仍需前后端按协议 5 一起更新。
