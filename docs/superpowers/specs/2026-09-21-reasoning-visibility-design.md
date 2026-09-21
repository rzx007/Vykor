# 思考过程展示与回传设计

> 状态：待实现。

## 目标

1. 让桌面与 TUI 能看到模型的思考过程：默认折叠可见（点开才看内容），可以在设置里全局关闭。
2. 顺带修掉两个已知隐患：
   - 回传用的 `reasoningHistory` 按下标存取，历史一压缩就错位，而且只增不减。
   - 思考内容没有体积控制、没有展示开关。
3. 覆盖两类上游来源：OpenAI 兼容渠道的 `reasoning_content`，以及正文里的 `<think>…</think>` 块。

不硬截断思考内容——这与主流实现一致，也是上游强约束：DeepSeek 在带 `tools` 的 thinking 模式下要求所有 `reasoning_content` 完整回传，否则返回 400。

## 背景与现状

### 渲染分支已经存在，但没有生产者

- 桌面端已经具备渲染能力：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/message-render-model.ts:80-83` 把 `reasoning` part 生成独立单元；`message/assistant-message.tsx:91-100` 渲染成 `<details>` 折叠块，标题是"思考过程"；`transcript/transcript-visibility.ts:5-12` 用 `showReasoning === false` 过滤，默认显示。
- 但没有任何代码路径会创建这种 part：
  - `packages/core/src/types/events.ts:5-54` 的 `StreamEvent` 只有 text/tool/error/usage/complete，没有 reasoning 事件。
  - `packages/server/src/application/session/transcript-projection.ts` 只产出 `text` / `tool` / `attachment` / `error` 四类 part。
  - `packages/client/src/state/reducer.ts:281` 硬编码 `field === "text"`，`reasoning` 增量被直接丢弃。
  - `packages/protocol/src/session.ts:513-519` 的 `AppendMessagePartDeltaInput.field` 字面量只有 `"text"`。
  - 上游事件模型同样缺失：`packages/core/src/types/runtime.ts:241-248` 只有 `output.text.delta`。
- 协议层已经预留：`packages/protocol/src/session.ts:15-23` 的 `SessionMessagePartType` 含 `"reasoning"`；`packages/services/src/session-runtime/event-registry.ts:178-181` 的 delta 字段校验已允许 `"reasoning"`。
- TUI 目前把 reasoning 和正文混成同一条 assistant 条目、不区分样式：`apps/frontend/src/hooks/transcript.ts:53-60`。

### 回传现状（隐患一）

`packages/api/src/providers/openai.ts`：
- `reasoningHistory: Map<number, string>`（`:168`）在流结束时按 `reasoningHistory.size` 写入（`:341-343`），在 `convertMessages` 里按 assistant 消息的出现序号读取（`:449-455`）。
- 序号依赖消息列表 append-only。压缩、回退（rewind）或任何历史重排都会让旧思考内容贴到错误的 assistant 消息上；Map 本身没有清理路径。
- 正文里的 `<think>` 块被 `stripThinkBlocks`（`:85`）直接丢弃，不进历史也不展示。

### 上游规则（已查证）

- DeepSeek 官方：带 `tools` 的请求必须把所有轮次的 `reasoning_content` 完整回传（包括没发生工具调用的轮次），缺了返回 400；不带 `tools` 时可省略，传了会被忽略。
- Anthropic 官方：工具轮次内 thinking block 必须完整原样回传；跨轮次建议全传，服务端会自动筛选并只对真正进上下文的部分计费。
- Codex：服务端只回加密 reasoning 与摘要，客户端拿不到长文本。

结论：体积控制靠"上下文压缩 + 展示折叠"，不做字符级硬截断。

### 设置现状（隐患二）

- `packages/core/src/types/settings.ts:125-156` 没有"是否显示思考过程"字段。
- 桌面 `showReasoning` 只是组件参数（`transcript.tsx:36,51`），唯一显式关闭在子智能体只读回放 `tools/agents/agents-tool.tsx:322`（本设计保留该行为）。
- 设置的下发路径已有：`packages/server/src/application/settings-api.ts` → `GET/PATCH /settings`（`packages/server/src/http/routes/system.ts:180-243`）→ 客户端 `packages/client/src/resources/system-resource.ts:32-57`。

## 术语

- **思考内容（reasoning）**：模型在最终回答前生成的推理文本。
- **来源（source）**：`reasoning_content`（上游专门字段）或 `think`（正文里的 `<think>` 块）。
- **回传（replay）**：把思考内容作为 assistant 消息的一部分重新发给模型。
- **折叠可见**：默认渲染一个收起的折叠块，用户点开才看内容。

## 设计决策

1. **新增独立事件 `reasoning_delta`**，携带 `source` 标记；不复用 `text_delta` + `phase`。理由：`phase` 是 commentary/final_answer 语义，复用会让思考内容和正文落进同一个 part，桌面已有的 reasoning 渲染分支反而用不上。
2. **思考内容存到 assistant 消息上，删除 `reasoningHistory`**。消息新增两个字段：
   - `reasoning?: string`：展示与落盘用，两类来源合并。
   - `reasoningReplay?: string`：仅当本轮确实收到过 `reasoning_content` 时存在，回传专用。
   分开的原因：`<think>` 来源的网关（Qwen/GLM 这类）经常不接受请求里带 `reasoning_content`（有网关直接 400）；现状对这类流量从不回传，不能因为本次改动引入新行为。
3. **服务端落成 `reasoning` part**，复用 `session.message.part.delta` 的增量通道（`field: "reasoning"`）。part 顺序按事件到达顺序，天然支持 interleaved thinking 的多段交替。
4. **默认折叠可见 + 全局设置开关** `showReasoning`（默认 `true`），并提供 `/reasoning on|off` 命令，与 `/effort` 的做法对齐。子智能体只读回放继续强制隐藏。
5. **不硬截断**：回传与落盘保留完整内容；只加展示层与落盘的防御上限。
   - 展示层：单个 reasoning 块超过 20000 字符时只渲染尾部，并显示"已省略前 N 字符"。
   - 落盘：单条 reasoning part 超过 1000000 字符时截断并加标记（防御性，正常不会触发）。
6. **Anthropic 与 Codex 不在本次范围**。Anthropic 展示思考需要额外的 extended thinking 请求配置与预算参数；Codex 服务端只提供加密内容与摘要。两者都保持现状。

## 数据模型

### core 事件与消息

`packages/core/src/types/events.ts` 新增：

```ts
export interface ReasoningDeltaEvent {
  type: "reasoning_delta";
  delta: string;
  source: "reasoning_content" | "think";
}
```

`StreamEvent` 联合加入 `ReasoningDeltaEvent`。

`packages/core/src/types/messages.ts` 的 `AssistantMessage` 新增：

```ts
/** 展示与落盘用的思考内容，两类来源合并。 */
reasoning?: string;
/** 仅当上游用 reasoning_content 提供思考内容时存在，用于回传。 */
reasoningReplay?: string;
```

`packages/core/src/types/runtime.ts` 的 AgentEvent 新增与 `output.text.delta` 并列的 `output.reasoning.delta`（`data: { delta: string; source: "reasoning_content" | "think" }`）。

### 协议

`packages/protocol/src/session.ts:513-519` 的 `AppendMessagePartDeltaInput.field` 从 `"text"` 放开为 `"text" | "reasoning"`。`SessionMessagePartType` 已含 `"reasoning"`，无需改动；无需数据库 schema 迁移。

### 设置

`packages/core/src/types/settings.ts` 新增 `showReasoning?: boolean`，缺省视为 `true`。持久化沿用 `packages/core/src/config/settings.ts`，不新增存储层。桌面设置快照类型 `apps/desktop/src/shared/settings-types.ts:15-23` 同步加字段，让渲染进程能读到。

## 行为

### 1. provider 采集（packages/api/src/providers/openai.ts）

- `reasoning_content` 增量直接产出 `reasoning_delta`（`source: "reasoning_content"`），不再只进内存。
- 把 `stripThinkBlocks` 改造成 `extractThinkBlocks`：返回 `{ visible, reasoning, leftover }` 三段，保留现有跨 chunk 尾部扣留逻辑；`<think>` 内容产出 `reasoning_delta`（`source: "think"`）。删除 `stripThinkBlocks` 并迁移其测试。
- 处理顺序：`<think>` 抽取 → DSML 工具调用扫描器 → 输出。思考内容不参与工具调用恢复。
- 一次响应内两类来源可以同时出现，按各自的累积器分别记录。

### 2. 引擎与回传（packages/core/src/engine/query-engine.ts）

- 累积 `assistantReasoning` 与 `assistantReasoningReplay`，在装配 assistant 消息时写入；事件照常向下 yield。
- `packages/api/src/providers/openai.ts` 的 `convertMessages` 改为读 `msg.reasoningReplay`，删除 `reasoningHistory` 及其两处读写。
- `OPENHARNESS_REQUIRE_EMPTY_REASONING_CONTENT` 语义不变：assistant 消息带 `toolUses` 但无 `reasoningReplay` 时，按开关补空串。
- 压缩把消息丢弃时，思考内容随消息一起消失（不发这条消息就不需要回传，符合上游规则）；压缩采用 `...msg` 展开的路径会自然保留字段。

### 3. 服务端投影（packages/server/src/application/session/transcript-projection.ts）

- 新增 reasoning part 的打开/追加/关闭：首次 reasoning 事件打开 `type: "reasoning"`、`status: "running"` 的 part，随后 `appendMessagePartDelta({ field: "reasoning" })`。
- 打开 text part 或 tool part 前先关闭未结束的 reasoning part；reasoning 再次出现时重新打开新 part（多段交替）。
- 落盘安全阀：单条 reasoning part 累计超过 1000000 字符时截断并追加标记文本。

### 4. 客户端与渲染

- `packages/client/src/state/reducer.ts` 的 `appendPartDelta` 支持 `field: "reasoning"`；part 不存在时按 field 创建对应 `type` 的占位 part（现状固定 `text`）。
- 桌面：`ConversationTranscript` 的 `showReasoning` 从设置读取（当前未传值）；折叠块与超长省略逻辑加在 `assistant-message.tsx` 的 reasoning 分支。
- TUI：`apps/frontend/src/hooks/transcript.ts` 把 reasoning 拆成独立条目；`apps/frontend/src/routes/session/parts.tsx` 用暗淡样式 + 折叠渲染，超长同样省略尾部。

### 5. 设置与命令

- `GET/PATCH /settings` 支持 `showReasoning`；桌面设置页新增开关；TUI 读取同一设置。
- 新增 `/reasoning on|off` 命令（`packages/client/src/commands/session-commands.ts`，参照 `/effort` 的读写方式）。它写的是用户级 `settings.json`：展示与否是用户偏好，不按会话区分。
- 未设置时视为显示。

## 错误边界与状态

- 旧会话没有 reasoning part，各客户端按"没有就不渲染"处理；快照与重连路径无需改动。
- reasoning 增量与 text 一样是 transient 事件，不进入 durable replay；重连靠快照补齐。
- 客户端先收到增量、后收到快照（或反之）时，reducer 以 part id 为准幂等处理，与 text 的现有行为一致。
- 未知 `source` 值按 `think` 处理，仅影响回传判定，不影响展示。
- 单块展示上限与落盘安全阀触发时，只截断展示/存储文本，不改变消息上的 `reasoningReplay`。

## 测试与验收

### 分层测试

- api：`<think>` 抽取（完整块、未闭合扣留、跨 chunk 拆分）、`reasoning_content` 转事件、两类来源混合、消息字段回传、`reasoningHistory` 删除后的回归（多轮工具调用场景）。
- core：引擎累积并写入消息、事件顺序、压缩后字段消失的行为。
- server：reasoning part 的建立/增量/关闭、与 text/tool part 的交替、落盘安全阀、`showReasoning` 设置读写。
- client：reducer 处理 `field: "reasoning"`（含缺 part 时创建占位、重连去重）。
- 桌面 / TUI：开关生效、折叠渲染、超长省略。

### 手工验收

1. 桌面用带思考的模型跑一轮，看到收起的"思考过程"块，点开有内容。
2. 设置里关闭 `showReasoning` 后，历史与新消息里的思考块都消失，重新打开后恢复。
3. DeepSeek 带 `tools` 的多轮工具调用会话不再出现 400（对照改动前用下标 Map 的行为）。
4. 长会话（触发一次压缩）里，思考内容不会贴到错误的 assistant 消息上。

## 不在范围内

- Anthropic extended thinking 的请求配置与展示。
- Codex 加密 reasoning / 摘要的展示。
- `ohs --print` 等非交互输出的思考内容。
- 思考内容的检索、导出、复制增强。
