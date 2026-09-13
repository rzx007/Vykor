# Slash Commands Flow

> 状态：当前 daemon/TUI 主线。斜杠命令**不是**通用 `runCommand`；按三层分流。
> 呈现/派发层在 `@openharness/client`（`dispatchSessionCommand`），TUI/Web/Desktop 共用。
> 命令清单参考 [slash-commands.md](./slash-commands.md)；daemon 协议见 [daemon-application-architecture.md](./daemon-application-architecture.md)、[client-sync-flow.md](./client-sync-flow.md)。

## 目标

用户输入 `/...` 时：

1. 先命中 **client-local UI**（会话切换、主题、权限弹层等）。
2. 再命中 **session/resource 命令**（catalog + HTTP 资源 API，呈现文案由共享模块生成）。
3. 再命中 **template/skill**（普通 prompt 的结构化 `items` → 正常 admit/run → 原生 Skill 工具加载）。
4. 未知 `/...` **失败关闭**，不得当普通用户消息发给模型。

长期约束：

- Server **不**托管旧 REPL `slash-commands.ts` registry。
- Server catalog（`GET /commands`）只提供元数据；状态变更走资源 API。
- 呈现层（拼系统消息、调 `OpenHarnessClient`）放在 `@openharness/client`，不绑 TUI React。

## 分层

```text
┌─────────────────────────────────────────────────────────────────┐
│  Host UI（TUI App / 未来 Web / Desktop）                         │
│  · /new /resume /sessions /theme /permissions /jobs /workflow … │
│  · template invoke 的 busy/run 状态（setLocalBusy 等）            │
└────────────────────────────┬────────────────────────────────────┘
                             │ slash line
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  @openharness/client  dispatchSessionCommand(host)               │
│  · parseSlashLine / mergeCommandDetails / LOCAL_COMMAND_*        │
│  · /config /memory /jobs list|show|cancel /background … 呈现 + API│
│  · emit(text) 把系统消息交回宿主                                  │
│  · outcome: handled | local_ui | unhandled                       │
└────────────────────────────┬────────────────────────────────────┘
                             │ unhandled + catalog.kind===template
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  OpenHarnessClient.admitPrompt                                   │
│  · items 保留 Skill 引用与用户任务的原始顺序                       │
│  · Skill item 携带 catalog 的 name/path，不携带正文                │
│  → run executor 生成显式调用要求 → Agent 原生 Skill 工具加载       │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Daemon (@openharness/server)                                    │
│  · GET /commands          catalog（builtin session + skills）    │
│  · PATCH /sessions/:id    runtime config 等                     │
│  · GET/PATCH /settings    /config /effort /fast /turns …         │
│  · 其它资源 API           memory / jobs / background-shells …   │
│  · MaintenanceService -> AgentPool / OpenHarnessAgent            │
│                           compact / remember / mcp inspect …     │
└─────────────────────────────────────────────────────────────────┘
```

## 涉及模块

| 组件 | 路径 | 职责 |
| --- | --- | --- |
| Builtin catalog | `packages/server/src/commands/commands.ts` | `BUILTIN_SESSION_COMMANDS` + `mergeCommandCatalog` |
| HTTP routes | `packages/server/src/http/server.ts` | `/commands` 发现接口、Session prompt、Jobs/后台 shell 等资源 API |
| Default catalog | `packages/server/src/commands/default-command-catalog.ts` | cwd 下 skill/plugin templates 与 builtin catalog |
| Skill input materializer | `packages/server/src/application/session/session-input-materializer.ts` | 校验结构化 Skill 输入，并在执行前生成“先调用 Skill 工具”的 Agent 输入 |
| Native Skill tool | `packages/tools/src/meta/skill.ts` | 按注册表读取实际 `SKILL.md`，返回 Skill 文件、根目录和正文 |
| Application services | `packages/server/src/application/default-application-services.ts` | settings/memory/git/plugins 等命令依赖 |
| Shared dispatch | `packages/client/src/commands/session-commands.ts` | 呈现层 + 资源 API 调用 |
| TUI adapter | `apps/frontend/src/hooks/sessionSlashCommands.ts` | React ctx → `SessionCommandHost` |
| TUI sync | `apps/frontend/src/hooks/useServerSync.ts` | `/new` `/resume`、template busy、admitPrompt |
| TUI App | `apps/frontend/src/App.tsx` | 本地 UI 命令（theme/sessions/permissions…） |
| Helpers（非执行器） | `apps/cli/src/commands/slash-helpers.ts` | prompt/profile 格式化，供 daemon-services |

## 提交流程（TUI）

```text
用户 Enter
  → App / useServerSync sendRequest({ type: "submit_line", line })
  → parseSlashLine(line)

  /new | /sessions open <session-id>
      → 宿主会话生命周期（createAndSwitchSession / getSession）
      → return

  /resume [run-id]
      → 从当前 reducer state 筛选 prompt-backed interrupted run
      → 无参数时打开恢复选择器；有 run-id 时调用
        POST /sessions/:id/runs/:runId/resume
      → server 复制原始 prompt，创建带 recovery 溯源的新 input/run
      → return

  dispatchSessionSlashCommand  (frontend adapter)
      → resolveSessionCwd(status, daemon)
      → dispatchSessionCommand(slash, host)
           ├─ handled     → emit 系统消息，结束
           ├─ local_ui    → 交给 App 已处理的 UI 命令（或忽略）
           └─ unhandled   → 继续

  catalogEntry.kind === "template"
      → client.admitPrompt(sessionId, {
          items: [
            { type: "skill", name: skillName, path, displayName?, source? },
            ...(args ? [{ type: "text", text: ` ${args}` }] : [])
          ]
        })
      → setSubmittedRun

  仍是 slash 且未处理
      → emit "Unknown command: /…"
      → 不 admitPrompt

  普通文本
      → client.admitPrompt(sessionId, { items: [{ type: "text", text: line }] })
```

Web/Desktop 应复用同一语义：session 命令仍由宿主或共享 dispatcher 处理；Skill 则统一提交普通 prompt 和结构化 items。Desktop 中从 `/` 或 `$` 菜单选中 Skill 时只插入行内 Skill 引用，不立即发送；用户发送后才调用 `admitPrompt`。消息列表根据 text part 的 `metadata.items` 显示 Skill 名称，不显示绝对路径或 `SKILL.md` 正文。

## SessionCommandHost（共享契约）

```ts
type SessionCommandHost = {
  client: OpenHarnessClient;
  sessionId?: string;
  cwd: string;
  model?: string;
  permissionMode?: string;
  statusSessionId?: string;
  commandCatalog: CommandCatalogEntry[];
  clientState: OpenHarnessClientState;
  busy: boolean;
  emit(text: string): void;
  patchStatus?(patch: Record<string, unknown>): void;
};

type SessionCommandOutcome = "handled" | "unhandled" | "local_ui";
```

- `emit`：呈现层唯一出口（系统/通知文案）。
- `patchStatus`：可选；`/plan` `/provider` 写本地 UI 状态。
- `cwd`：由宿主解析（`resolveSessionCwd`），不要在共享层读 React refs。

## 命令归属速查

| 层 | 代表命令 | 执行位置 |
| --- | --- | --- |
| Client-local UI | `/new` `/sessions` `/resume` `/models` `/theme` `/permissions`，以及无参数 `/jobs`、`/workflow(s)` | 宿主 App；后三者打开同一个 Jobs Panel；`/resume` 调用专用恢复 API，catalog 可不列或仅 autocomplete |
| Shared session（资源 API） | `/config` `/provider` `/mcp` `/jobs list\|show\|cancel` `/background` `/memory` `/auth` `/context` `/stats` `/agents` `/compact` `/rewind` `/remember` `/dream` `/profile` `/doctor` `/effort` `/fast` `/turns` `/usage` `/cost` `/export` `/output-style` `/init` `/plugin` `/reload-plugins` `/hooks` `/subagents` `/diff` `/branch` `/commit` `/help` `/status` `/version` `/skills` | `dispatchSessionCommand` |
| Template | 带可校验文件 path 的 project/user/plugin user-invocable skills | 普通 `admitPrompt` + 结构化 Skill/text items；运行时交给原生 Skill 工具。内嵌 bundled Skill 当前不能通过这条用户路径执行 |
| 禁止 | 通用 `runCommand`、未知 slash 当 prompt | — |

`/plan`：App 无参 toggle 会改写成 `/plan on|off`；共享层只处理 on/off 并 `patchStatus`。

`/models`：TUI 本地弹窗，不进共享 dispatch。没有 active session 时，它改 settings，作为下一条新 session 的默认模型；有 active session 时，它 PATCH `metadata.runtime.model`，daemon 关闭旧 agent，下一轮消息重建并生效。旧的 `PATCH /sessions/:id { model }` 不再支持。

`/background <command>`：共享层调用 `POST /background-shells`。创建成功后 TUI 走现有 Jobs 刷新路径；失败或只有空参数时不刷新。`/jobs show|cancel` 走统一 Job API。无参数 `/jobs` 由 App 拦截并打开 Jobs Panel，避免同时出现文字列表和面板。

## Catalog 与 template

```text
GET /commands?cwd=
  → mergeCommandCatalog(BUILTIN_SESSION_COMMANDS + skill/plugin extras)
  → 客户端 mergeCommandDetails(+ LOCAL_COMMAND_DETAILS) 做 /help 与 autocomplete

POST /sessions/:id/prompts
  {
    items: [
      { type: "skill", name: "archify", path: ".../archify/SKILL.md" },
      { type: "text", text: " 用户任务" }
    ]
  }
  → 与普通 prompt 同一 input/run 队列
  → run executor 用当前 cwd catalog 校验 name/path
  → materializer 生成显式的 Skill 工具调用要求
  → Agent 调用原生 Skill 工具
  → Skill 工具再次按 name/path 解析当前赢家，并返回 Skill file、Skill root 与内容
```

客户端发送 command catalog 给出的 Skill 路径作为待校验引用，但不发送 `SKILL.md` 内容。daemon 执行前用当前 cwd catalog 重新验证路径和名称；真正加载发生在 Agent 调用原生 Skill 工具时，因此 Skill 内部相对路径始终以工具返回的 `Skill root` 为准。完整执行和失败边界见 [Skill Prompt Flow](./skill-prompt-flow.md)。

Builtin session 名与 skill 重名时 **builtin 胜出**（例如 `/commit` 是 git 资源命令，不再当 template）。

内嵌 bundled Skill 的 catalog path 为空：Desktop 会过滤，TUI 提交后也无法通过执行前 catalog 校验。当前可靠入口是模型按 name 调用 `Skill` 工具，不属于可成功执行的 template 用户路径。

## 失败关闭

| 情况 | 行为 |
| --- | --- |
| 未知 `/foo` | 系统消息 `Unknown command: /foo`；**不**调用 admitPrompt |
| session 命令缺 `sessionId`（需会话的） | 静默 `handled`（与 TUI 现状一致） |
| 资源 API 4xx/5xx | 由宿主 `sendRequest` 外层 error 路径处理（adapter 不吞） |

## 与旧 REPL 的边界

| 旧（已拆除） | 现 |
| --- | --- |
| `registerBuiltinCommandsOnRegistry` | 无；catalog + `dispatchSessionCommand` |
| 进程内 `QueryEngine` 上改历史 | store `replaceTranscript` + `closeRuntime`（如 `/rewind` `/compact`） |
| print 斜杠 | **不支持**完整 slash 面；print 是一次性 prompt |

print 走 daemon Session API，不走本 flow。旧 `--task-worker` 入口已退场。见 [daemon-application-architecture.md](./daemon-application-architecture.md)。

## Web/Desktop 接入清单

1. 用 `@openharness/client`：`OpenHarnessClient` + `hydrateState`/`syncEvents`。
2. 拉取 `listCommands({ cwd })`，与 `LOCAL_COMMAND_DETAILS` 合并做 autocomplete。
3. 提交行：本地 UI → `dispatchSessionCommand` → Skill 则 `admitPrompt({ items: [skill, text] })` → unknown 拦截 → 普通文本 `admitPrompt`。
4. 实现 `emit`（transcript / toast）与可选 `patchStatus`。
5. `/new` `/sessions` 等会话生命周期由宿主自己接 HTTP；`/resume` 必须调用专用恢复 API，不能把旧 prompt 当普通文本悄悄重新发送（与 TUI `useServerSync` 对齐即可）。

## 相关文档

- [slash-commands.md](./slash-commands.md) — 命令清单（参考）
- [client-sync-flow.md](./client-sync-flow.md) — snapshot + SSE
- [daemon-application-architecture.md](./daemon-application-architecture.md) — HTTP API 与 slash 边界
- [skills-flow.md](./skills-flow.md) — Skill 发现、注册表与两条调用路径
- [skill-prompt-flow.md](./skill-prompt-flow.md) — 结构化 Skill 输入从发送到 Run 收尾
- [tui-flow.md](./tui-flow.md) — TUI 启动与 attach
