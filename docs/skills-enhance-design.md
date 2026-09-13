# Skills 增强与内置 Skills（E.5）

> 状态：历史设计记录，正文已按当前 daemon/结构化输入实现修订。当前总览见 [Skills Flow](./skills-flow.md)，发送到结束见 [Skill Prompt Flow](./skill-prompt-flow.md)。

## 目标与落地结果

E.5 最初解决四件事，当前均已并入统一扩展和 Session 运行链：

1. `userInvocable` Skill 进入 `/`、`$` 用户目录；
2. bundled Skill 随应用提供，并可被模型按名称调用；
3. frontmatter 支持用户可调用性、模型可见性、命令名、展示名和参数提示；
4. 模型通过原生 `Skill` 工具按需读取正文，而不是把所有正文放进 system prompt。

旧 REPL 曾把 `skill.content` 拼进一次 prompt。当前用户显式选择 Skill 时，客户端提交结构化 item：

```ts
{
  type: "skill",
  name: "review",
  path: "D:/skills/review/SKILL.md",
  displayName: "Review",
  source: "project",
}
```

daemon 先用当前 cwd catalog 校验 `name + path`，再要求模型调用 `Skill { name, path }`。catalog、用户消息和 system prompt 都不包含 `SKILL.md` 正文。

## 当前组件

| 组件 | 位置 | 当前职责 |
| --- | --- | --- |
| `SkillDefinition` / `SkillRegistry` | `packages/skills/src/index.ts` | frontmatter、多来源加载、名称与路径解析、覆盖赢家 |
| bundled Skills | `packages/skills/src/bundled.ts` | 随包提供的内嵌 Skill |
| 扩展发现 | `packages/agent-runtime/src/extensions.ts` | 合并 bundled、标准全局、用户、项目和 plugin Skill |
| 用户目录 | `packages/server/src/commands/default-command-catalog.ts` | 将 `userInvocable` Skill 映射为 template command |
| Desktop 输入 | `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/` | `/`、`$` 选择后插入 `SkillMentionNode` |
| TUI 输入 | `apps/frontend/src/hooks/useServerSync.ts` | template slash 转成 Skill + text items |
| 服务端展开 | `packages/server/src/application/session/session-input-materializer.ts` | 校验引用并生成 Skill 工具调用要求 |
| 原生工具 | `packages/tools/src/meta/skill.ts` | `Skill` / `ListSkills`，返回可信位置和正文 |

## Frontmatter

核心字段及语义：

- `user-invocable`：是否进入用户 Skill 菜单，默认 `true`；
- `disable-model-invocation`：是否从模型可发现清单排除，默认 `false`；
- `command-name`：slash command 名，默认使用 `name`；
- `display-name`：UI 显示名称；
- `argument-hint`：参数提示；
- `model`：定义仍可解析，但当前结构化 Session 提交不会为单个 Skill 临时切换模型。

`userInvocable` 与 `disableModelInvocation` 正交。前者控制用户入口，后者控制模型主动发现；用户显式选择的隐藏 Skill 仍能通过结构化 item 要求模型加载。

## 来源与覆盖

当前 registry 统一接收 bundled、标准全局目录、OpenHarness 用户目录、项目目录和 Native Plugin 基线。项目目录从 git root 向 cwd 逐层发现，越接近 cwd 的定义优先。路径解析只接受当前 registry 中仍然有效的赢家。

当前 bundled Skill 是内嵌定义，`path` 为空。虽然定义保留 `userInvocable` 元数据，但结构化用户调用必须有可校验 path：Desktop 会从 picker 目录过滤 bundled 条目，TUI 若提交空 path 会在执行前校验失败。因此 bundled 当前可靠入口是模型按 name 调用，不应宣传为用户可直接选择。

同名 builtin session command 优先于 template Skill。例如 `/commit` 由共享 session command 处理；同名 bundled Skill 当前仍可被模型按名称使用。

## 用户调用流程

### Desktop

`/` 或 `$` 打开 picker，选中后只插入 Skill 引用，不发送。用户继续输入任务并发送后，`sendPrompt({ items })` 进入普通 Session API。

### TUI

`/<skill> args` 先经过本地 UI 和共享 session command；未处理且 command catalog 命中 template 时，立即提交：

```ts
[
  { type: "skill", name, path, displayName, source },
  { type: "text", text: ` ${args}` },
]
```

未知 slash 失败关闭，不转成普通 prompt。

## 模型调用流程

Runtime system prompt 只列 Skill 名称和描述。模型主动发现时通常调用 `Skill { name }`；用户显式选择时，materializer 明确要求调用 `Skill { name, path }`。

工具刷新文件系统 registry，并在有 path 时确认它和按 name 解析的赢家是同一个定义。成功结果包含 Skill file、Skill root、正文和执行环境提示；相对资源路径以 Skill root 为基准。

## 与原始 E.5 方案的差异

| 原始方案 | 当前实现 |
| --- | --- |
| CLI REPL/BackendHost 进程内加载 Skill | daemon/runtime 统一执行扩展发现 |
| `/<skill>` 直接拼接 `skill.content` | 提交结构化 items，正文由 Skill 工具读取 |
| 单次用户入口只表达一个 Skill | composer items 可保留多个 Skill 及其顺序 |
| 工具只按名称返回正文 | 工具支持可选 path，并返回 Skill file/root |
| BackendHost emit 运行事件 | durable input/run + projector + SSE |

这些差异不是兼容分支；旧 BackendHost、正文注入和单数 Skill 调用数据都不是当前协议。
