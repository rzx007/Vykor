# 上下文占用分桶与预算观测设计

日期：2026-09-04

状态：已完成实现；实现计划见 `docs/superpowers/plans/2026-09-05-context-usage-budget.md`

## 结论

Vykor 在与「下一跳发送」**同源**的组装路径上，产出带桶标签的 ledger 段，再生成只读 `ContextUsageSnapshot`：按固定桶统计启发式 token，对照**当前 session 模型**的裸 `contextWindow` 计算占用百分比。桌面端提供与 Cursor Context 托盘同构的环 + 分段条 + 分类列表；CLI/HTTP 通过 `/context usage` 消费同一快照（优先读该同源缓存）。本版只做观测与软提示，不拦截发送、不自动裁剪。

## 已确认决策

| 项 | 选择 |
| --- | --- |
| 交付面 | 桌面环/托盘 + 共享 API/CLI（`/context usage`） |
| 治理 | 观测 + 软提示，不硬拦截 |
| 分桶 | 对齐截图 7 类，另加独立 `Summarized conversation` |
| 估算 | v1 启发式 `ceil(chars/4)`（文本）；媒体另有常量；真实 tokenizer 后置 |
| 下钻 | v1 仅桶级；按 MCP/rule/skill 下钻后置 |
| 架构 | 组装点 Ledger（方案 1）+ **带 `ContextBucketId` 的段契约** |
| 换模 | 快照绑定当前 `runtime.model` 窗宽；立即重算百分比 |

## 目标

- 让用户看清「当前模型上下文窗」里各类内容各占多少 token。
- 同 session 切换模型时，分母与告警随新模型更新，避免误判。
- CLI、HTTP、桌面共用一份快照，避免两套分类逻辑。
- 用软提示引导 compact / 关注静态前缀膨胀，不改变发送路径。

## 非目标

- 硬拦截发送、自动裁剪、自动触发 compact。
- 桶内按 MCP server、rule 文件、skill 名下钻。
- 真实 tokenizer 或跨模型复用上一轮 provider `usage` 作为精确校准。
- 与 Workflow `budgetPolicy` 合并。
- 改写 Context Persistence 的写入/存储模型。
- 网页 frontend 完整复刻桌面托盘（非本版验收必选项）。
- 更新 `docs/context-memory-map.md` 的写入模型说明（由 Persistence 规格负责；本规格只要求 usage **跟随当前实际注入路径**）。

## 与现有能力的关系

- **复用**：prompt 组装、内置工具与 MCP 注册表、session messages、compact 摘要/边界、`ModelInfo.contextWindow` / `outputLimit`、现有 `/context` preview 与 status、`packages/core` 的 `estimateTokens` 与 compact 侧图片常量。
- **正交**：Context Persistence（记住/规则持久化）负责写什么；本功能只计量「进窗内容」。
- **不合并**：Workflow 的 token/time `budgetPolicy` 是多 worker 调度预算，不进入本快照。
- **增量**：保留 `/context`、`/context status`；新增 usage 通道，不替换「来源状态表」。
- **禁止**：`usage` 不得直接复用 `ContextService.preview` 的「全量 `buildMemoryPrompt` 塞进 layers」路径当作真实进窗计量（preview 可继续展示全量，usage 只计本轮会注入的 reminder）。

## 架构

### 单元职责

| 单元 | 职责 | 不做 |
| --- | --- | --- |
| Prompt/工具组装生产者 | 在组装时输出 **已打标** 的 `ContextLedgerSegment[]`（或与发送 payload 一一对应的等价结构） | 不估百分比、不生成 tips |
| `ContextBudgetAssembler` | 消费 tagged segments，估 token，汇总快照与 tips | 不调模型、不 compact、不改组装结果、**禁止**仅凭 `stable/context/volatile` 猜桶 |
| Session usage 缓存 | 按 `sessionId` 保存最近一次同源组装快照；换模/run 终态/强制刷新时失效或重算 | 不持久化到用户项目目录 |
| `ContextService.usage()` | 返回 `{ snapshot, report }`；驱动 `/context usage` 与 HTTP | 不发明第二套分桶 |
| Desktop context ring + tray | 对齐截图：百分比、总量、分段条、分类列表；换模刷新 | 不下钻、不做独立设置大页 |
| Soft tip | 按阈值与 tip `code` 生成提示文案 | 不阻止发送 |

### 推荐放置

- 分桶与估算纯逻辑：`packages/core`（与现有 `estimateTokens`、compact 图片常量同侧），无 UI/HTTP 依赖。
- 数据采集、缓存与 `ContextService.usage()`：server/daemon 侧，挂在能看到「最终 system / tools / messages」且与下一跳发送同源的边界。
- 桌面与 CLI：只消费快照 / report，不在渲染层重算分桶。

## 带桶标签的组装契约（Critical）

Assembler **唯一合法输入**是已打标段列表，而不是裸 `PromptLayers` 或 Markdown 标题猜测。

```ts
interface ContextLedgerSegment {
  bucket: ContextBucketId;
  /** 用于估算的文本；工具 schema 用稳定序列化字符串 */
  text: string;
  /** 可选：图片等非文本块的固定 token 估值，计入同一 bucket */
  mediaTokens?: number;
  /** 可选调试标签，v1 不上报 UI */
  source?: string;
}
```

### 谁负责打标

| 来源 | 打标责任方 | bucket |
| --- | --- | --- |
| SOUL、invariant、Environment、permission/fast/effort 等产品内核 | prompt 组装扩展为按段输出（可在现有 `buildPromptLayers` 之上增加 tagged API，保留字符串渲染兼容） | `system` |
| Project Instructions、Custom Instructions、用户偏好/项目规则/环境事实等常驻规则正文 | 同上；按**语义段**打标，不绑死磁盘路径 | `rules` |
| Available Skills 目录（名+描述） | prompt 组装 | `skills` |
| Delegation / subagent 说明 | prompt 组装 | `subagents` |
| 内置工具 schema | 与下一跳发送相同的 tool 序列化点 | `tools` |
| MCP instructions + MCP/动态工具 schema | 与下一跳发送相同的 MCP 工具表 | `mcp` |
| compact 摘要消息 | compact 写入显式标记（见下节） | `summary` |
| compact boundary、用户/助手/thinking、tool results、附件正文、本轮 memory reminder | 消息遍历 / 发送前 system 附加 | `conversation` |

**禁止**：仅根据 `stable | context | volatile` 三层推断桶；tools/MCP 不在 layers 内，必须从与发送同源的注册表序列化结果打标。

### Persistence 语义映射（Important）

`rules`（及必要时 `system`）按**语义**计量，loader 可随 Persistence 切换而替换，**不改 `ContextBucketId`**：

| 语义段 | Persistence 落地前（当前注入） | Persistence 落地后 |
| --- | --- | --- |
| 用户偏好 | 现有 USER / profile loader | `user_preference` entries 投影 |
| 项目规则（对话产生） | 现有 local/project 规则注入（若仍存在） | `project_rule` 投影 |
| 环境事实 | 现有 local_rules 注入（若仍存在） | `environment_fact` 投影 |
| 仓库指令 | `CLAUDE.md` / `.claude/rules` | 仍为仓库文件（Persistence 不接管） |
| 自定义指令 | `settings.systemPrompt` | 不变 |

用法组装必须跟随**当时真实会注入的路径**；不得为了 usage 单独读已废弃文件。

## 数据模型

```ts
type ContextBucketId =
  | "system"
  | "tools"
  | "rules"
  | "skills"
  | "mcp"
  | "subagents"
  | "summary"
  | "conversation";

type ContextUsageTipCode =
  | "near_full"
  | "overflow_after_model_switch"
  | "static_tools_heavy"
  | "conversation_omitted"
  | "partial_sources"
  | "media_unestimated"
  | "no_context_window"
  | "stale_or_rebuilt";

interface ContextUsageBucket {
  id: ContextBucketId;
  label: string;
  tokens: number;
}

interface ContextUsageTip {
  code: ContextUsageTipCode;
  message: string;
}

interface ContextUsageSnapshot {
  model: string;
  contextWindow: number | null;
  /** 仅供展示/后续预留；v1 不计入 percentFull 分母 */
  outputLimit?: number | null;
  estimatedInputTokens: number;
  /**
   * estimatedInputTokens / contextWindow。
   * 分母为裸 contextWindow（不扣 outputReserve）。
   * 与 compact 内部阈值（另扣 summary/buffer）不对齐，属已知差异。
   * 无窗宽时为 null。允许大于 1。
   */
  percentFull: number | null;
  estimator: "heuristic_v1";
  buckets: ContextUsageBucket[];
  tips: ContextUsageTip[];
  computedAt: string;
  /** 快照是否来自与上一跳发送同源的缓存 */
  source: "live_assembly" | "session_cache" | "static_only";
}
```

展示标签（对齐截图文案）：

| id | label |
| --- | --- |
| `system` | System prompt |
| `tools` | Tool definitions |
| `rules` | Rules |
| `skills` | Skills |
| `mcp` | MCP & dynamic tools |
| `subagents` | Subagent definitions |
| `summary` | Summarized conversation |
| `conversation` | Conversation |

空桶：列表与分段条 **隐藏** `tokens === 0` 的桶（与截图一致）。

## 分桶规则

核心原则：**目录与定义进静态桶；正文与工具结果进 conversation；compact 摘要进 summary。**

| id | 计入 | 不计入 |
| --- | --- | --- |
| `system` | 产品内核段（见打标表） | — |
| `tools` | 内置工具 JSON schema / 定义 | 工具调用结果 |
| `rules` | 语义上的常驻规则/偏好/仓库指令/自定义指令正文 | 被工具读入后的文件正文 → `conversation` |
| `skills` | 技能目录（名称 + 描述） | skill 正文打开后 → `conversation` |
| `mcp` | MCP instructions、MCP/动态工具目录与 schema | MCP 调用结果 → `conversation` |
| `subagents` | 可委派子 agent / delegation 说明文案 | 子 agent 实际对话内容 |
| `summary` | 带 compact 摘要标记的消息（见下节） | boundary 本身 |
| `conversation` | 用户/助手/thinking、所有 tool results、读入附件/文件正文、compact boundary、本轮 memory reminder | — |

### Memory（Important）

- v1 不设独立桶。
- **只计**「本轮发送时会附加的 Project Memory `<system-reminder>`（或等价检索结果）」；无检索上下文则记 0。
- **不计** preview 用的全量 `buildMemoryPrompt(...)`。

### compact 摘要识别（Critical）

当前 `compact-service` 产出的摘要是普通 `assistant` 文本，boundary 是含 `[Compact boundary marker]` 的 `user` 消息，**尚无专用 type**。本功能要求：

1. **实现首选**：compact 写入时为摘要消息打显式标记（例如 message metadata / 扩展字段 `compactRole: "summary"`；boundary 为 `compactRole: "boundary"`）。Ledger 只认该标记把摘要计入 `summary`，boundary 计入 `conversation`。
2. **过渡期启发式（仅当旧 transcript 无标记时）**：
   - 若某条 `assistant` 的 content 以 `[Conversation compacted` 开头，或 `formatSummary` 风格的 `Summary:\n` 开头，且紧后跟随 content 含 `[Compact boundary marker]` 的 `user` 消息，则该 assistant → `summary`，该 user → `conversation`。
   - 否则整段进 `conversation`（宁可把摘要算进 conversation，也不要把普通助手回复误判为 summary）。
3. 新写入的 compact **必须**带显式标记，以便启发式可退役。

## 估算与换模

### 估算

- 文本：`tokens = ceil(characterCount / 4)`，复用 `packages/core` 的 `estimateTokens`，**不**再在 services 侧复制第二套公式。
- 图片/视觉块：与 compact 一致，默认每张 **3072** tokens（`DEFAULT_VISION_IMAGE_TOKEN_ESTIMATE`），计入所属消息的 `conversation`（或 segment 的 `mediaTokens`）。
- 无法估值的媒体：`mediaTokens = 0` 并加 tip `media_unestimated`。
- `estimatedInputTokens` = 各桶 tokens 之和（含 mediaTokens）。
- 列表与环上主数字用未 padding 总和；tip 的「接近满窗」用 `paddedTotal = ceil(estimatedInputTokens * 4/3)`（与 compact `TOKEN_ESTIMATION_PADDING` 一致）。
- `estimator` 固定 `"heuristic_v1"`。

### percentFull 分母（Important）

- `percentFull = estimatedInputTokens / contextWindow`（裸窗宽）。
- `outputLimit` 可进快照供 UI 展示「最大输出」，**不**从分母扣除。
- 已知差异：compact 自动阈值会再扣 summary 输出预留与 buffer；环上百分比偏「窗占用」而非「距 autocompact 还剩多少」。v1 接受该差异；不在 tip 文案中声称等于 compact 阈值。

### 同 session 换模型

- 快照始终使用当前 `session.runtime.model` 的 `contextWindow` / `outputLimit`。
- 换模：使 session usage 缓存失效，立刻用**当前 ledger 内容** + **新窗宽**重算；`buckets` 可不变，`percentFull` 与 tips 变。
- 换模路径必须传入或可读取 **previousContextWindow**（至少在服务端换模处理中），以便发出 `overflow_after_model_switch`（当 `estimatedInputTokens > newContextWindow`）。
- 不把上一模型的 provider `usage.input_tokens` 当作新模型精确校准源。
- `percentFull > 1` 时 UI 显示可超过 100%（例如 `120% Full`）并告警态。
- 无 `contextWindow`：`percentFull = null`，tip `no_context_window`，环显示占位，托盘仍列各桶 token。

## 同源取数与缓存（Critical）

**单一真相**：某 session 的 usage 快照必须来自与「该 session 下一跳会发送的 system + tools + messages」相同的数据源。

| 模式 | 何时 | `snapshot.source` |
| --- | --- | --- |
| 发送/组装路径写出缓存 | 每次成功完成「与发送同源」的组装（含 dry-run 组装若与发送同函数） | `live_assembly` → 写入后可读为 `session_cache` |
| 读缓存 | `usage` / 打开托盘且缓存未失效 | `session_cache` |
| 强制重装 | 缓存缺失或失效，且 session 有 live agent / 可复现组装 | 再次 `live_assembly` |
| 仅静态 | 无 `sessionId`，或无法获得该 session 的 live tools/messages | `static_only`：conversation/summary=0，tip `conversation_omitted` |

**缓存失效（必须重算或标记 stale）**：

- `runtime.model`（或 provider）变更
- run 到达终态（成功、失败、取消均刷新）
- compact 完成
- 调用方请求 `usage({ refresh: true })`（可选参数；打开托盘默认若失效则重装）

**tools/MCP 取数**：必须来自该 session agent 当前将用于发送的工具表；禁止 usage 走「全局 rediscovery 另一套工具列表」而发送走 agent 池另一套。

无 live agent 时：允许 `static_only` 降级，并 tip 说明对话/工具可能不完整（`partial_sources` 或 `conversation_omitted`）。

## 数据流

1. **触发**：打开托盘、`/context usage`、session 模型变更、run 终态（成功/失败/取消）、compact 完成。
2. **组装/读取**：按上节同源规则得到 tagged segments → Assembler → snapshot。
3. **消费**：Desktop / CLI / HTTP 只读快照，不再本地重分类。

## API 与 CLI

- `ContextService.usage({ cwd, sessionId?, refresh?: boolean })` → `{ snapshot, report: string }`
- HTTP：`GET /context/usage?cwd=&sessionId=&refresh=`
- CLI：`/context usage`；用法：`/context [preview|status|usage]`
- 现有 preview/status 签名可保持仅 `cwd`；usage 需要 session 维度才能计量对话。

## 桌面交互

对齐参考截图（用户提供的 Context 托盘：百分比、`~X / Y Tokens`、分段条、分类列表）：

- Composer 旁 **context ring** 显示占用百分比（或无窗宽占位）。
- 点击打开托盘：标题 Context；主信息 `N% Full` 与 `~X / Y Tokens`；分段色条；列表色点 + 标签 + 右对齐 token（K 缩写）；**隐藏空桶**。
- 换模：立刻刷新；溢出时告警态 + `overflow_after_model_switch`。
- 软提示在托盘列表下方；不阻断输入。
- 色序：按上表桶固定顺序分配稳定色值（实现计划里给常量表）；v1 不要求像素级复刻 Cursor，结构同构即可。

## 软提示

v1 写死常数（后续可配置化）：

| code | 条件 | tip 方向 |
| --- | --- | --- |
| `near_full` | `paddedTotal >= contextWindow * 0.85` | 建议 `/compact` 或新开对话 |
| `overflow_after_model_switch` | 换模后 `estimatedInputTokens > newContextWindow` | 已超过当前模型上下文，建议先 compact |
| `static_tools_heavy` | `(tools + mcp) >= contextWindow * 0.20` | 工具/MCP 定义偏多 |
| `conversation_omitted` | `static_only` 或无 session 对话 | 对话占用未计入 |
| `partial_sources` | 部分段读取失败 | 快照可能不完整 |
| `media_unestimated` | 存在无法估值的媒体 | 媒体未计入 |
| `no_context_window` | 当前模型无窗宽元数据 | 无法计算百分比 |
| `stale_or_rebuilt` | 可选：刚强制重装且与上一缓存差异大 | 已刷新 |

Tips 仅文案；用户仍可发送。

## 错误与降级

- 单个来源失败：该段记 0 + `partial_sources`；不整单失败。
- Assembler 异常：环保留上次成功快照或显示不可用；不阻断 composer。
- 无窗宽：见 `no_context_window`。

## 测试要求（可执行）

### 纯函数 / Assembler

1. **Given** 一组 tagged segments（含 tools schema 文本与一条 tool_result 文本），**When** 汇总，**Then** schema ∈ `tools` 或 `mcp`，tool_result ∈ `conversation`，总和等于各桶之和。
2. **Given** 带 `compactRole: "summary"` 的消息 + boundary，**When** 分桶，**Then** 摘要 ∈ `summary`，boundary ∈ `conversation`。
3. **Given** 旧 transcript 无标记但满足启发式前缀 + boundary，**When** 分桶，**Then** 同 2；普通 assistant 不进 `summary`。
4. **Given** 含一张图的消息，**When** 估算，**Then** `conversation` 至少增加 3072。
5. **Given** 同 segments、窗宽 128000→256000，**When** 换模重算，**Then** buckets 不变，`percentFull` 约减半。
6. **Given** 总量 100k、新窗宽 80k 且标记为 model switch，**When** 生成 tips，**Then** 含 `overflow_after_model_switch`，且无「拒绝发送」行为（单元层即无 throw）。

### API / 缓存

7. **Given** session 刚完成与发送同源的组装并写入缓存，**When** `usage({ sessionId })`，**Then** `source` 为 `session_cache` 或等价，且与缓存 buckets 一致。
8. **Given** 换模，**When** `usage`，**Then** 不以旧窗宽计算 `percentFull`；缓存已失效或已按新窗宽重算。
9. **Given** 无 `sessionId`，**When** `usage`，**Then** conversation/summary 为 0，含 `conversation_omitted`。
10. **Given** preview 全量 memory 很大而本轮无 reminder，**When** `usage`，**Then** 不把全量 memory 计入（对比 fixture）。

### Desktop

11. Ring 在 `percentFull === null` 显示占位；`percentFull > 1` 显示 >100% 或告警态。
12. 托盘隐藏空桶；标签文案与上表一致。

### 回归

13. 现有 `/context` preview、status、`setModel`、compact 路径不被破坏；compact **新**摘要带显式标记。

## 后续规划（本规格外）

1. 真实 tokenizer，及同模型下用 provider usage 校准总量。
2. 桶内 items 下钻。
3. tip 阈值可配置；可选 `percentFull` 改为扣除 output 预留。
4. 动态 MCP 目录加载、长工具输出落盘等减负（另开规格）。
5. 退役 summary 启发式，仅保留显式 `compactRole`。

## 验收标准

1. 有活跃 session 且存在同源缓存/可重装时，桌面环与 `/context usage` 对同一快照给出一致的总量与分桶。
2. 托盘结构与参考截图同构：百分比、总量、分段条、分类列表；空桶隐藏。
3. 同 session 切换到不同 `contextWindow` 的模型后，百分比随新窗宽更新；溢出时有 `overflow_after_model_switch` 且可继续输入。
4. 工具定义与工具结果分属 `tools`/`mcp` 与 `conversation`；分桶来自 tagged segments，而非 layers 猜测。
5. compact 摘要计入 `summary`（显式标记优先）；boundary 不计入 `summary`。
6. Memory：usage 不计 preview 全量 memory prompt；只计本轮 reminder（若有）。
7. `percentFull` 使用裸 `contextWindow`；文档/实现注释标明与 compact 阈值的已知差异。
