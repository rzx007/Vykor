# Slash Skill 原生调用设计

> 状态：历史设计，已按 2026-09-10 落地后的结构化 items 契约修订。当前权威流程见 [Skill Prompt Flow](../../skill-prompt-flow.md) 和 [Skills Flow](../../skills-flow.md)。

日期：2026-08-31

## 结论

Slash Skill 不需要单独执行接口，也不需要第二套 Skill loader。它是普通用户 prompt 的结构化输入：

```ts
{
  items: [
    {
      type: "skill",
      name: "archify",
      path: "D:/skills/archify/SKILL.md",
      displayName: "Archify",
      source: "project",
    },
    { type: "text", text: " 画一下系统架构" },
  ],
}
```

客户端发送 command catalog 给出的路径作为待校验引用，不发送 Skill 正文。daemon 在 run 执行前按 session cwd 刷新 registry，验证 `name + path`，再生成：

```text
用户显式选择了以下技能，请按出现顺序使用 Skill 工具的 { name, path } 加载并遵循：
1. archify (path: D:/skills/archify/SKILL.md)

用户输入：
$archify 画一下系统架构
```

模型随后调用原生 `Skill { name, path }`。工具再次确认 path 与按 name 解析的当前赢家一致，并返回 Skill file、Skill root 和正文。

## 演进说明

本设计在 2026-08-31 首次落地时使用过单数 `skillInvocation` metadata，只能表达正文开头的一个 Skill。2026-09-10 的结构化 composer 方案把它替换为有序 `SessionUserInputItem[]`，支持正文中多个 Skill、编辑恢复、复制降级和服务端统一校验。旧 metadata 不再读取、转换或双写。

本文件以下内容描述最终契约，不再把中间 metadata 方案作为现行 API。

## 目标

- `/` 或 `$` 选择的 Skill 进入普通 prompt API；
- Desktop 选择时只插入行内引用，发送时才 admission；
- TUI `/<skill> args` 回车后提交 Skill + text items；
- `SKILL.md` 正文不作为用户消息发送或持久化；
- 服务端不信任 renderer 提交的任意路径，只接受当前 cwd catalog 赢家；
- 同一输入可包含多个 Skill，并保留用户表达顺序；
- Agent 通过原生 `Skill` 工具读取当前正文；
- transcript 保存 items 展示快照，消息 UI 不显示绝对路径或正文；
- Skill 能以真实 `Skill root` 定位 `scripts/`、`references/` 和 `assets/`。

## 非目标

- 不新增 `/sessions/:id/commands` 或通用 `runCommand`；
- 不把 Skill 正文拼进 system prompt；
- 不给 `QueryEngine` 增加 Skill 专用输入类型；
- 不提供旧 metadata 的兼容读取或迁移；
- 不保证执行选择时的历史 Skill 快照；工具调用读取当前 registry 内容；
- 不改变模型自行按名称发现和调用 Skill 的路径。

## 数据结构

协议事实来源是 `packages/protocol/src/session-input-items.ts`：

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

`items` 是 durable input 的事实来源。`content` 由 items 派生，用 `$name` 表示 Skill，供 transcript、搜索和纯文本导出。`displayName` 和 `source` 是展示快照；`path` 参与安全解析，不直接授权文件读取。

## 选择与提交

### Command catalog

`GET /commands?cwd=...` 使用统一扩展发现，并把所有 `userInvocable` Skill 映射为：

```ts
{
  kind: "template",
  name: "/archify",
  skillName: "archify",
  path: "D:/skills/archify/SKILL.md",
  displayName: "Archify",
  source: "project",
}
```

Builtin session command 与 Skill command 重名时 builtin 胜出。

### Desktop

picker 选择 Skill 后创建 `SkillMentionNode`，不触发 IPC。发送时 composer document 变为有序 items，经 `window.desktop.sessions.sendPrompt()` 和 `OpenHarnessClient.admitPrompt()` 进入普通 prompt API。

### TUI

本地和共享 slash dispatcher 未处理命令后，TUI 检查 catalog。template 命中时立即提交一个 Skill item，并把 args 作为后续 text item。未知 slash 不进入模型。

## 服务端执行

`SessionRunExecutor` 在实际执行时：

1. 读取 durable input；
2. 用 session cwd 重新发现 Skill registry；
3. 用 `resolvePath(path)` 校验路径，并确认解析出的 name 与 item name 相同；
4. 按路径去重 Skill，保留首次出现顺序；
5. 用 `session-input-materializer.ts` 生成一次工具调用要求；
6. 附件如有需要先路由，再把要求放入第一个文本 block；
7. 调用 `agent.submitMessage()`，传递原始 `inputItems` 和 durable IDs。

校验失败使用 `session_input_skill_catalog_mismatch`，registry 无法取得使用 `session_input_skill_catalog_unavailable`。

## 原生 Skill 工具

工具输入：

```ts
{ name: string, path?: string }
```

工具调用时刷新文件系统 registry：

- 无 path：按 name 读取当前赢家；
- 有 path：path 必须解析到与 name 当前赢家相同的定义；
- 失败：返回 `Skill not found: <name>`，并标记 `isError`；
- 成功：返回 Skill file、Skill root、相对路径说明、正文和 shell/path 环境提醒。

工具只信任 registry 的解析结果，不信任 input 自带的任意路径。

## Transcript

`SessionTranscriptProjection` 把派生 `input.content` 写入用户 text part，并把原始 `input.items` 放进 `metadata.items`。Desktop 由 items 还原文本和 Skill 名称，保留原顺序，但不渲染 path 或正文。

复制到纯文本时 Skill 降级为 `$name`；应用内结构化粘贴必须再次对照当前 catalog，不匹配时同样降级为文本。

## 验收

1. Desktop `/`、`$` 选择不会立即发送，发送后 IPC 收到有序 items；
2. TUI template slash 提交 Skill + args items，未知 slash 失败关闭；
3. store 持久化 items，content 是稳定派生文本；
4. executor 对 name/path mismatch 零正文读取并让 run 失败；
5. Agent 收到包含所有去重 Skill 的有序工具调用要求；
6. `Skill { name, path }` 返回 file/root/content，错误引用返回工具错误；
7. transcript 显示 Skill 名称和任务，不显示绝对路径或正文；
8. 普通 prompt 没有 Skill/context 时不经过 materialize 改写；
9. `pnpm check-docs` 通过，当前权威文不再出现旧单数 metadata。
