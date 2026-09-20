# 压缩分割线合并与运行韧性实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉「自动压缩后正文看起来卡住」的渲染错位，并补上事件流断流与服务端 run 无进展两处兜底。

**Architecture:** 分三段独立实施：A 只改桌面渲染层（turn model 合并压缩分割线并放进所属轮次）；B 改客户端传输/同步层与桌面主进程订阅（空闲超时、重连重新取快照、订阅重建）；C 在服务端 run 执行器加一个轮询式无进展看门狗。三段各自可单独验证与回滚，不触碰事件协议、DB schema 与压缩策略。

**Tech Stack:** TypeScript、pnpm workspace、vitest、React 19（desktop renderer）、SSE（Hono 服务端 + fetch 客户端）、SQLite（drizzle）会话存储。

**Spec:** `docs/superpowers/specs/2026-09-20-compaction-divider-and-run-resilience-design.md`

## Global Constraints

- **严格文件范围**：只允许改动本计划每个任务列出的文件。不得顺手重构、改名、移动文件、升级依赖；发现范围外的问题只记录，不动手。
- **TDD**：每个任务先写失败测试，跑出失败，再写最小实现，再跑通。
- **分支与提交**：在分支 `fix/compaction-divider-and-run-resilience` 上实施；每个任务完成并通过自测后提交一次，提交信息带任务号（如 `fix(desktop): A2 合并压缩分割线到所属轮次`）。只提交本任务范围内的文件；不 amend、不 force push、不改 git 配置。
- **不改协议与数据**：不改事件类型、DB schema、服务端压缩行为、前端虚拟滚动。
- **阈值默认值**：SSE 空闲 `60_000`ms；run 看门狗 `staleTimeout = 600_000`ms、检查周期 `30_000`ms；两者都通过内部选项可覆盖，不新增用户配置。
- **文案精确值**：`正在压缩上下文`、`已压缩上下文`、`上下文压缩失败`、`上下文压缩已中断`。
- **命令约定**：聚焦测试用 `pnpm --filter <pkg> exec vitest run <相对路径>`；包级测试用 `pnpm --filter <pkg> test`；类型检查用 `pnpm --filter <pkg> check-types`（desktop 用 `typecheck`）。

---

## 文件结构

| 文件 | 动作 | 职责 |
|------|------|------|
| `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/compaction-presentation.ts` | 新建 | 压缩分割线的 phase 类型、metadata 读取、文案（A1） |
| `.../message/context-compaction-divider.tsx` | 修改 | 按 phase 渲染图标（含 interrupted）（A1） |
| `.../message/message-block.tsx` | 修改 | 改为从新模块导入 reader（A1） |
| `.../message/conversation-turn-model.ts` | 修改 | 分割线配对/归属/轮内 blocks（A2） |
| `.../transcript/turn-block-plan.ts` | 新建 | 把 turn.blocks 映射成渲染计划（streaming/actions 归属）（A3） |
| `.../transcript/transcript.tsx` | 修改 | 按渲染计划输出（A3） |
| `packages/client/src/transport/sse-transport.ts` | 修改 | 原始帧空闲超时（B1） |
| `packages/client/src/types/index.ts` | 修改 | `EventSyncOptions.idleTimeoutMs`（B1） |
| `packages/client/src/resources/event-resource.ts` | 修改 | 透传 `idleTimeoutMs`（B1） |
| `packages/client/src/state/sync.ts` | 修改 | 重连时重新取快照 + 透传 idle 超时（B2） |
| `apps/desktop/src/main/features/session/session-subscription-pump.ts` | 新建 | 带退避的订阅重建循环（纯函数，B3） |
| `apps/desktop/src/main/features/session/session-subscription-service.ts` | 修改 | 用 pump 循环替换一次性 pump（B3） |
| `packages/server/src/application/session/run-stall-watchdog.ts` | 新建 | run 无进展看门狗（C1） |
| `packages/server/src/application/session/session-run-executor.ts` | 修改 | 创建/销毁看门狗 + 依赖（C2） |
| `packages/server/src/application/session/session-run-executor-assembly.ts` | 修改 | store pick 增加 `permissions`（C2） |

---

## Stage A：压缩分割线合并与定位

### Task A1: 抽出 compaction presentation 模块，补「已中断」文案

**Files:**
- Create: `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/compaction-presentation.ts`
- Modify: `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/context-compaction-divider.tsx`
- Modify: `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/message-block.tsx:36-39`
- Test: `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/__test__/compaction-presentation.test.ts`

**Interfaces:**
- Produces: `ContextCompactionPhase = "started" | "completed" | "failed" | "interrupted"`；`ContextCompactionPresentation`；`readContextCompactionPresentation(metadata): ContextCompactionPresentation | null`；`compactionDividerLabel(phase): string`。A2/A3 直接复用这些名字。

- [ ] **Step 1: 写失败测试**

新建 `.../message/__test__/compaction-presentation.test.ts`：

```ts
import { describe, expect, it } from "vitest"

import {
  compactionDividerLabel,
  readContextCompactionPresentation,
} from "../compaction-presentation"

describe("compaction presentation", () => {
  it("labels every phase", () => {
    expect(compactionDividerLabel("started")).toBe("正在压缩上下文")
    expect(compactionDividerLabel("completed")).toBe("已压缩上下文")
    expect(compactionDividerLabel("failed")).toBe("上下文压缩失败")
    expect(compactionDividerLabel("interrupted")).toBe("上下文压缩已中断")
  })

  it("reads compaction metadata and ignores other presentations", () => {
    expect(
      readContextCompactionPresentation({
        presentation: { kind: "context_compaction", phase: "completed" },
      })
    ).toEqual({ kind: "context_compaction", phase: "completed" })
    expect(
      readContextCompactionPresentation({
        presentation: { kind: "model_switch", fromModel: "a", toModel: "b" },
      })
    ).toBeNull()
    expect(readContextCompactionPresentation({})).toBeNull()
    expect(
      readContextCompactionPresentation({
        presentation: { kind: "context_compaction", phase: "nonsense" },
      })
    ).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @openharness/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/message/__test__/compaction-presentation.test.ts`
Expected: FAIL（模块不存在 / 导入报错）

- [ ] **Step 3: 新建模块**

`.../message/compaction-presentation.ts`：

```ts
export type ContextCompactionPhase = "started" | "completed" | "failed" | "interrupted"

export interface ContextCompactionPresentation {
  kind: "context_compaction"
  phase: ContextCompactionPhase
}

export function readContextCompactionPresentation(
  metadata: Record<string, unknown>
): ContextCompactionPresentation | null {
  const presentation = metadata.presentation
  if (!presentation || typeof presentation !== "object" || Array.isArray(presentation)) return null
  const value = presentation as Record<string, unknown>
  if (value.kind !== "context_compaction") return null
  if (
    value.phase !== "started" &&
    value.phase !== "completed" &&
    value.phase !== "failed" &&
    value.phase !== "interrupted"
  ) {
    return null
  }
  return { kind: "context_compaction", phase: value.phase }
}

export function compactionDividerLabel(phase: ContextCompactionPhase): string {
  if (phase === "started") return "正在压缩上下文"
  if (phase === "completed") return "已压缩上下文"
  if (phase === "failed") return "上下文压缩失败"
  return "上下文压缩已中断"
}
```

- [ ] **Step 4: 改 divider 组件用新模块并支持 interrupted**

`.../message/context-compaction-divider.tsx` 全文替换为：

```tsx
import { Check, CircleSlash, LoaderCircle, TriangleAlert } from "lucide-react"

import {
  compactionDividerLabel,
  type ContextCompactionPresentation,
} from "./compaction-presentation"

export function ContextCompactionDivider({
  presentation,
}: {
  presentation: ContextCompactionPresentation
}) {
  const label = compactionDividerLabel(presentation.phase)
  const Icon =
    presentation.phase === "started"
      ? LoaderCircle
      : presentation.phase === "completed"
        ? Check
        : presentation.phase === "failed"
          ? TriangleAlert
          : CircleSlash
  return (
    <div role="separator" aria-label={label} className="flex items-center gap-2 py-2 text-xs text-ui-muted">
      <span className="h-px flex-1 bg-border/60" />
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <Icon className={presentation.phase === "started" ? "size-3.5 animate-spin" : "size-3.5"} />
        {label}
      </span>
      <span className="h-px flex-1 bg-border/60" />
    </div>
  )
}
```

- [ ] **Step 5: 改 message-block 的导入**

`.../message/message-block.tsx` 中把：

```ts
import {
  ContextCompactionDivider,
  readContextCompactionPresentation,
} from "./context-compaction-divider"
```

替换为：

```ts
import { ContextCompactionDivider } from "./context-compaction-divider"
import { readContextCompactionPresentation } from "./compaction-presentation"
```

- [ ] **Step 6: 跑测试与类型检查**

Run: `pnpm --filter @openharness/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/message/__test__/compaction-presentation.test.ts`
Expected: PASS（2 个用例）

Run: `pnpm --filter @openharness/desktop exec vitest run src/renderer/src/components/desktop/conversation-page`
Expected: 现有相关用例全部 PASS

---

### Task A2: turn model 合并分割线并放进所属轮次

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/conversation-turn-model.ts`（全文替换）
- Test: `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/__test__/conversation-turn-model.test.ts`（新增用例）

**Interfaces:**
- Consumes: A1 的 `readContextCompactionPresentation`、`ContextCompactionPhase`。
- Produces:
  - `TurnBlock = { kind: "assistant"; messages: DesktopSessionMessage[]; parts: DesktopSessionPart[] } | { kind: "divider"; message: DesktopSessionMessage; parts: DesktopSessionPart[]; phase: ContextCompactionPhase }`
  - `ConversationTurn.blocks: TurnBlock[]`
  - 顶层 system entry 变为 `{ type: "system"; system: { id; message; parts; compactionPhase?: ContextCompactionPhase } }`
  - `buildConversationEntries(messages, parts, runs)` 签名不变。

- [ ] **Step 1: 写失败测试**

在 `.../message/__test__/conversation-turn-model.test.ts` 的 `describe` 内追加（并在文件底部 helper 区追加 `compactionMessage`）：

```ts
  it("merges an auto-compaction divider pair inside the turn that triggered it", () => {
    const messages = [
      message("user", 1, { inputId: "input-1", runId: "run-1" }),
      compactionMessage("started", 2),
      compactionMessage("completed", 3),
      message("assistant", 4, { inputId: "input-1", runId: "run-1" }),
      message("assistant", 5, { inputId: "input-1", runId: "run-1" }),
    ]
    const parts = messages.map((item) => part(item.id, item.seq, `${item.role}-${item.seq}`))
    const entries = buildConversationEntries(messages, parts, [run("run-1", "input-1")])

    expect(entries).toHaveLength(1)
    if (entries[0]?.type !== "turn") throw new Error("Expected a conversation turn")
    const blocks = entries[0].turn.blocks
    expect(blocks.map((block) => block.kind)).toEqual(["divider", "assistant"])
    if (blocks[0]?.kind !== "divider") throw new Error("Expected a divider block")
    expect(blocks[0].phase).toBe("completed")
    expect(blocks[0].message.seq).toBe(2)
    if (blocks[1]?.kind !== "assistant") throw new Error("Expected an assistant block")
    expect(blocks[1].messages.map((item) => item.seq)).toEqual([4, 5])
  })

  it("places a mid-turn compaction divider between assistant segments", () => {
    const messages = [
      message("user", 1, { inputId: "input-1", runId: "run-1" }),
      message("assistant", 2, { inputId: "input-1", runId: "run-1" }),
      compactionMessage("started", 3),
      compactionMessage("completed", 4),
      message("assistant", 5, { inputId: "input-1", runId: "run-1" }),
    ]
    const parts = messages.map((item) => part(item.id, item.seq, `${item.role}-${item.seq}`))
    const entries = buildConversationEntries(messages, parts, [run("run-1", "input-1")])

    if (entries[0]?.type !== "turn") throw new Error("Expected a conversation turn")
    const blocks = entries[0].turn.blocks
    expect(blocks.map((block) => block.kind)).toEqual(["assistant", "divider", "assistant"])
    if (blocks[0]?.kind !== "assistant" || blocks[2]?.kind !== "assistant") {
      throw new Error("Expected assistant blocks around the divider")
    }
    expect(blocks[0].messages.map((item) => item.seq)).toEqual([2])
    expect(blocks[2].messages.map((item) => item.seq)).toEqual([5])
  })

  it("marks an unmatched started divider as interrupted when no run is active", () => {
    const messages = [
      message("user", 1, { inputId: "input-1", runId: "run-1" }),
      compactionMessage("started", 2),
    ]
    const entries = buildConversationEntries(messages, [], [])
    if (entries[0]?.type !== "turn") throw new Error("Expected a conversation turn")
    const divider = entries[0].turn.blocks[0]
    if (divider?.kind !== "divider") throw new Error("Expected a divider block")
    expect(divider.phase).toBe("interrupted")
  })

  it("keeps an unmatched started divider as started while a run is active", () => {
    const messages = [
      message("user", 1, { inputId: "input-1", runId: "run-1" }),
      compactionMessage("started", 2),
    ]
    const active = { ...run("run-1", "input-1"), status: "running" as const }
    const entries = buildConversationEntries(messages, [], [active])
    if (entries[0]?.type !== "turn") throw new Error("Expected a conversation turn")
    const divider = entries[0].turn.blocks[0]
    if (divider?.kind !== "divider") throw new Error("Expected a divider block")
    expect(divider.phase).toBe("started")
  })

  it("keeps a compaction divider at the end of the finished turn when it arrives after the turn", () => {
    const messages = [
      message("user", 1, { inputId: "input-1", runId: "run-1" }),
      message("assistant", 2, { inputId: "input-1", runId: "run-1" }),
      compactionMessage("started", 3),
      compactionMessage("completed", 4),
    ]
    const entries = buildConversationEntries(messages, [], [run("run-1", "input-1")])
    if (entries[0]?.type !== "turn") throw new Error("Expected a conversation turn")
    expect(entries[0].turn.blocks.map((block) => block.kind)).toEqual(["assistant", "divider"])
  })

  it("keeps non-compaction system messages as top-level entries", () => {
    const modelSwitch = {
      ...message("system", 2),
      metadata: { presentation: { kind: "model_switch", fromModel: "a", toModel: "b" } },
    }
    const entries = buildConversationEntries(
      [
        message("user", 1, { inputId: "input-1", runId: "run-1" }),
        modelSwitch,
        message("assistant", 3, { inputId: "input-1", runId: "run-1" }),
      ],
      [],
      [run("run-1", "input-1")]
    )
    expect(entries.map((entry) => entry.type)).toEqual(["turn", "system"])
    const system = entries[1]
    if (system?.type !== "system") throw new Error("Expected a system entry")
    expect(system.system.compactionPhase).toBeUndefined()
  })
```

底部 helper：

```ts
function compactionMessage(
  phase: "started" | "completed" | "failed",
  seq: number
): DesktopSessionMessage {
  return {
    ...message("system", seq),
    metadata: { presentation: { kind: "context_compaction", phase } },
  }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @openharness/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/message/__test__/conversation-turn-model.test.ts`
Expected: FAIL（`turn.blocks` 为 undefined / 分割线是顶层 system entry）

- [ ] **Step 3: 实现 turn model**

`.../message/conversation-turn-model.ts` 全文替换为：

```ts
import type {
  DesktopSessionMessage,
  DesktopSessionPart,
  DesktopSessionRun,
} from "@shared/session-types"

import {
  readContextCompactionPresentation,
  type ContextCompactionPhase,
} from "./compaction-presentation"

export interface ConversationTurn {
  id: string
  createdAt: number
  inputId?: string
  runIds: string[]
  userMessage?: DesktopSessionMessage
  userParts: DesktopSessionPart[]
  assistantMessages: DesktopSessionMessage[]
  assistantParts: DesktopSessionPart[]
  blocks: TurnBlock[]
}

export type TurnBlock =
  | { kind: "assistant"; messages: DesktopSessionMessage[]; parts: DesktopSessionPart[] }
  | {
      kind: "divider"
      message: DesktopSessionMessage
      parts: DesktopSessionPart[]
      phase: ContextCompactionPhase
    }

export type ConversationEntry =
  | { type: "turn"; turn: ConversationTurn }
  | {
      type: "system"
      system: {
        id: string
        message: DesktopSessionMessage
        parts: DesktopSessionPart[]
        compactionPhase?: ContextCompactionPhase
      }
    }

interface PendingDivider {
  seq: number
  message: DesktopSessionMessage
  parts: DesktopSessionPart[]
  phase: ContextCompactionPhase
}

interface ResolvedDivider {
  message: DesktopSessionMessage
  parts: DesktopSessionPart[]
  phase: ContextCompactionPhase
  mergedIds: string[]
}

export function buildConversationEntries(
  messages: DesktopSessionMessage[],
  parts: DesktopSessionPart[],
  runs: DesktopSessionRun[]
): ConversationEntry[] {
  const sorted = [...messages].sort(compareMessages)
  const partsByMessage = groupPartsByMessage(parts)
  const inputIdByRunId = new Map(runs.map((run) => [run.id, run.inputId]))
  const turnsByInputId = new Map<string, ConversationTurn>()
  const turnsByRunId = new Map<string, ConversationTurn>()
  const entries: ConversationEntry[] = []
  const pendingDividersByTurn = new Map<ConversationTurn, PendingDivider[]>()
  const resolvedDividers = resolveCompactionDividers(sorted, partsByMessage, runs)
  const mergedDividerIds = new Set(
    [...resolvedDividers.values()].flatMap((divider) => divider.mergedIds)
  )
  let latestTurn: ConversationTurn | undefined

  for (const message of sorted) {
    const messageParts = partsByMessage.get(message.id) ?? []
    if (message.role === "system") {
      const resolved = resolvedDividers.get(message.id)
      if (resolved) {
        if (
          latestTurn?.userMessage &&
          latestTurn.userMessage.seq < resolved.message.seq
        ) {
          const pending = pendingDividersByTurn.get(latestTurn) ?? []
          pending.push({
            seq: resolved.message.seq,
            message: resolved.message,
            parts: resolved.parts,
            phase: resolved.phase,
          })
          pendingDividersByTurn.set(latestTurn, pending)
          continue
        }
        entries.push({
          type: "system",
          system: {
            id: resolved.message.id,
            message: resolved.message,
            parts: resolved.parts,
            compactionPhase: resolved.phase,
          },
        })
        continue
      }
      if (mergedDividerIds.has(message.id)) continue
      entries.push({
        type: "system",
        system: { id: message.id, message, parts: messageParts },
      })
      continue
    }

    const inputId =
      message.inputId ?? (message.runId ? inputIdByRunId.get(message.runId) : undefined)
    if (message.role === "user") {
      const existingTurn = inputId ? turnsByInputId.get(inputId) : undefined
      if (existingTurn) {
        existingTurn.userMessage = message
        existingTurn.userParts = messageParts
        existingTurn.createdAt = Math.min(existingTurn.createdAt, message.createdAt)
        latestTurn = existingTurn
        if (message.runId) {
          if (!existingTurn.runIds.includes(message.runId)) existingTurn.runIds.push(message.runId)
          turnsByRunId.set(message.runId, existingTurn)
        }
        continue
      }
      const turn = createTurn(message, messageParts, inputId)
      entries.push({ type: "turn", turn })
      latestTurn = turn
      if (inputId) turnsByInputId.set(inputId, turn)
      if (message.runId) turnsByRunId.set(message.runId, turn)
      continue
    }

    let turn = message.inputId ? turnsByInputId.get(message.inputId) : undefined
    if (!turn && !message.inputId && message.runId) turn = turnsByRunId.get(message.runId)
    if (!turn && inputId) turn = turnsByInputId.get(inputId)
    if (!turn && !inputId) turn = latestTurn
    if (!turn) {
      turn = createTurn(undefined, [], inputId, message.id)
      entries.push({ type: "turn", turn })
      latestTurn = turn
      if (inputId) turnsByInputId.set(inputId, turn)
    }

    turn.assistantMessages.push(message)
    turn.assistantParts.push(...messageParts)
    turn.createdAt = Math.min(turn.createdAt, message.createdAt)
    if (message.runId) {
      if (!turn.runIds.includes(message.runId)) turn.runIds.push(message.runId)
      turnsByRunId.set(message.runId, turn)
    }
    if (inputId && !turn.inputId) {
      turn.inputId = inputId
      turnsByInputId.set(inputId, turn)
    }
  }

  for (const run of runs) {
    const turn =
      (run.inputId ? turnsByInputId.get(run.inputId) : undefined) ?? turnsByRunId.get(run.id)
    if (turn) {
      if (!turn.runIds.includes(run.id)) turn.runIds.push(run.id)
      turnsByRunId.set(run.id, turn)
      continue
    }
    if (run.status !== "failed" || messages.length > 0) continue
    const failedTurn = createTurn(undefined, [], run.inputId, `failed-run-${run.id}`, run.createdAt)
    failedTurn.runIds.push(run.id)
    entries.push({ type: "turn", turn: failedTurn })
  }

  for (const entry of entries) {
    if (entry.type !== "turn") continue
    entry.turn.blocks = buildTurnBlocks(
      entry.turn,
      pendingDividersByTurn.get(entry.turn) ?? [],
      partsByMessage
    )
  }

  entries.sort(compareEntries)

  return entries
}

function buildTurnBlocks(
  turn: ConversationTurn,
  dividers: PendingDivider[],
  partsByMessage: Map<string, DesktopSessionPart[]>
): TurnBlock[] {
  const queue = [...dividers].sort((left, right) => left.seq - right.seq)
  const blocks: TurnBlock[] = []
  let current: DesktopSessionMessage[] = []
  const flush = (): void => {
    if (current.length === 0) return
    blocks.push({
      kind: "assistant",
      messages: current,
      parts: current.flatMap((message) => partsByMessage.get(message.id) ?? []),
    })
    current = []
  }

  for (const message of [...turn.assistantMessages].sort(compareMessages)) {
    while (queue.length > 0 && queue[0]!.seq < message.seq) {
      flush()
      const divider = queue.shift()!
      blocks.push({
        kind: "divider",
        message: divider.message,
        parts: divider.parts,
        phase: divider.phase,
      })
    }
    current.push(message)
  }
  flush()
  for (const divider of queue) {
    blocks.push({
      kind: "divider",
      message: divider.message,
      parts: divider.parts,
      phase: divider.phase,
    })
  }
  return blocks
}

function resolveCompactionDividers(
  messages: DesktopSessionMessage[],
  partsByMessage: Map<string, DesktopSessionPart[]>,
  runs: DesktopSessionRun[]
): Map<string, ResolvedDivider> {
  const runActive = runs.some(
    (run) => run.status === "pending" || run.status === "running"
  )
  const compaction = messages.flatMap((message) => {
    if (message.role !== "system") return []
    const presentation = readContextCompactionPresentation(message.metadata)
    return presentation ? [{ message, presentation }] : []
  })
  const resolved = new Map<string, ResolvedDivider>()

  for (let index = 0; index < compaction.length; index++) {
    const current = compaction[index]!
    const next = compaction[index + 1]
    const merged =
      current.presentation.phase === "started" &&
      (next?.presentation.phase === "completed" || next?.presentation.phase === "failed")
    if (merged && next) {
      resolved.set(current.message.id, {
        message: current.message,
        parts: partsByMessage.get(current.message.id) ?? [],
        phase: next.presentation.phase,
        mergedIds: [next.message.id],
      })
      index++
      continue
    }
    const phase: ContextCompactionPhase =
      current.presentation.phase === "started" && !runActive
        ? "interrupted"
        : current.presentation.phase
    resolved.set(current.message.id, {
      message: current.message,
      parts: partsByMessage.get(current.message.id) ?? [],
      phase,
      mergedIds: [],
    })
  }

  return resolved
}

function createTurn(
  userMessage: DesktopSessionMessage | undefined,
  userParts: DesktopSessionPart[],
  inputId?: string,
  fallbackId?: string,
  fallbackCreatedAt = Number.MAX_SAFE_INTEGER
): ConversationTurn {
  return {
    id: inputId ?? userMessage?.id ?? fallbackId ?? "empty-turn",
    createdAt: userMessage?.createdAt ?? fallbackCreatedAt,
    inputId,
    runIds: [],
    userMessage,
    userParts,
    assistantMessages: [],
    assistantParts: [],
    blocks: [],
  }
}

function compareEntries(left: ConversationEntry, right: ConversationEntry): number {
  const leftCreatedAt = left.type === "system" ? left.system.message.createdAt : left.turn.createdAt
  const rightCreatedAt =
    right.type === "system" ? right.system.message.createdAt : right.turn.createdAt
  return leftCreatedAt - rightCreatedAt
}

function groupPartsByMessage(parts: DesktopSessionPart[]): Map<string, DesktopSessionPart[]> {
  const grouped = new Map<string, DesktopSessionPart[]>()
  for (const part of parts) {
    const current = grouped.get(part.messageId) ?? []
    current.push(part)
    grouped.set(part.messageId, current)
  }
  for (const current of grouped.values()) current.sort((a, b) => a.seq - b.seq)
  return grouped
}

function compareMessages(a: DesktopSessionMessage, b: DesktopSessionMessage): number {
  return a.seq - b.seq || a.createdAt - b.createdAt
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @openharness/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/message/__test__/conversation-turn-model.test.ts`
Expected: PASS（含全部既有用例）

---

### Task A3: transcript 按 blocks 渲染

**Files:**
- Create: `apps/desktop/src/renderer/src/components/desktop/conversation-page/transcript/turn-block-plan.ts`
- Modify: `apps/desktop/src/renderer/src/components/desktop/conversation-page/transcript/transcript.tsx`
- Test: `apps/desktop/src/renderer/src/components/desktop/conversation-page/transcript/__test__/turn-block-plan.test.ts`

**Interfaces:**
- Consumes: A2 的 `ConversationTurn.blocks`；A1 的 `ContextCompactionPhase`、`ContextCompactionDivider`。
- Produces: `planTurnBlocks(turn: ConversationTurn, options: { streaming: boolean }): TurnBlockPlanItem[]`，其中
  `TurnBlockPlanItem = { key: string; messageId: string; kind: "assistant" | "divider"; parts: DesktopSessionPart[]; streaming: boolean; showActions: boolean; phase?: ContextCompactionPhase }`。

- [ ] **Step 1: 写失败测试**

新建 `.../transcript/__test__/turn-block-plan.test.ts`：

```ts
import { describe, expect, it } from "vitest"

import type { ConversationTurn } from "../../message/conversation-turn-model"
import { planTurnBlocks } from "../turn-block-plan"

describe("turn block plan", () => {
  it("streams and shows actions only on the last assistant block", () => {
    const turn = turnWithBlocks([
      { kind: "divider", message: message("d-1", 2), parts: [], phase: "completed" },
      { kind: "assistant", messages: [message("a-1", 4)], parts: [] },
      { kind: "divider", message: message("d-2", 5), parts: [], phase: "completed" },
      { kind: "assistant", messages: [message("a-2", 6)], parts: [] },
    ])
    const plan = planTurnBlocks(turn, { streaming: true })

    expect(plan.map((item) => item.kind)).toEqual([
      "divider",
      "assistant",
      "divider",
      "assistant",
    ])
    expect(plan[0]).toMatchObject({ kind: "divider", streaming: false, showActions: false })
    expect(plan[1]).toMatchObject({ kind: "assistant", streaming: false, showActions: true })
    expect(plan[3]).toMatchObject({ kind: "assistant", streaming: true, showActions: false })
  })

  it("never streams when the turn is not the running turn", () => {
    const turn = turnWithBlocks([
      { kind: "assistant", messages: [message("a-1", 2)], parts: [] },
    ])
    const plan = planTurnBlocks(turn, { streaming: false })

    expect(plan[0]).toMatchObject({ streaming: false, showActions: true })
  })

  it("uses stable keys for dividers and assistant blocks", () => {
    const turn = turnWithBlocks([
      { kind: "divider", message: message("d-1", 2), parts: [], phase: "interrupted" },
      { kind: "assistant", messages: [message("a-1", 4)], parts: [] },
    ])
    const plan = planTurnBlocks(turn, { streaming: false })

    expect(plan[0]?.key).toContain("d-1")
    expect(plan[0]?.phase).toBe("interrupted")
    expect(plan[1]?.messageId).toBe("a-1")
  })
})

function turnWithBlocks(blocks: ConversationTurn["blocks"]): ConversationTurn {
  return {
    id: "input-1",
    createdAt: 1,
    inputId: "input-1",
    runIds: ["run-1"],
    userMessage: message("u-1", 1),
    userParts: [],
    assistantMessages: blocks.flatMap((block) =>
      block.kind === "assistant" ? block.messages : []
    ),
    assistantParts: [],
    blocks,
  }
}

function message(id: string, seq: number): ConversationTurn["assistantMessages"][number] {
  return {
    id,
    sessionId: "session-1",
    seq,
    role: "assistant",
    metadata: {},
    createdAt: seq,
    updatedAt: seq,
  }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @openharness/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/transcript/__test__/turn-block-plan.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 新建渲染计划模块**

`.../transcript/turn-block-plan.ts`：

```ts
import type { DesktopSessionPart } from "@shared/session-types"

import type { ContextCompactionPhase } from "../message/compaction-presentation"
import type { ConversationTurn } from "../message/conversation-turn-model"

export interface TurnBlockPlanItem {
  key: string
  messageId: string
  kind: "assistant" | "divider"
  parts: DesktopSessionPart[]
  streaming: boolean
  showActions: boolean
  phase?: ContextCompactionPhase
}

export function planTurnBlocks(
  turn: ConversationTurn,
  options: { streaming: boolean }
): TurnBlockPlanItem[] {
  const lastAssistantIndex = turn.blocks.reduce(
    (latest, block, index) => (block.kind === "assistant" ? index : latest),
    -1
  )
  return turn.blocks.map((block, index) => {
    if (block.kind === "divider") {
      return {
        key: `${turn.id}-divider-${block.message.id}`,
        messageId: block.message.id,
        kind: "divider" as const,
        parts: block.parts,
        streaming: false,
        showActions: false,
        phase: block.phase,
      }
    }
    const isStreaming = options.streaming && index === lastAssistantIndex
    const lastMessageId = block.messages.at(-1)?.id
    return {
      key: lastMessageId ?? `${turn.id}-assistant-${index}`,
      messageId: lastMessageId ?? `${turn.id}-assistant-${index}`,
      kind: "assistant" as const,
      parts: block.parts,
      streaming: isStreaming,
      showActions: !isStreaming,
    }
  })
}
```

- [ ] **Step 4: 改 transcript 渲染**

`.../transcript/transcript.tsx`：

1. 顶部新增导入：

```ts
import { ContextCompactionDivider } from "../message/context-compaction-divider"
import { planTurnBlocks } from "./turn-block-plan"
```

2. 把 system entry 的渲染（原 `MessageBlock`）替换为：

```tsx
        if (entry.type === "system") {
          return (
            <MessageScrollerItem key={entry.system.id} messageId={entry.system.id}>
              {entry.system.compactionPhase ? (
                <ContextCompactionDivider
                  presentation={{
                    kind: "context_compaction",
                    phase: entry.system.compactionPhase,
                  }}
                />
              ) : (
                <MessageBlock
                  message={entry.system.message}
                  parts={entry.system.parts}
                  streaming={false}
                  onOpenFile={onOpenFile}
                  canOpenReview={canOpenReview}
                  onOpenReview={onOpenReview}
                  onOpenTerminal={onOpenTerminal}
                />
              )}
            </MessageScrollerItem>
          )
        }
```

3. 找到原来的助手渲染块（以 `{entry.turn.assistantMessages.length > 0 ? (` 开头、以 `) : null}` 结尾，内部含 `AssistantMessage` 与 `AssistantMessageActions`），整体替换为：

```tsx
            {planTurnBlocks(entry.turn, { streaming: running && entry === lastTurn }).map((item) =>
              item.kind === "divider" && item.phase ? (
                <MessageScrollerItem key={item.key} messageId={item.messageId}>
                  <ContextCompactionDivider
                    presentation={{ kind: "context_compaction", phase: item.phase }}
                  />
                </MessageScrollerItem>
              ) : (
                <MessageScrollerItem
                  key={item.key}
                  messageId={item.messageId}
                  className="group/msg min-w-0"
                >
                  <AssistantMessage
                    parts={item.parts}
                    streaming={item.streaming}
                    onOpenFile={onOpenFile}
                    canOpenReview={canOpenReview}
                    onOpenReview={onOpenReview}
                    onOpenTerminal={onOpenTerminal}
                  />
                  {item.showActions ? (
                    <AssistantMessageActions
                      message={entry.turn.assistantMessages.at(-1)}
                      content={messageTextContent(entry.turn.assistantParts)}
                      disabled={false}
                      onCopy={onCopyAssistantMessage}
                      onFork={onForkAssistantMessage}
                    />
                  ) : null}
                </MessageScrollerItem>
              )
            )}
```

- [ ] **Step 5: 跑测试与类型检查**

Run: `pnpm --filter @openharness/desktop exec vitest run src/renderer/src/components/desktop/conversation-page`
Expected: 全部 PASS

Run: `pnpm --filter @openharness/desktop typecheck`
Expected: 无错误

---

## Stage B：桌面端事件流断流兜底

### Task B1: SSE 传输层空闲超时（按原始帧判活）

**Files:**
- Modify: `packages/client/src/transport/sse-transport.ts`
- Modify: `packages/client/src/types/index.ts`（`EventSyncOptions` 增加 `idleTimeoutMs?: number`）
- Modify: `packages/client/src/resources/event-resource.ts`（透传）
- Test: `packages/client/src/transport/__test__/sse-transport.test.ts`（新建）

**Interfaces:**
- Produces: `SseStreamOptions.idleTimeoutMs?: number`；`EventSyncOptions.idleTimeoutMs?: number`。
- 行为：启用后，`idleTimeoutMs` 内没有收到任何**原始 SSE 帧**（含注释/keepalive）就中止当前响应；流按「干净结束」返回，由调用方决定是否重连。

- [ ] **Step 1: 写失败测试**

新建 `packages/client/src/transport/__test__/sse-transport.test.ts`：

```ts
import { describe, expect, it } from "vitest"

import type { HttpTransport } from "../http-transport"
import { SseTransport } from "../sse-transport"

function transportWith(
  body: (signal: AbortSignal) => ReadableStream<Uint8Array>
): HttpTransport {
  return {
    baseUrl: "http://localhost",
    requestResponse: async (_path: string, options?: { signal?: AbortSignal }) => {
      const signal = options?.signal ?? new AbortController().signal
      return new Response(body(signal))
    },
  } as unknown as HttpTransport
}

function silentBody(signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener(
        "abort",
        () => controller.error(new DOMException("Aborted", "AbortError")),
        { once: true }
      )
    },
  })
}

function keepaliveBody(
  signal: AbortSignal,
  options: { keepaliveMs: number; eventAtMs: number }
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const interval = setInterval(
        () => controller.enqueue(encoder.encode(": keepalive\n\n")),
        options.keepaliveMs
      )
      const eventTimer = setTimeout(() => {
        clearInterval(interval)
        controller.enqueue(encoder.encode('data: {"seq":1}\n\n'))
        setTimeout(() => controller.close(), 5)
      }, options.eventAtMs)
      signal.addEventListener(
        "abort",
        () => {
          clearInterval(interval)
          clearTimeout(eventTimer)
          controller.error(new DOMException("Aborted", "AbortError"))
        },
        { once: true }
      )
    },
  })
}

describe("SseTransport idle timeout", () => {
  it("ends the stream when no frame arrives within idleTimeoutMs", async () => {
    const transport = new SseTransport(transportWith(silentBody))
    const received: unknown[] = []
    for await (const event of transport.stream("http://localhost/events", {
      idleTimeoutMs: 20,
    })) {
      received.push(event)
    }
    expect(received).toEqual([])
  })

  it("keeps the stream alive while keepalive frames arrive", async () => {
    const transport = new SseTransport(
      transportWith((signal) => keepaliveBody(signal, { keepaliveMs: 5, eventAtMs: 45 }))
    )
    const received: unknown[] = []
    for await (const event of transport.stream("http://localhost/events", {
      idleTimeoutMs: 20,
    })) {
      received.push(event)
    }
    expect(received).toEqual([{ seq: 1 }])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @openharness/client exec vitest run src/transport/__test__/sse-transport.test.ts`
Expected: 第 1 个用例挂起/超时失败（没有空闲超时）

- [ ] **Step 3: 实现空闲超时**

`packages/client/src/transport/sse-transport.ts`：

1. `SseStreamOptions` 增加字段：

```ts
  /** 超过该毫秒数没有收到任何原始 SSE 帧（含注释帧）就中止当前连接；0/未设置表示关闭。 */
  idleTimeoutMs?: number
```

2. `stream()` 方法整体替换为：

```ts
  async *stream<T>(
    url: string,
    options: SseStreamOptions<T> = {},
  ): AsyncIterable<T> {
    let lastEventId = options.lastEventId
    let reconnectDelayMs = options.reconnectDelayMs ?? 250
    let connected = false

    while (!options.signal?.aborted) {
      const connection = new AbortController()
      const onOuterAbort = () => connection.abort(options.signal?.reason)
      options.signal?.addEventListener("abort", onOuterAbort, { once: true })
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      let idleExpired = false
      const resetIdleTimer = () => {
        if (!options.idleTimeoutMs || options.idleTimeoutMs <= 0) return
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          idleExpired = true
          connection.abort("sse_idle_timeout")
        }, options.idleTimeoutMs)
      }
      try {
        const headers = new Headers(options.headers)
        if (lastEventId) headers.set("Last-Event-ID", lastEventId)
        const requestUrl = connected && lastEventId ? withoutCursor(url) : url
        const response = await this.transport.requestResponse(
          requestUrl.slice(this.transport.baseUrl.length),
          { headers, signal: connection.signal },
        )
        connected = true
        if (!response.body) {
          throw new Error(options.noBodyMessage ?? "Event stream response has no body")
        }
        resetIdleTimer()
        try {
          for await (const frame of readRawSseFrames(response.body)) {
            resetIdleTimer()
            if (frame.id !== undefined) lastEventId = frame.id
            if (frame.retry !== undefined) reconnectDelayMs = frame.retry
            if (frame.data !== undefined) {
              yield (options.decode ?? ((value) => value as T))(JSON.parse(frame.data))
            }
          }
        } catch (error) {
          if (!idleExpired) throw error
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
        options.signal?.removeEventListener("abort", onOuterAbort)
      }

      if (!options.reconnect || options.signal?.aborted) return
      await waitForReconnect(reconnectDelayMs, options.signal)
    }
  }
```

- [ ] **Step 4: 透传选项**

`packages/client/src/types/index.ts` 的 `EventSyncOptions` 增加：

```ts
  /** 会话事件流空闲超时（毫秒）；默认由 sync 层填 60s。 */
  idleTimeoutMs?: number
```

`packages/client/src/resources/event-resource.ts` 的 `sse.stream(...)` 调用里增加：

```ts
        idleTimeoutMs: options.idleTimeoutMs,
```

- [ ] **Step 5: 跑测试**

Run: `pnpm --filter @openharness/client exec vitest run src/transport/__test__/sse-transport.test.ts`
Expected: PASS（2 个用例）

Run: `pnpm --filter @openharness/client test`
Expected: 全部 PASS

---

### Task B2: 重连时重新取快照

**Files:**
- Modify: `packages/client/src/state/sync.ts`
- Test: `packages/client/src/state/__test__/sync.test.ts`（新建）

**Interfaces:**
- Consumes: B1 的 `EventSyncOptions.idleTimeoutMs`。
- 行为：会话路径每次重连（流干净结束或抛错）后重新 `client.sessions.getState`，并以 `source: "snapshot"` yield 一次；`liveWithReconnect` 的既有签名与调用方不变。

- [ ] **Step 1: 写失败测试**

新建 `packages/client/src/state/__test__/sync.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest"

import type { SessionEventRecord, SessionStateSnapshot } from "../../types/index"
import { syncEvents } from "../sync"

function snapshot(cursor: number): SessionStateSnapshot {
  return {
    cursor,
    session: {
      id: "s1",
      cwd: "/repo",
      title: "s1",
      model: "gpt-test",
      status: "running",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    },
    inputs: [],
    messages: [],
    parts: [],
    runs: [],
    permissions: [],
  } as SessionStateSnapshot
}

function emptyStream(): AsyncIterable<SessionEventRecord> {
  return (async function* () {})()
}

describe("syncEvents reconnect", () => {
  it("re-snapshots after a clean stream end and reports snapshot source", async () => {
    const getState = vi
      .fn<() => Promise<SessionStateSnapshot>>()
      .mockResolvedValueOnce(snapshot(1))
      .mockResolvedValueOnce(snapshot(5))
    const client = {
      sessions: { getState },
      events: { list: vi.fn(async () => []), stream: vi.fn(() => emptyStream()) },
    }

    const sources: string[] = []
    for await (const update of syncEvents(client as never, {
      sessionId: "s1",
      reconnectDelayMs: () => 0,
    })) {
      sources.push(update.source)
      if (sources.length >= 3) break
    }

    expect(sources).toEqual(["snapshot", "reconnecting", "snapshot"])
    expect(getState).toHaveBeenCalledTimes(2)
  })

  it("re-snapshots after a stream error", async () => {
    const getState = vi.fn(async () => snapshot(1))
    const failing = (async function* (): AsyncIterable<SessionEventRecord> {
      throw new Error("stream boom")
    })()
    const client = {
      sessions: { getState },
      events: { list: vi.fn(async () => []), stream: vi.fn(() => failing) },
    }

    const sources: string[] = []
    for await (const update of syncEvents(client as never, {
      sessionId: "s1",
      reconnectDelayMs: () => 0,
    })) {
      sources.push(update.source)
      if (sources.length >= 3) break
    }

    expect(sources).toEqual(["snapshot", "reconnecting", "snapshot"])
    expect(getState).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @openharness/client exec vitest run src/state/__test__/sync.test.ts`
Expected: FAIL（第二次 yield 是 `live` 而不是 `snapshot`；`getState` 只调用一次）

- [ ] **Step 3: 改 sync.ts**

`packages/client/src/state/sync.ts`：

1. `syncEvents` 的会话分支改为传入会话重连能力（`liveWithReconnect` 增加一个可选参数）：

```ts
  if (options.sessionId) {
    const sessionId = options.sessionId
    const snapshot = await client.sessions.getState(sessionId, { signal: options.signal })
    state = applySessionSnapshot(state, snapshot)
    yield { state, source: "snapshot" }

    yield* liveWithReconnect(client, state, options, snapshot.cursor, async (current) => {
      const refreshed = await client.sessions.getState(sessionId, { signal: options.signal })
      const next = applySessionSnapshot(current, refreshed)
      return { state: next, cursor: refreshed.cursor }
    })
    return
  }
```

2. `liveWithReconnect` 签名与循环改为（注意：重连分支的「等待退避 → 重新快照 → yield」在流结束与 catch 两处各写一遍，不要嵌套 generator）：

```ts
async function* liveWithReconnect(
  client: SyncEventsClient,
  initialState: OpenHarnessClientState,
  options: EventSyncOptions,
  initialCursor: number,
  resync?: (
    current: OpenHarnessClientState,
  ) => Promise<{ state: OpenHarnessClientState; cursor: number }>,
): AsyncIterable<SyncEventUpdate> {
  let state = initialState
  let cursor = initialCursor
  let attempt = 0
  const delayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS

  while (!options.signal?.aborted) {
    try {
      for await (const event of client.events.stream({
        cursor,
        sessionId: options.sessionId,
        signal: options.signal,
        transportReconnect: false,
        idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS,
      })) {
        attempt = 0
        if (event.seq > state.lastSeq + 1 && !options.sessionId) {
          const gap = await client.events.list({
            cursor: state.lastSeq,
            signal: options.signal,
          })
          for (const missed of gap) {
            const beforeGap = state
            state = applyEvent(state, missed)
            if (state !== beforeGap) yield { event: missed, state, source: "replay" }
          }
          cursor = state.lastSeq
        }

        const before = state
        state = applyEvent(state, event)
        cursor = state.lastSeq
        if (state !== before) yield { event, state, source: "live" }
      }

      // Clean stream end is treated as a disconnect that should resume.
      if (options.signal?.aborted) return
      yield { state, source: "reconnecting" }
      if (!(await waitForReconnect(delayMs(attempt), options.signal))) return
      attempt += 1
      if (resync) {
        const refreshed = await resync(state)
        state = refreshed.state
        cursor = refreshed.cursor
        yield { state, source: "snapshot" }
      } else {
        cursor = state.lastSeq
      }
    } catch (error) {
      if (error instanceof UnsupportedSessionEventSchemaVersionError) throw error
      if (isAbortError(error) || options.signal?.aborted) return
      yield { state, source: "reconnecting" }
      if (!(await waitForReconnect(delayMs(attempt), options.signal))) return
      attempt += 1
      if (resync) {
        const refreshed = await resync(state)
        state = refreshed.state
        cursor = refreshed.cursor
        yield { state, source: "snapshot" }
      } else {
        cursor = state.lastSeq
      }
    }
  }
}
```

3. 文件顶部常量区（`DEFAULT_RECONNECT_DELAY_MS` 之后）增加：

```ts
/** 会话事件流空闲超时：服务端 keepalive 每 15s 一次，取 4 倍余量。 */
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 60_000
```

- [ ] **Step 4: 跑测试**

Run: `pnpm --filter @openharness/client exec vitest run src/state/__test__/sync.test.ts`
Expected: PASS（2 个用例）

Run: `pnpm --filter @openharness/client test`
Expected: 全部 PASS

---

### Task B3: 桌面主进程订阅重建

**Files:**
- Create: `apps/desktop/src/main/features/session/session-subscription-pump.ts`
- Modify: `apps/desktop/src/main/features/session/session-subscription-service.ts`
- Test: `apps/desktop/src/main/features/session/session-subscription-pump.test.ts`（新建）

**Interfaces:**
- Produces: `pumpSubscription<T>(options: SubscriptionPumpOptions<T>): Promise<void>`；
  `SubscriptionPumpOptions<T> = { initialIterator?; createIterator(); isActive(); onUpdate(value); onReconnecting?(last); onError?(error); backoffMs?(attempt); sleep?(ms) }`。
- 行为：迭代器结束或抛错后，只要 `isActive()` 为真就按退避重建订阅并继续；`onReconnecting` 只在有「最后一次更新」时回调。

- [ ] **Step 1: 写失败测试**

新建 `apps/desktop/src/main/features/session/session-subscription-pump.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest"

import { pumpSubscription } from "./session-subscription-pump"

describe("pumpSubscription", () => {
  it("rebuilds the iterator after an error and continues", async () => {
    const updates: number[] = []
    const reconnecting: number[] = []
    const errors: unknown[] = []
    let created = 0
    let active = true
    const failing: AsyncIterator<number> = {
      next: async () => {
        throw new Error("boom")
      },
    }
    const working = (async function* () {
      yield 1
      await new Promise(() => {})
    })()

    await pumpSubscription<number>({
      createIterator: () => {
        created += 1
        return created === 1 ? failing : working[Symbol.asyncIterator]()
      },
      isActive: () => active,
      onUpdate: (value) => {
        updates.push(value)
        active = false
      },
      onReconnecting: (value) => reconnecting.push(value),
      onError: (error) => errors.push(error),
      backoffMs: () => 0,
    })

    expect(created).toBe(2)
    expect(updates).toEqual([1])
    expect(errors).toHaveLength(1)
    expect(reconnecting).toEqual([])
  })

  it("reports the last update when rebuilding after a clean end", async () => {
    const events: string[] = []
    let created = 0
    let active = true
    const first = (async function* () {
      yield "a"
    })()
    const second = (async function* () {
      yield "b"
      await new Promise(() => {})
    })()

    await pumpSubscription<string>({
      createIterator: () => {
        created += 1
        return (created === 1 ? first : second)[Symbol.asyncIterator]()
      },
      isActive: () => active,
      onUpdate: (value) => {
        events.push(value)
        if (value === "b") active = false
      },
      onReconnecting: (value) => events.push(`reconnecting:${value}`),
      backoffMs: () => 0,
    })

    expect(events).toEqual(["a", "reconnecting:a", "b"])
  })

  it("stops immediately when inactive", async () => {
    const createIterator = vi.fn()
    await pumpSubscription<number>({
      createIterator,
      isActive: () => false,
      onUpdate: () => {},
    })
    expect(createIterator).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @openharness/desktop exec vitest run src/main/features/session/session-subscription-pump.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 新建 pump 模块**

`apps/desktop/src/main/features/session/session-subscription-pump.ts`：

```ts
export interface SubscriptionPumpOptions<T> {
  initialIterator?: AsyncIterator<T>
  createIterator(): AsyncIterator<T> | Promise<AsyncIterator<T>>
  isActive(): boolean
  onUpdate(value: T): void
  onReconnecting?(last: T): void
  onError?(error: unknown): void
  backoffMs?(attempt: number): number
  sleep?(ms: number): Promise<void>
}

const DEFAULT_BACKOFF_MS = (attempt: number): number =>
  Math.min(30_000, 250 * 2 ** Math.max(0, attempt))

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 消费订阅迭代器；迭代器结束或抛错后按退避重建并继续，直到 isActive() 为假。
 * 订阅替换、窗口销毁、controller abort 都由调用方的 isActive() 表达。
 */
export async function pumpSubscription<T>(options: SubscriptionPumpOptions<T>): Promise<void> {
  let attempt = 0
  let iterator = options.initialIterator
  let last: T | undefined

  while (options.isActive()) {
    try {
      iterator ??= await options.createIterator()
      while (options.isActive()) {
        const update = await iterator.next()
        if (update.done) break
        last = update.value
        options.onUpdate(update.value)
      }
      iterator = undefined
    } catch (error) {
      iterator = undefined
      options.onError?.(error)
    }
    if (!options.isActive()) return
    if (last !== undefined) options.onReconnecting?.(last)
    await (options.sleep ?? defaultSleep)((options.backoffMs ?? DEFAULT_BACKOFF_MS)(attempt))
    attempt += 1
  }
}
```

- [ ] **Step 4: 接线到 service**

`apps/desktop/src/main/features/session/session-subscription-service.ts`：

1. 顶部导入：

```ts
import { pumpSubscription } from "./session-subscription-pump"
```

2. 两处 `setTimeout(() => { void this.pumpSession(...) }, 0)` 调用改为传入 `client`（主订阅）：

```ts
    setTimeout(() => {
      void this.pumpSession(client, webContents, primarySubscriptionSlot, sessionId, controller, iterator)
    }, 0)
```

辅助订阅：

```ts
    setTimeout(() => {
      void this.pumpSession(client, webContents, slot, sessionId, controller, iterator, subscriptionId)
    }, 0)
```

3. `pumpSession` 整体替换为：

```ts
  private async pumpSession(
    client: SessionSubscriptionClient,
    webContents: WebContents,
    slot: string,
    sessionId: string,
    controller: AbortController,
    iterator: AsyncIterator<SyncEventUpdate>,
    auxiliarySubscriptionId?: string
  ): Promise<void> {
    const subscription = this.subscriptions.get(webContents.id, slot)
    const send = (view: DesktopSessionView): void => {
      if (auxiliarySubscriptionId) {
        const payload: DesktopAuxSessionUpdate = { subscriptionId: auxiliarySubscriptionId, view }
        webContents.send(IpcEvents.sessionAuxUpdated, payload)
        return
      }
      webContents.send(IpcEvents.sessionUpdated, view)
    }

    await pumpSubscription<SyncEventUpdate>({
      initialIterator: iterator,
      createIterator: () =>
        syncEvents(client, { sessionId, signal: controller.signal })[Symbol.asyncIterator](),
      isActive: () =>
        !controller.signal.aborted &&
        !webContents.isDestroyed() &&
        Boolean(subscription) &&
        this.subscriptions.isCurrent(webContents.id, slot, subscription!),
      onUpdate: (update) => send(toDesktopSessionView(update.state, sessionId, update.source)),
      onReconnecting: (last) => send(toDesktopSessionView(last.state, sessionId, "reconnecting")),
      onError: (error) => {
        if (!controller.signal.aborted && !webContents.isDestroyed()) {
          console.error(`[session] sync failed for ${sessionId}`, error)
        }
      },
    })
  }
```

注意：`SessionSubscriptionRegistry` 无需改动（重建时仍用同一个 subscription/controller，`isCurrent` 语义不变）。

- [ ] **Step 5: 跑测试**

Run: `pnpm --filter @openharness/desktop exec vitest run src/main/features/session`
Expected: 全部 PASS（含既有 `session-subscriptions.test.ts`）

Run: `pnpm --filter @openharness/desktop typecheck`
Expected: 无错误

---

## Stage C：服务端 run 无进展看门狗

### Task C1: RunStallWatchdog

**Files:**
- Create: `packages/server/src/application/session/run-stall-watchdog.ts`
- Test: `packages/server/src/application/session/__test__/run-stall-watchdog.test.ts`（新建）

**Interfaces:**
- Produces: `RunStallWatchdog`，构造参数 `{ runId; sessionId; staleMs; intervalMs; now?; setInterval?; clearInterval?; readActivity(): { runUpdatedAt: number; taskUpdatedAt: number }; hasPendingPermission(): boolean; hasRunningChildTask(): boolean; onStall(): void; log?(message: string): void }`；方法 `start()`、`check()`、`dispose()`。
- 行为：`check()` 发现「最近活动时间 + staleMs < now」且无豁免时调用一次 `onStall()` 并自我 dispose。

- [ ] **Step 1: 写失败测试**

新建 `packages/server/src/application/session/__test__/run-stall-watchdog.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest"

import { RunStallWatchdog, type RunStallWatchdogOptions } from "../run-stall-watchdog"

function watchdog(
  overrides: Partial<RunStallWatchdogOptions> = {},
): { watchdog: RunStallWatchdog; stalls: string[]; advance: (ms: number) => void } {
  let now = 0
  const stalls: string[] = []
  const instance = new RunStallWatchdog({
    runId: "run-1",
    sessionId: "s1",
    staleMs: 100,
    intervalMs: 10,
    now: () => now,
    readActivity: () => ({ runUpdatedAt: 0, taskUpdatedAt: 0 }),
    hasPendingPermission: () => false,
    hasRunningChildTask: () => false,
    onStall: () => stalls.push("stall"),
    ...overrides,
  })
  return { watchdog: instance, stalls, advance: (ms) => { now += ms } }
}

describe("RunStallWatchdog", () => {
  it("fires once when there is no activity past the threshold", () => {
    const { watchdog: instance, stalls, advance } = watchdog()

    advance(99)
    instance.check()
    expect(stalls).toEqual([])

    advance(2)
    instance.check()
    expect(stalls).toEqual(["stall"])

    advance(1_000)
    instance.check()
    expect(stalls).toEqual(["stall"])
  })

  it("treats run or task updates as progress", () => {
    let runUpdatedAt = 0
    const { watchdog: instance, stalls, advance } = watchdog({
      readActivity: () => ({ runUpdatedAt, taskUpdatedAt: 0 }),
    })

    advance(150)
    runUpdatedAt = 150
    instance.check()
    expect(stalls).toEqual([])

    advance(50)
    instance.check()
    expect(stalls).toEqual([])

    advance(60)
    instance.check()
    expect(stalls).toEqual(["stall"])
  })

  it("does not fire while a permission request is pending", () => {
    const { watchdog: instance, stalls, advance } = watchdog({
      hasPendingPermission: () => true,
    })

    advance(1_000)
    instance.check()
    expect(stalls).toEqual([])
  })

  it("does not fire while a child task is running", () => {
    const { watchdog: instance, stalls, advance } = watchdog({
      hasRunningChildTask: () => true,
    })

    advance(1_000)
    instance.check()
    expect(stalls).toEqual([])
  })

  it("schedules and clears the interval", () => {
    const handle = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>
    const setIntervalSpy = vi.fn(() => handle)
    const clearIntervalSpy = vi.fn()
    const { watchdog: instance } = watchdog({
      setInterval: setIntervalSpy,
      clearInterval: clearIntervalSpy,
    })

    instance.start()
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 10)

    instance.dispose()
    expect(clearIntervalSpy).toHaveBeenCalledWith(handle)

    instance.check()
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @openharness/server exec vitest run src/application/session/__test__/run-stall-watchdog.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现看门狗**

`packages/server/src/application/session/run-stall-watchdog.ts`：

```ts
export interface RunStallWatchdogOptions {
  runId: string
  sessionId: string
  /** 超过该毫秒数没有任何 run/task 更新就判定停滞。 */
  staleMs: number
  /** 检查周期（毫秒）。 */
  intervalMs: number
  now?(): number
  setInterval?(handler: () => void, ms: number): ReturnType<typeof setInterval>
  clearInterval?(handle: ReturnType<typeof setInterval>): void
  readActivity(): { runUpdatedAt: number; taskUpdatedAt: number }
  hasPendingPermission(): boolean
  hasRunningChildTask(): boolean
  onStall(): void
  log?(message: string): void
}

/**
 * run 无进展看门狗：只在「run 与关联 task 都没有更新」且没有等待用户授权、
 * 没有运行中的子任务时判停。触发一次后自我 dispose，避免重复中断。
 */
export class RunStallWatchdog {
  private handle?: ReturnType<typeof setInterval>
  private lastActivityAt: number
  private disposed = false

  constructor(private readonly options: RunStallWatchdogOptions) {
    this.lastActivityAt = this.now()
  }

  start(): void {
    if (this.handle || this.disposed) return
    const schedule = this.options.setInterval ?? setInterval
    this.handle = schedule(() => this.check(), this.options.intervalMs)
    ;(this.handle as { unref?: () => void }).unref?.()
  }

  check(): void {
    if (this.disposed) return
    const now = this.now()
    const activity = this.options.readActivity()
    const latest = Math.max(activity.runUpdatedAt, activity.taskUpdatedAt)
    if (latest > this.lastActivityAt) {
      this.lastActivityAt = latest
      return
    }
    if (now - this.lastActivityAt < this.options.staleMs) return
    if (this.options.hasPendingPermission() || this.options.hasRunningChildTask()) {
      this.lastActivityAt = now
      return
    }
    this.options.log?.(`run ${this.options.runId} made no progress for ${now - this.lastActivityAt}ms`)
    this.dispose()
    this.options.onStall()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.handle) {
      (this.options.clearInterval ?? clearInterval)(this.handle)
      this.handle = undefined
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @openharness/server exec vitest run src/application/session/__test__/run-stall-watchdog.test.ts`
Expected: PASS（5 个用例）

---

### Task C2: executor 接线

**Files:**
- Modify: `packages/server/src/application/session/session-run-executor.ts`
- Modify: `packages/server/src/application/session/session-run-executor-assembly.ts:17-20`（store pick 增加 `"permissions"`）
- Test: `packages/server/src/application/session/__test__/session-run-executor.test.ts`

**Interfaces:**
- Consumes: C1 的 `RunStallWatchdog`。
- Produces: `SessionRunExecutorContext.data` 增加 `permissions`；`SessionRunExecutorContext.stallTimeoutMs?`、`stallCheckIntervalMs?`。

- [ ] **Step 1: 写失败测试**

在 `.../__test__/session-run-executor.test.ts` 的 `describe` 内追加：

```ts
  it("interrupts a run that makes no progress", async () => {
    const store = createStore()
    const handle = hangingHandle()
    const interrupt = handle.interrupt as ReturnType<typeof vi.fn>
    const executor = new SessionRunExecutor({
      data: store.data,
      attachments: store.attachments,
      goals: store.goals,
      agentPool: {
        configured: true,
        acquireSession: async () => ({ setModel: () => {}, submitMessage: () => handle }),
        close: async () => {},
        closeIfStale: async () => {},
      } as any,
      events: { checkpoint: () => 1, publishSince: () => {} },
      transcriptProjection: { finalizeRunParts: () => {} } as any,
      traceIdForRun: () => "trace-1",
      log: () => {},
      stallTimeoutMs: 20,
      stallCheckIntervalMs: 5,
    });

    await executor.execute(
      { sessionId: "s1", inputId: "input-1", runId: "run-1" },
      { signal: new AbortController().signal, registerHandle: async () => {} },
    );

    expect(interrupt).toHaveBeenCalledWith(expect.stringContaining("无进展"));
  });
```

并在文件底部追加 helper：

```ts
function hangingHandle(): AgentRunHandle {
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<never>((_, reject) => {
    rejectResult = reject;
  });
  return {
    id: "run-1",
    inputId: "input-1",
    sessionId: "s1",
    traceId: "trace-1",
    started: Promise.resolve({ sessionId: "s1", inputId: "input-1", runId: "run-1" }),
    result,
    steer: vi.fn(),
    interrupt: vi.fn(async (reason?: string) => {
      rejectResult(new Error(reason ?? "Run interrupted"));
    }),
  } as unknown as AgentRunHandle;
}
```

同时更新 `createStore()` 的 `data`（C2 需要 `permissions.list` 与 `runs.listSessionTasks`）：

```ts
    runs: { getRun, updateRun, listSessionTasks: vi.fn(() => []) },
    permissions: { list: vi.fn(() => []) },
  } satisfies SessionRunExecutorContext["data"];
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @openharness/server exec vitest run src/application/session/__test__/session-run-executor.test.ts`
Expected: 类型/断言失败（`permissions` 不在 `data` 类型中；看门狗不存在）

- [ ] **Step 3: 改 executor**

`packages/server/src/application/session/session-run-executor.ts`：

1. 顶部导入与常量：

```ts
import { RunStallWatchdog } from "./run-stall-watchdog.js"

const DEFAULT_RUN_STALL_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_RUN_STALL_CHECK_INTERVAL_MS = 30 * 1_000;
```

2. `SessionRunExecutorContext.data` 的 Pick 增加 `"permissions"`：

```ts
  data: Pick<SessionStore,
    "conversations" | "conversationTransactions" | "permissions" | "runs" | "sessions" | "transaction"
  >;
```

3. context 增加选项：

```ts
  /** 无进展看门狗：超过该时长没有任何 run/task 更新就中断 run（默认 10 分钟）。 */
  stallTimeoutMs?: number;
  /** 无进展看门狗检查周期（默认 30 秒）。 */
  stallCheckIntervalMs?: number;
```

4. `execute()` 内：在 `await workContext.registerHandle(run)` 之后创建并启动看门狗，在 `catch` 后加 `finally { watchdog?.dispose(); }`：

```ts
      await workContext.registerHandle(run);

      const stallTimeoutMs = this.context.stallTimeoutMs ?? DEFAULT_RUN_STALL_TIMEOUT_MS;
      watchdog = new RunStallWatchdog({
        runId,
        sessionId,
        staleMs: stallTimeoutMs,
        intervalMs: this.context.stallCheckIntervalMs ?? DEFAULT_RUN_STALL_CHECK_INTERVAL_MS,
        readActivity: () => ({
          runUpdatedAt: this.context.data.runs.getRun(runId)?.updatedAt ?? 0,
          taskUpdatedAt: this.context.data.runs
            .listSessionTasks(sessionId)
            .reduce((latest, task) => Math.max(latest, task.updatedAt), 0),
        }),
        hasPendingPermission: () =>
          this.context.data.permissions
            .list({ sessionId })
            .some((request) => request.runId === runId && request.status === "pending"),
        hasRunningChildTask: () =>
          this.context.data.runs
            .listSessionTasks(sessionId)
            .some((task) => Boolean(task.childSessionId) && task.status === "running"),
        onStall: () => {
          void run.interrupt(
            `运行超过 ${Math.round(stallTimeoutMs / 60_000)} 分钟无进展，已自动终止`,
          );
        },
        log: (message) =>
          this.context.log({
            level: "warn",
            event: "session.run.stalled",
            sessionId,
            runId,
            error: message,
          }),
      });
      watchdog.start();

      // 模型回合、工具、JobWait 都在这次 result 里。成功时 projector 已经把 run 标成 completed。
      await run.result;
```

声明 `let watchdog: RunStallWatchdog | undefined;` 与 `let agentTouched = false;` 同一行区域。

- [ ] **Step 4: 改 assembly 的 store pick**

`packages/server/src/application/session/session-run-executor-assembly.ts`：

```ts
  store: Pick<SessionStore,
    "attachments" | "conversations" | "conversationTransactions" |
    "permissions" | "runs" | "sessions" | "transaction"
  >;
```

- [ ] **Step 5: 跑测试与类型检查**

Run: `pnpm --filter @openharness/server exec vitest run src/application/session/__test__/session-run-executor.test.ts src/application/session/__test__/run-stall-watchdog.test.ts`
Expected: PASS

Run: `pnpm --filter @openharness/server check-types`
Expected: 无错误

---

## 最终验证（Task V）

- [ ] **Step 1: 三个包各自全量测试**

Run: `pnpm --filter @openharness/desktop test`
Run: `pnpm --filter @openharness/client test`
Run: `pnpm --filter @openharness/server test`
Expected: 全绿（desktop 的 test 脚本还会跑 node 校验脚本）

- [ ] **Step 2: 类型检查**

Run: `pnpm --filter @openharness/desktop typecheck`
Run: `pnpm --filter @openharness/client check-types`
Run: `pnpm --filter @openharness/server check-types`
Expected: 无错误

- [ ] **Step 3: 人工验收（用户参与）**

打开桌面端会话 `63ab048d`，确认：
1. 02:45 与 03:10 两组历史压缩各只显示一条分割线，且位置在那一轮内容之前/中间（不在最底部堵住）；
2. 新发一条消息触发自动压缩时，压缩完成后新内容出现在分割线下方并实时增长；
3. 压缩被中断且没有运行中 run 时显示「上下文压缩已中断」。

- [ ] **Step 4: 变更清单核对（防越界）**

Run: `git status --short` 与 `git diff --stat`
Expected: 改动只落在本计划「文件结构」表列出的文件与新增测试文件；若有多余文件，回退并记录原因。
