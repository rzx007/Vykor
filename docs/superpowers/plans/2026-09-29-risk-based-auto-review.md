# 按风险自动触发只读评审实现计划

> 2026-09-30 审核修订：结果交付以[子代理结果交付边界规范](../specs/2026-09-30-child-result-delivery-boundary-design.md)为准。父 Task 可以承载最终评审报告；“只含摘要”限定于父 Run 的评审状态与默认观测数据，不再要求新增通用投影器或推迟 Task 结算。

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在一次成功的 Root Agent Run 结束后，对本次 Run 可归因的代码改动做确定性风险分类；中高风险改动自动启动有界、严格只读的 `review` 子代理，并把跳过、通过、发现问题、部分覆盖、失败或超时作为持久状态记录，绝不把评审异常伪报为通过。

**架构：** Server 在 Root Run 开始前保存轻量 Git 基线，Run 完成后通过前后复读生成稳定、可归因的 change set，并交给纯函数风险策略。低风险直接记录 `skipped`；中高风险通过受控的 post-run Child API 启动内置 patch-only reviewer（无工具），等待有界结构化结果并原子写回父 Run metadata 与 durable event。首版默认关闭，通过 `settings.autoReview.mode = "risk_based"` 显式启用；不自动修复、不执行测试、不修改父 Run 的业务终态。

**技术栈：** TypeScript、Vitest、现有 Vykor Agent Child Manager、SessionStore、Git CLI（`execFile` 参数数组）、Execution Observability、Hono/CLI 现有调试入口。

---

## 范围与硬边界

- 只自动评审 Root Session Run；框架 Child Run 不递归触发自动评审。
- 自动评审必须从 `getBuiltinAgentDefinitions()` 取得并校验 `source === "builtin"` 的 `review` 定义，不使用可被用户或插件覆盖的合并定义。
- 首版 reviewer 是 patch-only：实际启动时 `allowedTools: []` 且禁用所有工具，只依据 change-set patch 和固定规则评审。这样恶意 diff 无法诱导 Child 读取 `.env`、绝对路径或 change set 外文件。
- 自动评审是独立质量状态，不把已经完成的父 Run 改成 failed，也不自动开启修复 Run。
- 只有严格解析出的 `pass` 才能记为 passed。输出无法解析、Child 失败、超时、部分覆盖、daemon 重启或改动无法安全归因时分别记录真实状态。
- 不审查整个脏工作区。只能评审能够证明属于当前 Run 的 commit range 或新增 dirty path；与 Run 前已有脏文件重叠时记为 unavailable。
- post-run Child 使用“公开 spawn 摘要 + 敏感初始内容”双通道：`child.created` 和父 Task 的创建信息只持久化任务摘要；真实 patch 作为初始输入进入 Child Session，不由框架额外复制到父 Run metadata、父 Task、framework child.created event、durable review event 或 Execution Observation。父 Task 的最终输出可以承载 reviewer 提交的报告，子代理工作记录与最终报告分开。模型可能在报告中引用代码，这不是内容脱敏保证。授权诊断入口允许查看 Child input，默认导出遵守现有敏感输入规则。
- patch 超过 512 KiB 或被截断时风险至少为 high，最终 verdict 最高只能是 partial。
- 首版不做 Desktop 设置 UI；通过现有 `config set autoReview.mode risk_based` 启用。
- 不引入第二套 Agent、Job 或 Workflow 生命周期；Child Task、JobRead、JobWait、partialResult 和 failureKind 全部复用现有实现。

## 状态模型

在 `@vykor/protocol` 定义以下稳定结构并提供安全 parser：

```ts
export type AutoReviewMode = "off" | "risk_based";
export type AutoReviewRiskLevel = "none" | "low" | "medium" | "high" | "unknown";
export type AutoReviewStatus =
  | "disabled"
  | "captured"
  | "skipped"
  | "pending"
  | "passed"
  | "findings"
  | "partial"
  | "failed"
  | "timed_out"
  | "unavailable";

export interface AutoReviewRunMetadata {
  version: 1;
  policyVersion: "risk-v1";
  mode: AutoReviewMode;
  riskLevel: AutoReviewRiskLevel;
  status: AutoReviewStatus;
  reasons: string[];
  reviewTaskId?: string;
  verdict?: "pass" | "fail" | "partial";
  findingCount?: number;
  highestSeverity?: "critical" | "important" | "minor";
  patchTruncated?: boolean;
  startedAt?: number;
  finishedAt?: number;
}
```

允许的稳定 reason code：

```ts
export type AutoReviewReason =
  | "mode_off"
  | "no_changes"
  | "low_risk_change"
  | "source_change"
  | "large_change"
  | "many_files"
  | "sensitive_path"
  | "production_delete_or_rename"
  | "patch_truncated"
  | "not_git_repository"
  | "preexisting_dirty_overlap"
  | "non_linear_head_change"
  | "post_commit_worktree_changed"
  | "git_inspection_failed"
  | "review_output_invalid"
  | "review_child_failed"
  | "review_child_timed_out"
  | "parent_run_not_completed"
  | "daemon_restarted";
```

## 固定风险策略 `risk-v1`

按以下顺序分类，命中高风险后不再降级：

1. 无改动：`none`，不触发评审。
2. attribution/patch 不完整：`unknown` 或 `high`，状态 unavailable 或触发后最多 partial。
3. 高风险：任一敏感路径；生产文件删除/重命名；文件数 ≥ 8；总增删行 ≥ 600；patch 被截断。
4. 低风险：全部是 `docs/**`、`**/*.md`、`**/*.test.*`、`**/__test__/**`、`**/fixtures/**`，文件数 ≤ 5、总增删行 ≤ 300，且没有删除/重命名。
5. 其余包含生产源码的改动：medium。

敏感路径固定为：

```text
**/auth/**
**/permissions/**
**/sandbox/**
**/security/**
**/migrations/**
**/database/**
**/agent-runtime/**
**/core/src/engine/**
.github/workflows/**
Dockerfile*
docker-compose*.yml
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
```

预算固定而不开放阈值配置：

| 风险 | 是否评审 | requestedMaxTurns | requestedTimeoutSeconds |
| --- | --- | ---: | ---: |
| none / low | 否 | — | — |
| medium | 是 | 10 | 120 |
| high | 是 | 20 | 240 |
| unknown attribution | 否，记 unavailable | — | — |

## 改动归因规则

### Run 开始前

记录：仓库根、HEAD、`git status --porcelain=v1 -z --untracked-files=all` 中每个脏路径的状态和 working-tree blob hash。只把该基线的摘要写入 Run metadata；不写文件正文或 diff。

### Run 完成后

- HEAD 改变：仅当旧 HEAD 是新 HEAD 的祖先，且 Run 后 working tree 与基线脏状态相同，才评审 `oldHead..newHead`。否则 unavailable。
- HEAD 未改变：比较前后 status/hash，只允许本次新增的 dirty path。任一 Run 前已脏路径内容或状态发生变化，记 `preexisting_dirty_overlap`，不审查混合 diff。
- tracked path 使用 `git diff --binary HEAD -- <paths>`；untracked path 使用 `git diff --no-index -- /dev/null <path>`，所有命令用 `execFile` 参数数组。
- patch 与 numstat/name-status 都按规范化 `/` 路径排序；512 KiB 后停止追加，设置 `patchTruncated=true`。
- 非 Git 工作区、Git 命令失败、非线性 HEAD 变化均记 unavailable，不回退到“审查整个工作区”。

## 任务依赖

任务按 1 → 8 顺序执行，每项独立提交。共享文件只允许串行修改。

| 任务 | 交付物 | 依赖 |
| --- | --- | --- |
| 1 | 协议、设置与纯风险策略 | 无 |
| 2 | 安全 Git 基线和 Run change set | 任务 1 |
| 3 | Reviewer prompt 与严格结果 parser | 任务 1 |
| 4 | Root Agent 的 post-run Child 启动入口 | 任务 1、现有生命周期 |
| 5 | 持久 AutoReview Service | 任务 2、3、4 |
| 6 | Executor、daemon 与重启收束 | 任务 5 |
| 7 | 观测数据与 CLI 过滤 | 任务 1、5 |
| 8 | 集成验收与操作文档 | 任务 6、7 |

---

### 任务 1：定义协议、设置开关和风险分类纯函数

**文件：**

- 创建：`packages/protocol/src/auto-review.ts`
- 创建：`packages/protocol/src/auto-review.test.ts`
- 修改：`packages/protocol/src/index.ts`
- 修改：`packages/core/src/types/settings.ts`
- 修改：`packages/core/src/config/settings.ts`
- 修改：`packages/core/src/config/settings.test.ts`
- 修改：`apps/cli/src/config-coerce.ts`
- 修改：`apps/cli/src/index.test.ts`
- 创建：`packages/server/src/application/auto-review/auto-review-policy.ts`
- 创建：`packages/server/src/application/auto-review/auto-review-policy.test.ts`
- 创建：`packages/server/src/application/auto-review/index.ts`
- 修改：`packages/server/src/application/index.ts`

- [ ] **步骤 1：写协议和设置失败测试**

协议测试覆盖合法 round-trip、未知 status/reason、过长 reasons、负 findingCount。设置测试覆盖：

```ts
expect(load({ autoReview: { mode: "risk_based" } }).autoReview).toEqual({ mode: "risk_based" });
expect(() => load({ autoReview: { mode: "always" } })).toThrow("settings.autoReview.mode");
```

- [ ] **步骤 2：运行 RED**

```powershell
pnpm --filter @vykor/protocol exec vitest run src/auto-review.test.ts
pnpm --filter @vykor/core exec vitest run src/config/settings.test.ts
```

预期：新类型、parser 和设置字段不存在。

- [ ] **步骤 3：实现协议与设置**

实现 `readAutoReviewRunMetadata(value)`：只接受 version 1、固定 policyVersion、枚举值；reasons 最多 16 个，每个 1–128 字符；findingCount 为非负安全整数；时间为非负有限整数。非法 metadata 返回 `undefined`，不抛错。

设置只新增：

```ts
export interface AutoReviewSettings { mode: "off" | "risk_based"; }
// Settings.autoReview?: AutoReviewSettings
```

`DEFAULT_SETTINGS` 必须显式包含 `autoReview: { mode: "off" }`，否则现有 `config set` 会把顶层键判为 Unknown。同步更新 TOP_LEVEL、nested enum 校验和 CLI config coercion；用真实 `vykor config set autoReview.mode risk_based` 路由测试证明命令可写入。

- [ ] **步骤 4：写风险策略失败测试**

```ts
expect(classifyAutoReviewRisk(changeSet([]))).toMatchObject({ level: "none", shouldReview: false });
expect(classifyAutoReviewRisk(changeSet([{ path: "docs/a.md", status: "modified", lines: 20 }])))
  .toMatchObject({ level: "low", shouldReview: false });
expect(classifyAutoReviewRisk(changeSet([{ path: "packages/server/src/a.ts", status: "modified", lines: 20 }])))
  .toMatchObject({ level: "medium", shouldReview: true, requestedMaxTurns: 10 });
expect(classifyAutoReviewRisk(changeSet([{ path: "packages/auth/src/token.ts", status: "modified", lines: 5 }])))
  .toMatchObject({ level: "high", shouldReview: true, requestedMaxTurns: 20 });
```

`AutoReviewChangeFile` 必须显式包含 `path`、可选 `oldPath`、status 和行数。生产文件定义为“不属于 low-risk docs/tests/fixtures 集合的文件”。另测 8 文件、600 行、生产删除/重命名、patchTruncated、attribution incomplete、仓库根路径、Windows `\`、大小写、rename 新旧两侧敏感路径。

- [ ] **步骤 5：实现固定 `risk-v1` 并验证**

导出 `AutoReviewChangeSet`、`AutoReviewRiskDecision` 与 `classifyAutoReviewRisk()`。路径统一 `/`，匹配大小写按 Git 路径原义；只返回固定 reason code。

```powershell
pnpm --filter @vykor/server exec vitest run src/application/auto-review/auto-review-policy.test.ts
pnpm --filter @vykor/protocol run check-types
pnpm --filter @vykor/core run check-types
pnpm --filter @vykor/server run check-types
```

- [ ] **步骤 6：提交**

```powershell
git add packages/protocol/src/auto-review.ts packages/protocol/src/auto-review.test.ts packages/protocol/src/index.ts packages/core/src/types/settings.ts packages/core/src/config/settings.ts packages/core/src/config/settings.test.ts apps/cli/src/config-coerce.ts apps/cli/src/index.test.ts packages/server/src/application/auto-review
git commit -m "feat(review): define risk-based auto review policy"
```

---

### 任务 2：实现可归因的 Git 基线与 change set

**文件：**

- 创建：`packages/server/src/application/auto-review/git-run-change-inspector.ts`
- 创建：`packages/server/src/application/auto-review/git-run-change-inspector.test.ts`
- 修改：`packages/server/src/application/auto-review/index.ts`

- [ ] **步骤 1：用注入式 Git executor 写失败测试**

定义 fake executor 依次返回 rev-parse、status、hash、diff。覆盖：clean baseline 新增 tracked/untracked 文件；dirty baseline 新增不重叠文件；同一 dirty 文件被 Run 再改；线性 HEAD commit；非线性 HEAD；commit 后还有额外 dirty；非 Git；512 KiB 截断；rename 双路径/delete；带空格路径；symlink/submodule；非 UTF-8 或控制字符路径；capture/compare/patch 生成过程中 HEAD 或文件发生变化。

关键断言：

```ts
expect(delta).toMatchObject({
  attribution: "complete",
  baseHead: "a",
  head: "b",
  files: [{ path: "packages/x.ts", status: "modified" }],
  patchTruncated: false,
});
expect(overlap).toEqual({ attribution: "unavailable", reason: "preexisting_dirty_overlap" });
```

- [ ] **步骤 2：运行 RED**

```powershell
pnpm --filter @vykor/server exec vitest run src/application/auto-review/git-run-change-inspector.test.ts
```

- [ ] **步骤 3：实现 inspector**

接口固定为：

```ts
export interface GitRunBaseline {
  repositoryRoot: string;
  head: string;
  dirty: Record<string, {
    status: string;
    worktreeHash: string | "missing";
    indexHash: string | "missing";
    indexMode: string | "missing";
  }>;
}

export interface GitRunChangeInspector {
  capture(cwd: string): Promise<GitRunBaseline | { unavailable: AutoReviewReason }>;
  compare(cwd: string, baseline: GitRunBaseline): Promise<AutoReviewChangeSet | { unavailable: AutoReviewReason }>;
}
```

实际 executor 使用 `execFile("git", args, { cwd, windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 })`。禁止拼 shell 字符串。status/name-status 使用 `-z` 解析，rename 同时保留 oldPath/path。tracked path 同时用 working-tree hash 与 `git ls-files -s -z` 的 index blob/mode 表示：untracked 为实际 `worktreeHash` + `indexHash/indexMode: missing`；deleted 为 `worktreeHash: missing` + 删除前仍可读取的 index hash/mode；其它缺失按对应层明确编码。每次 capture、compare 和 patch 生成都执行“读取 repositoryRoot+HEAD+status+worktree/index hash → 收集数据 → 再读同一组数据”；仓库根变化或任一摘要变化立即 `git_inspection_failed/unavailable`。生成 patch 后再做最后一次复核。测试必须包含“XY status 不变、worktree hash 不变、只有 index blob 改变”。symlink/submodule、无法无损解码或带控制字符的路径一律 unavailable。所有输出设置总大小上限。

- [ ] **步骤 4：验证**

```powershell
pnpm --filter @vykor/server exec vitest run src/application/auto-review/git-run-change-inspector.test.ts
pnpm --filter @vykor/server run check-types
```

- [ ] **步骤 5：提交**

```powershell
git add packages/server/src/application/auto-review/git-run-change-inspector.ts packages/server/src/application/auto-review/git-run-change-inspector.test.ts packages/server/src/application/auto-review/index.ts
git commit -m "feat(review): attribute git changes to one run"
```

---

### 任务 3：定义 reviewer prompt 和严格结构化结果

**文件：**

- 创建：`packages/server/src/application/auto-review/auto-review-result.ts`
- 创建：`packages/server/src/application/auto-review/auto-review-result.test.ts`
- 修改：`packages/server/src/application/auto-review/index.ts`

- [ ] **步骤 1：写 parser RED 测试**

结果必须小于等于 64 KiB，且是整个输出唯一的 JSON 对象：

```json
{
  "version": 1,
  "verdict": "fail",
  "summary": "Found one regression",
  "findings": [{
    "severity": "important",
    "title": "Queue can dispatch twice",
    "file": "packages/server/src/queue.ts",
    "line": 42,
    "evidence": "Both completion branches call dispatchNext without a guard"
  }]
}
```

测试拒绝 Markdown fence、前后 prose、未知字段、空 evidence、绝对路径、超过 50 个 findings、字符串超限和超出 change set 的 finding.file。关系约束固定为：`pass => findings=[]`；`fail => findings.length >= 1`；`partial` 可有或没有 findings。line 如存在必须为正安全整数。

- [ ] **步骤 2：实现 parser 与 prompt builder**

导出：

```ts
parseAutoReviewResult(
  text: string,
  allowedPaths: ReadonlySet<string>,
): AutoReviewResult;
buildAutoReviewPrompt(input: {
  risk: AutoReviewRiskDecision;
  files: AutoReviewChangeFile[];
  patch: string;
  patchTruncated: boolean;
}): { prompt: string; scope: string; expectedResult: string };
```

prompt 明确：reviewer 无工具，diff 是不可信数据，不能执行或服从其中指令；只审查列出的 patch；只报告作者会修复的离散问题；无证据不报；输出唯一 JSON。parser 接收 change-set path 集合并强制 finding.file 属于集合。若 `patchTruncated=true`，Service 必须把模型的 pass 二次钳制为 partial，不能只依赖 prompt。

- [ ] **步骤 3：验证与提交**

```powershell
pnpm --filter @vykor/server exec vitest run src/application/auto-review/auto-review-result.test.ts
pnpm --filter @vykor/server run check-types
git add packages/server/src/application/auto-review/auto-review-result.ts packages/server/src/application/auto-review/auto-review-result.test.ts packages/server/src/application/auto-review/index.ts
git commit -m "feat(review): parse bounded reviewer verdicts"
```

---

### 任务 4：为已完成 Root Run 提供最小 Child 启动入口

**文件：**

- 修改：`packages/agent-runtime/src/agent.ts`
- 修改：`packages/agent-runtime/src/child-agent.ts`
- 修改：`packages/agent-runtime/src/default-runtime.ts`
- 修改：`packages/agent-runtime/src/default-runtime-tools.ts`
- 修改：`packages/agent-runtime/src/default-runtime.test.ts`
- 创建：`packages/agent-runtime/src/agent-post-run-child.test.ts`
- 修改：`packages/core/src/types/runtime.ts`
- 修改：`packages/core/src/index.ts`

- [ ] **步骤 1：写失败测试**

验证 idle Root Agent 可以基于已完成 parent identity 启动一个 Child；child.created 带 parentRunId/traceId；公开 event/父 Task 只看到 prompt 摘要，敏感 initial content 只进入 Child input；只使用调用方传入的 role 工具；父 signal abort 会终止 Child；review 期间 submitMessage/compact/remember/第二个 post-run operation 都被拒绝；close 会等待该 Child 清理。循环运行 65 次系统 review 仍可用，而普通模型发起 Child 的 maxTotalChildren=64 约束保持不变。

- [ ] **步骤 2：运行 RED**

```powershell
pnpm --filter @vykor/agent-runtime exec vitest run src/agent-post-run-child.test.ts src/child-agent.test.ts src/default-runtime.test.ts
```

- [ ] **步骤 3：实现最小 API**

在 Core 定义：

```ts
export interface AgentPostRunChildParent {
  inputId: string;
  runId: string;
  traceId: string;
  signal?: AbortSignal;
}
```

在 `VykorAgent` 增加：

```ts
runChildForCompletedRun(
  input: AgentChildSpawnInput,
  parent: AgentPostRunChildParent,
  sensitiveInitialContent: string,
  capabilityView?: RunCapabilityView,
): Promise<{ invocation: AgentChildInvocation; result: AgentChildResult }>;
```

`VykorAgent` 公共接口与 `DefaultVykorAgent` 都增加该方法。实现复用现有 maintenance 互斥，使 Root 在整个 review 期间不是 idle；仅构造 Root 自身的 `AgentRunScope`，不允许调用方伪造 parent session/agent/cwd。

ChildManager 增加仅供该宿主方法调用的 trusted system spawn：仍计入 depth 和 activeChildren，完成后立即 close/release，但不消耗模型可调用的累计 `maxTotalChildren`；系统 review 同时最多 1 个。普通 `Agent` 工具无法设置 system 标记。`sensitiveInitialContent` 送入 `beginRun`，但从 `child.created.data.spawn` 和父 Task prompt 中排除；事件仅携带固定摘要。

工具上限增加显式 `ToolLimit { kind: "none" }`，`RuntimeToolRegistry.isVisible()` 对 none 恒为 false，`intersectToolLimits()` 中 none 吸收其它上限。trusted system spawn 以不可由 Agent tool 输入构造的内部参数强制 none；不能把 `allowedTools: []` 当 none，因为现有语义是 all。测试必须在实际 Child 内断言 `listModelVisibleTools()` 为空。

- [ ] **步骤 4：验证与提交**

```powershell
pnpm --filter @vykor/agent-runtime exec vitest run src/agent-post-run-child.test.ts src/child-agent.test.ts src/default-runtime.test.ts
pnpm --filter @vykor/agent-runtime run check-types
git add packages/core/src/types/runtime.ts packages/core/src/index.ts packages/agent-runtime/src/agent.ts packages/agent-runtime/src/child-agent.ts packages/agent-runtime/src/default-runtime.ts packages/agent-runtime/src/default-runtime-tools.ts packages/agent-runtime/src/default-runtime.test.ts packages/agent-runtime/src/agent-post-run-child.test.ts packages/agent-runtime/src/child-agent.test.ts
git commit -m "feat(agent): spawn bounded post-run child review"
```

---

### 任务 5：实现持久 AutoReview Service

**文件：**

- 创建：`packages/server/src/application/auto-review/session-auto-review-service.ts`
- 创建：`packages/server/src/application/auto-review/session-auto-review-service.test.ts`
- 修改：`packages/server/src/application/auto-review/index.ts`
- 修改：`packages/services/src/session-runtime/event-registry.ts`
- 修改：`packages/services/src/session-runtime/__test__/event-registry.test.ts`

- [ ] **步骤 1：写状态机失败测试**

使用 fake inspector、fake agent 和真实临时 SessionStore，覆盖：mode off、无改动、low、medium pass、high findings、partial、invalid JSON、Child failed、timeout、unavailable attribution、patch truncated 强制 partial、恶意 diff 指令无法产生工具调用。

每个分支断言父 Run metadata 和 `session.auto_review.updated` event 一致。关键规则：

```ts
expect(readAutoReviewRunMetadata(run.metadata.autoReview)).toMatchObject({
  status: "findings",
  riskLevel: "high",
  verdict: "fail",
  findingCount: 2,
  reviewTaskId: "child-review-1",
});
```

Child 返回 failed/timed_out/invalid output 时不得出现 status passed。

- [ ] **步骤 2：实现 Service API**

```ts
export class SessionAutoReviewService {
  captureBaseline(input: {
    sessionId: string;
    runId: string;
    cwd: string;
    mode: AutoReviewMode;
  }): Promise<void>;

  reviewCompletedRun(input: {
    sessionId: string;
    inputId: string;
    runId: string;
    traceId: string;
    cwd: string;
    agent: VykorAgent;
    signal: AbortSignal;
  }): Promise<AutoReviewRunMetadata>;

  settleUnreviewedRun(input: {
    sessionId: string;
    runId: string;
    reason: "parent_run_not_completed";
  }): AutoReviewRunMetadata;

  failIncompleteReviewsOnStartup(): number;
}
```

`captureBaseline` 将安全摘要放在内存 map，并在 Run metadata 写 `captured/disabled`。`reviewCompletedRun` 先持久化 pending，再调用 `runChildForCompletedRun`；role 必须从 `getBuiltinAgentDefinitions()` 中按 name 取出并断言 `source === "builtin"`。实际 spawn 强制 `allowedTools: []`、`requiredMcpServers: []`，并传入一个经测试确认 `tools.size === 0` 的 capability view；不得依赖通配符 deny 语义。随后传入 scope、expectedResult 和风险预算。完成后严格 parse 并校验 change-set paths；patch truncated 时强制 partial；再持久化最终状态。完整 findings 可以通过 Child Task output 和既有结果通知交付，父 Run 的评审 metadata 不存正文。

所有状态写入必须走同一个私有 `transition()`：在 `store.transaction` 内同时更新 `metadata.autoReview` 和 append `session.auto_review.updated`，事务外通过 `SessionEventPublisher.checkpoint/publishSince` 发布。写入或 event 校验失败时整笔回滚；startup recovery 复用同一入口。Service 对自身异常做 fail-closed：能定位父 Run 时写 failed/unavailable 并记录固定 reason；只记录详细异常到本地 structured log。

- [ ] **步骤 3：注册 durable event**

`session.auto_review.updated` payload 只含 `{ runId, review }`；event registry 用 `readAutoReviewRunMetadata` 校验，不接受 prompt/diff/findings/error 文本。

- [ ] **步骤 4：验证与提交**

```powershell
pnpm --filter @vykor/server exec vitest run src/application/auto-review/session-auto-review-service.test.ts
pnpm --filter @vykor/services exec vitest run src/session-runtime/__test__/event-registry.test.ts
pnpm --filter @vykor/server run check-types
git add packages/server/src/application/auto-review packages/services/src/session-runtime/event-registry.ts packages/services/src/session-runtime/__test__/event-registry.test.ts
git commit -m "feat(review): persist automatic review lifecycle"
```

---

### 任务 6：接入 Run Executor、daemon 装配和重启收束

**文件：**

- 修改：`packages/server/src/application/session/session-run-executor.ts`
- 修改：`packages/server/src/application/session/__test__/session-run-executor.test.ts`
- 修改：`packages/server/src/application/session/session-run-executor-assembly.ts`
- 修改：`packages/server/src/application/daemon-application.ts`
- 修改：`packages/server/src/application/recovery/startup-recovery-service.ts`
- 修改：`packages/server/src/application/recovery/startup-recovery-service.test.ts`

- [ ] **步骤 1：写执行顺序 RED 测试**

断言：baseline 在 Agent submit 前捕获；只有 projector 已将 Root Run 写成 completed 才 review；review 在 memory/personalization maintenance 前完成；失败/中断 Run 把 captured 收束为 unavailable + parent_run_not_completed；review 期间 running Child 让 watchdog 保持活跃；用户 abort 传入 reviewer Child；review failure 不覆盖父 Run completed。额外注入一个直接抛错的 autoReview service，断言父 Run completed 且 maintenance、usage refresh、closeIfStale 仍全部执行。

- [ ] **步骤 2：扩展 Executor context**

```ts
autoReview?: Pick<
  SessionAutoReviewService,
  "captureBaseline" | "reviewCompletedRun" | "settleUnreviewedRun"
>;
resolveAutoReviewMode?(cwd: string): Promise<AutoReviewMode>;
```

在读取 session/run 后捕获基线；`await run.result` 后重新读取 durable Run。status completed 时在独立 try/catch 中 `await reviewCompletedRun(...)`；failed/interrupted 时调用 Service 收束 captured。任何 auto-review 编程/存储异常只写 structured log，随后仍继续 postRunMaintenance、usage refresh、closeIfStale；不得进入包住整个 execute 的失败 catch。

- [ ] **步骤 3：装配设置与启动恢复**

Daemon 使用 `getSettingsForCwd` 解析 `settings.autoReview.mode`。StartupRecovery 在 interrupt active runs 后调用 `failIncompleteReviewsOnStartup()`：pending → failed + daemon_restarted；captured → unavailable + daemon_restarted。正常父 Run failed/interrupted 已用 parent_run_not_completed 收束，不应等到重启。重复启动幂等。

- [ ] **步骤 4：验证与提交**

```powershell
pnpm --filter @vykor/server exec vitest run src/application/session/__test__/session-run-executor.test.ts src/application/recovery/startup-recovery-service.test.ts
pnpm --filter @vykor/server run check-types
git add packages/server/src/application/session/session-run-executor.ts packages/server/src/application/session/__test__/session-run-executor.test.ts packages/server/src/application/session/session-run-executor-assembly.ts packages/server/src/application/daemon-application.ts packages/server/src/application/recovery/startup-recovery-service.ts packages/server/src/application/recovery/startup-recovery-service.test.ts
git commit -m "feat(server): trigger bounded post-run reviews"
```

---

### 任务 7：把评审状态接入统一观测与 CLI

**文件：**

- 修改：`packages/protocol/src/execution-observability.ts`
- 修改：`packages/protocol/src/execution-observability.test.ts`
- 修改：`packages/server/src/application/observability/session-execution-observation-reader.ts`
- 修改：`packages/server/src/application/observability/session-execution-observation-reader.test.ts`
- 修改：`packages/server/src/application/observability/execution-observation-service.ts`
- 修改：`packages/server/src/application/observability/execution-observation-service.test.ts`
- 修改：`packages/server/src/http/routes/__test__/routes.test.ts`
- 修改：`apps/cli/src/commands/debug.ts`
- 修改：`apps/cli/src/commands/debug.test.ts`

- [ ] **步骤 1：扩展 observation RED 测试**

`ExecutionObservation` 增加：

```ts
review?: {
  policyVersion: "risk-v1";
  riskLevel: AutoReviewRiskLevel;
  status: AutoReviewStatus;
  verdict?: "pass" | "fail" | "partial";
  findingCount?: number;
};
```

Filter 增加 `reviewStatuses`、`reviewRiskLevels`；`parseExecutionObservationFilter()` 解析 `reviewStatus`、`reviewRisk` 并拒绝未知枚举。summary 每 kind 增加 `reviews: Partial<Record<AutoReviewStatus, number>>`。测试 reader 从父 Run metadata 安全读取；invalid metadata 忽略而非抛错；`sanitizeRecord()` 显式保留有界 review；`matchesFilter()` 和 `summarize()` 消费 review。HTTP route 测试 query 能穿透到 Service，非法值返回 400。

- [ ] **步骤 2：实现协议、Reader、Service**

不输出 reasons、task output 或 findings 正文。CLI 新增：

```text
--review-status <statuses>
--review-risk <levels>
```

人类摘要每 kind 追加 `reviews=passed:X,findings:Y,partial:Z,failed:W`，只展示存在的计数。

- [ ] **步骤 3：验证与提交**

```powershell
pnpm --filter @vykor/protocol exec vitest run src/execution-observability.test.ts
pnpm --filter @vykor/server exec vitest run src/application/observability src/http/routes/__test__/routes.test.ts
pnpm --filter @rzx/ohs exec vitest run src/commands/debug.test.ts
pnpm --filter @vykor/server run check-types
git add packages/protocol/src/execution-observability.ts packages/protocol/src/execution-observability.test.ts packages/server/src/application/observability packages/server/src/http/routes/__test__/routes.test.ts apps/cli/src/commands/debug.ts apps/cli/src/commands/debug.test.ts
git commit -m "feat(observability): expose automatic review outcomes"
```

---

### 任务 8：端到端验收、操作说明和评估入口

**文件：**

- 修改：`packages/server/src/http/__test__/http.test.ts`
- 创建：`packages/server/src/application/auto-review/auto-review.integration.test.ts`
- 创建：`docs/auto-review.md`
- 修改：`docs/README.md`

- [ ] **步骤 1：写真实 daemon 集成测试**

用临时 Git 仓库和 fake model/child program 覆盖：

1. mode off：父 Run completed，metadata disabled，无 Child。
2. low docs-only：skipped。
3. medium source：创建只读 review Child，严格 JSON pass → passed。
4. high sensitive path：使用 high 预算；findings → findings。
5. reviewer timeout/invalid JSON → timed_out/failed，绝不 passed。
6. Run 前 dirty 文件被同一 Run 改动 → unavailable。
7. daemon restart 收束 pending review。
8. `/debug/executions?reviewStatus=findings` 能查询父 Run，默认 JSON 不含 patch、prompt、finding evidence 或绝对路径。
9. 直接查询持久 store：`child.created` event、父 Session Task、父 Run metadata 和 auto-review event 均不含 patch；只有 reviewer Child Session input 含一次 patch。默认 run inspection/session export 不含 patch，显式 includeContent 才允许人工读取 Child input。
10. 连续完成 65 次自动评审仍可启动第 65 次；同一 Root 下模型发起的普通 Child 仍在 maxTotalChildren 达限时被拒绝。

- [ ] **步骤 2：运行 RED 并实现缺失接线**

只修复集成测试暴露的装配问题，不新增自动修复、UI 或远程遥测。

- [ ] **步骤 3：写操作文档**

`docs/auto-review.md` 必须包含：启用/关闭命令、风险规则、状态含义、dirty workspace 限制、review 不运行测试、如何用 `vykor debug executions --review-status ... --json` 导出、如何做 A/B 对照。

示例：

```powershell
vykor config set autoReview.mode risk_based
vykor debug executions --review-status passed,findings,partial,failed,timed_out --json
vykor config set autoReview.mode off
```

- [ ] **步骤 4：最终定向测试**

```powershell
pnpm --filter @vykor/protocol exec vitest run src/auto-review.test.ts src/execution-observability.test.ts
pnpm --filter @vykor/core exec vitest run src/config/settings.test.ts
pnpm --filter @vykor/agent-runtime exec vitest run src/agent-post-run-child.test.ts src/child-agent.test.ts src/default-runtime.test.ts
pnpm --filter @vykor/services exec vitest run src/session-runtime/__test__/event-registry.test.ts
pnpm --filter @vykor/server exec vitest run src/application/auto-review src/application/session/__test__/session-run-executor.test.ts src/application/recovery/startup-recovery-service.test.ts src/application/observability src/http/__test__/http.test.ts
pnpm --filter @rzx/ohs exec vitest run src/commands/debug.test.ts
pnpm check-types
git diff --check
```

- [ ] **步骤 5：独立代码审查**

派只读 reviewer 检查：改动归因是否会吞入用户 WIP；所有失败分支是否 fail-closed；review role 是否仍严格只读；父 Run completed 是否不会被评审异常覆盖；metadata/event/观测是否不泄漏 diff/findings/path；设置默认是否 off。修复全部 Critical/Important 后复跑步骤 4。

- [ ] **步骤 6：提交**

```powershell
git add packages/server/src/http/__test__/http.test.ts packages/server/src/application/auto-review/auto-review.integration.test.ts docs/auto-review.md docs/README.md
git commit -m "test(review): verify risk-based automatic review flow"
```

---

## 最终验收清单

- [ ] `DEFAULT_SETTINGS.autoReview.mode` 为 off；CLI 可以真实切换 off/risk_based。
- [ ] none/low 不启动 Child；medium/high 启动一个严格只读 `review` Child。
- [ ] 风险分类只使用固定、可测试的事实，不让模型自己决定是否需要评审。
- [ ] dirty baseline 与本次改动重叠时 unavailable，不审查混合 diff。
- [ ] commit range 必须线性可归因；额外 working-tree 改动会阻止 commit-range 评审。
- [ ] patch 截断时无法得到 passed。
- [ ] reviewer failed、timeout、invalid JSON、daemon restart 均不会变成 passed。
- [ ] reviewer findings 不自动改代码，不覆盖父 Run completed。
- [ ] Child Task 能通过 JobRead/JobWait 查看 activity、partialResult 和失败原因。
- [ ] review 期间 Root Agent 的 submit/compact/remember 被互斥，完成后恢复；系统 review 不耗尽模型 Child 累计配额。
- [ ] diff 作为输入保存在 reviewer Child；框架不额外把输入 patch 拼接到父结果中。父 Run metadata、review event 和 observation 不复制 patch/findings/error 正文；最终报告允许引用代码，不能将上下文隔离视为内容脱敏。
- [ ] Execution Observation 能按 risk/status 查询并用于开启/关闭 A/B 对照。
- [ ] 默认导出不泄漏 prompt、diff、finding evidence、绝对路径或 provider 配置。
- [ ] 无数据库表迁移、无 Desktop 页面、无远程遥测。
- [ ] 所有定向测试、全仓类型检查和独立审查通过。

## 交给执行智能体的启动提示

```text
请严格执行 docs/superpowers/plans/2026-09-29-risk-based-auto-review.md。
先确认当前任务编号，只执行该任务，不提前修改后续任务文件。按 RED→GREEN→受影响回归→独立提交执行；每次提交前检查 git status、git diff 和暂存文件，绝不暂存或回滚用户/其它智能体的 WIP。评审失败、超时、输出无法解析或改动无法归因时必须保存真实非通过状态，禁止降级为 passed。
```
