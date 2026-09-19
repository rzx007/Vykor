# OpenHarness-ts — 补齐计划（对比 Python 原版 v0.1.9）

基于对 Python 原版 `openharness` **v0.1.9** 源码的逐模块审计整理。核心 harness（引擎 / 工具 / 权限 / 会话 / 前端协议）已可用，但相对原版仍有大量功能未对齐。本文档按**影响面 + 优先级**排序，给出可执行的补齐路线。

> 状态图例：✅ 基本对齐 · 🟡 可用但简化 · 🟠 骨架/部分 · 🔴 未实现 · ⛔ 不在复刻范围

> **进度（分支 `feat/align-phase-ab`）**：**Phase A、Phase B 已完成**（4 commit，`check-types` 26/26、`test` 25/25 全绿）。
> 遗留 TODO：① bash 在无 Git Bash 的 Windows 上的优雅降级。B.2 compact attachments、B.5 per-turn 记忆检索均已完成；Phase C/D 大部分已完成，见下表。

## 原则

1. 每步完成 = `pnpm check-types` 通过 + `pnpm test` 通过（pre-commit 与 CI 已接入）。
2. **先修正确性、再补能力、最后做大模块**：Phase A 不增功能只修 bug，Phase B/C 补核心与扩展，Phase D/E 做大模块与体验。
3. 每步可独立验证，不依赖后续步骤。
4. ⛔ 不在范围：`autopilot`（仓库级自动驾驶 + dashboard）、`voice`（STT/TTS）。

---

## 对齐总览

| 模块 | 状态 | 一句话差距 |
|------|------|-----------|
| api | 🟡 | ✅`<think>`过滤/图片传递/max_completion_tokens(A.1)；仍缺 Codex/Copilot client、reasoning effort、modelscope |
| tools | 🟡 | ✅bash/grep/glob 健壮性(A.3)；✅ImageToText(视觉 fallback)/ImageGeneration(DALL-E 兼容) |
| mcp | ✅ | stdio + HTTP(streamable)/SSE 传输 + headers/env 静态鉴权 + `McpAuth` 保存配置并重连 + 失败隔离已补(C.3)；仅 MCP OAuth flow 待补 |
| engine/compact | ✅ | context collapse/PTL 重试/配对保护/图片占位/boundary/hooks/checkpoint/attachments 全部完成(B.2) |
| hooks | ✅ | priority/10 事件/prompt·agent/`$ARGUMENTS`+转义/matcher 已补(B.1) |
| memory | 🟡 | ✅frontmatter/加权搜索(distinct)/use_count/签名去重/MEMORY.md/中文分词(A.4+B.4)；仍缺团队隔离+密钥扫描(C) |
| prompts | 🟡 | ✅CLAUDE.md 向上遍历/permission-mode/delegation 段+per-turn 记忆检索(B.5)；personalization 段待 C |
| tasks | ✅ | 真实子进程执行/stdin/落盘/completion listener/断管重启/优雅关停(B.3) |
| coordinator | ✅ | ✅mode env(A.5)+用户/plugin agent 加载器+mode 辅助+CLI接线(C.4)；✅agent 级字段运行时生效(tools/disallowedTools/maxTurns/effort/permissionMode) |
| auth | 🟠 | 无 ProviderProfile 体系、无 keyring、明文凭证、无 copilot/codex OAuth |
| plugins | 🟡 | ✅Native Plugin v1 schema、路径边界、installed store、版本 cache、Skills/Agents/Hooks/MCP、Runtime/API/CLI 硬切；✅Claude Code Converter 主链路；隔离 Native Tool、更多组件和 Marketplace 待后续 |
| bridge | 🟡 | ✅spawn+stdout捕获+terminate/kill(D.4)；work-secret / SDK WS URL 不做（云端专用） |
| swarm | ✅ | 派发/TaskWait/worktree/只读放行+文件邮箱/team.json/权限同步+task-worker 多轮 sendMessage+重启上下文恢复(D.1)；缺 TUI 人工裁决 |
| channels | 🟠 | ~5%，仅 Feishu(未导出+bug)+Stdio+Http，缺 7+ 通道与附件/群组/桥接 |
| sandbox | 🟡 | ✅ SRT/Docker runtime、per-session 容器、统一进程入口、host file guard、Docker 整棵进程停止、daemon 托管 Cron、MCP stdio sandbox-aware transport、Docker active 文件操作、主 daemon 系统常驻与 E2E 用例；缺 Docker CI 实跑 |
| services(autodream/memory_extract/session_memory/tool_outputs) | 🟡 | ✅记忆四件套+/dream /remember+每轮 checkpoint+✅compact 读回(E.6 第一刀)；✅cron: command/timezone/daemon(E.6 第二刀)；缺 tool_outputs 接 microcompact、lsp 真 AST |
| personalization | 🟡 | 10 类事实抽取+local_rules 持久化+prompt 注入；session-end 自动抽取尚未接 standalone 或 daemon/TUI lifecycle(C.5) |
| observability | 🟡 | ✅ trace/结构化日志/持久事实指标/Run Inspector/Projection diagnostics 已闭环；缺统一 span、外部 exporter、长期时序查询、面板与告警 |
| evaluation | 🔴 | 有单元/集成/恢复/soak 测试，但尚无固定 Agent 任务集、评分器、基线结果、回归阈值和 CI eval 入口 |
| ohmo | 🔴 | 整应用缺失（个人助理 + 多渠道网关） |
| autopilot | ⛔ | 不复刻 |

---

## 生产平台缺口（当前明确未完成）

这些能力不一定阻塞本地 coding agent 使用，但会影响“可托管、可审计、可多租户、可回归验证”的生产化程度。

1. **Remote Agent backend 尚未实现**
   - 现状：`Agent` 工具不再暴露 `mode` 参数，默认只走 framework child manager；历史/手写输入若传 `mode` 会明确报“不支持”。
   - 边界：`local_agent` / `remote_agent` 都不作为公开执行模式，不再存在 subprocess 静默 fallback。
   - 下一步：只有出现真实远端执行服务时再实现 remote backend；在此之前可考虑隐藏保留参数以降低认知负担。

2. **MCP OAuth 未完成**
   - 现状：MCP 已支持 stdio + HTTP/SSE + headers 鉴权；`McpAuth` 已能配置静态 Bearer、自定义 Header 或 stdio 环境变量，并保存配置后重连 live MCP server。
   - 仍缺：OAuth 授权跳转、token 存储/刷新、过期重试和动态授权闭环。
   - 含义：只能用静态 headers/env token 连接需要鉴权的 MCP server；需要 OAuth 动态授权的 MCP server 仍缺闭环。

3. **Sandbox 主链路已闭环，CI 实跑仍需接入**
   - 已完成：Bash、TaskManager/autodream、command hooks、Cron/RemoteTrigger、LSP ripgrep、MCP stdio 统一走 `createShellProcess` / `createProcess`；严格模式缺失后端时 fail-closed。
   - 已完成：Docker 容器内任务树 stop/timeout 真实 E2E；Read/Write/Edit/Glob/Grep 通过 `FileOperations` 在 Docker active session 内执行。
   - 仍缺：把 Docker/SRT 可选 E2E 接入有对应后端的 CI job，并保留本地无 Docker 环境下的跳过路径。
   - 权威流程：`docs/sandbox-runtime-flow.md`。

4. **单机可观测性第一版已闭环，生产监控平台仍不完整**
   - 已完成：`traceId` 贯穿 HTTP、Input、Run、模型 Attempt、Tool、Permission、Child Task 和 Workflow；服务端输出脱敏的 JSON Lines 结构化日志。
   - 已完成：受 bearer token 保护的 `GET /debug/runtime`、`GET /debug/runs/:runId` 和 `GET /debug/projection-settlements`。Run Inspector 能汇总 Input、Attempt、Message/Tool Part、Task、Permission、Event、Workflow 和 Projection Settlement，并给出 `warnings` / `diagnosticOk`；默认隐藏正文和工具输入输出。
   - 已完成：从 SQLite 持久事实即时汇总有界标签指标，覆盖 Run/Attempt/Tool/Token/Permission/Child Agent/Workflow/Projection Settlement 的数量、状态和已有耗时；指标构建失败不会影响 Run 主流程。
   - 当前边界：`/debug/runtime.metrics` 是当前持久数据的查询快照，不是长期时序库；日志和 debug 接口是诊断视图，SQLite 中的持久记录仍是运行事实来源。
   - 仍缺：统一 span 与嵌套阶段模型、首 token/重试/排队/channel delivery 等细分耗时、OpenTelemetry/Prometheus exporter、长期指标存储与时间窗口查询、Grafana 类面板、告警和 SLO、长期 token/成本趋势，以及 Retention/Backup 最近成功状态的统一控制面指标。
   - 权威说明：`docs/observability.md`；核心实现位于 `packages/server/src/shared/runtime-metrics.ts`、`packages/server/src/application/control/run-inspector.ts` 和 `packages/server/src/http/routes/system.ts`。

5. **缺系统化 Agent evaluation / regression benchmark**
   - 现状：已有单元、集成、恢复和 soak 测试用于验证协议与运行正确性，但没有一套固定任务集来评估 Agent 的真实任务质量；仓库也没有统一的 `eval` / `benchmark` 脚本。
   - 含义：改 prompt、工具管线、模型 provider、权限策略后，只能靠零散测试和人工试用判断是否退化。
   - 仍缺：可重复 fixture、任务清单、确定性/模型/人工评分器、成功率与成本指标、基线结果、回归阈值、失败 trace artifact，以及 CI/手动回归入口。
   - 推荐第一版：先覆盖文件检索、小型代码修改、测试诊断、多工具组合、权限拒绝与恢复、Child Agent 和 Workflow；优先用文件断言、测试结果、越权检查、未收束记录、耗时/token/工具次数做确定性评分，再增加模型评分。

6. **Channels 仍偏单通道 MVP**
   - 现状：Channels 基座 + 飞书文本对话跑通；媒体、长消息分片、去重、线程级会话隔离、Slack/Discord/Telegram 等平台仍待补。
   - 影响：多平台生产网关、富媒体机器人、长上下文外部对话体验还不完整。

7. **README/PLAN/代码状态仍需持续校准**
   - 现状：部分文档比代码旧或比代码超前。例：`tools_dir` 动态工具加载已实现，但 README 曾仍写“待补”。
   - 要求：能力落地或发现缺口时，同步更新 README / PLAN / 设计文档，避免把 placeholder 当生产能力。

---

## Phase A — 正确性修复（P0，不增功能）✅ 已完成

> 已在 `feat/align-phase-ab` 完成（commit `8a31413`）。A.1–A.5 全部实现并测试。

先把"看起来实现了但实际有 bug / 行为不对"的地方修对，影响面最广、成本最低。

### A.1 API 客户端正确性
- OpenAI 兼容流式补 `<think>` 块跨 chunk 过滤（对齐 `_strip_think_blocks`）。
- 图片消息转换：`convertMessages` 对非字符串 content 用 `JSON.stringify`，导致 ImageBlock 无法传给 OpenAI 端 → 转为 `image_url` data-uri。
- gpt-5 / o1 / o3 / o4 系列改用 `max_completion_tokens`（当前恒用 `max_tokens` 会报错）。
- reasoning_content 重放加 `OPENHARNESS_REQUIRE_EMPTY_REASONING_CONTENT` 开关（当前无条件发空 reasoning_content，严格端点会 400）。
- **文件**：`packages/api/src/providers/openai.ts`、`anthropic.ts`

### A.2 channels Feishu 修复
- `FeishuAdapter.send` 用 `message.id` 当 `receive_id`（疑似 bug）→ 用正确的会话 ID。
- `FeishuAdapter` 未在 `packages/channels/src/index.ts` 导出 → 导出。
- **文件**：`packages/channels/src/feishu.ts`、`index.ts`

### A.3 工具健壮性（对齐 v0.1.8 修复）
- grep/glob：ripgrep stderr 重定向到 DEVNULL（避免 pipe 填满阻塞）；超长行（>64KB）跳过而非崩溃；grep 加 `--hidden`。
- bash：超时后抓取 partial output；统一大输出截断（~12000 字符）。
- glob：尊重 `.gitignore`、跳过 `.venv`/重目录、支持 limit。
- **文件**：`packages/tools/src/search/grep.ts`、`glob.ts`、`shell/bash.ts`

### A.4 memory 中文检索
- 搜索分词支持 CJK 逐字（`一-鿿`），当前 `split(/\s+/)` 对中文整句视作一个 term。
- 搜索匹配 body 内容（不只 metadata）。
- **文件**：`packages/memory/src/index.ts`

### A.5 coordinator mode env 一致性 ✅ 已收口
- `isCoordinatorMode()` 统一读取 `OPENHARNESS_COORDINATOR_MODE`；不再兼容 `CLAUDE_CODE_COORDINATOR_MODE` / `COORDINATOR_MODE` / `OPENHARNESS_COORDINATOR` / `CLAUDE_CODE_COORDINATOR`。
- 简单模式统一读取 `OPENHARNESS_COORDINATOR_SIMPLE`。
- **文件**：`packages/coordinator/src/index.ts`、`packages/coordinator/src/coordinator-mode.ts`

---

## Phase B — 核心能力补齐（P1）✅ 已完成

> 已在 `feat/align-phase-ab` 完成（commit `998b1c7`、`46aa5e5`，审查修复 `8be7984`）。B.1–B.5 全部实现并测试。
> **遗留 TODO**：（已全部完成）

### B.1 Hooks 完整化
- 补 `priority` 字段 + 同事件内按 priority 降序稳定排序。
- 事件类型补齐到 10 种（新增 pre/post_compact、user_prompt_submit、notification、stop、subagent_stop）。
- 实现 prompt / agent 类型 hook（真正调模型返回 `{ok, reason}`）。
- `$ARGUMENTS` 注入 + shell 转义（防注入）；matcher（fnmatch）过滤；`OPENHARNESS_HOOK_EVENT/PAYLOAD` 环境变量。
- **文件**：`packages/hooks/src/index.ts`、`packages/core/src/types/hooks.ts`

### B.2 Compact 高级链路 ✅ 已完成
- ✅ context collapse（确定性折叠超长文本）、PTL（prompt-too-long）重试 + 头部截断、tool_use/result 配对保护、图片占位替换。
- ✅ boundary marker、PRE/POST_COMPACT hooks、progress/checkpoint。
- ✅ compact attachments（B.2 尾巴）：`extractRecentFiles()`（Read/Write/Edit tool_use 历史，最近 20）、`deriveWorkLog()`（工具调用计数摘要）、`buildCompactPrompt()`（拼入 `<context>` 段）；`setAttachmentsProvider()` 可外部注入 taskFocus/plan。当前 `OpenHarnessAgent` 默认 composition 尚未注入 daemon task focus/plan provider。
- **文件**：`packages/core/src/engine/compact-service.ts`、`packages/core/src/types/runtime.ts`、`packages/core/src/engine/query-engine.ts`、`apps/cli/src/commands/main.ts`

### B.3 Tasks 真实执行
- `TaskManager.createAgentTask` 真正拉起子进程（当前只建记录不执行）、stdin 流式写入、输出落盘 + tail。
- completion listener 注册/通知、agent 任务断管自动重启、优雅关停。
- **文件**：`packages/services/src/tasks/index.ts`

### B.4 Memory 模型升级
- Markdown + YAML frontmatter 格式（type/scope/importance/ttl/disabled/supersedes/signature）。
- 加权搜索（frontmatter×2 / body×1 + recency / importance / use_count）、使用次数索引、stale 候选挖掘。
- `MEMORY.md` 索引维护、content signature 去重、按项目(cwd) 隔离。
- **文件**：`packages/memory/src/index.ts`

### B.5 Prompts 上下文增强
- CLAUDE.md 从 cwd **向上逐级遍历**累积（含 `.claude/CLAUDE.md`、`.claude/rules/*.md`）。
- 相关记忆检索（select_relevant_memories + mark_memory_used）注入。
- permission-mode 段、delegation/subagent 段。
- **文件**：`packages/prompts/src/index.ts`

> B.5 per-turn 相关记忆检索已于后续完成：`QueryEngine.memoryRetriever` 回调 + `composeTurnSystemPrompt()` 瞬态注入。当前由 `createOpenHarnessAgent()` 统一创建 `AgentMemoryRuntime` 并接入所有 standalone/daemon agent。

---

## Phase C — 扩展层补齐（P2）

### C.1 Native Plugin 与外部转换 ✅ 第一阶段完成
- ✅ Runtime 唯一接受 `.openharness-plugin/plugin.json`，不解析 Claude/Codex manifest。
- ✅ installed store、user/project/local/managed scope、原子版本 cache、权限批准和结构化诊断。
- ✅ Native Skills、Agents、Hooks、MCP 加载；单组件失败保持其他组件并报告 degraded。
- ✅ Claude Code Converter 执行 detect/inspect/plan/convert，产物保留 provenance/plan/report。
- ✅ 删除旧根级 manifest、Settings 插件字段、CLI 重复 cache 和主进程 Tool 动态 import。
- ⏳ Native Tool 隔离执行、更多原生组件、Desktop 管理页和 Marketplace 属于后续计划。
- **文件**：`packages/plugins`、`packages/plugin-converters`、`packages/agent-runtime/src/extensions.ts`

### C.2 Auth ProviderProfile 体系
- 命名 ProviderProfile（list/use/add/edit/remove/switch；base_url/api_format/model/credential_slot 等字段）。
- 凭证存储支持系统 keyring + 文件回退（0o600 权限），与 settings 联动。
- auth source 多源状态探测（env/file/keyring/external）。
- **文件**：`packages/auth/src/index.ts`、`credential-storage.ts`

### C.3 MCP HTTP/SSE 传输 ✅ 已完成
- ✅ streamable-http / SSE 传输；HTTP headers / stdio env 静态鉴权 + `authConfigured` 追踪；失败隔离保持。
- ✅ resources 区分 "Method not found" 与真实错误。
- ✅ `McpAuth` 静态鉴权配置：Bearer / 自定义 Header / stdio env，保存 settings 后重连 live MCP server。
- 留待：完整 MCP OAuth flow（授权跳转、token 存储/刷新、过期重试）。
- **文件**：`packages/mcp/src/index.ts`、`packages/core/src/types/settings.ts`、`packages/agent-runtime/src/mcp-auth.ts`、`packages/tools/src/mcp/index.ts`

### C.4 Coordinator 加载与 prompt 还原 ✅ 完成
- ✅ 用户 `.md` agent 加载器（真 YAML frontmatter + 行级回退，~20 字段）；
  `getAllAgentDefinitions` 三源合并 builtin < user < plugin。
- ✅ Native plugin agents 使用稳定 plugin ID 命名，hooks/mcpServers/omitClaudeMd 信任面剥除。
- ✅ coordinator system prompt 经核对本就全量（「大幅精简」描述过时）；补
  `OPENHARNESS_COORDINATOR_SIMPLE` 简单模式分支、`matchSessionMode`、`getCoordinatorTools`、
  `getCoordinatorUserContext`（scratchpad/worker-tools 注入）。
- ✅ CLI 接线：session 快照存 `session_mode`；`--continue/--resume` 恢复时调
  `matchSessionMode` 自动同步 env；REPL 启动时若 coordinator 模式
  调 `queryEngine.setAllowedTools(getCoordinatorTools())`（Agent/SendMessage/TaskStop/Workflow）。
  daemon `createDaemonAgentLoader()` 尚未按 durable `session_mode` 向 framework agent 应用 coordinator 工具集限制。
- `QueryEngine.setAllowedTools(string[]|null)`：在 submitMessage 内 streamMessage
  调用前过滤 toolRegistry，null 解除限制。
- ✅ agent 级字段运行时生效：`tools/disallowedTools/maxTurns/effort/permissionMode` 经 `TeammateSpawnConfig` → `ChildSessionBackend` 写入 child session metadata，由 daemon runtime 应用。留待：agent 级 `hooks/mcpServers` 的运行时生效。
- **文件**：`packages/coordinator/src/{agent-loader,coordinator-mode}.ts`、`packages/plugins/src/agents.ts`、`packages/core/src/{types/runtime,engine/query-engine}.ts`、`packages/services/src/session/storage.ts`、`apps/cli/src/commands/main.ts`

### C.5 Personalization（新模块）✅ 核心完成 / daemon 未接
- ✅ `packages/personalization`：10 类环境事实正则抽取（SSH/IP/数据路径/conda/
  Python/端点/env/git remote/Ray/cron），去重合并 + 置信度胜出。
- ✅ `local_rules/` rules.md + facts.json 持久化（尊重 OPENHARNESS_CONFIG_DIR）。
- ✅ `rules.md` 已注入 framework 默认 system prompt；`updateRulesFromSession()` 抽取能力已实现
  system prompt（CLAUDE.md 后，含 daemon bootstrap）。
- 留待：standalone host 与 daemon/TUI session archive 或进程退出时调用 `updateRulesFromSession`。
  旧 BackendHost shutdown 路径已删除。详见 `docs/personalization-design.md`。
- 顺带修了 Python git_remote 正则的失效模式（恒捕获 1 字符被过滤）。
- **文件**：`packages/personalization/src/index.ts`、`packages/prompts/src/index.ts`、`apps/cli/src/commands/main.ts`

---

## Phase D — 大模块（P3）

### D.1 Swarm 真实派发 ✅ 完成（D.1–D.5 + 重启上下文恢复）
- ✅ `subprocess` 后端（spawn → 后台子进程 → TaskWait 取结果，swarm D.1/D.2）。
- ✅ 文件式邮箱（每消息一文件 + `.tmp`+rename 原子写 + wx 锁文件，D.5-R1）。
- ✅ 权限同步（read-only 自动批准 D.4；pending/resolved 文件流 + leader/worker 检测 +
  **worker 写操作转 leader checker 自动裁决**——接线超出 Python 原版，见
  `docs/swarm-file-infra-design.md` 差异表，D.5-R3）。
- ✅ 团队磁盘持久化 `team.json`（D.5-R2）、git worktree 隔离（D.3）。
- ✅ 多轮 `sendMessage`（task-worker 重启式，对齐 Python）。
- ✅ 重启上下文恢复：Agent 工具预生成 `sessionId` → `TeammateSpawnConfig.sessionId`
  → `--session-id <id>` → task-worker 启动时 `loadSessionById` 加载快照注入引擎；
  每轮结束后 `saveSessionSnapshot` 持久化，下次重启无缝续接。team.json 也记录 sessionId。
- 留待：`ask` 时 TUI 弹框人工裁决（当前 checker 自动）。
- **文件**：`packages/swarm/src/{lockfile,mailbox,team-lifecycle,permission-sync,index}.ts`、`packages/tools/src/agent/index.ts`、`apps/cli/src/teammate.ts`、`apps/cli/src/index.ts`、`apps/cli/src/commands/main.ts`、`apps/cli/src/runtime.ts`

### D.2 Channels 多通道 + 引擎桥接
- ✅ 基座：`MessageBus`（双异步队列，AbortSignal 退出）、ACL（fail-closed：
  空全拒/`"*"`全放/`"|"`分段）、`ChannelManager`（注入式 adapter、启停/出站
  分发、单通道失败不拖垮）、`ChannelBridge`（inbound → `agent.submitMessage`
  聚合 text_delta → outbound）。
- ✅ 接线（TS 自有，Python 侧是 ohmo 消费的库）：`ohs channels serve|status`
  长驻模式；渠道配置（含密钥）在 `channel-credentials.json`，`settings.json`
  不再承载 `channels`；飞书基础版（文本收发 + @bot 过滤，
  ACL 上移 manager）。微信不做（用户裁决，Python 本无）。serve 无头模式
  只读工具自动放行（写/Bash 仍拒）；`settings.permission.autoApproveTools`
  顺带接线。详见 `docs/channels-flow.md`。
- 留待：Telegram/Discord/Slack 等其余通道、媒体收发、长消息分片、飞书消息
  去重 + bot 消息跳过、线程级会话隔离。
- **文件**：`packages/channels/src/`、`apps/cli/src/commands/channels.ts`

### D.3 Sandbox Docker backend ✅ 主链路完成
- ✅ Docker backend：`docker run` + 资源限制（`--cpus`/`--memory`）+ 网络模式 + 镜像管理 + path validator。
- ✅ Bash / hooks / Cron / LSP / MCP stdio 走 sandbox-aware process entry。
- ✅ Docker active 时 Read/Write/Edit/Glob/Grep 通过 `FileOperations` 进入容器执行，并有真实 Docker E2E 覆盖。
- 留待：接入 CI 中有 Docker daemon/SRT 的 job。
- **文件**：`packages/sandbox/src/*`、`packages/tools/src/file/operations.ts`、`packages/mcp/src/sandbox-stdio-transport.ts`

### D.4 Bridge 多进程会话（按需）
- ✅ `spawn(command, cwd)`：`child_process.spawn(shell:true)`，stdout+stderr 并行泵入 `~/.openharness-ts/bridge/logs/<id>.log`。
- ✅ `stop(sessionId)`：SIGTERM → 3s 超时 → SIGKILL，对齐 Python `SessionHandle.kill()`。
- ✅ `listSpawnedSessions()`：返回 `BridgeSessionRecord`（pid / status / outputPath），按启动时间倒序。
- ✅ `readOutput(sessionId, maxBytes=12000)`：读末尾日志，对齐 Python `read_output()`。
- ✅ `getBridgeManager()` 单例导出。
- 留待：work-secret 编解码 + SDK WS URL 构造（云端专用，按需）。
- **文件**：`packages/bridge/src/index.ts`

---

## Phase E — CLI / TUI 体验 + 订阅 Provider（P4）

### E.1 CLI 子命令补齐 ✅ 已完成（最小版）
- ✅ `oh setup` 首次引导向导；`oh provider`（list/use/add/edit/remove，含 `--api-key`）。最小版：settings.provider + credentials key，**不做**命名 ProviderProfile/keyring（C.2）。
- ✅ `oh --dry-run` 安全预览（model/provider/key 来源/有效 baseURL/工具数/skills/MCP/readiness）。
- 留待：auth switch / copilot-login / codex-login（OAuth 订阅属 E.4）。
- 顺带修：`ANTHROPIC_BASE_URL` 污染通用 baseUrl（dry-run 实测发现，commit `f6fed64`）。
- **文件**：`apps/cli/src/commands/provider.ts`、`setup.ts`、`apps/cli/src/dry-run.ts`

### E.2 缺失斜杠命令
- ✅ 高价值批次：`/stats`（messages/tokens/tools/memory/jobs/output_style）、`/jobs`
  （统一 list/show/cancel）、`/background`（创建后台 shell 并返回 Job ID）、
  `/reload-plugins`（先清后注册，disable 立即生效）、`/subagents`（三源人格列表；
  差异：Python 为任务视图，TS 由既有 `/agents` 覆盖）、`/plugin list|enable|disable`
  （持久化 settings.plugins；install/uninstall 不做——无插件市场）。
  顺带修：`getUserPluginsDir` 尊重 `OPENHARNESS_CONFIG_DIR`。
- `/export` `/agents` `/output-style` 此前已有；skill 作 `/<skill>` 已随 E.5 落地。
- 留待：`/keybindings` `/vim` `/passes` `/release-notes` `/login` `/logout` 等低频项（按需）。
- **文件**：`packages/client/src/commands/session-commands.ts`、`packages/server/src/commands/commands.ts`、`apps/frontend/src/hooks/useServerSync.ts`、`packages/plugins/src/discovery.ts`

### E.3 TUI 渲染
- ✅ **Edit/Write unified diff 预览**（approve once / session / full_auto 自动跳过）——
  改文件前在 TUI 权限框显示 +/− 着色 diff，`[y]` 本次 / `[a]` 整个会话(按工具名) / `[n]` 拒绝。
  仅 TUI（REPL/print 无交互权限确认）。详见 `docs/permission-flow.md`。
- ✅ **Output styles**（输出样式,忠实复刻 v0.1.9）——`default/minimal/codex` 三内置 +
  用户 `~/.openharness-ts/output_styles/*.md`;REPL `EventRenderer` 按 name 分支(`minimal` 极简纯文本);
  `/output-style [show|list|NAME]` 命令(REPL 热切换+持久化);TUI render-branch 已随
  E.3 收口补齐。详见 `docs/output-styles-design.md`。
- ✅ 语法高亮（cli-highlight，无 lang 不 auto-detect）、TUI output-style
  render-branch（minimal 极简工具行 + /output-style 热切换）、tool 行分组
  折叠（最新组展开，旧组摘要行）——E.3 全部收口，详见 `docs/tui-render-tail-design.md`。
- **文件**：`packages/tools/src/file/{preview,diff}.ts`、`packages/output-styles/src/index.ts`、`apps/cli/src/renderer.ts`、`apps/cli/src/commands/{main,slash-commands}.ts`、`apps/frontend/src/components/ModalHost.tsx`、`apps/frontend/src/App.tsx`

### E.4 订阅 Provider（按需）
- Codex client（chatgpt.com Responses API + reasoning effort `xhigh`）；Copilot client（OAuth device flow + token 持久化）。
- vision/multimodal 检测 + image_to_text fallback 工具；`--vision-model` 覆盖。
- 补 modelscope provider profile。
- **文件**：`packages/api/src/providers/`、`packages/tools/src/`

### E.5 Skills 增强 ✅ 完成
- ✅ frontmatter 补 user-invocable / disable-model-invocation / model / argument-hint。
- ✅ 内置 bundled skills（commit/review/test/plan/debug/create-skill，TS 内嵌）；user/project 多源（bundled<user<project）+ 同名覆盖。
- ✅ user-invocable skill 作 `/<skill>` 斜杠命令（REPL；内置命令优先）；model 可见性过滤（disable-model-invocation 不进 system prompt）。daemon 会加载 skills 供模型/工具使用，但 TUI 侧 `/<skill>` 斜杠路由仍需按 client-local vs server API 分层设计。
- ✅ project skills **git-root 向上逐级遍历**：`findProjectSkillDirs(cwd)` 从 cwd 走到 `.git` 根，每层各收 `.openharness-ts/skills` + `.claude/skills`，root→cwd 顺序加载（cwd 层最高优先）。
- ✅ **路径穿越防护**：`discoverMarkdownFiles` 用 `resolve + sep` 校验每个文件的绝对路径必须在 `dirPath` 内（防 symlink/`..` 逃逸）。
- ✅ **每命令 model 覆盖**：`/<skill>` 调用时若 `skill.model` 非空，在 `submitMessage` 前
  临时 `setModel(skill.model)`，finally 块恢复原 model（REPL 接线；旧 BackendHost 路径已删除）。
- 留待：skill-creator/diagnose 重工作流 skill；TUI/daemon 的 user-invocable skill 斜杠命令。
- **文件**：`packages/skills/src/index.ts`、`packages/agent-runtime/src/extensions.ts`、`apps/cli/src/commands/main.ts`

### E.6 Services 杂项
- ✅ 记忆四件套（第一刀）：`autodream`（/dream 命令+锁/备份/回滚）、`memory_extract`
  （/remember 命令）、`session_memory`（REPL 每轮 checkpoint）、`tool_outputs`
  （预算函数）。daemon compact 侧已经 attachments provider 读回 session checkpoint。留待：tool_outputs 接 microcompact、
  executeAutoDream 自动触发（归 cron）。详见 `docs/services-memory-quartet-design.md`。
- ✅ cron 调度升级（第一刀）：`CronScheduler.start()` 改为 `setTimeout` 自重调度，
  每次触发后用 `computeNextRunTime()` 精确计算下一次绝对时刻，替代近似 `setInterval`。
- ✅ cron 升级（第二刀，旧实现，已由 daemon 托管方案替代）：
  - `command` 字段接线：触发时 `execAsync()` 运行 shell 命令（5 min 超时，输出写日志）。
  - 时区支持：`CronJob.timezone`（IANA 名），`computeNextRunTime(expr, base?, tz?)` 用
    `Intl.DateTimeFormat + hourCycle:'h23'` 按时区计算触发时刻；无效 tz 安全回退本地。
  - 当前实现不再使用独立 Cron 进程、JSON、JSONL 或 PID 文件。主 daemon 从 SQLite 加载任务，负责触发、Sandbox 生命周期和执行记录；CLI 与 Agent Cron 工具都调用主 daemon 的同一套能力。
  留待：通知回调（job 完成后 webhook/channel 通知）。
- ✅ session 存储（第二刀）：cwd 哈希分目录 + latest/id 双写 + load 侧配对修复 +
  Markdown 导出；--continue/--resume 已接线（裸 continue 不串项目）。
- ✅ toolMetadata 投喂：`saveSessionSnapshot()` 传入 `engine.getToolMetadata?.()` 。
- ✅ Ctrl+C 保存：REPL `rl.on("close")` 退出前 `await saveSessionSnapshot`。
- ✅ `/export` 命令：`/export [filename] [--json]`，文件名 `.json` 后缀或 `--json` 标志
  输出结构化 JSON（session_id/model/exported_at/messages），否则输出 Markdown；
  默认写入 `~/.openharness-ts/data/exports/`。
- 留待：tool_outputs 接 microcompact。
  详见 `docs/session-storage-design.md`。
- lsp 用真实 AST 解析（当前为正则/rg 近似）。

---

## 执行顺序建议

```
Phase A (正确性)   → 最高优先，低成本，立即提升可用性
Phase B (核心)     → 引擎/工具/记忆/prompt 能力，影响上层
Phase C (扩展)     → 插件/auth/mcp/coordinator/personalization
Phase D (大模块)   → swarm/channels/sandbox（工作量大，可挑选）
Phase E (体验)     → CLI/TUI/订阅 provider，可与 C/D 并行
```

> ⛔ 明确不做：`autopilot`、`voice`。`ohmo` 视为可选的上层应用（依赖 channels 网关成熟后再评估）。
