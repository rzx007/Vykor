# 上下文占用分桶与预算观测 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 按桶统计当前 session 即将发送的上下文占用，经 `/context usage` 与桌面 Context 环/托盘展示，支持同 session 换模重算与软提示。

**架构：** `packages/core` 提供带 `ContextBucketId` 的 ledger 段与纯函数 Assembler；prompt/tools/messages 在组装时打标（模型可见内容不变）；server 在与下一跳发送同源处写 session 缓存并由 `ContextService.usage` 读取；桌面只消费快照渲染环与托盘。

**技术栈：** TypeScript、Vitest、Hono HTTP、桌面 React + Tailwind。

**规格：** `docs/superpowers/specs/2026-09-04-context-usage-budget-design.md`

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| 创建 `packages/core/src/context-budget/types.ts` | 桶 ID、segment、snapshot、tip code 类型与展示 label |
| 创建 `packages/core/src/context-budget/assemble.ts` | segments → buckets → snapshot（含 percentFull、source） |
| 创建 `packages/core/src/context-budget/tips.ts` | 按阈值生成 tips（含换模溢出） |
| 创建 `packages/core/src/context-budget/messages-to-segments.ts` | Message[] → conversation/summary segments（compactRole + 启发式） |
| 创建 `packages/core/src/context-budget/tool-segments.ts` | 已序列化工具 schema → tools/mcp 段 |
| 创建 `packages/core/src/context-budget/format-report.ts` | CLI 人类可读 report |
| 创建 `packages/core/src/context-budget/index.ts` | 导出 |
| 创建 `packages/core/src/context-budget/*.test.ts` | 对应单测 |
| 修改 `packages/core/src/types/messages.ts` | 可选 `compactRole?: "summary" \| "boundary"` |
| 修改 `packages/core/src/engine/compact-service.ts` | 新摘要/boundary 写入 `compactRole` |
| 修改 `packages/core/src/index.ts` | 导出 context-budget 与类型 |
| 创建 `packages/prompts/src/ledger-segments.ts` | `buildPromptLedgerSegments()`：按段打标，不改模型可见文案 |
| 创建 `packages/prompts/src/ledger-segments.test.ts` | tagged 段覆盖 |
| 修改 `packages/prompts/src/index.ts` | re-export |
| 修改 `packages/server/src/application/settings-api.ts` | `ContextService.usage` |
| 创建 `packages/server/src/application/context-usage-cache.ts` | sessionId → snapshot 缓存与失效 |
| 修改 `packages/server/src/application/default-services/context-service.ts` | 实现 usage |
| 修改 `packages/server/src/http/routes/service.ts` | `GET /context/usage` |
| 修改 server / client 测试与命令表 | usage 通道 |
| 修改 `packages/client/src/transport/http-client.ts` | `getContextUsage` |
| 修改 `packages/client/src/commands/session-commands.ts` | `/context usage` |
| 接线 run / 换模 / compact | 写缓存与失效 |
| 创建桌面 `context-usage-ring.tsx` / `context-usage-tray.tsx` | 环与托盘 |
| 修改 `composer.tsx` / conversation-page | 挂载与刷新 |

---

### 任务 1：Core 类型与 Assembler 纯函数

**文件：**
- 创建：`packages/core/src/context-budget/types.ts`
- 创建：`packages/core/src/context-budget/assemble.ts`
- 创建：`packages/core/src/context-budget/tips.ts`
- 创建：`packages/core/src/context-budget/index.ts`
- 创建：`packages/core/src/context-budget/assemble.test.ts`
- 修改：`packages/core/src/index.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { assembleContextUsageSnapshot } from "./assemble.js";
import type { ContextLedgerSegment } from "./types.js";

it("puts tool schema in tools and tool result text in conversation", () => {
  const segments: ContextLedgerSegment[] = [
    { bucket: "tools", text: '{"name":"Read"}' },
    { bucket: "conversation", text: "file contents here...." },
  ];
  const snap = assembleContextUsageSnapshot({
    segments,
    model: "m",
    contextWindow: 100_000,
    source: "live_assembly",
  });
  expect(snap.buckets.find((b) => b.id === "tools")!.tokens).toBeGreaterThan(0);
  expect(snap.buckets.find((b) => b.id === "conversation")!.tokens).toBeGreaterThan(0);
  expect(snap.estimatedInputTokens).toBe(
    snap.buckets.reduce((n, b) => n + b.tokens, 0),
  );
});

it("halves percentFull when contextWindow doubles", () => {
  const segments: ContextLedgerSegment[] = [
    { bucket: "conversation", text: "x".repeat(4000) },
  ];
  const a = assembleContextUsageSnapshot({
    segments, model: "m", contextWindow: 128_000, source: "live_assembly",
  });
  const b = assembleContextUsageSnapshot({
    segments, model: "m", contextWindow: 256_000, source: "live_assembly",
  });
  expect(a.buckets).toEqual(b.buckets);
  expect(b.percentFull!).toBeCloseTo(a.percentFull! / 2, 5);
});

it("emits overflow_after_model_switch tip", () => {
  const segments: ContextLedgerSegment[] = [
    { bucket: "conversation", text: "x".repeat(400_000) },
  ];
  const snap = assembleContextUsageSnapshot({
    segments,
    model: "small",
    contextWindow: 80_000,
    source: "live_assembly",
    modelSwitch: { previousContextWindow: 200_000 },
  });
  expect(snap.tips.some((t) => t.code === "overflow_after_model_switch")).toBe(true);
  expect(snap.percentFull!).toBeGreaterThan(1);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @vykor/core test -- src/context-budget/assemble.test.ts`

预期：FAIL（模块不存在）。

- [ ] **步骤 3：编写最少实现代码**

实现要点：

- `estimateTokens` 来自 `../utils/token-counter`
- 桶 tokens = `estimateTokens(text) + (mediaTokens ?? 0)`，按 `bucket` 累加
- 固定 8 桶顺序与 label
- `percentFull = contextWindow == null ? null : estimatedInputTokens / contextWindow`
- `paddedTotal = Math.ceil(estimatedInputTokens * 4 / 3)`
- tips：`near_full`（padded ≥ window*0.85）、`overflow_after_model_switch`、`static_tools_heavy`（tools+mcp ≥ window*0.20）、以及调用方传入的额外 tips

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @vykor/core test -- src/context-budget/assemble.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add packages/core/src/context-budget packages/core/src/index.ts
git commit -m "feat(core): 添加上下文占用 Assembler 与分桶类型"
```

---

### 任务 2：compactRole 与 messages → segments

**文件：**
- 修改：`packages/core/src/types/messages.ts`
- 修改：`packages/core/src/engine/compact-service.ts`
- 创建：`packages/core/src/context-budget/messages-to-segments.ts`
- 创建：`packages/core/src/context-budget/messages-to-segments.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { messagesToLedgerSegments } from "./messages-to-segments.js";

it("routes compactRole summary to summary bucket and boundary to conversation", () => {
  const segments = messagesToLedgerSegments([
    { type: "assistant", content: "Summary: did stuff", compactRole: "summary" },
    { type: "user", content: "[Compact boundary marker]\n...", compactRole: "boundary" },
    { type: "user", content: "continue please" },
  ]);
  expect(segments.filter((s) => s.bucket === "summary")).toHaveLength(1);
  expect(segments.filter((s) => s.bucket === "conversation").length).toBeGreaterThanOrEqual(2);
});

it("uses heuristic for unmarked legacy compact pair", () => {
  const segments = messagesToLedgerSegments([
    {
      type: "assistant",
      content:
        "[Conversation compacted: 3 messages summarized (1 tool results removed). 2 recent messages preserved.]",
    },
    {
      type: "user",
      content: "[Compact boundary marker]\nEarlier conversation was compacted.",
    },
  ]);
  expect(segments.some((s) => s.bucket === "summary")).toBe(true);
});

it("counts image blocks with 3072 mediaTokens", () => {
  const segments = messagesToLedgerSegments([
    {
      type: "user",
      content: [
        { type: "text", text: "see" },
        {
          type: "image",
          source: { type: "file", mediaType: "image/png", path: "/x.png" },
        },
      ],
    },
  ]);
  expect(segments.find((s) => s.bucket === "conversation")?.mediaTokens).toBe(3072);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @vykor/core test -- src/context-budget/messages-to-segments.test.ts`

预期：FAIL。

- [ ] **步骤 3：编写最少实现代码**

1. `AssistantMessage` / `UserMessage` 增加可选 `compactRole?: "summary" | "boundary"`（不改发给模型的 content）。
2. `compact-service` 创建 summary / boundary 时设置该字段。
3. `messagesToLedgerSegments`：`compactRole` 优先；否则启发式（`[Conversation compacted` / `Summary:\n` + 下一条含 `[Compact boundary marker]`）；图片 `mediaTokens = 3072`（与 compact 常量同值，可抽共享常量）。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @vykor/core test -- src/context-budget/messages-to-segments.test.ts`

预期：PASS（必要时更新 compact 测试允许新字段）。

- [ ] **步骤 5：Commit**

```bash
git add packages/core/src/types/messages.ts packages/core/src/engine/compact-service.ts packages/core/src/context-budget
git commit -m "feat(core): compact 消息标记与 conversation/summary 分桶"
```

---

### 任务 3：Prompt 侧 tagged ledger segments

**文件：**
- 创建：`packages/prompts/src/ledger-segments.ts`
- 创建：`packages/prompts/src/ledger-segments.test.ts`
- 修改：`packages/prompts/src/index.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
it("tags skills catalog as skills and delegation as subagents", async () => {
  const segments = await buildPromptLedgerSegments({
    cwd: tmpDir,
    includeDelegation: true,
    skillsList: [{ name: "foo", description: "bar" }],
  });
  expect(segments.some((s) => s.bucket === "skills" && s.text.includes("foo"))).toBe(true);
  expect(segments.some((s) => s.bucket === "subagents")).toBe(true);
  expect(segments.some((s) => s.bucket === "system")).toBe(true);
});

it("does not put full memory preview into segments by default", async () => {
  const segments = await buildPromptLedgerSegments({ cwd: tmpDir });
  expect(segments.every((s) => s.bucket !== "conversation")).toBe(true);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @vykor/prompts test -- src/ledger-segments.test.ts`

预期：FAIL。

- [ ] **步骤 3：编写最少实现代码**

- SOUL / invariant / Environment / permission / fast / effort → `system`
- Custom Instructions / ClaudeMd / USER / local rules → `rules`（跟随当前 loader）
- skills list → `skills`；delegation → `subagents`
- 默认**不**打 preview 全量 memory；可选 `memoryReminderText` → `conversation`
- `renderPromptLayers` / 模型可见内容保持不变

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @vykor/prompts test -- src/ledger-segments.test.ts src/index.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add packages/prompts/src/ledger-segments.ts packages/prompts/src/ledger-segments.test.ts packages/prompts/src/index.ts
git commit -m "feat(prompts): 输出带桶标签的 prompt ledger 段"
```

---

### 任务 4：Tools / MCP 段序列化辅助

**文件：**
- 创建：`packages/core/src/context-budget/tool-segments.ts`
- 创建：`packages/core/src/context-budget/tool-segments.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
it("marks builtin schemas as tools and mcp schemas as mcp", () => {
  const segments = toolSchemasToLedgerSegments([
    { kind: "builtin", text: '{"name":"Read","parameters":{}}' },
    { kind: "mcp", text: '{"name":"mcp__x__y","parameters":{}}' },
  ]);
  expect(segments.map((s) => s.bucket)).toEqual(["tools", "mcp"]);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @vykor/core test -- src/context-budget/tool-segments.test.ts`

预期：FAIL。

- [ ] **步骤 3：编写最少实现代码**

输入为已序列化字符串 + `kind: "builtin" | "mcp"`，避免 core 依赖 MCP 包。

- [ ] **步骤 4：运行测试验证通过**

- [ ] **步骤 5：Commit**

```bash
git add packages/core/src/context-budget/tool-segments.ts packages/core/src/context-budget/tool-segments.test.ts
git commit -m "feat(core): 工具 schema 到 ledger 段的映射"
```

---

### 任务 5：Session 缓存 + ContextService.usage + HTTP/CLI

**文件：**
- 创建：`packages/server/src/application/context-usage-cache.ts`
- 创建：`packages/core/src/context-budget/format-report.ts`
- 修改：`packages/server/src/application/settings-api.ts`
- 修改：`packages/server/src/application/default-services/context-service.ts`
- 修改：`packages/server/src/http/routes/service.ts`
- 修改：server HTTP/应用测试
- 修改：`packages/client/src/transport/http-client.ts`
- 修改：`packages/client/src/commands/session-commands.ts`
- 修改：`packages/client/src/commands/__test__/session-commands.test.ts`
- 修改：`packages/server/src/commands/commands.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
it("returns conversation_omitted tip without sessionId", async () => {
  const result = await contextService.usage({ cwd: process.cwd() });
  expect(result.snapshot.source).toBe("static_only");
  expect(result.snapshot.tips.some((t) => t.code === "conversation_omitted")).toBe(true);
});

it("returns cached snapshot for sessionId when cache warm", async () => {
  cache.set("s1", warmSnapshot);
  const result = await contextService.usage({ cwd, sessionId: "s1" });
  expect(result.snapshot.source).toBe("session_cache");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @vykor/server test --`（定位到新增/相关测试文件）

预期：FAIL（`usage` 未定义）。

- [ ] **步骤 3：编写最少实现代码**

```ts
usage(input: {
  cwd: string;
  sessionId?: string;
  refresh?: boolean;
  previousContextWindow?: number;
}): Promise<{ snapshot: ContextUsageSnapshot; report: string }>;
```

- 无 `sessionId` → prompt ledger + `static_only` + `conversation_omitted`
- 缓存命中且 `!refresh` → `session_cache`
- live 重装完整接线在任务 6；本任务先保证 API/CLI/缓存契约

HTTP：`GET /context/usage?cwd=&sessionId=&refresh=`

CLI：`/context usage` → emit `report`；命令表 `argumentHint: "[preview|status|usage]"`

- [ ] **步骤 4：运行测试验证通过**

- [ ] **步骤 5：Commit**

```bash
git commit -m "feat(server): 添加 /context usage 与 session 占用缓存"
```

---

### 任务 6：同源组装接线（写缓存 + 失效）

**文件（实现时先 rg 定位精确符号）：**
- `packages/server/src/application/session/session-run-executor.ts`
- session agent 工具表 / messages 读取处
- runtime.model 更新路径
- compact 完成通知（若可订阅）

- [ ] **步骤 1：编写失败的测试**

```ts
it("writes usage cache from the same tools list used for the run", async () => {
  // arrange agent with known tools + messages
  // act assembleForUsage(sessionId) or complete a run
  // assert tools bucket matches serialize(agent tools)
});

it("invalidates cache on model change", async () => {
  cache.set("s1", snap);
  await updateSessionModel("s1", "other-model");
  expect(cache.get("s1")).toBeUndefined();
});
```

- [ ] **步骤 2：运行测试验证失败**

- [ ] **步骤 3：实现 `assembleSessionContextUsage(sessionId)`**

1. `buildPromptLedgerSegments`（可选本轮 `memoryReminderText`）
2. `toolSchemasToLedgerSegments` 来自该 session agent 当前 tools
3. `messagesToLedgerSegments`
4. `assembleContextUsageSnapshot` → `cache.set`
5. 失效：model 变更、run 终态（成功/失败/取消）、compact 完成

- [ ] **步骤 4：测试通过**

- [ ] **步骤 5：Commit**

```bash
git commit -m "feat(server): 同源组装上下文占用并在换模/run/compact 时失效缓存"
```

---

### 任务 7：桌面 Context 环与托盘

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/desktop/conversation-page/context-usage-ring.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/conversation-page/context-usage-tray.tsx`
- 创建：对应 `*.test.tsx`
- 修改：`composer.tsx` / conversation-page
- 修改：desktop session 拉取 usage 的路径（换模、打开托盘、run 结束）

- [ ] **步骤 1：编写失败的组件测试**

```tsx
it("shows placeholder when percentFull is null", () => {
  render(<ContextUsageRing snapshot={{ ...base, percentFull: null, contextWindow: null }} />);
  expect(screen.getByLabelText(/context/i)).toHaveTextContent("—");
});

it("hides zero-token buckets in the tray list", () => {
  render(
    <ContextUsageTray
      snapshot={{
        ...base,
        buckets: [
          { id: "system", label: "System prompt", tokens: 100 },
          { id: "tools", label: "Tool definitions", tokens: 0 },
        ],
      }}
    />,
  );
  expect(screen.getByText("System prompt")).toBeTruthy();
  expect(screen.queryByText("Tool definitions")).toBeNull();
});

it("renders percent over 100 when percentFull > 1", () => {
  render(<ContextUsageRing snapshot={{ ...base, percentFull: 1.2 }} />);
  expect(screen.getByText(/120%/)).toBeTruthy();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @vykor/desktop test -- context-usage`

预期：FAIL。

- [ ] **步骤 3：实现 UI**

标题 Context；`N% Full`；`~X / Y Tokens`；分段色条；列表；tips；隐藏空桶；不拦截发送。8 桶固定色值常量。

- [ ] **步骤 4：测试通过**

- [ ] **步骤 5：Commit**

```bash
git commit -m "feat(desktop): Context 占用环与分桶托盘"
```

---

### 任务 8：收尾验收

- [ ] **步骤 1：跑规格相关测试包**

```bash
pnpm --filter @vykor/core test -- src/context-budget
pnpm --filter @vykor/prompts test -- src/ledger-segments.test.ts
pnpm --filter @vykor/server test -- context
pnpm --filter @vykor/client test -- session-commands
pnpm --filter @vykor/desktop test -- context-usage
```

- [ ] **步骤 2：对照规格验收标准 1–7，修复缺口**

- [ ] **步骤 3：更新规格状态为已进入/完成实现，Commit**

```bash
git add docs/superpowers/specs/2026-09-04-context-usage-budget-design.md
git commit -m "docs: 更新上下文占用规格实现状态"
```

---

## 规格覆盖自检

| 规格要点 | 任务 |
| --- | --- |
| Tagged `ContextLedgerSegment` | 1, 3, 4 |
| Assembler / 裸窗宽 percentFull / tips | 1 |
| compactRole + 启发式 | 2 |
| Prompt 打标且不改可见文案 | 3 |
| Memory 只计 reminder | 3, 6 |
| Tools/MCP 同源 | 4, 6 |
| Session 缓存与失效 | 5, 6 |
| `/context usage` HTTP/CLI | 5 |
| 桌面环/托盘 | 7 |
| 换模溢出 tip | 1, 6, 7 |

## 实现注意

- 开始编码前建议用 worktree 隔离功能分支。
- UI 层禁止重算分桶。
- 不要复制 `packages/services` 的另一套 `estimateTokens`。
