import { expect, it, vi } from "vitest"

const persist = vi.hoisted(() => ({ drafts: vi.fn(), notes: vi.fn() }))
vi.mock("../business-data-service", () => ({ desktopBusinessDataService: { flush: persist.drafts } }))
vi.mock("../../notes/note-service", () => ({ desktopNoteService: { flush: persist.notes } }))

import {
  acknowledgeBusinessDataFlush,
  flushDesktopBusinessData,
  markBusinessDataWindowReady,
  trackBusinessDataWindow,
} from "../window-flush"

it("waits for renderer recovery and the local Notes queue before reporting that the data is flushed", async () => {
  let requestId: unknown
  const sender = {
    id: 45, once: vi.fn(), isDestroyed: () => false,
    send: (_channel: string, id: string) => { requestId = id },
  }
  trackBusinessDataWindow(sender as never)
  markBusinessDataWindowReady(sender.id)

  let releaseNotes!: () => void
  let notesStarted!: () => void
  const started = new Promise<void>((resolve) => { notesStarted = resolve })
  persist.notes.mockImplementation(() => new Promise<void>((resolve) => {
    releaseNotes = resolve
    notesStarted()
  }))
  let complete = false
  const done = flushDesktopBusinessData(true).then(() => { complete = true })
  expect(persist.drafts).not.toHaveBeenCalled()
  expect(persist.notes).not.toHaveBeenCalled()

  acknowledgeBusinessDataFlush(sender.id, requestId, true)
  await started
  expect(persist.drafts).toHaveBeenCalledOnce()
  expect(complete).toBe(false)

  releaseNotes()
  await done
  expect(complete).toBe(true)
})
