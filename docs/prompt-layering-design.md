# 设计：Prompt 三层分层与 SOUL.md / USER.md 迁移

> 状态：当前部分实现。已接入 `packages/prompts`：`SOUL.md` / `USER.md` 读取、
> `PromptLayers` 分层构建与渲染、`/context` 分层展示已完成；
> 安全扫描、可见诊断、`/profile init` 初始化模板与 `USER.md` pending 写入队列底座已完成；
> 自动抽取写入仍留后续显式接入。
> 参考对象：Hermes Agent 的 `stable / context / volatile` prompt 分层。

## 背景

Vykor 当前的 system prompt 是线性拼接：

```text
Base System Prompt
Environment
Permission Mode
Session Mode / Reasoning Settings
Available Skills
Delegation Guidance
Project Instructions: CLAUDE.md / .claude/CLAUDE.md / .claude/rules/*.md
Local Environment Rules: ~/.vykor/local_rules/rules.md
Project Memory
```

这套结构已经可用，但几个概念混在一起：

- “Agent 是谁、如何说话”写死在 `BASE_SYSTEM_PROMPT` 中，没有用户可编辑的身份槽。
- “用户是谁、偏好什么”没有独立文件，只能落在 project memory 或自动抽取规则里。
- 自动环境事实、项目记忆、项目规则都直接排在线性顺序里，缺少稳定性/缓存边界说明。

因此迁移目标是借鉴 Hermes 的三层模型，把 prompt 来源按语义和变动频率分开。

---

## 目标分层

### stable：会话稳定身份与能力层

这一层描述 Agent 的基础身份、不可轻易变动的行为约束，以及本会话可用能力。它应在一次会话内保持稳定。

目标内容：

```text
SOUL.md or fallback identity
Base invariant guidance
Environment
Permission Mode
Session Mode / Reasoning Settings
Available Skills
Delegation Guidance
```

说明：

- `SOUL.md` 只负责“Agent 是谁、默认语气、长期行为风格”。
- `SOUL.md` 存在时替换默认 identity 文案，但不应替换安全、工具、权限等 invariant guidance。
- `SOUL.md` 只从 Vykor home/config 目录加载，不从当前 repo 加载，避免不同项目意外改变 Agent 身份。
- Skills/permission/environment 虽可能随配置改变，但对单个会话而言应是稳定前缀的一部分。

### context：当前工作上下文层

这一层描述当前项目、当前调用方或当前运行入口给出的规则。它比 stable 更贴近工作目录。

目标内容：

```text
Configured system prompt additions / CLI append prompt
Project Instructions:
  CLAUDE.md
  .claude/CLAUDE.md
  .claude/rules/*.md
```

说明：

- Vykor 目前已支持从 cwd 向上遍历加载 `CLAUDE.md`、`.claude/CLAUDE.md` 和 `.claude/rules/*.md`。
- 这层用于 repo 规则、构建/测试约定、项目协作指令。
- 项目规则优先级应高于用户长期偏好：如果 repo 要求某种格式、测试命令或安全边界，应服从 repo。

### volatile：跨会话记忆与自动事实层

这一层包含可变但需要注入 prompt 的事实快照。它可以来自文件、自动抽取、项目记忆或 per-turn 检索。

目标内容：

```text
USER.md
Local Environment Rules: ~/.vykor/local_rules/rules.md
Project Memory
Per-turn Relevant Memory (transient system-reminder)
```

说明：

- `USER.md` 是用户档案：偏好、沟通方式、长期习惯、期望，而不是项目规则。
- `local_rules/rules.md` 是自动抽取的本机环境事实，仍保持自动生成、用户不手改的定位。
- `Project Memory` 继续表示项目级长期语义记忆。
- per-turn relevant memory 仍不写入持久历史，只作为本轮 `system-reminder` 注入。
- `session_memory` 不属于常规 system prompt；它只在 compact 边界注入摘要 prompt，作为压缩连续性附件。

---

## 迁移步骤

### 1. 增加 USER.md

新增用户档案文件：

```text
$VYKOR_CONFIG_DIR/USER.md
```

默认目录仍遵循现有配置目录规则；未设置 `VYKOR_CONFIG_DIR` 时使用 Vykor 默认 config home。

职责：

- 存用户长期偏好，例如语言、回答风格、工作流偏好、审批习惯。
- 不存密钥、token、临时任务状态、大段日志。
- 不存 repo 规则；repo 规则继续放 `CLAUDE.md` / `.claude/rules/*.md`。

注入方式：

- 启动/刷新 system prompt 时读取。
- 空文件或不存在则跳过。
- 进入 volatile 层，标题建议为 `# User Profile`。

首版读取已接入；写入不直接落 `USER.md`，而是先通过 pending 队列生成候选更新，待显式批准后再合并。

### 2. 增加 SOUL.md

新增 Agent 身份文件：

```text
$VYKOR_CONFIG_DIR/SOUL.md
```

职责：

- 定义 Vykor 的默认身份、语气、长期行为风格。
- 适合“这个 Agent 应该像谁、怎样回应、避免什么表达习惯”。
- 不适合写项目构建命令、工具 allowlist、仓库规范、密钥或临时任务。

加载规则：

- 只从 config home 加载，不从 cwd 加载。
- 不存在、为空或读取失败时回退到内置 identity。
- 注入前做长度截断；后续实现应复用或新增 prompt-injection 扫描。
- 只出现在 stable identity slot 一次，不再作为普通 context file 重复出现。

实现上需要先把当前 `BASE_SYSTEM_PROMPT` 拆成：

```text
Default Identity
Invariant Guidance
```

这样 `SOUL.md` 可以替换 identity，而不会覆盖工具、安全、权限、任务执行等核心约束。

### 3. 文档化并重组 prompt builder

当前已新增三层结构：

```ts
interface PromptLayers {
  stable: string[];
  context: string[];
  volatile: string[];
}
```

最终 join 顺序固定：

```text
stable
context
volatile
```

已新增：

```ts
buildPromptLayers(options): Promise<PromptLayers>
renderPromptLayers(layers): string
buildRuntimeSystemPrompt(options): Promise<string>
```

`buildRuntimeSystemPrompt()` 保持兼容，对外仍返回字符串；测试从断言零散片段，逐步补充为断言层顺序。

---

## 目标注入顺序

迁移完成后的完整顺序：

```text
stable
  SOUL.md or Default Identity
  Invariant Guidance
  Environment
  Permission Mode
  Session Mode
  Reasoning Settings
  Available Skills
  Delegation Guidance

context
  Configured System Prompt Additions
  Project Instructions
    CLAUDE.md
    .claude/CLAUDE.md
    .claude/rules/*.md

volatile
  User Profile
    USER.md
  Local Environment Rules
    ~/.vykor/local_rules/rules.md
  Project Memory
  Per-turn Relevant Memory
    transient system-reminder, not persisted in history

compact-only
  Session Memory Checkpoint
    injected only into CompactService summary prompt
```

---

## 与当前实现的对应关系

| 当前来源 | 当前状态 | 目标层 | 迁移动作 |
|----------|----------|--------|----------|
| `BASE_SYSTEM_PROMPT` | 已拆成 identity + invariant guidance | stable | ✅ |
| Environment | 已注入 | stable | 保持 |
| Permission Mode | 已注入 | stable | 保持 |
| Skills List | 已注入 | stable | 保持 |
| Delegation Guidance | 已注入 | stable | 保持 |
| `CLAUDE.md` / `.claude/*` | 已注入 | context | 保持，文档化为 Project Instructions |
| `settings.systemPrompt` / CLI prompt override | 已支持 | context | 作为 `# Custom Instructions` 追加到 context 层，不再覆盖 identity / invariant guidance |
| `local_rules/rules.md` | 已注入 | volatile | 保持 |
| Project Memory | 已注入 + per-turn 检索 | volatile | 保持 |
| `session_memory` | compact 附件 | compact-only | 保持，不进入常规 prompt |
| `USER.md` | 已只读接入 | volatile | ✅ |
| `SOUL.md` | 已只读接入 | stable | ✅ |

---

## 优先级规则

从高到低建议如下：

1. 当前用户消息和显式本轮要求。
2. 安全、权限、工具执行等 invariant guidance。
3. Project Instructions。
4. User Profile。
5. Local Environment Rules。
6. Project Memory / per-turn memory。
7. SOUL.md 的语气与身份偏好。

注意：虽然 `SOUL.md` 位于 stable 层最前面，但它不应拥有最高行为优先级。它定义默认身份和风格，不能覆盖安全、权限、项目规则或用户本轮明确要求。

---

## 文件定位

首版建议：

```text
$VYKOR_CONFIG_DIR/
  SOUL.md
  USER.md
  local_rules/
    facts.json
    rules.md
```

不建议首版支持 repo 内 `SOUL.md`，原因：

- Agent 身份应属于用户/实例，不应被项目目录静默改变。
- repo 内身份文件有更高 prompt-injection 风险。
- 项目规则已有 `CLAUDE.md` / `.claude/rules/*.md` 承担。

是否支持 repo 内 `USER.md` 也建议暂缓。用户档案应跨项目生效；项目偏好可写 project memory 或 project instructions。

---

## 安全与预算

首版实现已包含：

- 文件不存在或为空时跳过。
- `SOUL.md` 和 `USER.md` 均限制最大字符数：`SOUL.md` 12,000 字符，`USER.md` 8,000 字符。
- `USER.md` 和生成型 section 带明确标题，避免和相邻层混淆；`SOUL.md` 作为 identity slot 原样注入。
- 加载 `SOUL.md` / `USER.md` 前执行轻量 prompt-injection 扫描；明显要求忽略高优先级指令、泄露隐藏 prompt/密钥、绕过权限或强制无审批执行的内容会被阻断，不进入 system prompt。
- `/context` 与 `/profile status` 会显示 `SOUL.md` / `USER.md` 的路径、加载状态、截断状态和阻断原因。
- `/profile init` 会在 config 目录创建缺失的 `SOUL.md` / `USER.md` 模板；已有文件不会被覆盖。
- `USER.md` 写入采用 pending 队列底座：`queueUserProfileUpdate()` 只写候选 JSON，`approvePendingUserProfileUpdate()` 才会合并到 `USER.md`。
- 不自动覆盖用户已有文件。

后续增强：

- 为 pending 队列增加 CLI / UI 审批入口。
- 将 `/remember` 或自动记忆抽取中的“用户长期偏好”显式接入 pending 队列。
- 扩展扫描规则为可配置策略。

---

## 测试计划

首批实现时应覆盖：

- 无 `SOUL.md` / `USER.md` 时 prompt 与当前行为兼容。
- 有 `SOUL.md` 时 identity 被替换，但 invariant guidance 仍存在。
- 有 `USER.md` 时出现在 volatile 层，且位于 Project Instructions 之后、Local Environment Rules 之前。
- `SOUL.md` 只从 config home 加载，不从 cwd 加载。
- `USER.md` 空文件不注入。
- 高风险 `SOUL.md` / `USER.md` 不注入。
- `/context` 和 `/profile status` 展示加载、阻断与截断诊断。
- `/profile init` 创建缺失模板且不覆盖已有文件。
- `USER.md` pending 更新可入队、列出、批准合并；高风险候选不能入队。
- 三模式一致：REPL、print、backend/TUI 走同一 prompt builder 语义。

---

## 相关文档

- [memory-system.md](./memory-system.md) — 当前记忆体系总览
- [personalization-design.md](./personalization-design.md) — `local_rules` 自动环境事实
- [skills-flow.md](./skills-flow.md) — skills 如何进入 system prompt
- [compact-service-design.md](./compact-service-design.md) — compact-only 的 session memory 附件
- [prompt-runtime-audit.md](./prompt-runtime-audit.md) — prompt builder 全链路入口审计
