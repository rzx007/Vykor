# 按风险自动评审（risk-based auto review）

> 状态：当前实现。首版默认关闭，需要显式打开。

## 这个功能做什么

一个 Root Session 的 Run 正常结束（completed）后，Server 会尝试判断这次 Run 实际改了哪些代码：

- 先给风险定级：`none` / `low` / `medium` / `high` / `unknown`。
- 低风险不评审，只记录 `skipped`。
- 中高风险会启动一个**严格只读**的 `review` 子代理（Child），它没有任何工具，只能看这次的 diff。
- 评审结果（通过、发现问题、部分覆盖、失败、超时）作为持久状态写入父 Run 的 metadata，并追加 `session.auto_review.updated` 事件。

自动评审**不会**改代码、不会跑测试、不会把已经 completed 的父 Run 改成 failed，也不会自动开启修复 Run。

## 启用与关闭

```powershell
vykor config set autoReview.mode risk_based
vykor config set autoReview.mode off
```

默认是 `off`。设置只新增 `settings.autoReview.mode`，非法值（例如 `always`）会在读取配置时直接失败。

## 固定风险规则 `risk-v1`

判断只依据确定性的 Git 事实，不交给模型决定是否评审。命中高风险后不再降级：

1. 无改动：`none`，不评审。
2. 归因不完整：`unknown`，记为 `unavailable`。
3. 高风险：任一敏感路径；生产文件删除/重命名；改动文件数 ≥ 8；总增删行 ≥ 600；patch 被截断。
4. 低风险：全部是 `docs/**`、`**/*.md`、`**/*.test.*`、`**/__test__/**`、`**/fixtures/**`，文件数 ≤ 5、总增删行 ≤ 300，且没有删除/重命名。
5. 其余包含生产源码的改动：`medium`。

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

评审预算固定，不开放阈值配置：

| 风险 | 是否评审 | requestedMaxTurns | requestedTimeoutSeconds |
| --- | --- | ---: | ---: |
| none / low | 否 | — | — |
| medium | 是 | 10 | 120 |
| high | 是 | 20 | 240 |
| unknown 归因 | 否，记 unavailable | — | — |

## 状态含义

父 Run metadata 的 `autoReview.status` 取值：

| 状态 | 含义 |
| --- | --- |
| `disabled` | 模式为 off，未启用。 |
| `captured` | 已保存 Run 前的 Git 基线，等待 Run 结束。 |
| `skipped` | 风险为 none/low，未启动评审。 |
| `pending` | 已启动只读评审子代理，等待结果。 |
| `passed` | 评审通过（严格解析出的 `pass`）。 |
| `findings` | 评审发现问题（`fail`）。 |
| `partial` | 只覆盖了部分改动（例如 patch 被截断）。 |
| `failed` | 子代理失败或输出无法解析。 |
| `timed_out` | 子代理超时。 |
| `unavailable` | 无法安全归因（脏工作区重叠、非线性 HEAD、非 Git 仓库、daemon 重启等）。 |

只有严格解析出的 `pass` 才能记为 `passed`。输出无法解析、子代理失败、超时、部分覆盖、daemon 重启或改动无法安全归因时，分别记录真实状态，绝不降级为 `passed`。

## 归因与 dirty workspace 限制

- Run 开始前记录仓库根、HEAD、每个脏路径的状态和 worktree/index hash。
- Run 结束后只评审能证明属于本次 Run 的 commit range（要求线性、且 Run 后 working tree 与基线脏状态相同）或本次新增的 dirty path。
- 与 Run 前已有脏文件重叠时记为 `unavailable`，**不会**去评审整个脏工作区。
- 非 Git 工作区、Git 命令失败、非线性 HEAD 变化都记为 `unavailable`，不回退到全量审查。
- patch 超过 512 KiB 会被截断，此时风险至少为 high，最终 verdict 最高只能是 `partial`。

## 评审不运行测试

`review` 子代理被强制为无工具（`allowedTools: []`，并显式使用 none 工具上限），只能阅读本次 patch。它不会执行命令、不会读取 `.env`、绝对路径或 change set 之外的文件，也不会运行测试。恶意 diff 中的指令不会被服从。

## 导出评审结果

```powershell
# 只看需要关注的评审结果
vykor debug executions --review-status passed,findings,partial,failed,timed_out --json

# 只按风险查看
vykor debug executions --review-risk high,medium --json
```

人类的摘要里每个 execution kind 会追加 `reviews=...`，只展示存在的计数，例如：

```text
root_agent_run: completed=3 failed=0 timed_out=0 cancelled=0 skipped=1 reviews=findings:1,passed:1
```

导出的 JSON 只包含有界的评审状态（policyVersion、riskLevel、status、verdict、findingCount），不含 patch、prompt、finding 正文或绝对路径。

## A/B 对照

用开关切换即可对照：

```powershell
vykor config set autoReview.mode risk_based
# 跑一段真实工作，导出结果
vykor debug executions --review-status findings,failed,timed_out --json

vykor config set autoReview.mode off
# 再跑一段，导出结果对比
vykor debug executions --json
```

对照时关注 `review.status` 的分布、`reviewLevel` 是否为预期等级、以及 `unavailable` 是否集中在脏工作区场景。

## 数据边界

- 原始 patch 与完整 reviewer instructions 只进入 reviewer Child Session 的持久输入一次（`session_input` 及其 `session.input.admitted`）。
- 父 Run metadata、`session.auto_review.updated` 事件、`child.created` 的 spawn 摘要、Execution Observation 默认导出都不含 patch、prompt 正文、finding 正文或绝对路径。
- `vykor debug inspect-run` / session export 默认不含 patch；显式 `includeContent` 才允许读取 Child input。

## 已知取舍：finding 正文会作为 Child Task 输出落库

reviewer 子代理结束时，框架**通用**的子代理收尾逻辑会把它的最终输出（评审 JSON，含 `summary` 与 `findings` 正文）写进父会话的 `session_task.output`，并复制到 `agent.child.closed` 事件。它和「父 Run metadata、自动评审事件只存有界摘要」是两条不同的通道。

- 这是**有意保留**的行为：本计划任务 5 的约定是「完整 findings 仅保留在 Child Task output」，即把 reviewer 子会话/子任务视为承载结论正文的位置，父 Run metadata 与自动评审事件不承担该内容。
- 它与计划开头「父 Session Task 只能持久化摘要」的字面要求存在冲突；当前按前者执行，**未**对系统评审子代理的输出做额外脱敏。
- 影响：原始 diff 仍然只存在于 reviewer Child Session 输入中（这条经过真实端到端验证）；但由 diff 推导出的 finding 正文会出现在父会话的 `session_task.output` 与 `agent.child.closed` 事件里，`includeContent` 视图和任何读取父会话任务的一方都能看到。
- 如果某个部署要求「父可见记录里不能出现由 diff 推导出的 finding 正文」，需要额外改造通用子代理收尾投影层，只向父会话任务写入 `status/riskLevel/verdict/findingCount/highestSeverity` 等摘要。当前版本**未**做此改造。
