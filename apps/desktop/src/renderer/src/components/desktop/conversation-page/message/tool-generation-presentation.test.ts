import { describe, expect, it } from "vitest"
import type { DesktopSessionMessage, DesktopSessionPart, DesktopSessionRun } from "@shared/session-types"
import { buildAssistantContent, collectChangedFiles } from "./message-render-model"
import { isToolGenerationPresentation, withToolGenerationPresentation } from "./tool-generation-presentation"

const entry = { generationId: "g", attempt: 1, toolKey: "0", toolUseId: "call-a", toolName: "Write", receivedChars: 100 }
const message: DesktopSessionMessage = { id: "m", sessionId: "s", runId: "r", inputId: "input", role: "assistant", seq: 2, metadata: {}, createdAt: 1, updatedAt: 1 }
const run: DesktopSessionRun = { id: "r", sessionId: "s", inputId: "input", status: "running", metadata: { toolGeneration: [entry] }, createdAt: 1, updatedAt: 2 }
const formal: DesktopSessionPart = { id: "p", messageId: "m", sessionId: "s", type: "tool", status: "running", toolName: "Write", toolUseId: "call-a", seq: 1,
  input: { file_path: "index.html" }, metadata: { modelGeneration: { generationId: "g", attempt: 1, committed: false } }, createdAt: 1, updatedAt: 2 }
const derive = (entries: unknown[], messages = [message], parts: DesktopSessionPart[] = []) =>
  withToolGenerationPresentation([{ ...run, metadata: { toolGeneration: entries } }], messages, parts)
const uiParts = (parts: DesktopSessionPart[]) => parts.filter(isToolGenerationPresentation)

describe("render-only tool generation cards", () => {
  it("attaches to the current run's last assistant message without mutating source records", () => {
    const messages = [message, { ...message, id: "last", seq: 4 }, { ...message, id: "foreign", runId: "other", seq: 6 }]
    const parts = [{ ...formal, id: "text", type: "text" as const, messageId: "last", toolUseId: undefined, seq: 10 }]
    const before = structuredClone({ run, messages, parts })
    const result = withToolGenerationPresentation([run], messages, parts)
    expect(result.messages).toBe(messages)
    expect(result.parts[0]).toBe(parts[0])
    expect(result.parts[1]).toMatchObject({ messageId: "last", seq: 11, type: "tool", status: "running", toolName: "Write" })
    expect(result.parts[1]).not.toHaveProperty("toolUseId")
    expect(result.parts[1]).not.toHaveProperty("input")
    expect(result.parts[1]).not.toHaveProperty("output")
    expect({ run, messages, parts }).toEqual(before)
  })

  it("keeps IDs stable when counts grow and the provider's call ID arrives late", () => {
    const first = derive([{ ...entry, toolUseId: undefined }], [])
    const updated = derive([{ ...entry, receivedChars: 8192 }], [])
    expect(first.parts[0]!.id).toBe(updated.parts[0]!.id)
    expect(first.messages[0]!.id).toBe(updated.messages[0]!.id)
    expect(updated.messages[0]).toMatchObject({ sessionId: "s", runId: "r", inputId: "input", seq: 1, metadata: { uiToolGeneration: true } })
    expect(updated.parts[0]!.metadata.toolProgress).toMatchObject({ receivedChars: 8192, executionState: "not_started" })
    expect(uiParts(derive([entry], [message], [formal]).parts)).toHaveLength(0)
    expect(derive([], []).messages).toEqual([])
  })

  it("does not create a second card for a submitted call, or deduct a different same-name ID", () => {
    const second = { ...entry, toolKey: "1", toolUseId: "call-b" }
    const result = derive([entry, second], [message], [formal])
    expect(result.parts).toHaveLength(2)
    expect(uiParts(result.parts)[0]!.id).toContain(":1")
    // The server may already have removed the first progress entry.
    expect(uiParts(derive([second], [message], [formal]).parts)).toHaveLength(1)
    expect(uiParts(derive([entry, second], [message], [formal, { ...formal, id: "p2", toolUseId: "call-b" }]).parts)).toHaveLength(0)
  })

  it("closes unknown-ID cards only at the same generation's formal submission boundary", () => {
    const unknown = { ...entry, toolKey: "1", toolUseId: undefined }
    expect(uiParts(derive([entry, unknown]).parts)).toHaveLength(2)
    expect(uiParts(derive([entry, unknown], [message], [formal]).parts)).toHaveLength(0)
    expect(uiParts(derive([unknown], [message], [{ ...formal, toolName: "Read" }]).parts)).toHaveLength(0)
  })

  it.each([
    { modelGeneration: { generationId: "old", attempt: 1 } },
    { modelGeneration: { generationId: "g", attempt: 2 } },
    { modelGeneration: { generationId: "g", attempt: 1, superseded: true } },
    {},
  ])("does not hand off to a stale or unrelated part: %j", metadata => {
    const parts = [{ ...formal, metadata }]
    expect(uiParts(derive([entry, { ...entry, toolKey: "1", toolUseId: undefined }], [message], parts).parts)).toHaveLength(2)
  })

  it("does not hand off to another Run or session", () => {
    expect(uiParts(derive([entry], [{ ...message, runId: "old-run" }], [formal]).parts)).toHaveLength(1)
    expect(uiParts(derive([entry], [message], [{ ...formal, sessionId: "foreign" }]).parts)).toHaveLength(1)
  })

  it("gives subsequent generations different stable identities and withdraws cleared entries", () => {
    const first = derive([entry])
    const next = derive([{ ...entry, generationId: "next" }], [message], [formal])
    expect(uiParts(next.parts)).toHaveLength(1)
    expect(uiParts(next.parts)[0]!.id).not.toBe(first.parts[0]!.id)
    const messages = [message]
    const parts: DesktopSessionPart[] = []
    const cleared = derive([], messages, parts)
    expect(cleared.messages).toBe(messages)
    expect(cleared.parts).toBe(parts)
  })

  it.each(["completed", "failed", "interrupted"] as const)("ignores residual progress on a %s Run", status => {
    expect(withToolGenerationPresentation([{ ...run, status }], [], []).parts).toEqual([])
    expect(withToolGenerationPresentation([{ ...run, status }], [], []).messages).toEqual([])
  })

  it("withdraws speculative calls during a model retry", () => {
    const retryRun = { ...run, metadata: { ...run.metadata, modelRetry: {
      generationId: "g", attempt: 1, retryNumber: 1, maxRetries: 3, reason: "stream_incomplete", nextRetryAt: 100, recoveryDeadlineAt: 200,
    } } }
    expect(withToolGenerationPresentation([retryRun], [], []).parts).toEqual([])
  })

  it("accepts non-empty extension tool names, bounds entries and rejects malformed progress", () => {
    const invalid = [null, {}, { ...entry, toolName: " " }, { ...entry, generationId: "" }, { ...entry, toolKey: "" },
      { ...entry, attempt: 0 }, { ...entry, attempt: 1.5 }, { ...entry, receivedChars: -1 }, { ...entry, receivedChars: Infinity }, { ...entry, receivedChars: 1.5 }]
    expect(derive(invalid).parts).toEqual([])
    expect(derive([{ ...entry, toolName: "CustomExtension" }]).parts[0]!.toolName).toBe("CustomExtension")
    expect(derive(Array.from({ length: 40 }, (_, i) => ({ ...entry, toolKey: String(i) }))).parts).toHaveLength(32)
    expect(derive([entry, entry]).parts).toHaveLength(1)
  })

  it.each(["Agent", "ImageGeneration", "BackgroundShellCreate"])("uses an ordinary group while %s is generating", toolName => {
    const result = derive([{ ...entry, toolName }])
    expect(buildAssistantContent(result.parts)[0]!.type).toBe("tool")
    expect(collectChangedFiles(result.parts)).toEqual([])
  })

  it("never counts a generated card as a changed file even if terminal status is misused", () => {
    const speculative = derive([entry]).parts[0]!
    expect(collectChangedFiles([{ ...speculative, status: "completed", input: { file_path: "index.html" } }])).toEqual([])
    expect(isToolGenerationPresentation({ ...formal, metadata: speculative.metadata })).toBe(false)
  })
})
