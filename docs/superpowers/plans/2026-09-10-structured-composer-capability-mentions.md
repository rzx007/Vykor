# 结构化输入框与多能力引用实施记录

> 状态：历史实施计划，结构化 items 已落地。本文已按最终文件和运行契约整理，不再作为待执行任务；当前流程见 [Skill Prompt Flow](../../skill-prompt-flow.md)。

**目标：** 将 Desktop 输入框从字符串开头的单 Skill 命令升级为有序结构化文档，支持通过 `/` 或 `$` 插入多个 Skill 引用，并在发送、排队、重试、编辑、恢复和 transcript 中保留引用顺序。

**最终架构：** `@openharness/protocol` 定义 `SessionUserInputItem` 和派生纯文本规则；Session store 持久化 `items_json`；Desktop 使用 Lexical 文档作为编辑期事实来源。Skill catalog 提供 `name + path`，daemon 在 run 执行前按当前 cwd registry 校验，materializer 生成 `{ name, path }` 工具调用要求，原生 `Skill` 工具读取正文。

**技术栈：** TypeScript、React、Lexical、Zustand、Electron IPC、Drizzle/SQLite、Vitest、Tailwind CSS。

## 最终数据契约

```ts
type SessionUserInputItem =
  | { type: "text"; text: string }
  | {
      type: "skill"
      name: string
      path: string
      displayName?: string
      source?: "bundled" | "user" | "project" | "plugin"
    }
  | { type: "mention"; name: string; path: string; displayName?: string }
  | { type: "context"; kind: "conversation"; id: string; displayName: string }
```

- `items` 是 durable input 和 composer 恢复的事实来源；
- `content` 由 items 派生，Skill 表示为 `$name`；
- 附件保持独立 refs，不进入 composer items；
- 相邻 text 合并，空 text 删除；
- 文档顺序贯穿提交、pending、retry、edit、transcript；
- 旧单数 Skill metadata 不读取、不转换、不双写。

## 最终模块

| 模块 | 当前文件 | 结果 |
| --- | --- | --- |
| 协议 | `packages/protocol/src/session-input-items.ts` | items 类型、限制、规范化和纯文本派生 |
| 存储 | `packages/services/src/session-runtime/schema.ts`、`store.ts` | `items_json` 持久化和旧记录不兼容处理 |
| Skill registry | `packages/skills/src/index.ts` | 当前赢家的 name/path 解析 |
| Command catalog | `packages/server/src/commands/default-command-catalog.ts` | user-invocable Skill template 与 path |
| 输入 materializer | `packages/server/src/application/session/session-input-materializer.ts` | Skill/context 校验与 Agent 文本转换 |
| Run 执行 | `packages/server/src/application/session/session-run-executor.ts` | catalog、附件、materializer 和 submitMessage |
| Skill 工具 | `packages/tools/src/meta/skill.ts` | name + 可选 path 精确加载 |
| Desktop composer | `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/` | Lexical document、picker、SkillMentionNode |
| Desktop store | `apps/desktop/src/renderer/src/stores/desktop-session/` | draft、pending、queue、retry 和 edit 保留 items |
| Desktop IPC | `apps/desktop/src/main/features/session/session-service.ts` | `sendPrompt({ items })` 转发 |
| TUI | `apps/frontend/src/hooks/useServerSync.ts` | template slash 转 Skill + text items |
| Transcript | `packages/server/src/application/session/transcript-projection.ts` | text part `metadata.items` |

## 已落地任务

### 任务 1：结构化 Session 输入

- [x] 在 protocol 定义 text、skill、mention 和 conversation context items。
- [x] 限制 256 items、32 Skill、1 MiB UTF-8 text，并校验控制字符和字段长度。
- [x] 为 Session input 添加必填 items 和派生 content。
- [x] SQLite 持久化 `items_json`，旧格式不做静默迁移。

### 任务 2：Skill catalog 与工具精确路径

- [x] template catalog entry 带 `skillName`、path、displayName 和 source。
- [x] `SkillRegistry.resolvePath()` 只匹配当前非空 path 赢家。
- [x] `Skill` 工具接受可选 path；有 path 时必须与按 name 解析的赢家相同。
- [x] 工具返回 Skill file、Skill root、正文和执行环境提醒。

内嵌 bundled Skill 的 path 为空，当前不能通过结构化用户引用成功执行；Desktop 会过滤，TUI 提交也会在执行前校验失败。它仍可由模型使用 `Skill { name }` 加载。

### 任务 3：服务端 materializer

- [x] 执行时按 session cwd 重新发现 registry。
- [x] 校验每个 Skill item 的 name/path，失败使用稳定错误码。
- [x] 按首次出现顺序收集，按 path 去重。
- [x] 生成现行指令：

```text
用户显式选择了以下技能，请按出现顺序使用 Skill 工具的 { name, path } 加载并遵循：
1. writing-plans (path: D:/skills/writing-plans/SKILL.md)

用户输入：
使用 $writing-plans 写计划
```

- [x] 附件继续路由为 ContentBlock，并在首个文本 block 加入指令。

### 任务 4：Desktop Lexical composer

- [x] Skill 作为 `SkillMentionNode` 行内原子节点。
- [x] `/` 首字符显示应用命令和 Skill，inline `/` 只显示可插入能力，`$` 显示 Skill。
- [x] 选择 Skill 只替换 token 并移动光标，不立即发送。
- [x] draft、提交失败恢复、切换会话、重试和编辑都使用同一 ComposerDocument codec。
- [x] 应用内复制保留候选结构；粘贴时对照当前 catalog，失效引用降级为 `$name` 文本。

### 任务 5：Session store 与 Desktop IPC

- [x] 新会话第一条 prompt 和已有会话都转发 ordered items。
- [x] pending、optimistic transcript、queue、steer、retry 和 edit 保存相同快照。
- [x] main process 校验 items 和 source 后调用普通 `admitPrompt`。
- [x] 删除 Skill 专用 command IPC 和旧字符串解析路径。

### 任务 6：Transcript 与历史恢复

- [x] projection 在用户 text part 的 `metadata.items` 保存结构化顺序。
- [x] Desktop 按 items 渲染文本和 Skill 名称，不展示 path。
- [x] skill-only 消息仍有可见名称，复制和编辑保持可用。
- [x] snapshot/SSE 重连与历史消息使用同一投影事实。

### 任务 7：TUI 收敛

- [x] TUI template slash 发送 Skill + args items。
- [x] 普通文本发送 text item。
- [x] builtin session command 重名时优先。
- [x] 未知 slash 失败关闭。

## 验证入口

自动测试集中在：

- `packages/protocol/src/session-input-items.test.ts`
- `packages/services/src/session-runtime/__test__/store.test.ts`
- `packages/server/src/application/session/__test__/session-input-materializer.test.ts`
- `packages/server/src/application/session/__test__/session-run-executor.test.ts`
- `packages/server/src/application/session/__test__/transcript-projection.test.ts`
- `packages/tools/src/__test__/registry.test.ts`
- `apps/frontend/src/hooks/useServerSync.test.tsx`
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/__test__/`
- `apps/desktop/src/renderer/src/stores/desktop-session/prompt-actions.test.ts`
- `apps/desktop/src/renderer/src/stores/desktop-session/session-actions.test.ts`

文档收束运行：

```bash
pnpm check-docs
```

当前代码、自动测试和 [Skill Prompt Flow](../../skill-prompt-flow.md) 高于本历史记录。
