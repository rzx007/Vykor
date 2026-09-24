# Context And Memory Map

> 状态：当前 Context、Prompt 与长期记忆的总索引。

这份文档把 Vykor 里会影响 agent 上下文、长期记忆或运行行为的几条线放在一张图里。重点回答三个问题：

- 什么时候写入
- 从哪里注入到模型上下文
- 它实际解决什么问题

## 总览

| 来源 | 存放位置 | 什么时候写入 | 哪里注入/读取 | 作用 |
| --- | --- | --- | --- | --- |
| `SOUL.md` | `$VYKOR_CONFIG_DIR/SOUL.md`，默认 `~/.vykor/SOUL.md` | `/profile init` 创建模板；之后用户手动编辑 | `buildPromptLayers()` 的 stable identity slot | 定义 agent 默认身份、语气、长期行为风格 |
| `USER.md` | `$VYKOR_CONFIG_DIR/USER.md`，默认 `~/.vykor/USER.md` | `/profile init` 创建模板；用户手动编辑；pending 更新审批后合并 | `buildPromptLayers()` 的 volatile `# User Profile` | 记录用户长期偏好，例如语言、回复风格、工作流习惯 |
| `user_profile_pending/*.json` | `$VYKOR_CONFIG_DIR/user_profile_pending/` | `queueUserProfileUpdate()` 生成候选更新 | 不直接注入；`approvePendingUserProfileUpdate()` 后才合并进 `USER.md` | 防止自动抽取直接改用户档案，保留人工审批边界 |
| local rules | `$VYKOR_CONFIG_DIR/local_rules/projects/<project>-<hash>/facts.json` 和 `rules.md` | daemon root Run 成功收尾后从用户消息正则抽取；`/remember` 也会触发 | `buildPromptLayers()` 按 cwd 从本项目 `facts.json` 中有来源的条目生成 volatile local environment rules | 记录本项目环境事实，例如 SSH 主机、IP、路径、conda 环境、API endpoint |
| Project Instructions | 当前 cwd 向上查找 `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/*.md` | 用户或项目维护者手动写入 | `loadClaudeMdPrompt()` 组装成 `# Project Instructions`，进入 context 层 | 当前项目的构建、测试、协作和代码规范 |
| `settings.systemPrompt` | `$VYKOR_CONFIG_DIR/settings.json`，也可由 CLI/session runtime 传入 | `/config`、CLI 参数或前端 runtime metadata 更新 | `buildPromptLayers()` 的 `# Custom Instructions` | 当前用户配置的额外系统指令，不替换基础 identity/invariant guidance |
| Environment facts | 运行时动态生成，不单独落盘 | 每次构建 system prompt 时计算 | `formatEnvironmentSection()` 进入 stable 层 | 告诉模型当前 OS、cwd、home、git branch、真实 shell launcher 和命令规则 |
| Permission/Fast/Reasoning | settings 或 session runtime metadata | `/plan`、权限模式切换、settings 更新、创建 session 时写入 metadata | `buildPromptLayers()` stable 层 | 让模型知道当前权限模式、是否 fast mode、reasoning effort/passes |
| Available Skills | skills/plugin discovery 结果 | 启动或刷新 runtime 时发现 | `buildPromptLayers()` stable 层 | 告诉模型当前可用 skill 及其描述 |
| Project Memory | `$VYKOR_CONFIG_DIR/data/memory/<project>-<hash>/` | `/memory add`、`/remember`、自动 memory extraction 写入 | 运行时由 `QueryEngine` 按当前用户输入检索，作为临时 `system-reminder` 注入；`/context` preview 也会展示 `# Project Memory` | 记录项目级长期语义事实，例如决策、约定、偏好、不可从代码推导的信息 |
| Session Memory checkpoint | `$VYKOR_CONFIG_DIR/data/session-memory/<project>-<hash>/<sessionId>.md` | root Run 成功收尾后，`SessionPostRunMaintenance` 从 durable transcript 调用 `updateSessionMemoryFile()` | compact/autocompact 时通过 `sessionMemoryToCompactText()` 注入摘要 prompt | 保留显式 Goal（若有）和近期工作 |
| Session runtime history | `$VYKOR_CONFIG_DIR/data/session-runtime/sessions.db` | daemon session 收到输入、消息、part、run、permission、task 事件时写入 | `/sessions`、`/resume`、daemon restart recovery 读取；不是普通 system prompt 记忆 | 会话恢复和重放历史，不等同长期记忆 |
| Output styles | `~/.vykor/output_styles/*.md` | 用户手动添加 | 输出样式服务读取，不作为事实记忆注入 | 改变回答呈现风格 |
| Credentials | `$VYKOR_CONFIG_DIR/credentials.json` | `/auth login`、provider API key 保存 | provider/auth resolution 读取；不得注入 prompt | 保存供应商凭据 |

`VYKOR_CONFIG_DIR` 未设置时默认为 `~/.vykor`。`data/*` 都在这个目录下面。

## Prompt 注入顺序

常规运行时的 system prompt 由 `packages/prompts/src/index.ts` 里的 `buildPromptLayers()` 组装，当前顺序是：

```text
stable
  SOUL.md or default identity
  invariant guidance
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
  Project Memory（仅调用方传入 memoryContent 时）
```

运行时还有一条额外的 per-turn 注入线：Project Memory 会按当前用户输入检索相关内容，以临时 `system-reminder` 拼到本轮 system prompt 上。这个 reminder 不会写回消息历史，也不会修改常驻 system prompt。

## 各条线的职责边界

### `SOUL.md`

`SOUL.md` 只回答“这个 agent 默认应该是什么样”。适合写：

- 默认语气
- 回答风格
- 长期协作姿态
- 不涉及具体项目的行为偏好

不适合写：

- 项目构建命令
- provider/API key
- 临时任务状态
- 当前 repo 的具体约束

入口：

- 读取：`loadSoulMd()`
- 诊断：`inspectPersonalPromptFiles()`
- 初始化：`initializePersonalPromptFiles()`

### `USER.md`

`USER.md` 只回答“这个用户长期偏好什么”。适合写：

- 用户偏好中文或英文
- 偏好简短总结还是详细解释
- 是否希望先给风险点
- 常用工作流习惯

它不应该由自动抽取静默改写。自动候选应先进 `user_profile_pending/*.json`，审批后再合并。

入口：

- 读取：`loadUserProfile()`
- 候选更新：`queueUserProfileUpdate()`
- 审批合并：`approvePendingUserProfileUpdate()`

### local rules

local rules 是自动生成的环境事实，不是用户偏好。它用正则从会话文本抽取稳定的机器信息，例如：

- `ssh user@host`
- IP 地址
- `/data/...`、`/mnt/...` 等数据路径
- `conda activate xxx`
- API endpoint
- 环境变量名
- git remote

写入结果有两个文件：

```text
local_rules/
  projects/<project>-<hash>/
    facts.json
    rules.md
```

`facts.json` 是结构化事实，`rules.md` 是供人查看的自动生成缓存。提示词只读取 `facts.json` 中有会话、消息和观察时间且未命中凭据值检查的条目；旧的无来源项目事实仍在文件中，不能仅凭旧缓存文本进入提示词。旧全局文件若存在，也不自动读取或迁移。

入口：

- 抽取：`extractFactsFromText()`
- 会话更新：`updateRulesFromSession()`
- prompt 读取：`loadLocalRules()`

当前接线：`SessionPostRunMaintenance` 在 root Run 已经 durable completed 后更新 local rules；`SessionMaintenanceService.remember()` 成功后也会更新。失败只记录告警，不改变 Run 或 `/remember` 的结果。

### Project Instructions

Project Instructions 是项目规则，优先级应高于用户长期偏好。它从 cwd 往上找：

```text
CLAUDE.md
.claude/CLAUDE.md
.claude/rules/*.md
```

适合写：

- 本项目测试命令
- lint/build 规则
- 代码风格
- 安全边界
- 目录约定

入口：

- 发现：`discoverClaudeMdFiles()`
- 组装：`loadClaudeMdPrompt()`

注意：当前 Vykor prompt builder 读的是这些 Claude 风格项目文件。仓库根目录里的 `AGENTS.md` 是当前 Codex 协作环境的外部指令，不属于 Vykor 自己的 prompt builder 读取链路。

### Project Memory

Project Memory 是项目级长期语义记忆，适合保存无法稳定从代码或 git 推导出来的内容，例如：

- “我们决定废弃某个命令，因为会误导用户”
- “这个项目 prefer 某个 provider”
- “某个方案已验证不可行”

它和 local rules 的区别：

| 项 | local rules | Project Memory |
| --- | --- | --- |
| 抽取方式 | 正则 | LLM 或手动 `/memory add` |
| 内容类型 | 机器环境事实 | 语义事实、决策、约定 |
| 作用域 | 项目级 `<project>-<hash>` | 项目级 `<project>-<hash>` |
| 注入方式 | 从有来源的 `facts.json` 条目生成 prompt 文本 | 按当前输入检索后临时注入 |

入口：

- 目录：`getProjectMemoryDir(cwd)`
- 管理：`MemoryManager`
- 运行时检索：`createAgentMemoryRuntime()` + `QueryEngine.setMemoryRetriever()`
- 手动命令：`/memory`、`/remember`
- 自动抽取：`maybeExtractMemoriesAfterTurn()`

### Session Memory checkpoint

Session Memory checkpoint 是“本次会话的连续性文件”，不是长期知识库。它主要给 compact 使用。

写入内容：

- 绑定到本轮运行的显式 Goal（若有）
- 最近消息摘要，超出预算时优先保留最新消息

构建函数支持调用方提供 `next_step`、`verified_state` 和 `active_artifacts`；当前 daemon 收尾链路未提供这些字段。

写入时机：

- root Run 成功写入 durable 终态后，`SessionPostRunMaintenance` 调用 `updateSessionMemoryFile()`

读取时机：

- `/compact` 或 autocompact 时，通过 `sessionMemoryToCompactText()` 包装后塞进 compact summary prompt

所以它不是常规 system prompt 的一部分，也不是 `/resume` 的完整会话历史。

### Session runtime history

Session runtime history 存 daemon 会话的完整运行状态，包括 sessions、inputs、messages、parts、runs、tasks、permissions 等。

它解决的问题是：

- `/sessions` 列表
- `/resume` 恢复
- daemon 重启后 recovery
- 中断 run 的可追踪状态

它不应该被当成长期记忆，也不会每次构建 system prompt 时全量注入。

## 哪些是自动写入

| 来源 | 自动写入时机 | 是否需要 LLM | 是否 best-effort |
| --- | --- | --- | --- |
| Session Memory checkpoint | root Run 成功收尾后 | 否 | 是 |
| local rules | root Run 成功收尾；`/remember` 成功后也扫描 | 否 | 是 |
| Project Memory auto extract | 每轮成功结束后，受 `memory.autoExtractEnabled` 控制 | 是 | 是 |
| auto dream memory consolidation | 满足配置阈值后，受 `memory.autoDreamEnabled` 控制 | 是 | 是 |
| `USER.md` | 不应自动直接写入 | 不适用 | 不适用 |
| `SOUL.md` | 不应自动写入 | 不适用 | 不适用 |

## 哪些会进模型上下文

| 来源 | 常规 system prompt | per-turn 临时注入 | compact-only | 不进 prompt |
| --- | --- | --- | --- | --- |
| `SOUL.md` | 是 | 否 | 否 | 否 |
| `USER.md` | 是 | 否 | 否 | 否 |
| local rules 有来源事实 | 是 | 否 | 否 | 否 |
| Project Instructions | 是 | 否 | 否 | 否 |
| `settings.systemPrompt` | 是 | 否 | 否 | 否 |
| Environment/Permission/Skills | 是 | 否 | 否 | 否 |
| Project Memory | 仅 preview 或显式 `memoryContent` | 是 | 否 | 否 |
| Session Memory checkpoint | 否 | 否 | 是 | 否 |
| Session runtime history | 否 | 否 | 否 | 恢复/查询时读取 |
| `credentials.json` | 否 | 否 | 否 | provider/auth 使用 |
| `channel-credentials.json` | 否 | 否 | 否 | 飞书渠道配置与密钥，不进上下文 |

## 建议的排查顺序

当模型行为看起来被“某个记忆”影响时，按这个顺序查：

1. `/context status`：先看每条上下文/记忆线的加载状态、写入时机和注入位置。
2. `/context` 或 context preview：看最终 prompt 分层和内容预览。
3. `/profile status`：看 `SOUL.md` / `USER.md` 是否 loaded、blocked、truncated。
4. `~/.vykor/local_rules/projects/<项目>-<hash>/facts.json`：看当前项目的事实及来源；`/context status` 区分 sourced 与 unverified。
5. `/memory list` / `/memory show <id>`：看项目长期记忆。
6. 当前 repo 的 `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/*.md`。
7. `settings.json`：看 `systemPrompt`、memory 开关、权限模式。
8. compact 问题再查 `data/session-memory/<project>-<hash>/<sessionId>.md`。

## 维护原则

- 新增一种会影响模型上下文的来源时，必须在本文增加一行。
- 新增自动写入逻辑时，必须说明是否 best-effort、是否需要 LLM、是否会写敏感信息。
- 凭据、token、API key 只能走 `credentials.json`、飞书 `channel-credentials.json` 或 provider 环境变量，不能写入任何 prompt 文件或 memory。
- 用户长期偏好进 `USER.md`，项目规则进 Project Instructions，环境事实进 local rules，项目决策进 Project Memory，会话连续性进 Session Memory checkpoint。
