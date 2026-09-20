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
        if (latestTurn?.userMessage && latestTurn.userMessage.seq < resolved.message.seq) {
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
  const runActive = runs.some((run) => run.status === "pending" || run.status === "running")
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
