# 参考：斜杠命令与内置工具

> 状态：当前命令清单参考；流程权威文档是 [Slash Command Flow](./slash-commands-flow.md)。

> 交互主线是 daemon TUI：`GET /commands` catalog + client-local UI +
> Skill 普通 prompt metadata。**流程权威文档**：[slash-commands-flow.md](./slash-commands-flow.md)。
> 运行时以 TUI `/help` 与 `packages/server/src/commands/default-command-catalog.ts` 为准；
> 共享呈现层在 `@vykor/client` `dispatchSessionCommand`；TUI 适配层
> `apps/frontend/src/hooks/sessionSlashCommands.ts`。`slash-helpers.ts` 仅
> formatters。工具以 `ToolRegistry.getAll()` 为准。

## 斜杠命令（daemon / TUI 清单）

内置 session 命令见 `packages/server/src/commands/default-command-catalog.ts`；client-local UI 命令
（`/new` `/sessions` `/theme` `/permissions` 等）只在 TUI。user-invocable
skill 经 command catalog 以 template 形式出现。

### 会话

| 命令       | 用法 / 说明                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `/new`     | 开新对话（清空历史并回到首页，对齐 opencode）；TUI 下 ctrl+d 可在 /sessions 弹层删除历史会话                                     |
| `/compact` | 摘要压缩上下文                                                                                                                   |
| `/resume`  | 列出当前会话可重放的中断 run；`/resume <run-id>` 显式重放该 run 的原始 prompt。旧 run 保持中断态，不能自动续传 provider/workflow |
| `/rewind`  | 撤销最近 N 轮（默认 1）                                                                                                          |
| `/session` | 当前会话信息                                                                                                                     |
| `/export`  | 导出对话为 Markdown 文件                                                                                                         |
| `/context` | 按 stable/context/volatile 三层显示当前发送给模型的 system prompt 摘要与预览                                                     |
| `/profile` | `status \| init` 查看或初始化 `SOUL.md` / `USER.md` 个人 prompt 文件                                                             |
| `/stats`   | 会话统计：messages/estimated_tokens/tools/memory/jobs/output_style（差异：memory 报会话内条目数，Python 报文件数）               |
| `/cost`    | 估算成本拆解                                                                                                                     |
| `/usage`   | token 用量统计                                                                                                                   |
| `/turns`   | 设置最大 agentic 轮数（1-512）                                                                                                   |

### 模型与 Provider

| 命令        | 用法 / 说明                                                          |
| ----------- | -------------------------------------------------------------------- |
| `/models`   | 查看/切换模型                                                        |
| `/provider` | 查看/切换 API provider（`auto` 自动探测）                            |
| `/effort`   | 推理力度 `low \| medium \| high`                                     |
| `/fast`     | fast 模式 `on \| off \| toggle`                                      |
| `/auth`     | 凭证来源管理 `login \| logout \| status`；Codex 使用 `auth login codex` |

`/auth` 准备认证来源，`/provider` 切换模型供应商，`/models` 打开模型选择器。普通 API key 与 Codex 订阅的完整流程见 [auth-provider-model.md](auth-provider-model.md)。

### 记忆

| 命令        | 用法 / 说明                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| `/memory`   | 项目记忆 `list \| show ID \| add CONTENT \| remove ID`                                                                |
| `/remember` | 立刻从本会话提取持久记忆（LLM 提议 + 签名去重）                                                                       |
| `/dream`    | 记忆梦境整合：后台子进程重组 memory 目录（`--preview` 只提方案；锁/备份/回滚见 [memory-system.md](memory-system.md)） |

自动记忆提取默认开启，可通过 `/config set memory.autoExtractEnabled false` 关闭；自动 dream 默认关闭，可通过 `/config set memory.autoDreamEnabled true` 开启。session checkpoint 默认开启，可用 `/config set memory.sessionMemoryEnabled false` 关闭。

### 插件与扩展

| 命令              | 用法 / 说明                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `/plugin`         | `list \| enable ID \| disable ID`，按稳定 ID 管理 Native Plugin installed store，并展示来源、scope、inventory、激活状态和诊断 |
| `/reload-plugins` | 在 cwd mutation barrier 内关闭旧 Runtime；下一次使用时按 installed store 重新发现和激活 Native Plugin |
| `/skills`         | `list \| SKILL_NAME` 列出/查看 skill                                                                     |
| `/mcp`            | MCP 服务器连接状态                                                                                       |
| `/hooks`          | 已配置 hooks                                                                                             |

外部 Claude Code 插件不由斜杠命令直接解析；使用 `vk plugin convert` 或 `vk plugin install --from claude-code` 先生成、审阅并安装 Native Plugin。

### Agent / Jobs

| 命令          | 用法 / 说明                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `/jobs`       | TUI 中无参数时打开统一 Jobs Panel；`list \| show ID \| cancel ID` 列出、读取或取消当前 session 的 Job                               |
| `/background` | `/background <command>` 通过后台 shell producer 创建工作，返回 `jobId`；创建后的读取、等待、输入与取消统一走 Jobs                   |
| `/agents`     | 只列出 `kind=agent` 的 Agent Jobs                                                                                                   |
| `/subagents`  | 三源（builtin/user/plugin）agent 人格定义列表（差异：Python 此名为任务视图，TS 由 `/agents` 覆盖）                                  |

旧 `/tasks` 命令和同名后台 Task HTTP CRUD 已删除，不保留兼容别名。定时安排仍使用 Schedule 命令和 `/schedules/tasks` API；它表示“将来触发什么”，不是已经启动的 Job。

### 配置与外观

| 命令            | 用法 / 说明                                                                            |
| --------------- | -------------------------------------------------------------------------------------- |
| `/config`       | `show \| set KEY VALUE`                                                                |
| `/permissions`  | 权限模式 `default \| plan \| full_auto`                                                |
| `/plan`         | plan 模式 `on \| off`                                                                  |
| `/output-style` | 输出样式 `show \| list \| NAME`（default/minimal/codex + 用户自定义，REPL/TUI 热切换） |
| `/theme`        | 主题 `show \| list \| set NAME`                                                        |

### 工程

| 命令      | 用法 / 说明                              |
| --------- | ---------------------------------------- |
| `/init`   | 初始化 Vykor 项目文件              |
| `/commit` | git status 或 stage-all + 提交（带 MSG） |
| `/diff`   | git diff（`--stat` 或完整）              |
| `/branch` | `show \| list` 分支                      |

### 其他

| 命令       | 用法 / 说明      |
| ---------- | ---------------- |
| `/help`    | 列出全部可用命令 |
| `/status`  | 会话状态总览     |
| `/doctor`  | 环境诊断         |
| `/version` | 版本信息         |
| `/exit`    | 退出 REPL        |

### 留待（按需，Python 有 TS 未做）

`/keybindings` `/vim` `/passes` `/release-notes` `/login` `/logout` 等低频项，
见 PLAN-REMAINING E.2。

## 内置工具（基础 33 个；完整 daemon 工具面 44 个）

注册处：`packages/tools/src/`（按目录分组）。daemon/host 根据 capability 追加 `TerminalOpen`、5 个 `Job*` 和 5 个 `Schedule*` 工具。运行时 MCP 服务器工具另行注入（`mcp__server__tool` 命名）。

### 文件（file/）

| 工具    | 说明                                                  |
| ------- | ----------------------------------------------------- |
| `Read`  | 读文件（行号格式，支持 offset/limit）                 |
| `Write` | 写/覆盖文件                                           |
| `Edit`  | 精确字符串替换（TUI 下 unified diff 预览 + 权限确认） |
| `Glob`  | 文件名模式匹配                                        |

### 搜索（search/）

| 工具   | 说明                                        |
| ------ | ------------------------------------------- |
| `Grep` | 内容正则搜索（ripgrep 语义）                |
| `Lsp`  | 符号查询（当前为正则近似实现，真 AST 留待） |

### Shell（shell/）

| 工具   | 说明                                        |
| ------ | ------------------------------------------- |
| `Bash` | 执行 shell 命令（权限门控、超时、后台模式） |

### Agent / Swarm（agent/）

| 工具                        | 说明                                                                          |
| --------------------------- | ----------------------------------------------------------------------------- |
| `Agent`                     | 派发子代理执行任务                                                            |
| `TeamCreate` / `TeamDelete` | 创建/解散 swarm 团队（`~/.vykor/teams/<team>/`，team.json 生命周期） |

### 后台任务（task/）

| 工具                              | 说明                                                  |
| --------------------------------- | ----------------------------------------------------- |
| `BackgroundShellCreate`                      | 创建后台 shell，并返回 `jobId`                        |
| `JobList` / `JobRead` / `JobWait` | 统一列出、读取和等待 Terminal、shell、Agent、Workflow |
| `JobSend` / `JobCancel`           | 给可交互 Job 输入，或明确停止 Job                     |

### 计划与工作区（mode/）

| 工具                             | 说明                  |
| -------------------------------- | --------------------- |
| `EnterPlanMode` / `ExitPlanMode` | 进出 plan 模式        |
| `EnterWorktree` / `ExitWorktree` | 进出隔离 git worktree |

### MCP（mcp/）

| 工具                                   | 说明                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `McpToolCall`                          | 调用 MCP 服务器工具                                                                        |
| `McpAuth`                              | 配置静态 Bearer / 自定义 Header / stdio 环境变量，并尝试重连 MCP server；不是 OAuth 授权流 |
| `ListMcpResources` / `ReadMcpResource` | MCP 资源列举/读取                                                                          |

### 定时（schedule/，daemon/host 注入后可用）

| 工具                                                   | 说明                              |
| ------------------------------------------------------ | --------------------------------- |
| `ScheduleCreate` / `ScheduleUpdate` / `ScheduleDelete` | 创建和修改运行 Agent 的已安排任务 |
| `ScheduleList` / `ScheduleRunNow`                      | 查看任务或立即执行                |

### Web（web/）

| 工具        | 说明          |
| ----------- | ------------- |
| `WebFetch`  | 抓取 URL 内容 |
| `WebSearch` | 网络搜索      |

### 笔记本（notebook/）

| 工具           | 说明                       |
| -------------- | -------------------------- |
| `NotebookEdit` | 编辑 Jupyter notebook 单元 |

### 元工具（meta/）

| 工具         | 说明                                |
| ------------ | ----------------------------------- |
| `TodoWrite`  | 任务清单跟踪                        |
| `Skill`      | 调用 skill                          |
| `ToolSearch` | 搜索当前 QueryEngine 实际可见的工具 |
| `AskUser`    | 向用户提问                          |
| `Config`     | 读写配置                            |
| `Brief`      | 会话简报                            |
| `Sleep`      | 等待                                |
