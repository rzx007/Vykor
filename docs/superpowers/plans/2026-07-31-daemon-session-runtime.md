# Vykor Daemon Session Runtime 实现计划

> **面向代理式工作者：** 必需子技能：使用 superpowers:executing-plans，或等效的清单驱动实现循环。工作完成时更新复选框。

**目标：** 用类似 opencode 的 daemon/server runtime 替换遗留的单一 `BackendHost` TUI 架构，以支持 TUI、Web、Desktop、远程 attach、持久化 session，以及跨客户端恢复。

**当前实现：** [Daemon Application Architecture](../../daemon-application-architecture.md)

---

## 文件地图

| 动作 | 路径 | 职责 |
|---|---|---|
| 创建 | `packages/session` 或 `packages/services/src/session-runtime` | 持久化 session store、事件日志、run coordinator |
| 创建 | `packages/server` | HTTP API、SSE 流、本地 daemon 认证 |
| 修改 | `apps/cli/src/index.ts` | 增加 `serve` / daemon / attach 命令 |
| 修改 | `apps/cli/src/commands/main.ts` | 移除主线 `BackendHost` 路径；`vk --tui` 经 daemon 路由 |
| 修改 | `packages/core/src/engine/query-engine.ts` | 接受显式 cwd/location、runtime 事件 hook、取消能力 |
| 修改 | `packages/core/src/types/runtime.ts` | 增加 session 感知的 runtime 与 permission broker 类型 |
| 修改 | `packages/sandbox` | 用按 session/location 作用域的注册表替换全局活跃 session |
| 修改 | `apps/frontend` | 用 server sync 客户端接管 TUI 数据流 |
| 创建 | `packages/client` | 供 TUI/Web/Desktop 共用的 API 客户端与事件 reducer |

---

## Task 0：遗留路径退场

- [x] 将迁移前状态留在 Git 历史，不在当前代码维护兼容分支。
- [x] 在 `docs/tui-flow.md` 中说明：LegacyJSON BackendHost 已退出当前主线。
- [x] 从当前主线移除 `runBackendHost` 与旧 LegacyJSON host 协议。

退出标准：

- 当前代码不再暴露旧行为入口。
- 主线架构工作不携带旧 host 兼容性假设。

---

## Task 1：持久化存储基础

- [x] 选定最终包位置：`packages/services/src/session-runtime`。
- [ ] 增加 SQLite 依赖与数据库路径解析。
- [x] 将当前文件持久化 adapter 替换为 SQLite adapter。
- [ ] 为以下表实现迁移：
  - `session`
  - `session_input`
  - `session_message`
  - `session_event`
  - `session_run`
  - `permission_request`
- [x] 实现单调事件追加与回放。
- [x] 实现 session 的 create/get/list/archive。
- [x] 实现 message 的 append/list。
- [x] 实现将 prompt 准入到 `session_input`。
- [ ] 增加从现有 JSON `session-<id>.json` 快照的导入。
- [x] 增加事务边界与 cursor 回放的单元测试。

退出标准：

- Store 可以创建 session、准入 prompt、追加 message、追加 event，并按 cursor 回放。
- 本任务尚不依赖任何 runtime 执行代码。

---

## Task 2：Server 骨架

- [x] 创建 `packages/server`。
- [x] 增加带本地 bearer-token 认证的 HTTP server。
- [x] 增加端点：
  - `GET /health`
  - `GET /sessions`
  - `POST /sessions`
  - `GET /sessions/:sessionId`
  - `GET /sessions/:sessionId/messages`
  - `POST /sessions/:sessionId/prompts`
  - `GET /events`
  - `GET /events/stream`
- [x] 增加 `vk serve --register`。
- [x] 增加包含 version/url/pid/token 路径的 daemon 注册文件。
- [x] 增加 `vk daemon start/status/stop`。
- [x] 增加聚焦的 API 测试。

退出标准：

- 客户端可启动 daemon、创建 session、准入 prompt，并在不跑模型的情况下接收持久化事件。

---

## Task 3：Session Runtime 抽取

- [x] 将执行所有权迁移到 server-owned `SessionRuntime`。
- [x] 让 runtime 构造接受显式的 `sessionId` 与 `location.cwd`。
- [x] 尽可能从 runtime 拥有的路径中移除 `process.cwd()`；将 `cwd` 贯穿到 `ToolContext`。
- [x] 确保 runtime 被驱逐或 daemon 停止时调用 `RuntimeBundle.close()`。
- [x] 在 run 前加载持久化消息。
- [x] 在 run 后提交 messages/events。
- [ ] 为活跃 run 增加取消面。
- [x] 使用假流式客户端与假工具增加测试。

退出标准：

- 由 server 拥有的 session 可以运行一次 prompt，并持久化 messages/events。
- 现有 `QueryEngine` 被复用，但 session 所有权不再位于 `BackendHost`。

---

## Task 4：Run Coordinator

- [x] 实现 `SessionRunCoordinator`。
- [x] 强制每个 session 只有一个活跃 run。
- [x] 允许不同 session 并发运行。
- [x] 在 session 运行中合并 wake 请求。
- [x] 实现 interrupt 语义。
- [x] 增加单元测试，覆盖：
  - 同 session 串行
  - 不同 session 并发
  - wake 合并
  - 中断

退出标准：

- 并发 session 在构造上是安全的。

---

## Task 5：Permission Broker

- [x] 定义 `PermissionBroker` 接口。
- [x] 在阻塞 run 之前持久化权限请求。
- [x] 发出 `permission.asked`。
- [x] 实现 `POST /permissions/:requestId/reply`。
- [x] 存储回复并发出 `permission.replied`。
- [x] 增加 session 作用域批准的持久化。
- [x] 定义无头策略：默认失败关闭，除非存在显式自动批准。
- [x] 增加客户端断开与稍后回复的测试。

退出标准：

- 权限请求在客户端断开后仍然存活，并可被另一个已 attach 的客户端回答。

---

## Task 6：SDK 与事件 Reducer

- [x] 创建共享客户端包。
- [x] 为 sessions、prompts、permissions、events 增加类型化 API 方法。
- [x] 增加按 `sessionId` 键控状态桶的事件 reducer。
- [x] 增加回放 + 实时流合并行为。
- [x] 增加乱序、防重复的 reducer 行为测试。

退出标准：

- TUI/Web/Desktop 可共享同一套客户端状态模型。

---

## Task 7：TUI 客户端迁移

- [x] 用 `useServerSync` 接管 TUI 数据流。
- [x] 移除主路径上由 frontend 拥有的 per-session backend 派生。
- [x] 在 TUI 中增加 session 路由/列表/创建。
- [x] 按活跃 session ID 渲染 messages/status/permissions。
- [x] 通过 server API 发送 prompt。
- [x] 通过 server API 回复权限。
- [x] 删除 LegacyJSON 路径与相关命令。
- [x] 增加 TUI reducer/组件测试。

退出标准：

- TUI 可 attach 到 daemon，切换 session，提交 prompt，回答权限，并在重启后恢复。

---

## Task 8：Sandbox、Tasks、MCP 与 Workflow 作用域

- [x] 用按 session/location 键控的注册表替换 sandbox 全局活跃 session。
- [x] 将 task manager 状态按 `sessionId + location/cwd` 键控；同 cwd 多 session 的 task list、wait、stop、output 互不串扰。
- [x] 将 swarm backend registry 按 `sessionId + location/cwd` 键控，避免第一个 runtime 固化 subprocess backend。
- [x] 决定并接线 MCP 生命周期首版：daemon session runtime 按 session/location 创建 `McpClientManager`，合并插件/用户 MCP server，随 runtime 关闭。
  - 后续可把纯静态、无认证的服务器提升为 daemon/project 共享池。
  - 对认证敏感的服务器继续保持 session/项目作用域。
- [x] 将 workflow 事件通过 `ToolContext.runtimeEventSink` 路由到 session 持久事件流。
  - Agent / Workflow runner 的 task spawn、wait、cancel 已使用 session-scoped TaskManager。
- [x] 增加两个 session 使用不同 cwd/sandbox 状态的首批测试，并补充同 cwd 不同 session 的 task/swarm registry 隔离测试。

退出标准：

- 两个并发 session 不会意外共享 cwd、sandbox、task 或权限状态。

---

## Task 9：Session Part Event Model

> 详细执行计划见 [2026-08-01-session-part-event-model.md](./2026-08-01-session-part-event-model.md)。

- [x] 将 `SessionStore` 直接收口为唯一的 message shell + message parts + part delta 模型，不保留旧 store 读取分支。
- [x] 废弃主路径 `session.message.appended` 与 `runtime.*` 客户端协议。
- [x] server runtime adapter 将 QueryEngine 的 `text_delta`、`tool_use_start`、`tool_use_end` 翻译为持久化 `session.message.part.*` 事件。
- [x] `@vykor/client` reducer 支持 message/part/delta，并成为 TUI/Web/Desktop 的唯一 UI 状态来源。
- [x] TUI 移除扫描 raw runtime events 的临时 transcript 逻辑。
- [x] 在 canonical event 模型稳定后，再审计发送消息时 Windows 终端闪窗的具体子进程来源。

退出标准：

- TUI 发送消息时可从持久事件看到流式文本。
- 工具调用开始、输入、结果都通过 message part 显示，并能被第二个客户端 replay 恢复。
- 切换 session、`/new`、删除 session 不再依赖 runtime 临时事件判断 busy 或 transcript。

---

## Task 10：Slash Command 可用性恢复

- [x] 审计旧 `slash-commands.ts`，按职责分为：
  - client-local UI 命令：`/new`、`/sessions`、`/resume`、`/theme`、`/permissions`、`/workflow`、`/exit` 等。
  - server/session API 命令：`/model`、`/provider`、`/auth`、`/config`、`/memory`、`/mcp`、`/tasks`、`/agents` 等。
  - runtime/prompt 模板命令：user-invocable skills、项目/插件 command template。
  - REPL-only 或需要重新设计的命令：直接依赖本地 renderer、stdin/stdout 或一次性 CLI 环境的命令。
- [x] 增加 server command catalog API，按 `cwd/location` 返回可跨客户端共享的命令元数据。
- [x] 在 `@vykor/client` 增加 `listCommands` / `invokeCommand` / `updateSession`（**不是**通用 `runCommand`）。
- [x] TUI 将本地 UI 命令与 server command catalog 合并，用于 slash autocomplete 与 command palette。
- [x] 提交 slash 命令时先命中本地命令；再命中 server/session/template；未知 `/...` 失败关闭，不入队普通 prompt。
- [x] 对 skill/template 命令采用 opencode 风格：`POST /sessions/:id/commands` 展开后走正常 admit/run。
- [x] 首批恢复：`/model`（PATCH session）、`/skills`（catalog 列表）、skill template、`/permissions`/`/plan`/`/theme`（client-local）、未知 slash 拦截。
- [x] 第二批：`/config`（GET/PATCH `/settings`）、`/provider`（GET `/providers` + PATCH settings）、`/mcp`（GET `/sessions/:id/mcp`）、`/tasks`（list/show/stop）、`/help` `/status` `/version`。
- [x] 第三批：`/memory`（GET/POST/DELETE `/memory`）、`/auth`（GET `/auth` + login/logout）、`/context`（GET `/context`）、`/stats` `/agents`（客户端组合现有 API）。
- [x] 第四批：`/compact`（runtime.compact + store.replaceTranscript + `session.transcript.replaced`）、`/remember`（runtime.remember）、`/dream`（POST `/dream`）、`/profile`（GET `/profile` + POST `/profile/init`）、`/doctor`（客户端组合）、`/effort` `/fast` `/turns`（PATCH `/settings`）。
- [x] 第五批：`/usage` `/cost`（GET `/sessions/:id/usage`）、`/export`（POST `/sessions/:id/export`）、`/output-style`（GET `/output-styles` + PATCH `/settings`）。
- [x] 第六批：`/tasks run`（POST `/tasks`）、`/init`（POST `/project/init`）、`/plugin`（GET `/plugins` + enable/disable）、`/hooks`（GET `/hooks`）、`/subagents`（GET `/agent-personas`）、`/diff` `/branch`（GET `/git/diff` `/git/branch`）。
- [x] 第七批：`/rewind`（POST `/sessions/:id/rewind` + store.replaceTranscript + closeRuntime）、`/commit`（GET `/git/status` + POST `/git/commit`）、`/reload-plugins`（POST `/plugins/reload` + closeRuntimesForCwd）。
- [x] 债务收口：拆空 legacy REPL registry（`slash-helpers.ts` + 兼容 re-export）；slash 呈现层进 `@vykor/client` `dispatchSessionCommand`（TUI 薄适配）；文档化 print/worker 刻意进程内、`/commit` 与 plugin reload 风险；流程见 `docs/slash-commands-flow.md`。
- [x] 用户 print/headless 迁入 Session API（ensure daemon + client admitPrompt）；内部 `--task-worker` / swarm 暂缓（第二阶段 child session）。
- [x] task/subagent → daemon 内 child session（取代 daemon 主路径的 `--task-worker` 子进程旁路；旧 CLI 仅兼容保留）。
- [x] 退场进程内 REPL 产品入口：默认 `vk` → TUI/daemon；删除 `runRepl`；`--continue/--resume` 不再用于交互入口。
- [x] 增加回归测试覆盖 `/new`、`/sessions`、`/model`、`/config`、`/provider`、`/mcp`、`/tasks`、`/memory`、`/auth`、`/compact`、`/dream`、`/profile`、skill/template 命令，以及未知 slash 不误触发。

退出标准：

- TUI 迁到 daemon 后，旧主线常用 slash 命令不会退化成普通模型输入。
- Web/Desktop 可通过同一 command catalog 获取共享命令，而不依赖 TUI 专用协议。
- **不**把旧 REPL `slash-commands.ts` registry 原样搬进 server。

---

## Task 11：Daemon 重启恢复与 child session 收口

- [x] daemon 启动时将遗留 `pending`/`running` session run 明确标记为 `interrupted`，并完成停在 `closing` 的归档。
- [x] 以 `workflow.workflow_started` session event 作为 daemon 所有权凭据，只收口该 daemon/session 启动且仍为 `running` 的 project workflow snapshot。
- [x] 将 daemon-owned running workflow 写为 terminal snapshot：已运行 task 为 `killed`、未开始 task 为 `skipped`，并追加可 replay 的 `workflow.workflow_cancelled` 审计事件。
- [x] 保留 parent/child session、messages、parts 和 event timeline；不在启动时擅自重跑 provider、child TaskManager task 或 workflow。
- [x] 增加 restart 回归：daemon-owned workflow 会终态化，同目录但无 session 所有权事件的 workflow 不受影响。

退出标准：

- daemon 重启后客户端不会看到永久 `busy` 的 session 或 workflow。
- 用户可审计中断前的 child session 与 workflow timeline，再由新的显式操作决定是否重新执行。
- 不把“内存 TaskManager 已丢失”的工作伪装成已恢复或继续运行。

---

## Task 12：Web/Desktop 就绪

- [x] 文档化远程 attach 的认证模型：本地 registry 仅限本机；远程客户端必须显式提供 URL + bearer token。
- [x] 增加 deny-by-default 的 CORS/origin 策略；仅精确 allowlist origin 可跨域，预检不需要 bearer token。
- [x] 公网/非 loopback bind 强制要求显式 `--token`；TUI 用 `--daemon-url` + `--daemon-token` 进行远程 attach，不读取或改写本地 registry。
- [x] 增加 `@vykor/client` 的 Web/Desktop SDK 示例与部署边界文档（[remote-attach.md](../../remote-attach.md)）。

退出标准：

- 非 TUI 客户端仅凭已文档化的 HTTP/SSE API 即可 attach。

---

## Task 13：可控恢复体验

- [x] 将 daemon 重启遗留 run 保持为 `interrupted`，不自动重跑 provider、child task 或 workflow。
- [x] 增加 prompt-backed run 的专用恢复 API：`POST /sessions/:sessionId/runs/:runId/resume`；恢复会创建有 source run/input 溯源的新 input/run，旧 run 不被改写。
- [x] 用稳定请求 id 保证恢复请求可重试：相同 id 返回同一恢复结果，同一 source run 的其它恢复请求返回 `409`。
- [x] 在 session 有活跃/排队 run、source 非中断、没有原始 prompt 时明确拒绝，避免把工作流或已丢失内存所有权的任务伪装成可续传。
- [x] TUI `/resume` 显示当前会话可恢复 run 并发起显式重放；`/sessions` 负责切换会话。

退出标准：

- 重启后用户能看到中断原因和可执行的恢复操作，而不是只有一个不明所以的空闲会话。
- 每一次恢复都有可 replay 的 input/run/event 审计链；网络重试不会创建第二次执行。
- 恢复是“重新开始原始 prompt”，不是伪造 provider stream、workflow 或 child task 的内存续传。

---

## Task 14：Task / child 生命周期持久化

- [x] 在 `SessionStore` 中增加 daemon-owned `SessionTaskRecord`，持久化 task、parent session、child session 和当前 child run 的关联。
- [x] 增加 `session.task.created` / `session.task.updated` 事件，并把 task 放入 session attach snapshot；`@vykor/client` reducer 与其它 canonical 状态一并收敛。
- [x] 将 server 的 `SessionTaskBridge` 注入 `CliSessionRuntime -> bootstrap -> ChildSessionBackend`；TaskManager 继续只承担本进程执行与 stdin/callback，不能再单独充当事实来源。
- [x] session-scoped `/tasks` 读取 daemon 持久 task 投影；HTTP 创建的 session task 与 child task 使用全局唯一 id，避免不同 session 的 `task_1` 碰撞。
- [x] daemon 重启时将遗留 `pending`/`running` task 收口为 `interrupted`，保留 child session/run 的历史与 Task 13 的显式 prompt 重放入口，不自动复活 callback、子进程或 child runtime。

退出标准：

- 任一客户端 attach 到 parent session 后，都能看到其 child task 的身份、状态和 child/run 链接。
- daemon 重启不会丢失 task；未完成 task 有明确 `interrupted` 结论，而不是消失或永久 `running`。
- TaskManager 进程内状态与 `SessionStore` 持久化投影职责分离。

---

## 验证清单

- [x] 两个 session 在同一个 daemon 中并发运行。
- [x] 同一 session 的 prompt 按策略串行或排队。
- [x] 第二个客户端可以 attach 并 hydrate 当前状态。
- [x] 权限请求在客户端断开后仍然存活。
- [x] Daemon 重启保留 sessions/messages/events（`http.test` 跨进程 reload + `interruptActiveRuns`）。
- [x] Daemon 重启会终态化自己拥有的 running workflow，同时保留 child session 与审计时间线。
- [x] 中断的 prompt run 只有在显式恢复后才会重放；相同恢复请求 id 不会重复派生 run。
- [x] child task 的 task/session/run 链路可从 attach snapshot + SSE 重放；daemon 重启后遗留 task 会明确转为 `interrupted`。
- [x] TUI 主路径不再派生 per-session backend。
- [x] 当前主线不存在 BackendHost/LegacyJSON、版本化 store 目录或旧 store 读取分支。
