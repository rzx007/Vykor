# 思考过程展示与回传 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让桌面与 TUI 展示模型的思考过程（默认折叠可见、可全局关闭），同时把回传用的下标 Map 换成消息字段，并给思考内容加上展示与落盘的防御上限。

**Architecture:** 新增一条独立的 `reasoning_delta` 事件流，从 provider 一路透传到 transcript part（服务端 `reasoning` part + `field: "reasoning"` 增量），客户端 reducer 与已有渲染分支负责展示；回传改为把思考文本存在 assistant 消息的 `reasoning` / `reasoningReplay` 字段上，删除 provider 的 `reasoningHistory`。

**Tech Stack:** TypeScript monorepo（pnpm + turbo + vitest）、OpenAI 兼容 provider、React（桌面 Electron renderer）、OpenTUI（apps/frontend）。

**Spec:** `docs/superpowers/specs/2026-09-21-reasoning-visibility-design.md`

## Global Constraints

- 思考内容**不硬截断**回传与落盘；只有展示层 20000 字符上限与落盘 1000000 字符安全阀。
- `<think>` 来源的思考内容**不回传**（`reasoningReplay` 只承接 `reasoning_content` 来源）；否则会给原本不接受该字段的网关引入 400 风险。
- 默认行为：`showReasoning` 缺省为 `true`；子智能体只读回放保持强制隐藏。
- 增量 part 事件（`session.message.part.delta`）是 transient，不新增 durable 事件类型；无需数据库 schema 迁移。
- 提交信息用仓库现有风格：Conventional Commits + 中文描述（如 `feat(api): ...`）。
- 开始前确认工作区是干净的（当前仓库有与本计划无关的未提交改动；在专用 worktree 或确认这些改动已落地后再开工）。

---

### Task 1: core 事件与消息契约

**Files:**
- Modify: `packages/core/src/types/events.ts`
- Modify: `packages/core/src/types/messages.ts:15-25`
- Modify: `packages/core/src/types/runtime.ts:241-248`
- Modify: `packages/core/src/index.ts:17-25`
- Test: `packages/core/src/types/reasoning-contracts.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces: `ReasoningSource`、`ReasoningDeltaEvent`；`AssistantMessage.reasoning?`、`AssistantMessage.reasoningReplay?`；`AgentEventInput` 的 `output.reasoning.delta`

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/src/types/reasoning-contracts.test.ts
import { describe, expect, it } from "vitest";
import type { ReasoningDeltaEvent, StreamEvent } from "./events.js";
import type { AssistantMessage } from "./messages.js";

describe("reasoning contracts", () => {
  it("carries reasoning deltas with their source", () => {
    const event: ReasoningDeltaEvent = {
      type: "reasoning_delta",
      delta: "先看文件。",
      source: "think",
    };
    const streamEvent: StreamEvent = event;
    expect(streamEvent.type).toBe("reasoning_delta");
  });

  it("lets assistant messages carry display and replay reasoning", () => {
    const message: AssistantMessage = {
      type: "assistant",
      content: "答案",
      reasoning: "想法",
      reasoningReplay: "想法",
    };
    expect(message.reasoningReplay).toBe("想法");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @openharness/core exec vitest run src/types/reasoning-contracts.test.ts`
Expected: FAIL —— `reasoning_delta` 不在 `StreamEvent` 联合里（类型错误），或 `reasoning` 字段不存在。

- [ ] **Step 3: 实现类型**

`packages/core/src/types/events.ts` 新增并加入联合：

```ts
export type ReasoningSource = "reasoning_content" | "think";

export interface ReasoningDeltaEvent {
  type: "reasoning_delta";
  delta: string;
  source: ReasoningSource;
}

export type StreamEvent =
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ToolUseStartEvent
  | ToolUseEndEvent
  | ErrorEvent
  | UsageEvent
  | CompleteEvent;
```

`packages/core/src/types/messages.ts` 的 `AssistantMessage` 新增：

```ts
/** 展示与落盘用的思考内容，两类来源合并。 */
reasoning?: string;
/** 仅当上游用 reasoning_content 提供思考内容时存在，用于回传。 */
reasoningReplay?: string;
```

`packages/core/src/types/runtime.ts` 在 `AgentEventInput` 的 `output.text.delta` 之后新增成员：

```ts
  | {
      type: "output.reasoning.delta";
      data: {
        delta: string;
        source: import("./events").ReasoningSource;
      };
    }
```

`packages/core/src/index.ts` 的 events 导出块加上 `ReasoningDeltaEvent` 与 `ReasoningSource`：

```ts
export type {
  StreamEvent,
  TextDeltaEvent,
  ReasoningDeltaEvent,
  ReasoningSource,
  ToolUseStartEvent,
  ToolUseEndEvent,
  ErrorEvent,
  UsageEvent,
  CompleteEvent,
} from "./types/events";
```

- [ ] **Step 4: 跑测试与类型检查**

Run: `pnpm --filter @openharness/core exec vitest run src/types/reasoning-contracts.test.ts && pnpm --filter @openharness/core check-types`
Expected: PASS，类型无错误。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/types/events.ts packages/core/src/types/messages.ts packages/core/src/types/runtime.ts packages/core/src/index.ts packages/core/src/types/reasoning-contracts.test.ts
git commit -m "feat(core): 新增 reasoning 事件与助手消息思考字段"
```

---

### Task 2: provider 把 reasoning_content 转成事件

**Files:**
- Modify: `packages/api/src/providers/openai.ts:276-280`（`reasoning_content` 累积处）
- Test: `packages/api/src/providers/openai.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ReasoningDeltaEvent`
- Produces: 流里每个 `reasoning_content` 增量都会产出 `{ type: "reasoning_delta", delta, source: "reasoning_content" }`（`reasoningHistory` 本任务暂不动，避免中间态丢失回传）

- [ ] **Step 1: 写失败测试**

在 `packages/api/src/providers/openai.test.ts` 文件末尾追加：

```ts
describe("OpenAICompatibleClient reasoning deltas", () => {
  function deltaClient(deltas: Array<Record<string, unknown>>) {
    const create = vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        for (const delta of deltas) {
          yield { choices: [{ delta, finish_reason: null }] };
        }
        yield { choices: [{ delta: {}, finish_reason: "stop" }] };
      },
    }));
    const client = new OpenAICompatibleClient({ apiKey: "test", baseURL: undefined } as any);
    client.client = { chat: { completions: { create } } } as any;
    return client;
  }

  it("emits reasoning_content as reasoning deltas", async () => {
    const client = deltaClient([
      { reasoning_content: "先看目录。" },
      { reasoning_content: "再读文件。" },
      { content: "完成。" },
    ]);
    const events: any[] = [];
    for await (const event of client.streamMessage({
      model: "deepseek-v4.1-flash",
      messages: [{ type: "user", content: "hi" }],
    })) {
      events.push(event);
    }

    const reasoning = events
      .filter((event) => event.type === "reasoning_delta")
      .map((event) => event.delta)
      .join("");
    expect(reasoning).toBe("先看目录。再读文件。");
    expect(events.filter((event) => event.type === "reasoning_delta")[0]!.source).toBe(
      "reasoning_content",
    );
    const text = events
      .filter((event) => event.type === "text_delta")
      .map((event) => event.delta)
      .join("");
    expect(text).toBe("完成。");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @openharness/api exec vitest run src/providers/openai.test.ts -t "reasoning deltas"`
Expected: FAIL —— 收到的 reasoning 文本是空串（事件不存在）。

- [ ] **Step 3: 实现**

把 `packages/api/src/providers/openai.ts` 里的：

```ts
          const reasoningPiece = (delta as any).reasoning_content;
          if (reasoningPiece) {
            collectedReasoning += reasoningPiece;
          }
```

改成：

```ts
          const reasoningPiece = (delta as any).reasoning_content;
          if (reasoningPiece) {
            collectedReasoning += reasoningPiece;
            yield {
              type: "reasoning_delta",
              delta: reasoningPiece,
              source: "reasoning_content",
            };
          }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @openharness/api exec vitest run src/providers/openai.test.ts && pnpm --filter @openharness/api check-types`
Expected: PASS（含原有用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/api/src/providers/openai.ts packages/api/src/providers/openai.test.ts
git commit -m "feat(api): reasoning_content 增量产出 reasoning_delta 事件"
```

---

### Task 3: `<think>` 抽取改为产出思考内容（含 EOF 语义）

**Files:**
- Create: `packages/api/src/providers/think-blocks.ts`
- Create: `packages/api/src/providers/think-blocks.test.ts`
- Modify: `packages/api/src/providers/openai.ts`（正文分支与 EOF 分支）
- Modify: `packages/api/src/providers/openai.test.ts`（删除迁移后的 `stripThinkBlocks` 测试）

**Interfaces:**
- Consumes: Task 1 的 `reasoning_delta`
- Produces: `extractThinkBlocks(buffer, options?: { final?: boolean }) => { visible: string; reasoning: string; leftover: string }`

- [ ] **Step 1: 写失败测试**

```ts
// packages/api/src/providers/think-blocks.test.ts
import { describe, expect, it } from "vitest";
import { extractThinkBlocks } from "./think-blocks.js";

describe("extractThinkBlocks", () => {
  it("splits a complete block into visible text and reasoning", () => {
    const result = extractThinkBlocks("before<think>secret</think>after");
    expect(result.visible).toBe("beforeafter");
    expect(result.reasoning).toBe("secret");
    expect(result.leftover).toBe("");
  });

  it("extracts multiple blocks", () => {
    const result = extractThinkBlocks("<think>a</think>mid<think>b</think>tail");
    expect(result.visible).toBe("midtail");
    expect(result.reasoning).toBe("ab");
  });

  it("holds back an unclosed block for the next chunk", () => {
    const result = extractThinkBlocks("before<think>partial");
    expect(result.visible).toBe("before");
    expect(result.reasoning).toBe("");
    expect(result.leftover).toBe("<think>partial");
  });

  it("holds back a partial opening tag split across chunks", () => {
    const result = extractThinkBlocks("before<thi");
    expect(result.visible).toBe("before");
    expect(result.leftover).toBe("<thi");
  });

  it("treats an unclosed block as reasoning at stream end", () => {
    const result = extractThinkBlocks("before<think>unfinished reasoning", { final: true });
    expect(result.visible).toBe("before");
    expect(result.reasoning).toBe("unfinished reasoning");
    expect(result.leftover).toBe("");
  });

  it("releases a partial tag prefix as visible text at stream end", () => {
    const result = extractThinkBlocks("before<thi", { final: true });
    expect(result.visible).toBe("before<thi");
    expect(result.reasoning).toBe("");
    expect(result.leftover).toBe("");
  });

  it("passes plain text through untouched", () => {
    const result = extractThinkBlocks("no tags here");
    expect(result.visible).toBe("no tags here");
    expect(result.reasoning).toBe("");
    expect(result.leftover).toBe("");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @openharness/api exec vitest run src/providers/think-blocks.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 think-blocks 模块**

```ts
// packages/api/src/providers/think-blocks.ts
export interface ThinkExtraction {
  visible: string;
  reasoning: string;
  leftover: string;
}

const THINK_TAG = "<think>";
const THINK_PAIR_RE = /<think>([\s\S]*?)<\/think>/g;

/**
 * 把正文里的 `<think>…</think>` 拆成三段：可见正文、思考内容、需要等下一个
 * chunk 的残留。`final: true` 表示流已结束：未闭合的块整体算思考内容，只有
 * "可能是标签前缀"的尾巴按正文放出。
 */
export function extractThinkBlocks(
  buffer: string,
  options: { final?: boolean } = {},
): ThinkExtraction {
  let visible = "";
  let reasoning = "";
  let rest = buffer;

  for (;;) {
    THINK_PAIR_RE.lastIndex = 0;
    const match = THINK_PAIR_RE.exec(rest);
    if (!match) break;
    visible += rest.slice(0, match.index);
    reasoning += match[1] ?? "";
    rest = rest.slice(match.index + match[0].length);
  }

  const openIndex = rest.indexOf(THINK_TAG);
  if (openIndex !== -1) {
    visible += rest.slice(0, openIndex);
    const tail = rest.slice(openIndex);
    if (options.final) {
      return { visible, reasoning: reasoning + tail.slice(THINK_TAG.length), leftover: "" };
    }
    return { visible, reasoning, leftover: tail };
  }

  if (options.final) {
    return { visible: visible + rest, reasoning, leftover: "" };
  }

  const maxPrefix = Math.min(rest.length, THINK_TAG.length - 1);
  for (let prefixLen = maxPrefix; prefixLen > 0; prefixLen--) {
    if (THINK_TAG.startsWith(rest.slice(rest.length - prefixLen))) {
      return {
        visible: visible + rest.slice(0, rest.length - prefixLen),
        reasoning,
        leftover: rest.slice(rest.length - prefixLen),
      };
    }
  }

  return { visible: visible + rest, reasoning, leftover: "" };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @openharness/api exec vitest run src/providers/think-blocks.test.ts`
Expected: PASS（7 个用例）。

- [ ] **Step 5: 接线到 openai.ts**

把 `packages/api/src/providers/openai.ts` 的 import 换掉（删除 `stripThinkBlocks`，引入 `extractThinkBlocks`）：

```ts
import { extractThinkBlocks } from "./think-blocks.js";
```

正文分支改为：

```ts
          if (delta.content) {
            thinkBuf += delta.content;
            const extracted = extractThinkBlocks(thinkBuf);
            thinkBuf = extracted.leftover;
            if (extracted.reasoning) {
              yield {
                type: "reasoning_delta",
                delta: extracted.reasoning,
                source: "think",
              };
            }
            if (extracted.visible) {
              const scanned = recovery
                ? recovery.push(extracted.visible)
                : { visible: extracted.visible, toolCalls: [] as RecoveredToolCall[] };
              if (scanned.visible) {
                emittedAnyText = true;
                yield { type: "text_delta", delta: scanned.visible };
              }
              recoveredToolCalls.push(...scanned.toolCalls);
            }
          }
```

EOF 分支改为：

```ts
        // Flush any remaining buffered content (e.g. a partial <think> prefix at EOF).
        if (thinkBuf) {
          const extracted = extractThinkBlocks(thinkBuf, { final: true });
          if (extracted.reasoning) {
            yield { type: "reasoning_delta", delta: extracted.reasoning, source: "think" };
          }
          if (extracted.visible) {
            const scanned = recovery
              ? recovery.push(extracted.visible)
              : { visible: extracted.visible, toolCalls: [] as RecoveredToolCall[] };
            if (scanned.visible) {
              emittedAnyText = true;
              yield { type: "text_delta", delta: scanned.visible };
            }
            recoveredToolCalls.push(...scanned.toolCalls);
          }
          thinkBuf = "";
        }
```

删除 `packages/api/src/providers/openai.ts` 里的 `THINK_RE` / `THINK_OPEN_TAG` 常量和 `stripThinkBlocks` 函数体，并从 `openai.test.ts` 删除 `describe("stripThinkBlocks", ...)` 整块（其行为已由 `think-blocks.test.ts` 覆盖）以及 `stripThinkBlocks` 的 import。

- [ ] **Step 6: 跑测试与类型检查**

Run: `pnpm --filter @openharness/api exec vitest run src/providers/think-blocks.test.ts src/providers/openai.test.ts && pnpm --filter @openharness/api check-types`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add packages/api/src/providers/think-blocks.ts packages/api/src/providers/think-blocks.test.ts packages/api/src/providers/openai.ts packages/api/src/providers/openai.test.ts
git commit -m "feat(api): <think> 块抽取为 reasoning 事件（含流结束语义）"
```

---

### Task 4: 引擎累积思考内容并写入消息

**Files:**
- Modify: `packages/core/src/engine/query-engine.ts:377-414`
- Test: `packages/core/src/engine/integration.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `reasoning_delta` / `AssistantMessage.reasoning`、`reasoningReplay`
- Produces: 每个带思考的 assistant 轮次都会在历史里留下 `reasoning`；`reasoning_content` 来源同时留下 `reasoningReplay`

- [ ] **Step 1: 写失败测试**

在 `packages/core/src/engine/integration.test.ts` 追加（沿用文件里的 `createMockStreamClient` / `allowAll` / `noopHooks`）：

```ts
  it("persists reasoning and replayable reasoning on the assistant message", async () => {
    const { client } = createMockStreamClient([
      [
        { type: "reasoning_delta", delta: "内部推演", source: "reasoning_content" },
        { type: "reasoning_delta", delta: "补充想法", source: "think" },
        { type: "text_delta", delta: "答案" },
        { type: "complete", stopReason: "end_turn" },
      ],
    ]);

    const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks());
    for await (const _ of engine.submitMessage("hi")) {}

    const history = engine.getHistory();
    const assistant = history.find((message) => message.type === "assistant") as any;
    expect(assistant.reasoning).toBe("内部推演补充想法");
    expect(assistant.reasoningReplay).toBe("内部推演");
    expect(assistant.content).toBe("答案");
  });

  it("keeps a reasoning-only assistant turn in history", async () => {
    const { client } = createMockStreamClient([
      [
        { type: "reasoning_delta", delta: "只有想法", source: "reasoning_content" },
        { type: "complete", stopReason: "end_turn" },
      ],
    ]);

    const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks());
    for await (const _ of engine.submitMessage("hi")) {}

    const history = engine.getHistory();
    const assistant = history.find((message) => message.type === "assistant") as any;
    expect(assistant.reasoning).toBe("只有想法");
    expect(assistant.content).toBe("");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @openharness/core exec vitest run src/engine/integration.test.ts -t "reasoning"`
Expected: FAIL —— `assistant.reasoning` 为 `undefined`。

- [ ] **Step 3: 实现**

`packages/core/src/engine/query-engine.ts` 在 `let assistantText = "";` 后加两个累积器：

```ts
      let assistantReasoning = "";
      let assistantReasoningReplay = "";
```

事件循环里补分支：

```ts
        } else if (event.type === "reasoning_delta") {
          assistantReasoning += event.delta;
          if (event.source === "reasoning_content") {
            assistantReasoningReplay += event.delta;
          }
        } else if (event.type === "usage") {
```

（即插在现有 `text_delta` 分支与 `tool_use_start` 分支之间。）

历史写入处改为：

```ts
      // 如果助手有文本、思考内容或工具调用，则将其添加到消息历史中
      if (assistantText || toolUses.length > 0 || assistantReasoning) {
        this.messages.push({
          type: "assistant",
          content: assistantText,
          phase: assistantPhase ?? (toolUses.length > 0 ? "commentary" : "final_answer"),
          toolUses: toolUses.length > 0 ? toolUses : undefined,
          ...(assistantReasoning ? { reasoning: assistantReasoning } : {}),
          ...(assistantReasoningReplay ? { reasoningReplay: assistantReasoningReplay } : {}),
        });
      }
```

- [ ] **Step 4: 跑测试与类型检查**

Run: `pnpm --filter @openharness/core exec vitest run src/engine/integration.test.ts && pnpm --filter @openharness/core check-types`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/engine/query-engine.ts packages/core/src/engine/integration.test.ts
git commit -m "feat(core): 引擎累积思考内容并写入助手消息"
```

---

### Task 5: 回传改用消息字段并删除 reasoningHistory

**Files:**
- Modify: `packages/api/src/providers/openai.ts:168`、`:449-455`、`:341-346`
- Test: `packages/api/src/providers/openai.test.ts`

**Interfaces:**
- Consumes: Task 4 写入的 `AssistantMessage.reasoningReplay`
- Produces: `convertMessages` 只从消息读思考内容；provider 实例不再持有跨轮状态

- [ ] **Step 1: 写失败测试**

在 `packages/api/src/providers/openai.test.ts` 的 `convertMessages reasoning_content gating` describe 内追加：

```ts
  it("replays reasoning from the assistant message field", async () => {
    const out = await client.build([
      {
        type: "assistant",
        content: "",
        reasoning: "想法",
        reasoningReplay: "想法",
        toolUses: [{ type: "tool_use", id: "t1", name: "foo", input: {} }],
      },
    ]);
    const assistant = out.find((message: any) => message.role === "assistant");
    expect(assistant.reasoning_content).toBe("想法");
  });

  it("does not replay think-only reasoning", async () => {
    const out = await client.build([
      {
        type: "assistant",
        content: "",
        reasoning: "来自 think 的想法",
        toolUses: [{ type: "tool_use", id: "t1", name: "foo", input: {} }],
      },
    ]);
    const assistant = out.find((message: any) => message.role === "assistant");
    expect(assistant.reasoning_content).toBeUndefined();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @openharness/api exec vitest run src/providers/openai.test.ts -t "replays reasoning"`
Expected: FAIL —— `reasoning_content` 为 `undefined`（当前实现只认实例内 Map）。

- [ ] **Step 3: 实现**

在 `convertMessages` 的 assistant 分支里，把：

```ts
          const reasoning = this.reasoningHistory.get(turnIdx);
          if (reasoning) {
            assistantMsg.reasoning_content = reasoning;
          } else if (msg.toolUses?.length && emptyReasoningRequired()) {
            assistantMsg.reasoning_content = "";
          }
```

改成：

```ts
          if (msg.reasoningReplay) {
            assistantMsg.reasoning_content = msg.reasoningReplay;
          } else if (msg.toolUses?.length && emptyReasoningRequired()) {
            assistantMsg.reasoning_content = "";
          }
```

删除：
- 字段 `private reasoningHistory: Map<number, string> = new Map();`（`:168`）
- 流结束处的写入（`const turnKey = this.reasoningHistory.size;` 起始的整段，`:341-346`）
- `let turnIdx = 0;` 与 assistant 分支末尾的 `turnIdx++;`（不再需要序号）

- [ ] **Step 4: 跑测试与类型检查**

Run: `pnpm --filter @openharness/api exec vitest run src/providers/openai.test.ts && pnpm --filter @openharness/api check-types`
Expected: PASS；`grep -n "reasoningHistory" packages/api/src/providers/openai.ts` 无输出。

- [ ] **Step 5: 提交**

```bash
git add packages/api/src/providers/openai.ts packages/api/src/providers/openai.test.ts
git commit -m "fix(api): 思考内容回传改读消息字段，删除按下标存取的 reasoningHistory"
```

---

### Task 6: agent-runtime 事件映射

**Files:**
- Modify: `packages/agent-runtime/src/framework-agent-run.ts:240-277`
- Test: `packages/agent-runtime/src/stream-event-mapping.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `ReasoningDeltaEvent`、`output.reasoning.delta`
- Produces: `streamEventToAgentEvent(event: StreamEvent): AgentEventInput | undefined`（导出，`text_delta` 与 `reasoning_delta` 两种映射；其余事件返回 `undefined` 由调用方继续处理）

- [ ] **Step 1: 写失败测试**

```ts
// packages/agent-runtime/src/stream-event-mapping.test.ts
import { describe, expect, it } from "vitest";
import { streamEventToAgentEvent } from "./framework-agent-run.js";

describe("streamEventToAgentEvent", () => {
  it("maps reasoning deltas to output.reasoning.delta", () => {
    expect(
      streamEventToAgentEvent({
        type: "reasoning_delta",
        delta: "想法",
        source: "reasoning_content",
      }),
    ).toEqual({
      type: "output.reasoning.delta",
      data: { delta: "想法", source: "reasoning_content" },
    });
  });

  it("maps text deltas with their phase", () => {
    expect(
      streamEventToAgentEvent({ type: "text_delta", delta: "答", phase: "commentary" }),
    ).toEqual({
      type: "output.text.delta",
      data: { delta: "答", phase: "commentary" },
    });
  });

  it("leaves other events to the caller", () => {
    expect(streamEventToAgentEvent({ type: "complete", stopReason: "stop" })).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @openharness/agent-runtime exec vitest run src/stream-event-mapping.test.ts`
Expected: FAIL —— `streamEventToAgentEvent` 未导出。

- [ ] **Step 3: 实现**

在 `packages/agent-runtime/src/framework-agent-run.ts` 的 import 旁加上类型导入（若尚未导入）：

```ts
import type { AgentEventInput } from "@openharness/core";
```

在文件顶部（class 之前）新增导出函数：

```ts
/** 把 StreamEvent 里与文本/思考相关的事件映射成 AgentEvent；其余事件交给调用方。 */
export function streamEventToAgentEvent(event: StreamEvent): AgentEventInput | undefined {
  if (event.type === "text_delta") {
    return {
      type: "output.text.delta",
      data: {
        delta: event.delta,
        ...(event.phase ? { phase: event.phase } : {}),
      },
    };
  }
  if (event.type === "reasoning_delta") {
    return {
      type: "output.reasoning.delta",
      data: { delta: event.delta, source: event.source },
    };
  }
  return undefined;
}
```

`projectStreamEvent` 的 text 分支改为复用：

```ts
  private async projectStreamEvent(event: StreamEvent): Promise<void> {
    const mapped = streamEventToAgentEvent(event);
    if (mapped) {
      await this.emit(mapped);
      return;
    }
    if (event.type === "complete") {
      await this.emit({
        type: "output.turn.completed",
        data: { stopReason: event.stopReason },
      });
    } else if (event.type === "tool_use_start") {
```

（后续 `tool_use_start` / `tool_use_end` / `usage` / `error` 分支保持原样。）

- [ ] **Step 4: 跑测试与类型检查**

Run: `pnpm --filter @openharness/agent-runtime exec vitest run src/stream-event-mapping.test.ts src/framework-agent-run-input.test.ts && pnpm --filter @openharness/agent-runtime check-types`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/agent-runtime/src/framework-agent-run.ts packages/agent-runtime/src/stream-event-mapping.test.ts
git commit -m "feat(agent-runtime): reasoning_delta 映射为 output.reasoning.delta"
```

---

### Task 7: 服务端投影 reasoning part

**Files:**
- Modify: `packages/server/src/application/session/transcript-projection.ts:18-27`、`:140-163`、`:164-189`、`:251-260`、`:276-292`
- Modify: `packages/server/src/application/agent/daemon-agent-event-projector.ts:121-130`
- Test: `packages/server/src/application/session/__test__/transcript-projection.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `output.reasoning.delta`；Task 1 的 `reasoning_delta`
- Produces: `type: "reasoning"` 的 part（`metadata.source`）+ `field: "reasoning"` 增量；状态新增 `activeReasoningPartId`、`reasoningChars`

- [ ] **Step 1: 写失败测试**

在 `packages/server/src/application/session/__test__/transcript-projection.test.ts` 追加：

```ts
  it("projects reasoning deltas into a reasoning part", () => {
    const store = createStore();
    const projection = new SessionTranscriptProjection(store);
    const state = projection.beginRun("s1", "i1", "r1", createInput());

    projection.projectStreamEvent(state, {
      type: "reasoning_delta",
      delta: "先看文件。",
      source: "reasoning_content",
    });

    expect(store.upsertMessagePart).toHaveBeenCalledWith(expect.objectContaining({
      type: "reasoning",
      status: "running",
      metadata: { source: "reasoning_content" },
    }));
    expect(store.appendMessagePartDelta).toHaveBeenCalledWith(expect.objectContaining({
      field: "reasoning",
      delta: "先看文件。",
    }));
  });

  it("closes the reasoning part when text starts and opens a new one later", () => {
    const store = createStore();
    const projection = new SessionTranscriptProjection(store);
    const state = projection.beginRun("s1", "i1", "r1", createInput());

    projection.projectStreamEvent(state, {
      type: "reasoning_delta",
      delta: "first",
      source: "think",
    });
    projection.projectStreamEvent(state, { type: "text_delta", delta: "正文" });
    projection.projectStreamEvent(state, {
      type: "reasoning_delta",
      delta: "second",
      source: "think",
    });

    const reasoningParts = store.upsertMessagePart.mock.calls
      .map(([input]) => input)
      .filter((input) => input.type === "reasoning");
    expect(reasoningParts).toHaveLength(3);
    expect(reasoningParts[0]).toMatchObject({ status: "running" });
    expect(reasoningParts[1]).toMatchObject({ status: "completed" });
    expect(reasoningParts[2]).toMatchObject({ status: "running" });
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @openharness/server exec vitest run src/application/session/__test__/transcript-projection.test.ts -t "reasoning"`
Expected: FAIL —— 没有任何 `type: "reasoning"` 的 part。

- [ ] **Step 3: 实现投影**

`ActiveTranscriptProjectionState` 增加两个字段：

```ts
  activeReasoningPartId?: string;
  reasoningChars?: number;
```

文件顶部加常量：

```ts
const REASONING_PART_CHAR_LIMIT = 1_000_000;
const REASONING_TRUNCATION_NOTICE = "\n\n…（思考内容过长，已截断）";
```

`projectStreamEvent` 里 `text_delta` 分支开头补关闭：

```ts
      case "text_delta": {
        this.completeOpenReasoningPart(state, "completed");
        const messageId = this.ensureAssistantMessage(state, true);
```

新增 `reasoning_delta` 分支（放在 `text_delta` 之前或之后皆可）：

```ts
      case "reasoning_delta": {
        const messageId = this.ensureAssistantMessage(state, true);
        if (!state.activeReasoningPartId) {
          const part = this.store.conversations.upsertMessagePart({
            sessionId: state.sessionId,
            messageId,
            type: "reasoning",
            status: "running",
            text: "",
            metadata: { source: event.source },
          });
          state.activeReasoningPartId = part.id;
        }
        const delta = this.takeReasoningDelta(state, event.delta);
        if (!delta) return {};
        return {
          liveEvent: this.store.incrementalOutput.appendMessagePartDelta({
            sessionId: state.sessionId,
            messageId,
            partId: state.activeReasoningPartId,
            field: "reasoning",
            delta,
          }),
        };
      }
```

`tool_use_start` 分支的 `this.completeOpenTextPart(state, "completed", "commentary");` 之前补一行：

```ts
        this.completeOpenReasoningPart(state, "completed");
```

`complete` 分支与 `error` 分支各补一次 `this.completeOpenReasoningPart(state, "completed");`（error 用 `"completed"`）。

新增两个私有方法（放在 `completeOpenTextPart` 之后）：

```ts
  completeOpenReasoningPart(
    state: ActiveTranscriptProjectionState,
    status: Extract<SessionMessagePartStatus, "completed" | "failed" | "interrupted">,
  ): void {
    if (!state.assistantMessageId || !state.activeReasoningPartId) return;
    this.store.conversations.upsertMessagePart({
      id: state.activeReasoningPartId,
      sessionId: state.sessionId,
      messageId: state.assistantMessageId,
      type: "reasoning",
      status,
    });
    delete state.activeReasoningPartId;
    delete state.reasoningChars;
  }

  private takeReasoningDelta(
    state: ActiveTranscriptProjectionState,
    delta: string,
  ): string {
    const used = state.reasoningChars ?? 0;
    if (used >= REASONING_PART_CHAR_LIMIT) return "";
    if (used + delta.length <= REASONING_PART_CHAR_LIMIT) {
      state.reasoningChars = used + delta.length;
      return delta;
    }
    state.reasoningChars = REASONING_PART_CHAR_LIMIT;
    return delta.slice(0, REASONING_PART_CHAR_LIMIT - used) + REASONING_TRUNCATION_NOTICE;
  }
```

`packages/server/src/application/agent/daemon-agent-event-projector.ts` 的 `project()` 里，`output.text.delta` case 之后新增：

```ts
      case "output.reasoning.delta":
        this.projectStream(event, {
          type: "reasoning_delta",
          delta: event.data.delta,
          source: event.data.source,
        });
        return;
```

同一个 Step 还要放开协议类型（**计划修订**：这一步原本写在 Task 9，但 server 投影在类型检查里必须有它才能编译，故提前到本任务；Task 9 只保留 reducer 改动）：

`packages/protocol/src/session.ts` 的 `AppendMessagePartDeltaInput`：

```ts
  /** 增量写入的字段；reasoning 用于模型的思考内容。 */
  field: "text" | "reasoning";
```

- [ ] **Step 4: 跑测试与类型检查**

Run: `pnpm --filter @openharness/server exec vitest run src/application/session/__test__/transcript-projection.test.ts && pnpm --filter @openharness/server check-types`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/application/session/transcript-projection.ts packages/server/src/application/agent/daemon-agent-event-projector.ts packages/server/src/application/session/__test__/transcript-projection.test.ts
git commit -m "feat(server): reasoning 事件投影为 reasoning part 与增量"
```

---

### Task 8: 历史重建与压缩重写保留思考内容

**Files:**
- Modify: `packages/server/src/application/agent/agent-transcript.ts:57-74`、`:123-146`、`:189-194`
- Test: `packages/server/src/application/agent/__test__/agent-transcript.test.ts`

**Interfaces:**
- Consumes: Task 7 产出的 `reasoning` part（含 `metadata.source`）
- Produces: `buildAgentTranscript` 重建出 `AssistantMessage.reasoning` / `reasoningReplay`，且 `content` 只含 text part；`agentMessagesToTranscript` 把两个字段写回 reasoning part

- [ ] **Step 1: 写失败测试**

在 `packages/server/src/application/agent/__test__/agent-transcript.test.ts` 追加（该文件已导入 `agentMessagesToTranscript` 与 `buildAgentTranscript`；下面用内联字面量构造记录，不依赖额外工厂）：

```ts
  it("rebuilds reasoning fields without merging them into content", () => {
    const messages = [
      {
        id: "m1",
        sessionId: "s1",
        seq: 2,
        role: "assistant",
        metadata: {},
        createdAt: 2,
        updatedAt: 2,
      },
    ] as any;
    const parts = [
      {
        id: "p1",
        sessionId: "s1",
        messageId: "m1",
        seq: 1,
        type: "reasoning",
        status: "completed",
        text: "想法A",
        metadata: { source: "reasoning_content" },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "p2",
        sessionId: "s1",
        messageId: "m1",
        seq: 2,
        type: "reasoning",
        status: "completed",
        text: "想法B",
        metadata: { source: "think" },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "p3",
        sessionId: "s1",
        messageId: "m1",
        seq: 3,
        type: "text",
        status: "completed",
        text: "答案",
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      },
    ] as any;

    const transcript = buildAgentTranscript(messages, parts);
    const assistant = transcript.messages.find((message) => message.type === "assistant") as any;
    expect(assistant.content).toBe("答案");
    expect(assistant.reasoning).toBe("想法A想法B");
    expect(assistant.reasoningReplay).toBe("想法A");
  });

  it("writes reasoning back when the transcript is replaced", () => {
    const output = agentMessagesToTranscript([
      {
        type: "assistant",
        content: "答案",
        reasoning: "想法A想法B",
        reasoningReplay: "想法A",
      } as any,
    ]);

    const parts = output[0]!.parts;
    expect(parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "reasoning",
          text: "想法A",
          metadata: { source: "reasoning_content" },
        }),
        expect.objectContaining({
          type: "reasoning",
          text: "想法B",
          metadata: { source: "think" },
        }),
      ]),
    );
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @openharness/server exec vitest run src/application/agent/__test__/agent-transcript.test.ts -t "reasoning"`
Expected: FAIL —— `assistant.content` 为 `"想法A想法B答案"` 且 `reasoning` 为 `undefined`。

- [ ] **Step 3: 实现**

`agent-transcript.ts` 的 `textFromParts` 改为只取 text part：

```ts
function textFromParts(parts: SessionMessagePartRecord[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}
```

新增两个提取函数：

```ts
function reasoningFromParts(parts: SessionMessagePartRecord[]): string {
  return parts
    .filter((part) => part.type === "reasoning")
    .map((part) => part.text ?? "")
    .join("");
}

function reasoningReplayFromParts(parts: SessionMessagePartRecord[]): string {
  return parts
    .filter(
      (part) =>
        part.type === "reasoning" &&
        (part.metadata as Record<string, unknown>).source === "reasoning_content",
    )
    .map((part) => part.text ?? "")
    .join("");
}
```

`buildAgentTranscript` 的 assistant 分支改为：

```ts
    const text = textFromParts(messageParts);
    const reasoning = reasoningFromParts(messageParts);
    const reasoningReplay = reasoningReplayFromParts(messageParts);
    const phase = assistantPhaseFromParts(messageParts);
    if (text || toolUses.length > 0 || reasoning) {
      output.push({
        type: "assistant",
        content: text,
        ...(phase ? { phase } : {}),
        ...(toolUses.length > 0 ? { toolUses } : {}),
        ...(reasoning ? { reasoning } : {}),
        ...(reasoningReplay ? { reasoningReplay } : {}),
      });
    }
```

`agentMessagesToTranscript` 的 assistant 分支，在 push text part 之前补 reasoning part：

```ts
      if (message.reasoning) {
        const replay = message.reasoningReplay ?? "";
        // 只有 reasoning_content 来源能回传；think 部分按前缀切出来。
        // 实际场景一轮只会出现一种来源，混用时按 replay 在前处理。
        const thinkOnly = replay
          ? message.reasoning.startsWith(replay)
            ? message.reasoning.slice(replay.length)
            : ""
          : message.reasoning;
        if (replay) {
          transcriptParts.push({
            type: "reasoning",
            status: "completed",
            text: replay,
            metadata: { source: "reasoning_content" },
          });
        }
        if (thinkOnly) {
          transcriptParts.push({
            type: "reasoning",
            status: "completed",
            text: thinkOnly,
            metadata: { source: "think" },
          });
        }
      }
```

- [ ] **Step 4: 跑测试与类型检查**

Run: `pnpm --filter @openharness/server exec vitest run src/application/agent/__test__/agent-transcript.test.ts && pnpm --filter @openharness/server check-types`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/application/agent/agent-transcript.ts packages/server/src/application/agent/__test__/agent-transcript.test.ts
git commit -m "fix(server): 历史重建与压缩重写保留思考内容且不并入正文"
```

---

### Task 9: 协议增量字段与客户端 reducer

**Files:**
- Modify: `packages/protocol/src/session.ts:513-519`
- Modify: `packages/client/src/state/reducer.ts:275-317`
- Test: `packages/client/src/state/__test__/reducer.test.ts`

**Interfaces:**
- Consumes: Task 7 的 `field: "reasoning"` 增量
- Produces: `AppendMessagePartDeltaInput.field: "text" | "reasoning"`；reducer 为 reasoning 增量建占位 part 时 `type: "reasoning"`

- [ ] **Step 1: 写失败测试**

在 `packages/client/src/state/__test__/reducer.test.ts` 追加：

```ts
  it("appends reasoning deltas and creates a reasoning placeholder part", () => {
    let state = createInitialClientState();
    state = applyEvent(state, event(1, "session.message.part.delta", {
      sessionId: "s1",
      messageId: "m1",
      partId: "p1",
      field: "reasoning",
      delta: "先想一下",
    }));

    const part = state.buckets.s1?.partsByMessageId.m1?.[0];
    expect(part).toMatchObject({ id: "p1", type: "reasoning", text: "先想一下", status: "running" });

    state = applyEvent(state, event(2, "session.message.part.delta", {
      sessionId: "s1",
      messageId: "m1",
      partId: "p1",
      field: "reasoning",
      delta: "再动手",
    }));
    expect(state.buckets.s1?.partsByMessageId.m1?.[0]?.text).toBe("先想一下再动手");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @openharness/client exec vitest run src/state/__test__/reducer.test.ts -t "reasoning"`
Expected: FAIL —— part 不存在（`field: "reasoning"` 被直接丢弃）。

- [ ] **Step 3: 实现**

`packages/protocol/src/session.ts` 的 `AppendMessagePartDeltaInput.field` 已在 Task 7 放开为 `"text" | "reasoning"`（计划修订），本任务不重复修改。

`packages/client/src/state/reducer.ts` 的 `appendPartDelta`（`:275-317`）改两处。第一处是入口校验（`:281`）：

```ts
  if (field !== "text" && field !== "reasoning") return state;
  if (!sessionId || !messageId || !partId || delta === undefined) return state;
```

第二处是占位 part 的类型（`:301`）：

```ts
      type: field === "reasoning" ? "reasoning" : "text",
```

其余逻辑（`:289-293` 的文本追加、seq 排序）对两种 field 通用，不用改。

- [ ] **Step 4: 跑测试与类型检查**

Run: `pnpm --filter @openharness/client exec vitest run src/state/__test__/reducer.test.ts && pnpm --filter @openharness/client check-types && pnpm --filter @openharness/protocol check-types`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/protocol/src/session.ts packages/client/src/state/reducer.ts packages/client/src/state/__test__/reducer.test.ts
git commit -m "feat(client): 支持 reasoning part 增量与占位 part"
```

---

### Task 10: 设置字段 showReasoning

**Files:**
- Modify: `packages/core/src/types/settings.ts:125-156`
- Modify: `packages/core/src/config/settings.ts:283-310`（`TOP_LEVEL_SETTINGS_FIELDS`）
- Modify: `packages/server/src/application/default-services/settings-service.ts:266-316`（`coerceConfigValue`）
- Test: `packages/core/src/config/settings.test.ts`（若不存在则新建）、`packages/server/src/application/default-services/settings-service.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `Settings.showReasoning?: boolean`（缺省 `true`）；`/config set showReasoning on|off` 能存成布尔值

- [ ] **Step 1: 写失败测试**

`packages/core/src/config/settings.test.ts`（若已有文件则追加用例）：

```ts
  it("accepts and preserves the showReasoning setting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-settings-"));
    try {
      await writeFile(
        join(dir, "settings.json"),
        JSON.stringify({ showReasoning: false }),
        "utf-8",
      );
      const settings = await loadSettings({ configDir: dir });
      expect(settings.showReasoning).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
```

`packages/server/src/application/default-services/settings-service.test.ts` 追加（照该文件现有的 service 构造方式）：

```ts
  it("coerces the showReasoning config value to a boolean", async () => {
    const service = createSettingsService();
    const result = await service.patch({ path: "showReasoning", value: "off" });
    expect(result.settings.showReasoning).toBe(false);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @openharness/core exec vitest run src/config/settings.test.ts -t "showReasoning"` 与 `pnpm --filter @openharness/server exec vitest run src/application/default-services/settings-service.test.ts -t "showReasoning"`
Expected: 第一个 FAIL（`showReasoning` 不在顶层白名单会抛错）；第二个 FAIL（存成字符串 `"off"`，真值）。

- [ ] **Step 3: 实现**

`packages/core/src/types/settings.ts` 的 `Settings` 增加（放在 `verbose?: boolean;` 之前）：

```ts
  /** 是否在会话界面展示模型的思考过程，缺省视为 true。 */
  showReasoning?: boolean;
```

`packages/core/src/config/settings.ts` 的 `TOP_LEVEL_SETTINGS_FIELDS` 增加 `"showReasoning"`（放在 `"verbose"` 之前）。

`packages/server/src/application/default-services/settings-service.ts` 的 `coerceConfigValue` 布尔键数组增加 `"showReasoning"`：

```ts
  if (
    [
      "verbose",
      "fastMode",
      "showReasoning",
      "plugins.enabled",
      "memory.enabled",
      "memory.sessionMemoryEnabled",
      "memory.autoExtractEnabled",
      "memory.autoDreamEnabled",
      "daemon.autoStart",
    ].includes(key)
  ) {
```

- [ ] **Step 4: 跑测试与类型检查**

Run: `pnpm --filter @openharness/core exec vitest run src/config/settings.test.ts && pnpm --filter @openharness/server exec vitest run src/application/default-services/settings-service.test.ts && pnpm --filter @openharness/core check-types && pnpm --filter @openharness/server check-types`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/types/settings.ts packages/core/src/config/settings.ts packages/server/src/application/default-services/settings-service.ts packages/core/src/config/settings.test.ts packages/server/src/application/default-services/settings-service.test.ts
git commit -m "feat(settings): 新增 showReasoning 展示开关"
```

---

### Task 11: `/reasoning` 命令

**Files:**
- Modify: `packages/server/src/commands/commands.ts:193-199`（命令目录）
- Modify: `packages/client/src/commands/session-commands.ts:782-793`（照 `/fast` 的实现位置追加）
- Test: `packages/client/src/commands/__test__/session-commands.test.ts`

**Interfaces:**
- Consumes: Task 10 的 `showReasoning` 设置
- Produces: `/reasoning`（无参切换）、`/reasoning on|off`（显式设置），输出 `Reasoning: ON/OFF`

- [ ] **Step 1: 写失败测试**

在 `packages/client/src/commands/__test__/session-commands.test.ts` 的 `describe("dispatchSessionCommand", ...)` 内追加（该文件的 `host()` / `fakeClient()` 见文件顶部，`fakeClient` 的 override 以方法名为键）：

```ts
  it("toggles showReasoning with no argument", async () => {
    const patchSettings = vi.fn(async () => ({}));
    const { host: h, emitted } = host({
      client: fakeClient({
        getSettings: async () => ({ showReasoning: false }),
        patchSettings,
      }),
    });

    await dispatchSessionCommand({ name: "/reasoning", args: "" }, h);

    expect(patchSettings).toHaveBeenCalledWith({ showReasoning: true });
    expect(emitted.join("\n")).toContain("Reasoning: ON");
  });

  it("accepts an explicit off argument", async () => {
    const patchSettings = vi.fn(async () => ({}));
    const { host: h } = host({
      client: fakeClient({
        getSettings: async () => ({ showReasoning: true }),
        patchSettings,
      }),
    });

    await dispatchSessionCommand({ name: "/reasoning", args: "off" }, h);

    expect(patchSettings).toHaveBeenCalledWith({ showReasoning: false });
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @openharness/client exec vitest run src/commands/__test__/session-commands.test.ts -t "reasoning"`
Expected: FAIL —— 命令未实现（返回 unhandled 或输出 usage）。

- [ ] **Step 3: 实现**

`packages/server/src/commands/commands.ts` 的 `BUILTIN_SESSION_COMMANDS` 数组里，`/effort` 之后追加：

```ts
  {
    name: "/reasoning",
    description: "Show or hide model reasoning in the transcript",
    kind: "session",
    source: "builtin",
    argumentHint: "[on|off]",
  },
```

`packages/client/src/commands/session-commands.ts` 的 `/fast` 分支之后追加（与 `/fast` 相同：无参数即切换，因此不需要进 `shouldPresentSlashOutput`）：

```ts
  if (slash?.name === "/reasoning") {
    const arg = slash.args.trim().split(/\s+/).filter(Boolean)[0];
    const settings = await client.system.getSettings();
    const current = settings.showReasoning !== false;
    let next: boolean;
    if (arg === "on") next = true;
    else if (arg === "off") next = false;
    else next = !current;
    await client.system.patchSettings({ showReasoning: next });
    emit(`Reasoning: ${next ? "ON" : "OFF"}`);
    return "handled";
  }
```

- [ ] **Step 4: 跑测试与类型检查**

Run: `pnpm --filter @openharness/client exec vitest run src/commands/__test__/session-commands.test.ts && pnpm --filter @openharness/client check-types && pnpm --filter @openharness/server check-types`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/commands/commands.ts packages/client/src/commands/session-commands.ts packages/client/src/commands/__test__/session-commands.test.ts
git commit -m "feat(client): 新增 /reasoning 展示开关命令"
```

---

### Task 12: 桌面设置快照与写值通路

**Files:**
- Modify: `apps/desktop/src/shared/settings-types.ts:15-27`、`:58-78`、`:88-94`
- Modify: `apps/desktop/src/main/features/settings/settings-service.ts:44-61`
- Modify: `apps/desktop/src/shared/ipc-channels.ts:301-306`、`:390-410`
- Modify: `apps/desktop/src/main/features/settings/ipc.ts`
- Modify: `apps/desktop/src/preload/desktop-api.ts:229-245`
- Modify: `apps/desktop/src/shared/desktop-api-contract.ts:285-300`
- Modify: `apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx:110-191`（新增控件）与同文件的控件区（`:238` 附近）
- Test: `apps/desktop/src/main/features/settings/settings-service.test.ts`、`apps/desktop/src/renderer/src/components/desktop/settings-page/__test__/` 下现有设置页测试（若有）

**Interfaces:**
- Consumes: Task 10 的 `showReasoning` 设置；daemon `PATCH /settings`
- Produces: `DesktopSettingsSnapshot.showReasoning: boolean`；`window.desktop.settings.updateReasoningVisibility({ showReasoning })`

- [ ] **Step 1: 写失败测试**

`apps/desktop/src/main/features/settings/settings-service.test.ts` 追加（沿用该文件顶部的 `preferences` 与 `defaultSnapshot`；把 `defaultSnapshot` 补上 `showReasoning: true`）：

```ts
describe("DesktopSettingsService.updateReasoningVisibility", () => {
  it("patches showReasoning through the daemon client", async () => {
    const patchSettings = vi.fn(async (patch) => patch)
    const service = new DesktopSettingsService({
      daemonClient: async () => ({
        protocol: { capabilities: vi.fn() },
        system: { getSettings: vi.fn(), patchSettings },
      }),
      refreshDaemonClient: async () => ({
        protocol: { capabilities: vi.fn() },
        system: { getSettings: vi.fn(), patchSettings },
      }),
      getPreferences: preferences,
      patchPreferences: vi.fn(),
    })

    const result = await service.updateReasoningVisibility({ showReasoning: false })

    expect(patchSettings).toHaveBeenCalledWith({ showReasoning: false })
    expect(result).toMatchObject({ showReasoning: false })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @openharness/desktop exec vitest run src/main/features/settings/settings-service.test.ts -t "showReasoning"`
Expected: FAIL —— 方法不存在 / 快照类型缺字段。

- [ ] **Step 3: 实现**

`apps/desktop/src/shared/settings-types.ts`：

```ts
export interface DesktopSettingsSnapshot {
  workStyle: DesktopWorkStyle
  notificationMode: DesktopNotificationMode
  agentEnvironment: DesktopAgentEnvironment
  showReasoning: boolean
  restartRequired: boolean
  defaultOpenerId: string | null
  defaultTerminalShellId: string | null
  wslSupported?: boolean
}

export interface UpdateDesktopReasoningVisibilityInput {
  showReasoning: boolean
}
```

`buildDesktopSettingsSnapshot` 的返回对象里加：

```ts
    showReasoning: settings.showReasoning !== false,
```

`apps/desktop/src/main/features/settings/settings-service.ts` 照 `updateWorkStyle` 追加：

```ts
  async updateReasoningVisibility(
    input: UpdateDesktopReasoningVisibilityInput
  ): Promise<DesktopSettingsSnapshot> {
    if (typeof input.showReasoning !== "boolean") {
      throw new Error("思考过程展示开关必须是布尔值。")
    }
    return this.withDaemonRetry(async (client) => {
      const settings = await client.system.patchSettings({ showReasoning: input.showReasoning })
      return buildDesktopSettingsSnapshot(settings, this.dependencies.getPreferences())
    })
  }
```

`apps/desktop/src/shared/ipc-channels.ts` 增加频道与类型映射：

```ts
  settingsUpdateReasoningVisibility: "settings:update-reasoning-visibility",
```

```ts
  [IpcChannels.settingsUpdateReasoningVisibility]: {
    args: [input: UpdateDesktopReasoningVisibilityInput]
    result: DesktopSettingsSnapshot
  }
```

`apps/desktop/src/main/features/settings/ipc.ts` 的注册数组增加：

```ts
      {
        channel: IpcChannels.settingsUpdateReasoningVisibility,
        handler: (_event, input) =>
          desktopSettingsService.updateReasoningVisibility(
            input as UpdateDesktopReasoningVisibilityInput
          ),
      },
```

`apps/desktop/src/preload/desktop-api.ts` 的 `settings` 对象增加：

```ts
    updateReasoningVisibility: (
      input: IpcInvokeMap[typeof IpcChannels.settingsUpdateReasoningVisibility]["args"][0]
    ) => invoke(IpcChannels.settingsUpdateReasoningVisibility, input),
```

`apps/desktop/src/shared/desktop-api-contract.ts` 的 `settings` 增加：

```ts
    updateReasoningVisibility: (
      input: UpdateDesktopReasoningVisibilityInput
    ) => Promise<DesktopSettingsSnapshot>
```

`settings-content.tsx` 的"常规"区里，在"工作风格"那一行之后插入：

```tsx
        <Separator />
        <SettingRow
          title="思考过程"
          description="在对话中展示模型的思考过程（默认收起，点击展开）。"
          control={<ReasoningVisibilityControl />}
        />
```

在同文件控件区（`WorkStyleControl` 之后）新增：

```tsx
function ReasoningVisibilityControl(): React.JSX.Element {
  const [enabled, setEnabled] = useState(true)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.desktop.settings
      .snapshot()
      .then((snapshot) => {
        if (!cancelled) setEnabled(snapshot.showReasoning)
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const update = (next: boolean): void => {
    if (saving || next === enabled) return
    const previous = enabled
    setEnabled(next)
    setSaving(true)
    setError(null)
    void window.desktop.settings
      .updateReasoningVisibility({ showReasoning: next })
      .then((snapshot) => setEnabled(snapshot.showReasoning))
      .catch((saveError: unknown) => {
        setEnabled(previous)
        setError(errorMessage(saveError))
      })
      .finally(() => setSaving(false))
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Switch
        aria-label="思考过程"
        checked={enabled}
        disabled={loading || saving}
        onCheckedChange={update}
      />
      {error ? (
        <p role="alert" className="text-ui-caption max-w-56 text-right text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
```

（`Switch` / `useState` / `useEffect` 该文件已导入。）

- [ ] **Step 4: 跑测试与类型检查**

Run: `pnpm --filter @openharness/desktop exec vitest run src/main/features/settings/settings-service.test.ts && pnpm --filter @openharness/desktop check-types`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/shared/settings-types.ts apps/desktop/src/main/features/settings/settings-service.ts apps/desktop/src/shared/ipc-channels.ts apps/desktop/src/main/features/settings/ipc.ts apps/desktop/src/preload/desktop-api.ts apps/desktop/src/shared/desktop-api-contract.ts apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx apps/desktop/src/main/features/settings/settings-service.test.ts
git commit -m "feat(desktop): 设置页新增思考过程开关"
```

---

### Task 13: 桌面会话页读取开关与超长省略

**Files:**
- Create: `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/reasoning-text.ts`
- Create: `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/reasoning-text.test.ts`
- Create: `apps/desktop/src/renderer/src/components/desktop/conversation-page/use-show-reasoning.ts`
- Modify: `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/assistant-message.tsx:91-100`
- Modify: `apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx:526-544`

**Interfaces:**
- Consumes: Task 12 的 `window.desktop.settings.snapshot().showReasoning`
- Produces: `truncateReasoning(text, limit) => { text, omitted }`；`useShowReasoning()` hook

- [ ] **Step 1: 写失败测试**

```ts
// apps/desktop/src/renderer/src/components/desktop/conversation-page/message/reasoning-text.test.ts
import { describe, expect, it } from "vitest"
import { truncateReasoning } from "./reasoning-text"

describe("truncateReasoning", () => {
  it("keeps short text unchanged", () => {
    expect(truncateReasoning("想法", 20000)).toEqual({ text: "想法", omitted: 0 })
  })

  it("keeps the tail and reports how much was omitted", () => {
    const long = "a".repeat(20005)
    const result = truncateReasoning(long, 20000)
    expect(result.text).toHaveLength(20000)
    expect(result.text).toBe(long.slice(-20000))
    expect(result.omitted).toBe(5)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @openharness/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/message/reasoning-text.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

```ts
// reasoning-text.ts
export const REASONING_DISPLAY_LIMIT = 20_000

export function truncateReasoning(
  text: string,
  limit = REASONING_DISPLAY_LIMIT
): { text: string; omitted: number } {
  if (text.length <= limit) return { text, omitted: 0 }
  return { text: text.slice(-limit), omitted: text.length - limit }
}
```

```ts
// use-show-reasoning.ts
import { useEffect, useState } from "react"

/** 读取桌面设置里的思考过程开关；页面挂载时取一次，默认显示。 */
export function useShowReasoning(): boolean {
  const [showReasoning, setShowReasoning] = useState(true)

  useEffect(() => {
    let cancelled = false
    void window.desktop.settings
      .snapshot()
      .then((snapshot) => {
        if (!cancelled) setShowReasoning(snapshot.showReasoning)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  return showReasoning
}
```

`assistant-message.tsx` 的 reasoning 分支改为：

```tsx
        if (unit.type === "reasoning") {
          const truncated = truncateReasoning(unit.text)
          return (
            <details key={unit.id} className="text-ui-small text-ui-muted">
              <summary className="w-fit cursor-pointer font-medium select-none hover:text-foreground">
                思考过程
              </summary>
              <p className="mt-2 border-l pl-3.5 leading-6 whitespace-pre-wrap">{truncated.text}</p>
              {truncated.omitted > 0 ? (
                <p className="mt-1 text-ui-caption text-ui-muted">
                  已省略前 {truncated.omitted} 个字符
                </p>
              ) : null}
            </details>
          )
        }
```

并在该文件顶部加 `import { truncateReasoning } from "./reasoning-text"`。

`conversation-page.tsx` 的 `ConversationTranscript` 调用处加一行：

```tsx
                      showReasoning={showReasoning}
```

并在组件内 `const canOpenReview = ...` 附近加 `const showReasoning = useShowReasoning()`，顶部 import 该 hook。

- [ ] **Step 4: 跑测试与类型检查**

Run: `pnpm --filter @openharness/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/transcript/__test__/transcript.test.ts src/renderer/src/components/desktop/conversation-page/message/reasoning-text.test.ts && pnpm --filter @openharness/desktop check-types`
Expected: PASS（现有 reasoning 显示/隐藏用例仍通过）。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/renderer/src/components/desktop/conversation-page/message/reasoning-text.ts apps/desktop/src/renderer/src/components/desktop/conversation-page/message/reasoning-text.test.ts apps/desktop/src/renderer/src/components/desktop/conversation-page/use-show-reasoning.ts apps/desktop/src/renderer/src/components/desktop/conversation-page/message/assistant-message.tsx apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx
git commit -m "feat(desktop): 会话页按设置展示思考过程并省略超长内容"
```

---

### Task 14: TUI 独立渲染思考条目

**Files:**
- Modify: `apps/frontend/src/types/index.ts:17-25`
- Modify: `apps/frontend/src/hooks/transcript.ts:30-35`、`:52-60`
- Modify: `apps/frontend/src/routes/session/parts.tsx:103-110`（新增 case）
- Modify: `apps/frontend/src/hooks/useServerSync.ts:474-500`、`:731-747`
- Test: `apps/frontend/src/hooks/transcript.test.ts`

**Interfaces:**
- Consumes: Task 9 的 reasoning part；Task 10 的 `showReasoning` 设置
- Produces: `TranscriptItem.role` 增加 `"reasoning"`；`bucketToTranscript(bucket, options?: { showReasoning?: boolean })`

- [ ] **Step 1: 写失败测试**

在 `apps/frontend/src/hooks/transcript.test.ts` 追加（该文件用 `bun:test`，已有 `input()` / `message()` / `part()` / `bucket()` 工厂）：

```ts
function reasoningPart(messageId: string, seq: number, text: string): SessionMessagePartRecord {
  return { ...part(messageId, seq, text), id: `p:${messageId}:reasoning`, type: "reasoning" };
}

test("projects reasoning parts as their own items", () => {
  const value = bucket(
    [input("i1", 1, "问题")],
    [message("m1", 2, "assistant")],
    [reasoningPart("m1", 1, "先想"), part("m1", 2, "答案")],
  );

  const items = bucketToTranscript(value);
  expect(items.map((item) => item.role)).toEqual(["reasoning", "assistant"]);
  expect(items[0]!.text).toBe("先想");
});

test("drops reasoning items when showReasoning is false", () => {
  const value = bucket(
    [input("i1", 1, "问题")],
    [message("m1", 2, "assistant")],
    [reasoningPart("m1", 1, "先想")],
  );

  expect(bucketToTranscript(value, { showReasoning: false })).toEqual([]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @openharness/frontend exec bun test src/hooks/transcript.test.ts`
Expected: FAIL —— reasoning part 被合并成 `role: "assistant"`（且 `bucketToTranscript` 不接受第二个参数）。

- [ ] **Step 3: 实现**

`apps/frontend/src/types/index.ts` 的 `TranscriptItem.role` 增加 `"reasoning"`。

`apps/frontend/src/hooks/transcript.ts` 的 part 循环里，把 `text` 与 `reasoning` 共用分支拆开：

```ts
    if (part.type === "text") {
      if (part.text) items.push({
        id: `${message.id}:${part.id}`,
        role: "assistant",
        text: part.text,
        streaming: part.status === "pending" || part.status === "running",
      });
      continue;
    }
    if (part.type === "reasoning") {
      if (part.text) items.push({
        id: `${message.id}:${part.id}`,
        role: "reasoning",
        text: part.text,
        streaming: part.status === "pending" || part.status === "running",
      });
      continue;
    }
```

`bucketToTranscript` 增加可选参数与过滤：

```ts
export function bucketToTranscript(
  bucket: SessionBucket | undefined,
  options: { showReasoning?: boolean } = {},
): TranscriptItem[] {
  const items = projectBucketToItems(bucket);
  if (options.showReasoning === false) {
    return items.filter((item) => item.role !== "reasoning");
  }
  return items;
}
```

（把现有 `bucketToTranscript` 的函数体原样改名为 `projectBucketToItems` 私有函数，新函数只做过滤，避免动现有投影逻辑。）

`apps/frontend/src/routes/session/parts.tsx` 的 `switch (item.role)` 增加 case（放在 `case "assistant"` 之前）：

```tsx
    case "reasoning":
      return (
        <CollapsibleTranscriptBlock
          tone={c.muted}
          summary={`思考过程${item.streaming ? " …" : ""}`}
        >
          <text fg={c.muted}>{item.text}</text>
        </CollapsibleTranscriptBlock>
      );
```

`apps/frontend/src/hooks/useServerSync.ts` 增加状态与投影参数：

```ts
  const [showReasoning, setShowReasoning] = useState(true);
```

bootstrap 读取设置处（`client.system.getSettings()` 之后）加：

```ts
        setShowReasoning(settings.showReasoning !== false);
```

投影处改为：

```ts
  const transcriptView = useMemo(() => {
    const base = splitStreamingAssistant(bucketToTranscript(bucket, { showReasoning }));
    return {
      transcript: [...base.items, ...recoveryItems, ...(activeSessionId ? (systemItemsBySession[activeSessionId] ?? []) : globalSystemItems)],
      assistantBuffer: base.assistantBuffer,
    };
  }, [activeSessionId, bucket, globalSystemItems, recoveryItems, showReasoning, systemItemsBySession]);
```

- [ ] **Step 4: 跑测试与类型检查**

Run: `pnpm --filter @openharness/frontend exec bun test src/hooks/transcript.test.ts && pnpm --filter @openharness/frontend check-types`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/frontend/src/types/index.ts apps/frontend/src/hooks/transcript.ts apps/frontend/src/routes/session/parts.tsx apps/frontend/src/hooks/useServerSync.ts apps/frontend/src/hooks/transcript.test.ts
git commit -m "feat(frontend): TUI 单独展示思考过程条目"
```

---

### Task 15: 收尾验证

**Files:**
- 无新增；只跑验证

- [ ] **Step 1: 全量类型检查**

Run: `pnpm check-types`
Expected: 全部包通过。

- [ ] **Step 2: 相关包测试**

Run: `pnpm --filter @openharness/api test && pnpm --filter @openharness/core test && pnpm --filter @openharness/client test && pnpm --filter @openharness/server test && pnpm --filter @openharness/agent-runtime exec vitest run src/stream-event-mapping.test.ts src/framework-agent-run-input.test.ts src/default-runtime-provider.test.ts`
Expected: 全部通过（agent-runtime 全量测试很慢，只跑受影响文件）。

- [ ] **Step 3: 文档与架构检查**

Run: `pnpm check-docs`
Expected: `文档检查通过`。

- [ ] **Step 4: 手工验收（按 spec 的五条）**

1. 桌面用带思考的模型跑一轮：看到收起的"思考过程"块，点开有内容。
2. `/reasoning off` 后历史与新消息里的思考块都消失；`/reasoning on` 后恢复。
3. DeepSeek 带 `tools` 的多轮工具调用不出现 400。
4. 触发一次上下文压缩后，思考内容没有贴到其它 assistant 消息上。
5. 重启 daemon 后继续同一会话的带工具多轮对话：思考块仍在且不 400。
