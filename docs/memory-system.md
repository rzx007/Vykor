# 记忆系统总览

> 状态：当前实现。持久记忆格式只接受 Markdown + frontmatter schema 1，不读取旧 JSON memory。

Vykor 的"记忆"不是单一模块，而是**四层互补体系**。每层解决不同的问题：

```
问题                     解决方案             作用域
────────────────────────────────────────────────────
单轮工具输出太大？  →  tool_outputs 预算判定   本轮之内
会话被压缩后忘事？  →  session_memory 检查点   本次会话
有些事情要记很久？  →  持久记忆 + /remember   跨会话
记忆积久变乱？      →  /dream 梦境整合         定期维护
```

## 运行时所有权

`agent-runtime` 在组装 `DefaultNodeAgent` 时创建并持有 `AgentMemoryRuntime`；Host 不传入记忆目录或 Memory store。user/project 的 Markdown 记忆位置仍由现有 settings 与路径解析逻辑决定，运行时只按这些既有规则读取、检索和写入。

这与 session_memory 是两条独立链路：前者是跨会话的受管 Markdown 记忆，后者是 compact 时使用的会话 checkpoint。session_memory 不替代长期 Memory，也不把 Host 的附件能力当成 Memory 的所有者。

---

## 一图看清四层

```
┌──────────────────────────────────────────────────────────────────┐
│  每轮对话                                                         │
│  ┌─────────────────────────────┐                                  │
│  │  工具调用产生输出            │                                  │
│  │    ≤ 16k chars → 内联      │ ← tool_outputs 预算判定           │
│  │    > 16k chars → 截断+预览  │   (纯内存计算，不写盘)            │
│  └───────────────┬─────────────┘                                  │
│                  ↓                                                │
│  ┌─────────────────────────────┐                                  │
│  │  session_memory 写 checkpoint│ ← 每轮自动，原子写               │
│  │  显式 Goal / 近期消息       │   ~/.vykor/data/        │
│  │  （最多 12k 字符 / 80 行）  │   session-memory/<项目>/<id>.md  │
│  └─────────────────────────────┘                                  │
└──────────────────────────────────────────────────────────────────┘
         ↓ Run 成功收尾                   ↓ 用户手动或自动触发
┌────────────────────┐         ┌──────────────────────────┐
│  personalization   │         │  /remember               │
│  正则抽环境事实     │         │  LLM 提取语义事实         │
│  IP/路径/conda/…   │         │  决策/偏好/约束…          │
│  → facts.json      │         │  → memory/ 目录           │
│  → rules.md        │         │    (Markdown + frontmatter)│
│  → 下次自动注入    │         │                          │
│    system prompt   │         │                          │
└────────────────────┘         └──────────────────────────┘
                                         ↓ 积累一段时间后
                               ┌──────────────────────────┐
                               │  /dream                  │
                               │  后台子进程整理 memory/   │
                               │  合并重复 / 纠错矛盾 /   │
                               │  相对日期→绝对 / 重建索引 │
                               │  ⚠ 跑前整目录备份        │
                               └──────────────────────────┘
```

---

## 各层详解

### 层 1 · tool_outputs 预算判定（轮内，不写盘）

工具输出太长会撑爆单轮上下文，靠三个阈值控制：


| 阈值             | 默认值       | 含义                       |
| -------------- | --------- | ------------------------ |
| `inline`       | 16 000 字符 | 低于此值 → 工具结果整段内联进上下文      |
| `preview`      | 3 000 字符  | 超出 inline → 截断保留前 3k 作预览 |
| `microcompact` | 4 000 字符  | 老工具结果超此值 → 可被微压缩清理       |


可用环境变量覆盖：`VYKOR_TOOL_OUTPUT_INLINE_CHARS` 等。

> 状态：✅ 已实现。工具结果写入 messages 前经 `applyToolOutputBudget` 截断（`query-engine.ts`）；microCompact 已扩展支持 MCP 工具（`compact-service.ts`）。阈值均可环境变量覆盖。

---

### 层 2 · session_memory 检查点（本次会话）

**解决什么问题**：`/compact` 会把历史消息全部压缩成一段摘要，模型压缩后就不知道"当前在做什么任务、下一步是什么"了。session-memory 的作用是在压缩边界把任务状态**注回上下文**，让模型不失忆。

**设计意图（完整流程）**：

```
压缩前：
  [消息1][消息2]...[消息100]   ← 上下文快满了

执行 /compact 之后（设计中）：
  [摘要：整段对话做了什么]
  [session-memory: 显式 Goal（若有）/近期消息]  ← 从文件读回来补上

效果：即使原始对话被替换，模型仍然知道自己在做什么
```

**写什么**：每轮结束自动将以下内容写入一个 Markdown 文件：

- 绑定到本轮运行的显式 Goal（若有）
- 最近最多 80 条消息的文本摘要；超出预算时优先保留最新消息

`next_step`、`verified_state`、`active_artifacts` 仅在调用方提供 `task_focus_state` 时渲染；当前 daemon 收尾链路尚未提供这些字段。没有显式 Goal 时，当前目标显示占位文本。

**文件位置**：

```
~/.vykor/data/session-memory/
  <项目名>-<sha1前12>/
    <sessionId>.md
```

**示例文件内容**：

```markdown
# Session Memory

## Current State
正在修复 TUI 权限弹窗死锁问题

## Recent Conversation
- user: 修复 TUI 权限弹窗死锁问题
- assistant: 已检查权限响应处理
```

> **当前实现状态：✅ 检查点读写已接线；状态字段仅接入显式 Goal。**
>
> - 写入：daemon root Run 成功收尾后，从 durable transcript 自动写（可用 `memory.sessionMemoryEnabled=false` 关闭）
> - 读回：`/compact` 和 autocompact 触发时，通过 `setCompactContextProvider` 读取 checkpoint，注入摘要 prompt 的 `## Session Memory Checkpoint` 段落

---

### 层 3a · personalization 环境事实（跨会话，自动）

**解决什么问题**：你提到的服务器 IP、conda 环境、数据路径这类机械事实，每次都要重新说。

**原理**：daemon root Run 成功写入 durable 终态后，用 10 个正则扫描当前 durable transcript，识别：

- SSH 主机 / 服务器 IP
- 数据路径（`/data/`、`/mnt/` 等开头）
- conda 环境名（`conda activate xxx`）
- Python 版本、API 端点、环境变量
- git 远端、Ray 集群地址、cron 表达式

**写哪里**（按项目隔离）：

```
~/.vykor/local_rules/
  projects/<项目名>-<cwd 的 sha1 前12>/
    facts.json   ← 结构化事实（按 type:value 去重）
    rules.md     ← 人类可读的摘要，同项目下次启动时注入 system prompt
```

**效果**：下次在同一项目启动时，`rules.md` 自动出现在 system prompt 里，不用你再说"测试服在 10.0.0.7"。旧全局 `local_rules/rules.md` 和 `facts.json` 保留在原位，但不再自动注入或迁入项目；它们缺少可靠的项目来源。

这条触发不依赖 TUI、print、Web、Desktop 或 Bot 是否正常退出；不同产品入口只要使用同一个 daemon，就共用同一套收尾规则。失败只记告警，不会把已经完成的 Run 改成失败。

---

### 层 3b · 持久记忆 `/remember`（跨会话，手动 / 可选自动）

**解决什么问题**：personalization 只抓正则能匹配的机械事实；"我们决定不做 X 因为 Y"、"这个项目偏好方案 Z"这类**语义事实**需要 LLM 来理解。

**触发方式**：你手动敲 `/remember`；默认也会在每轮结束后 best-effort 自动提取，可用 `/config set memory.autoExtractEnabled false` 关闭。

**原理**：

1. LLM 读取本次会话，找出「值得长期保存、无法从代码/git 推导」的事实（每次 ≤3 条）
2. 写进 `memory/` 目录（Markdown + YAML frontmatter 格式，带签名去重）
3. 下次会话启动，相关记忆按轮检索注入 prompt

每个持久记忆文件只接受当前格式：frontmatter 必须包含 `schema_version: 1`、id、name、description、type、scope、importance、signature、created_at、updated_at 和 use_count，文件名必须与 id 一致。缺字段、类型错误、版本不同或空正文都会直接失败；旧版自动提取曾写出的空 `description` 会在读取时用正文补全。系统不会读取旧 JSON 或猜测旧名字。

**内置护栏**：提取 prompt 里写死：不存密钥/令牌、只存稳定且不可推导的事实。

> 状态：`/remember` 手动触发和 Run 成功后的自动触发都已接入。自动触发默认开启，受 `memory.autoExtractEnabled` 控制；一次最多写 3 条。自动提取只写项目作用域，并要求候选附带能在近期用户消息中找到的原话；`private` 和 `team` 暂不自动写入。

#### 按轮自动提取的精确流程

当 `memory.enabled !== false` 且 `memory.autoExtractEnabled !== false` 时，每个成功完成的 root Run 会进入 `SessionPostRunMaintenance`：

1. 从 daemon Store 读取已经完成投影的 transcript。
2. 写 session_memory checkpoint。
3. 更新 personalization 环境事实。
4. 调用同一个 live Agent 的 `remember()` 尝试提取长期记忆。
5. 开启 autoDream 时，根据同一 cwd 下最近更新的 durable Session 判断是否达到门槛。

自动提取是 best-effort，不影响主对话。以下情况会跳过或不写入：

- 本轮没有成功完成。
- 历史消息少于 2 条。
- 本轮已经手动写过 memory 目录，避免重复提取。
- 模型没有提出值得保存的长期记忆。
- 提出的记录全部被拒绝，例如作用域不是 `project`、缺少用户原话，或所引原话不在近期用户消息中。
- 提取过程报错会写结构化告警，不阻断当前对话，也不回退 Run 终态。

提取时只把最近 12 条消息摘要给模型，一次最多写入 3 条。通过校验的记录会保存来源会话 ID 和用户消息的 SHA-256 指纹，不重复保存所引原话，再由 `MemoryManager` 做签名去重。原话核对只能确认引用确实出现在用户消息中，不能独立证明模型对其解释正确。下一轮会按当前用户输入检索相关记忆，并以临时 `system-reminder` 注入，不写进消息历史。

注意：代码默认开启不等于本机一定开启；用户 `settings.json` 里的显式配置会覆盖默认值。例如已有配置写了 `memory.autoExtractEnabled=false` 时，需要用 `/config set memory.autoExtractEnabled true` 重新打开。

---

### 层 4 · `/dream` 梦境整合（定期维护）

**解决什么问题**：memory 目录积累久了会有重复条目、相互矛盾的内容、写着"明天"但已经是两年前的相对日期。

**触发方式**：你手动敲 `/dream`（或 `/dream --preview` 只看方案不执行）；也可用 `/config set memory.autoDreamEnabled true` 开启阈值满足后的后台自动整合。

**原理**：

1. 整目录备份（`~/.vykor/data/memory-backups/`）
2. 抢整合锁（防止并发两次 dream）
3. 拉起一个 `vk --print <整合 prompt>` 后台子进程（type: "dream"）
4. 模型读 memory 目录，输出整合指令：合并近重复、纠错矛盾、相对日期改绝对、过时条目标 `disabled: true`、重建 MEMORY.md 索引
5. 失败/被杀 → 自动回滚锁 mtime

**内置护栏**：整合 prompt 里焊死纪律——不从日志臆测用户、不保存密钥/令牌、敏感内容必须标 `Privacy` 标签、一次最多新建 2 个文件。

> 状态：✅ 手动触发已实现；✅ 自动触发已实现，默认关闭，受 `memory.autoDreamEnabled` 与 hours/sessions 阈值控制。

读取时会排除 `disabled: true` 的条目，以及被有效条目的 `supersedes` 字段明确指向的旧条目；它们仍留在文件中供查看。运行中的 agent 每轮检索前重读磁盘，整合结果无需重启即可生效。`supersedes` 只接受明确的记忆 ID，不根据相似文字或多个 IP 猜测冲突。

---

## 具体例子：一段对话产生了什么

```
你："测试服在 10.0.0.7，conda 用 prod-ml，我们决定把 /clear 命令移除了"
```


| 时机             | 产生什么                                    | 写哪里                                                           |
| -------------- | --------------------------------------- | ------------------------------------------------------------- |
| 本轮结束           | session_memory checkpoint（goal + 消息摘要）  | `~/.vykor/data/session-memory/<project>-<hash>/<id>.md` |
| root Run 成功收尾 | personalization 抽出 `10.0.0.7`、`prod-ml` | `~/.vykor/local_rules/projects/<项目>-<hash>/facts.json` + `rules.md` |
| 你敲 `/remember` | LLM 提取"移除 /clear 的决策"                   | `~/.vykor/data/memory/<project>-<hash>/xxx.md`          |
| 你敲 `/dream`    | 整理 memory 目录，合并重复                       | 原地修改 + 备份                                                     |


**下次启动时**：

- 同项目 `rules.md` 里的 `10.0.0.7` / `prod-ml` 自动注入 system prompt ✅
- memory 里的"移除 /clear"在相关对话时自动检索注入 ✅

---

## 两条"自动记忆"的区别


|          | personalization                   | /remember（memory_extract）                      |
| -------- | --------------------------------- | ---------------------------------------------- |
| **触发**   | root Run 成功后自动；`/remember` 也触发 | 手动 `/remember`，或开启后每轮自动                        |
| **方法**   | 正则（10 个模式）                        | LLM 语义理解                                       |
| **抓什么**  | 机械事实：IP、路径、环境名、端点                 | 语义事实：决策、偏好、约束                                  |
| **成本**   | 零（无 LLM 调用）                       | 有成本（一次 LLM 调用）                                 |
| **存放位置** | `~/.vykor/local_rules/projects/<项目>-<hash>/`（项目级） | `~/.vykor/data/memory/<项目>-<hash>/`（项目级） |


---

## 容易混淆：两个"会话文件"


|         | session_memory checkpoint                         | session 快照                                  |
| ------- | ------------------------------------------------- | ------------------------------------------- |
| **目录**  | `~/.vykor/data/session-memory/<项目>-<hash>/` | daemon SQLite |
| **内容**  | goal + 消息摘要（12k 上限）                               | 完整 durable Session、Input、Run、Message 和 Part |
| **用途**  | 给 compact 提供连续性                                   | 多端恢复、审计和运行状态 |
| **由谁读** | compact 边界（`setCompactContextProvider` 注入）        | daemon Application 和共享 client |


项目级旧 Session JSON 不参与 daemon 主线，也不再由 CLI 每轮额外写一份。多端恢复只使用 daemon SQLite、snapshot 和 SSE。历史设计见 [session-storage-design.md](./session-storage-design.md)。

---

## 功能状态汇总


| 功能                             | 状态                   | 备注                                                         |
| ------------------------------ | -------------------- | ---------------------------------------------------------- |
| tool_outputs inline/preview 截断 | ✅                    | applyToolOutputBudget 在 query-engine.ts，写入 messages 前截断    |
| tool_outputs microCompact 接入   | ✅                    | MCP 工具已纳入 microcompactable，同内置工具一起按 keepRecent 清理          |
| session_memory 每轮写入            | ✅ daemon 所有产品入口 | root Run 成功后执行，受 `memory.enabled` 与 `memory.sessionMemoryEnabled` 控制 |
| session_memory compact 读回      | ✅                    | compact 时经 `setCompactContextProvider` 注入摘要 prompt         |
| personalization 抽取             | ✅                    | 10 个正则，root Run 成功后自动；`/remember` 也触发 |
| `/remember` 手动提取               | ✅                    | LLM 提取，签名去重                                                |
| `/remember` 按轮自动               | ✅                    | 默认开启；每轮结束 best-effort 提取，可用 `memory.autoExtractEnabled=false` 关闭 |
| `/dream` 手动整合                  | ✅                    | 备份 + 锁 + 回滚                                                |
| `/dream` 自动定期触发                | ✅                    | 默认关闭；`memory.autoDreamEnabled=true` 后按 hours/sessions 阈值触发 |
| memory 团队隔离 / 密钥扫描             | ⏳                    | Phase C                                                    |


---

## 相关文档

- [prompt-layering-design.md](./prompt-layering-design.md) — stable/context/volatile prompt 分层，以及 SOUL.md / USER.md 迁移设计
- [compact-service-design.md](./compact-service-design.md) — 上下文压缩服务：触发阈值、microCompact、LLM 摘要、PTL 重试与附件注入
- [services-memory-quartet-design.md](./services-memory-quartet-design.md) — tool_outputs / session_memory / memory_extract / autodream 详细设计
- [personalization-design.md](./personalization-design.md) — 环境事实抽取
- [session-storage-design.md](./session-storage-design.md) — 会话快照存储
