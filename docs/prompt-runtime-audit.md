# Prompt Runtime Audit

> 状态：当前 Prompt 组装入口的审计索引。

本文记录 Vykor 当前 system prompt 的运行时入口，确保 `SOUL.md`、`USER.md`、`settings.systemPrompt`、project instructions、memory、skills 和 permission mode 都通过同一套 prompt builder 语义。

## Canonical Builder

权威入口位于 `packages/prompts/src/index.ts`：

```text
buildPromptLayers(options) -> PromptLayers
renderPromptLayers(layers) -> string
buildRuntimeSystemPrompt(options) -> string
```

当前分层顺序固定为：

```text
stable
  SOUL.md or Default Identity
  Invariant Guidance
  Environment
  Permission Mode
  Session Mode / Reasoning Settings
  Available Skills
  Delegation Guidance

context
  Custom Instructions
  Project Instructions

volatile
  USER.md
  Local Environment Rules
  Project Memory
```

`settings.systemPrompt` / `customPrompt` 是 context 层的 `# Custom Instructions`，不会覆盖 identity 或 invariant guidance。

## Entry Points

| 入口 | 文件 | prompt 行为 | 审计结论 |
|---|---|---|---|
| REPL 初始化 / refresh | `apps/cli/src/commands/main.ts` | `refreshSystemPrompt()` 调用 `buildRuntimeSystemPrompt()`，传入 settings、memory、skills | ✅ canonical |
| print 模式 | `apps/cli/src/commands/main.ts` | 每次运行前调用 `buildRuntimeSystemPrompt()`，传入 settings、memory、skills | ✅ canonical |
| backend / TUI host 初始化 | `apps/cli/src/commands/main.ts` | `refreshSystemPrompt()` 调用 `buildRuntimeSystemPrompt()`，传入 settings、memory、skills | ✅ canonical |
| backend permission mode 切换 | `apps/cli/src/commands/main.ts` | 更新 settings 后调用 `refreshSystemPrompt()` | ✅ canonical |
| 默认 runtime composition | `packages/agent-runtime/src/default-runtime.ts` | 未提供 explicit override 时调用 `buildRuntimeSystemPrompt()`，传入 settings、skills | ✅ canonical |
| `/context` 调试 | `packages/client/src/commands/session-commands.ts` + server context service | 通过 daemon 返回当前上下文诊断 | ✅ diagnostic |
| `/profile` 管理 | `packages/client/src/commands/session-commands.ts` + server profile service | 使用统一的个人 prompt 诊断和初始化服务 | ✅ diagnostic + init |

## Explicit Overrides

仍有少数路径可以向 `QueryEngine` 传入已构造好的 system prompt，例如 task worker 通过环境变量传递 prompt，或测试直接构造 `QueryEngine({ systemPrompt })`。这些属于显式完整 prompt override，不代表 `settings.systemPrompt` 的常规语义。

规则：

- 常规用户配置 `settings.systemPrompt` 必须进入 context 层。
- 只有调用方已经持有完整 system prompt 字符串时，才允许绕过 canonical builder。
- 新 runtime 入口应优先调用 `buildRuntimeSystemPrompt()` 或 `buildPromptLayers()`。

## Personal Prompt Diagnostics

`SOUL.md` / `USER.md` 的读取状态由 `inspectPersonalPromptFiles()` 统一判断。诊断状态包括：

```text
missing
empty
loaded
blocked
error
```

`/context` 和 `/profile status` 都显示同一份诊断，因此被安全扫描阻断、超过预算截断、文件缺失等情况不会静默隐藏。

## Current Gaps

- pending `USER.md` 更新队列已有底座，但还没有 CLI/UI 审批入口。
- `/remember` 和自动记忆抽取还没有把用户长期偏好写入 pending 队列。
- prompt safety scan 规则目前是内置轻量规则，尚未做可配置策略。
