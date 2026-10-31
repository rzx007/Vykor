# CompactService 设计说明

> 状态：当前 Runtime 上下文压缩说明；主实现以 `packages/core/src/engine/compaction/compact-service.ts` 为准。

`CompactService` 是 Vykor 的上下文压缩服务。唯一实现位于
`packages/core/src/engine/compaction/compact-service.ts`，由 `QueryEngine` 在每轮模型调用前自动触发，也可通过
`/compact` 手动触发。

---

## 解决什么问题

长会话会同时遇到三类问题：

1. 工具结果太长，旧输出继续占上下文。
2. 对话历史接近模型上下文窗口，需要把旧消息折叠成摘要。
3. 压缩后模型容易丢失“当前任务、下一步、最近文件”等连续性信息。

`CompactService` 的目标是用分层策略降低 token 占用，同时保留继续工作的关键信息。

---

## 入口与触发

### 自动触发

`QueryEngine.submitMessage()` 每轮调用模型前都会执行：

```ts
this.messages = await this.compactService.autoCompact(this.messages);
```

触发阈值按保守 token 估算计算：

```text
threshold = maxTokens - MAX_OUTPUT_TOKENS_FOR_SUMMARY - AUTOCOMPACT_BUFFER_TOKENS
          = maxTokens - 20_000 - 13_000
```

默认 `maxTokens` 为 `100_000`，`keepRecent` 为 `10`。当估算 token 低于阈值时直接跳过。

### 手动触发

`/compact` 调用 `QueryEngine.compact()`：

1. 先执行 `microCompact()` 清理旧工具结果。
2. 如果清理后已经低于 `maxTokens`，直接返回。
3. 否则进入 `autoCompact()` 的完整压缩流程。

---

## 压缩流水线

完整 `autoCompact()` 流程如下：

```mermaid
flowchart TD
  A["QueryEngine.submitMessage 每轮模型调用前"] --> B["CompactService.autoCompact(messages)"]
  C["/compact 手动命令"] --> D["QueryEngine.compact()"]
  D --> E["先执行 microCompact()"]
  E --> F{"估算 token < maxTokens?"}
  F -- "是" --> Z["返回压缩后的 messages"]
  F -- "否" --> B

  B --> G["估算 token"]
  G --> H{"低于自动压缩阈值?"}
  H -- "是" --> I["跳过，原样返回"]
  H -- "否" --> J{"连续失败 >= 3 次?"}
  J -- "是" --> K["只做 microCompact()"]
  K --> Z

  J -- "否" --> L["microCompact() 清理旧工具结果"]
  L --> M{"低于自动压缩阈值?"}
  M -- "是" --> Z
  M -- "否" --> N["tryContextCollapse() 确定性压短超大文本"]
  N --> O{"低于自动压缩阈值?"}
  O -- "是" --> Z
  O -- "否" --> P{"有 summarizer client?"}
  P -- "否" --> Q["simpleCompact() 兜底摘要"]
  Q --> Z

  P -- "是" --> R["准备 LLM compact"]
  R --> S["替换图片为占位符"]
  S --> T["注入 sessionMemory / taskFocus / recentFiles / workLog"]
  T --> U["调用模型生成 summary"]
  U --> V{"prompt-too-long?"}
  V -- "是，且重试未耗尽" --> W["截掉更早 prompt round 后重试"]
  W --> U
  V -- "否，请求完成" --> AA{"摘要结构与正文有效?"}
  AA -- "是" --> X["写入 Summary + Compact boundary marker + recent messages"]
  AA -- "否，尚未纠正" --> AB["要求一次完整非空摘要"]
  AB --> U
  AA -- "否，已经纠正" --> AC["报告失败并保留原历史，结束本轮"]
  X --> Z
  V -- "纠正请求失败或重试耗尽" --> AC
  V -- "普通请求失败或重试耗尽" --> Y["记录失败，simpleCompact() 兜底"]
  Y --> Z
```

```text
messages
  │
  ├─ 1. token 估算，未达阈值则跳过
  │
  ├─ 2. 连续失败 >= 3 次：只做 microCompact
  │
  ├─ 3. microCompact：清理旧的 compactable tool_result
  │
  ├─ 4. context collapse：确定性压短超大文本块
  │
  ├─ 5. LLM compact：摘要 older messages，保留 recent messages
  │
  └─ 6. 无客户端或普通请求失败：simpleCompact；摘要验收失败保留原历史并结束本轮
```

### 1. microCompact

`microCompact()` 不调用模型，只把较旧的可压缩工具结果替换为：

```text
[Old tool result content cleared]
```

可清理的工具包括 `Bash`、`Read`、`Write`、`Edit`、`Glob`、`Grep`、`WebFetch`、`WebSearch`，以及所有
`mcp__` 前缀工具。最近 `keepRecent` 个可压缩结果会保留。

### 2. context collapse

当旧消息中存在超大文本块时，`tryContextCollapse()` 会用确定性方式保留头尾：

```text
<head 900 chars>
...[collapsed N chars]...
<tail 500 chars>
```

它不改变最近消息，并且只有在估算 token 确实下降时才返回折叠后的消息。

### 3. LLM compact

如果仍超过阈值且存在 summarizer client，服务会调用同一个模型客户端生成摘要。

压缩时消息会被分成两段：

| 段 | 处理方式 |
|----|----------|
| system messages | 原样保留 |
| older non-system messages | 送入摘要 prompt |
| recent non-system messages | 原样保留，默认最近 10 条 |

摘要 prompt 要求模型输出：

- `<analysis>`：用于模型推理的压缩分析
- `<summary>`：真正保留到历史里的继续工作摘要

写回历史前，`formatSummary()` 会移除可选的 `<analysis>` 草稿，要求恰好一个闭合且正文非空的 `<summary>`，再把正文整理为 `Summary:` 段。空响应、只有草稿、空正文、未闭合、重复或嵌套摘要均不合格。

首次不合格时，通过同一个摘要客户端请求一次格式纠正；纠正额度属于整个压缩操作，不因上下文超长截头重试而重置。每次请求继续经过既有准入、预算、取消和用量结算；模型请求已完成但摘要内容不合格，仍保留其真实用量和完成事实。

两次摘要均不合格，或纠正请求失败时，抛出内部 `CompactSummaryValidationError`。引擎保留压缩前历史，结束本轮，不继续发送主模型请求或执行工具。旧的已保存摘要不重新验收或迁移。

摘要输入由 `packages/core/src/engine/compaction/compact-transcript.ts` 构建。assistant 的正文和独立 `toolUses` 一起转录；每个工具调用记录 ID、名称和有界 JSON 参数，解析失败时记录 `inputError`，不把空对象占位当成真实参数。结果按 `toolUseId` 配对，仅在调用和结果 ID 均唯一且调用先出现时标记 `paired`；重复 ID 为 `ambiguous`，孤立或逆序结果为 `unmatched`，不推断执行成功。

单条源消息最多转录 4,000 字符，计入角色、标签、转义与省略标记。完整身份、显式执行状态、错误标志、结果引用和受控事实优先，参数及正文使用剩余预算；长参数保留头尾并标为不完整 JSON 摘录，最低预算包括标记与两端摘录。放不下的调用或事实明确整项省略，不能截短不透明 ID 后当作有效引用。已有事实前缀和匹配当前 `resultRef` 的宿主补读提示按完整文本块去重，引用由元数据统一保留或省略；图片仅用占位说明。转录不修改原历史、不调用工具或读取引用，也不改变摘要验收与失败提交边界。

前置 context collapse 不压短匹配当前 `resultRef` 的宿主补读提示，而是将完整提示交给转录器处理。否则提示先被切成头尾摘录后，就无法精确去重，残缺 ID 会再次进入摘要正文。

---

## 连续性上下文

为避免“压缩后忘记当前任务”，当前 Runtime 通过 **compact context provider** 为 `CompactService` 注入结构化的压缩上下文。调用方实现 `CompactContextProvider`，并通过 `setCompactContextProvider()` 注册或替换它：

```ts
interface CompactContext {
  sessionMemory?: string;
  taskFocus?: string;
  recentFiles?: string[];
  plan?: string;
  workLog?: string;
  supplementalSections?: CompactContextSection[];
}

interface CompactContextSection {
  heading: string;
  content: string;
}

type CompactContextProvider = () =>
  | CompactContext
  | Promise<CompactContext>;
```

`taskFocus`、`sessionMemory` 和 `plan` 由宿主通过 compact context provider 显式提供；当前 daemon 没有伪造一份 TaskManager 状态。未接 provider 时这些字段为空。

`supplementalSections` 是业务无关的补充章节。core 不解析章节里的附件、工单或其他业务结构，只负责清洗和限额：最多 8 节；heading 折叠换行、去除首尾空白并截到 120 字符；单节 content 最多 16,000 字符；所有补充章节的 content 合计最多 32,000 字符；空 heading 或 content 会被跳过。

当前 daemon 在 server 内生成 `Conversation Attachments` 章节，内容只包含有界的附件身份、访问提示和不可信 representation 预览，再通过 `supplementalSections` 注入。`sessionMemory` 与该章节会由同一个 provider 一起读回，因此 compact 后既保留任务 checkpoint，也保留附件续读线索。

服务自身还会自动派生：

- `recentFiles`：从 `Read` / `Write` / `Edit` / `MultiEdit` 工具调用里提取最近 20 个文件路径。
- `workLog`：按工具名统计调用次数，例如 `Read×4, Bash×2`。

这些内容会被拼进摘要 prompt 的 `<context>` 段，要求 summarizer 一并纳入最终摘要。

---

## 工具配对保护

压缩边界不能把 `tool_use` 和对应的 `tool_result` 分到两边，否则后续 API 调用可能因为消息序列非法而失败。

`splitPreservingToolPairs()` 会在切分 older/recent 时向前移动边界，确保同一组工具调用与结果落在同一侧。

---

## 图片处理

token 估算会把 image block 按固定成本计算，默认每张图片估算为 `3_072` tokens。

LLM 摘要请求不会发送原始图片 payload，而是替换为：

```text
[Image omitted from compaction summarization.]
```

这样可以避免摘要请求携带大图片或敏感图片内容。

---

## prompt-too-long 重试

如果 summarizer 返回上下文过长错误，`isPromptTooLongError()` 会识别常见错误文案，例如：

- `prompt too long`
- `context_length_exceeded`
- `maximum context`
- `exceeds the available context size`

随后 `truncateHeadForPtlRetry()` 按 prompt round 丢弃最旧约 20% 对话并重试，最多 `3` 次。若截断后第一条不是用户消息，会插入：

```text
[earlier conversation truncated for compaction retry]
```

边界 marker 也会记录本次 full compact 是否使用了 head-truncation retry。

---

## hooks、进度与 checkpoint

完整 LLM 压缩会触发 hook：

| hook | 时机 | 说明 |
|------|------|------|
| `pre_compact` | 摘要前 | 可阻止本次压缩 |
| `post_compact` | 摘要后 | 记录压缩前后消息数/token 等 |

进度事件包括：

- `context_collapse_start`
- `context_collapse_end`
- `compact_start`
- `compact_retry`
- `compact_end`
- `compact_failed`

`getCheckpoints()` 可读取最近压缩流程记录的 checkpoint 元数据。

---

## 失败策略

`CompactService` 区分普通请求失败与不可使用的摘要：

1. 普通 LLM 请求失败会递增 `consecutiveFailures`。
2. 连续失败达到 `3` 次后，后续只做 `microCompact()`。
3. 没有 client 或普通 LLM 请求失败时，兜底使用 `simpleCompact()`。
4. 摘要验收最终失败或纠正请求失败时，不进入简单压缩，也不递增普通失败计数，避免后续绕过验收；报告 `compact_failed` 后向上抛错。
5. 取消、运行预算和请求准入错误保持原有传播方式，不转换成格式纠正或简单压缩。

`simpleCompact()` 会保留 system messages 和 recent messages，中间插入占位摘要与 compact boundary marker。

候选历史只在整个压缩成功后交回引擎。失败时可以已有 context collapse 的诊断进度，但不能报告最终 `compact_end`、触发 `post_compact` 或提交完整摘要边界。

---

## 测试覆盖

主要测试在：

- `packages/core/src/engine/__test__/index.test.ts`
- `packages/core/src/engine/compaction/__test__/compact-service-advanced.test.ts`
- `packages/core/src/engine/compaction/__test__/compact-summary.test.ts`
- `packages/core/src/engine/compaction/__test__/compact-transcript.test.ts`
- `packages/core/src/engine/__test__/summary-validation.test.ts`
- `packages/core/src/engine/__test__/integration.test.ts`

覆盖点包括：

- microCompact 清理策略
- prompt-too-long 识别与截头重试
- tool_use / tool_result 配对保护
- 图片 token 估算与摘要占位
- context collapse
- compact boundary marker
- pre/post compact hooks
- progress callback 与 checkpoints
- `QueryEngine.compact()` 手动触发路径
- 摘要验收、一次格式纠正、纠正与截头重试的独立额度
- 工具名称、参数与结果 ID 配对，超预算省略和完整执行事实
- 自动、手动和被动压缩失败后保留历史，停止主请求与工具执行
- 纠正请求的准入、取消和逐请求用量结算

---

## 相关文档

- [memory-system.md](./memory-system.md) — 记忆系统总览，说明 `session_memory` 如何在 compact 边界注回上下文
- [session-storage-design.md](./session-storage-design.md) — 会话快照存储，与 compact 的“摘要历史”不同
- [slash-commands.md](./slash-commands.md) — `/compact` 命令入口
