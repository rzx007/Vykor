import { readSessionModelRetryState } from "@vykor/client"
import type { DesktopSessionMessage, DesktopSessionPart, DesktopSessionRun } from "@shared/session-types"

const partPrefix = "ui-tool-generation:"

export function isToolGenerationPresentation(part: DesktopSessionPart): boolean {
  return part.id.startsWith(partPrefix) && part.metadata.uiToolGeneration === true &&
    record(part.metadata.toolProgress)?.phase === "generating"
}

type GenerationEntry = {
  generationId: string
  attempt: number
  toolKey: string
  toolName: string
  toolUseId?: string
  receivedChars: number
}

function validEntry(value: unknown): value is GenerationEntry {
  const entry = record(value)
  return Boolean(entry && [entry.generationId, entry.toolKey, entry.toolName].every(value => typeof value === "string" && value.trim()) &&
    typeof entry.attempt === "number" && Number.isSafeInteger(entry.attempt) && entry.attempt > 0 &&
    typeof entry.receivedChars === "number" && Number.isSafeInteger(entry.receivedChars) && entry.receivedChars >= 0 &&
    (entry.toolUseId === undefined || typeof entry.toolUseId === "string"))
}

/** Render-only records: never insert these into session state, history or tool execution. */
export function withToolGenerationPresentation(
  runs: DesktopSessionRun[], messages: DesktopSessionMessage[], parts: DesktopSessionPart[]
): { messages: DesktopSessionMessage[]; parts: DesktopSessionPart[] } {
  const addedMessages: DesktopSessionMessage[] = []
  const addedParts: DesktopSessionPart[] = []
  for (const run of runs) {
    if ((run.status !== "running" && run.status !== "pending") || readSessionModelRetryState(run.metadata)) continue
    if (!Array.isArray(run.metadata.toolGeneration)) continue
    const runMessages = messages.filter(message => message.runId === run.id && message.sessionId === run.sessionId)
    const messageIds = new Set(runMessages.map(message => message.id))
    const formalTools = parts.filter(part => part.type === "tool" && messageIds.has(part.messageId) &&
      part.sessionId === run.sessionId && !isToolGenerationPresentation(part) && record(part.metadata.modelGeneration)?.superseded !== true)
    const seen = new Set<string>()
    const entries = run.metadata.toolGeneration.filter(validEntry).slice(0, 32).filter(entry => {
      const key = [entry.generationId, entry.attempt, entry.toolKey].map(String).map(encodeURIComponent).join(":")
      if (seen.has(key)) return false
      seen.add(key)
      return !formalTools.some(part => {
        const generation = record(part.metadata.modelGeneration)
        if (generation?.generationId !== entry.generationId || generation.attempt !== entry.attempt) return false
        // Core releases formal calls only after the whole model stream completes.
        // Without a call ID, close the speculative card at that boundary, not by name/count.
        return !entry.toolUseId?.trim() || part.toolUseId === entry.toolUseId
      })
    })
    if (!entries.length) continue
    let message = runMessages.filter(message => message.role === "assistant")
      .reduce<DesktopSessionMessage | undefined>((last, next) => !last || next.seq > last.seq ? next : last, undefined)
    if (!message) {
      message = {
        id: `ui-tool-generation-message:${encodeURIComponent(run.id)}`, sessionId: run.sessionId,
        runId: run.id, inputId: run.inputId, role: "assistant",
        seq: [...messages, ...addedMessages].reduce((max, message) => Math.max(max, message.seq), 0) + 1,
        metadata: { uiToolGeneration: true }, createdAt: run.startedAt ?? run.createdAt, updatedAt: run.updatedAt,
      }
      addedMessages.push(message)
    }
    const lastSeq = parts.filter(part => part.messageId === message.id).reduce((max, part) => Math.max(max, part.seq), 0)
    entries.forEach((entry, index) => addedParts.push({
      id: partPrefix + [run.id, entry.generationId, entry.attempt, entry.toolKey].map(String).map(encodeURIComponent).join(":"),
      sessionId: run.sessionId, messageId: message!.id, seq: lastSeq + index + 1,
      type: "tool", status: "running", toolName: entry.toolName,
      // Deliberately omit toolUseId/input/output so a speculative call cannot receive a real result.
      metadata: { uiToolGeneration: true, toolProgress: {
        phase: "generating", receivedChars: entry.receivedChars, executionState: "not_started",
      } },
      createdAt: run.startedAt ?? run.createdAt, updatedAt: run.updatedAt,
    }))
  }
  return {
    messages: addedMessages.length ? [...messages, ...addedMessages] : messages,
    parts: addedParts.length ? [...parts, ...addedParts] : parts,
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
