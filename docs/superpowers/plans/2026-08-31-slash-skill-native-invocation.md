# Slash Skill 原生调用实施记录

> 状态：历史实施计划。08-31 首次落地的单数 metadata 已在 09-10 被结构化 items 替换；本文已按最终落地结果修订。当前流程见 [Skill Prompt Flow](../../skill-prompt-flow.md)。

**目标：** Slash Skill 通过普通 prompt 提交结构化 Skill 引用，由 Agent 使用原生 `Skill` 工具加载正文；消息列表只展示 Skill 名称和用户任务。

**最终架构：** `GET /commands` 提供当前 cwd 可调用的 Skill 目录和可信候选 path。Desktop 把 `/`、`$` 选择变成 composer item，TUI 把 template slash 变成 Skill + text items；durable input 保存有序 items。`SessionRunExecutor` 在执行时重新校验 catalog，materializer 只生成工具调用要求，正文由 `Skill { name, path }` 现读。

**技术栈：** TypeScript、Vitest、React、Lexical、Electron IPC、Hono、OpenHarness Session Runtime。

## 演进

08-31 的中间实现使用单数 `skillInvocation`，解决了「不要把 Skill 正文直接展开成用户消息」的问题。09-10 为支持多个行内 Skill、编辑恢复和统一 composer 协议，改成：

```ts
type SessionUserInputItem =
  | { type: "text"; text: string }
  | { type: "skill"; name: string; path: string; displayName?: string; source?: SkillSource }
  | { type: "mention"; name: string; path: string; displayName?: string }
  | { type: "context"; kind: "conversation"; id: string; displayName: string }
```

旧字段不双写、不迁移，也不作为当前接口接受。本记录保留实施顺序，但使用最终模块名和契约。

## 最终文件结构

- `packages/protocol/src/session-input-items.ts`：共享 items 类型、校验、规范化和纯文本派生。
- `packages/client/src/transport/http-client.ts`：保留普通 `admitPrompt()`，不提供 Skill command POST。
- `packages/server/src/commands/default-command-catalog.ts`：只发现 `userInvocable` Skill，并携带当前 path。
- `packages/server/src/application/session/session-input-materializer.ts`：校验当前 catalog 引用，生成本轮工具调用要求。
- `packages/server/src/application/session/session-run-executor.ts`：附件路由后应用 materialized input，再提交 Agent。
- `packages/tools/src/meta/skill.ts`：按 name 和可选 path 加载，返回正文、Skill file 和 Skill root。
- `packages/server/src/application/session/transcript-projection.ts`：把 items 复制到用户 text part metadata。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/`：结构化 Skill picker 和 Lexical 节点。
- `apps/desktop/src/main/features/session/session-service.ts`：普通 prompt IPC 原样转发 items。
- `apps/frontend/src/hooks/useServerSync.ts`：TUI template slash 提交 Skill + text items。

## 已完成任务

### 任务 1：统一结构化输入协议

- [x] 定义 `SessionUserInputItem` 和限制。
- [x] 让 Desktop 新会话、已有会话、编辑、重试和恢复都使用 ordered items。
- [x] 保持附件为独立字段，不与 composer items 混排。
- [x] 删除旧单数 Skill 调用字段和 command POST 路径。

### 任务 2：Skill catalog 与路径校验

- [x] template catalog entry 携带 `skillName`、path、displayName 和 source。
- [x] renderer 只能从当前 catalog 选择 Skill。
- [x] executor 按 session cwd 重新发现 registry。
- [x] `resolvePath(path)` 结果必须与 item name 一致；不匹配时以 `session_input_skill_catalog_mismatch` 结束 run。

### 任务 3：本轮 Agent 输入转换

- [x] 按 Skill 首次出现顺序收集并按 path 去重。
- [x] 生成现行指令：

```text
用户显式选择了以下技能，请按出现顺序使用 Skill 工具的 { name, path } 加载并遵循：
1. archify (path: D:/skills/archify/SKILL.md)

用户输入：
$archify 画一下系统架构
```

- [x] 普通 prompt 无 Skill/context 时保持原内容。
- [x] 有附件时保留 `ContentBlock[]`，只给首个文本 block 增加指令。

### 任务 4：原生 Skill 工具精确加载

- [x] `Skill` 接受必需 name 和可选 path。
- [x] 有 path 时同时匹配 path 和按 name 解析的当前赢家。
- [x] 返回 Skill file、Skill root、正文和执行环境提醒。
- [x] 不信任工具 input 中的路径直接读文件。

### 任务 5：Transcript 与 UI

- [x] 用户 text part 的 `metadata.items` 保留结构化顺序。
- [x] Desktop 行内展示 Skill 名称和用户文本。
- [x] 消息、复制和编辑不展示或解析绝对路径与 Skill 正文。
- [x] 结构化粘贴对照当前 catalog，失败则降级为 `$name` 文本。

### 任务 6：端到端接线

- [x] Desktop 选择 Skill 只插入节点，发送后才调用 `sendPrompt`。
- [x] TUI `/<skill> args` 命中 template 后直接 `admitPrompt({ items })`。
- [x] Builtin session command 在重名时优先。
- [x] 未知 slash 失败关闭，不发给模型。

## 当前验证入口

相关自动测试位于：

- `packages/protocol/src/session-input-items.test.ts`
- `packages/server/src/application/session/__test__/session-input-materializer.test.ts`
- `packages/server/src/application/session/__test__/session-run-executor.test.ts`
- `packages/server/src/application/session/__test__/transcript-projection.test.ts`
- `packages/tools/src/__test__/registry.test.ts`
- `apps/frontend/src/hooks/useServerSync.test.tsx`
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/__test__/`
- `apps/desktop/src/renderer/src/stores/desktop-session/prompt-actions.test.ts`

文档验收使用：

```bash
pnpm check-docs
```

执行行为和失败边界以当前代码、上述测试与 [Skill Prompt Flow](../../skill-prompt-flow.md) 为准。
