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
| `skipped` | 风险为 none/low，或因用户任务优先而跳过/中止评审。 |
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
- 变更路径命中 `.env`、`.env.*`、`.npmrc`、`.pypirc`、`credentials.json` 或已列出的私钥扩展名时，在读取 patch 前记为 `unavailable`（`sensitive_content_path`），包括重命名前的路径。该路径检查不代替对任意源码中密钥的检测。
- patch 超过 512 KiB 会被截断，此时风险至少为 high，最终 verdict 最高只能是 `partial`。

## 评审不运行测试

`review` 子代理使用宿主内部的 `internalTextOnly` 约束：模型无可见工具，不加载插件和程序扩展、不连接 MCP 服务，也不执行 hook（自动回调）。它只能处理传入的 patch，不能通过执行工具响应 diff 中的指令。已有用户任务排队时跳过评审；评审过程中接纳新的用户任务则中止评审，记录为 `skipped`（`review_preempted_by_user`），收尾后按原队列继续执行。

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

- 原始 patch 与完整 reviewer instructions 作为初始输入进入 reviewer Child Session（`session_input` 及其 `session.input.admitted`），框架不额外拼接这些内容到父侧报告或统计记录。
- 父 Run metadata、`session.auto_review.updated` 事件、`child.created` 的 spawn 摘要、Execution Observation 默认导出都不含 patch、prompt 正文、finding 正文或绝对路径。
- `vykor debug inspect-run` 默认不含 patch；带有 `sensitiveInput` 标记的 Child Session 在 Markdown/JSON 导出时隐去内容，也兼容早期的评审专用标记。该规则约束导出，不改变授权诊断入口对原始持久记录的访问。

## 最终报告与观测摘要

reviewer 子代理结束时，通用子代理生命周期会把最终输出（可能包含评审 JSON 的 `summary` 与 `findings` 正文）写进父会话的 `session_task.output`，并通过 `agent.child.closed` 交付。这是任务成果；父 Run metadata、自动评审状态事件及默认 Execution Observation 只存有界摘要。

- 父代理和用户可通过现有授权 Task/Child Session 入口查看完整报告；普通 Agent 与 Workflow 的结果交付规则保持一致。
- Task 输出是模型提交的结果，保存不代表系统已采信。Task `completed`、报告中的 `verdict: pass` 和权威的 `autoReview.status: passed` 分开；格式、覆盖、运行与必要收尾验证均成功后才能记录后者。
- 独立上下文不等于保密隔离：最终报告可能引用输入中的代码，JobRead 活动查询也可返回已提交的文本片段。JSON 校验或字段名为 summary 都不构成脱敏保证。
- 如果以后需要不同读者之间的严格内容限制，应一起设计结果、事件、错误、部分结果、活动查询、恢复记录与导出的访问边界。

详细职责与验收标准见[子代理结果交付边界规范](superpowers/specs/2026-09-30-child-result-delivery-boundary-design.md)。
