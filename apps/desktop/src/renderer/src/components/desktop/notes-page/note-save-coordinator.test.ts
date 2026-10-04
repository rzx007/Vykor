import { VykorApiError } from "@vykor/client"
import type { DesktopNote, UpdateDesktopNoteInput } from "@shared/note-types"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { NoteRecoveryDraft, NoteRecoveryPort } from "./note-recovery"

type NoteApi = {
  create(input: { content: string }): Promise<DesktopNote>
  update(id: string, input: UpdateDesktopNoteInput): Promise<DesktopNote>
}

type Coordinator = {
  stage(draft: NoteRecoveryDraft): void
  flush(): Promise<DesktopNote | null>
  retry(): Promise<DesktopNote | null>
  snapshot(): {
    status: "idle" | "saving" | "saved" | "error" | "conflict"
    record: DesktopNote | null
    error: string | null
  }
  dispose(): void
}

async function createCoordinator(options: {
  api: NoteApi
  recovery: NoteRecoveryPort
  delayMs?: number
  record?: DesktopNote
}): Promise<Coordinator> {
  const path = "./note-save-coordinator"
  const module = (await import(/* @vite-ignore */ path).catch(() => null)) as null | {
    NoteSaveCoordinator: new (options: {
      api: NoteApi
      recovery: NoteRecoveryPort
      delayMs?: number
      record?: DesktopNote
    }) => Coordinator
  }
  expect(module).not.toBeNull()
  return new module!.NoteSaveCoordinator(options)
}

const note: DesktopNote = {
  id: "note",
  content: "v1",
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
}

const draft: NoteRecoveryDraft = {
  draftId: "draft",
  noteId: note.id,
  baseRevision: note.revision,
  content: note.content,
  updatedAt: 1,
}

function recoveryPort(): NoteRecoveryPort & {
  write: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
} {
  return { write: vi.fn(), remove: vi.fn() }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("NoteSaveCoordinator", () => {
  it("coalesces rapid edits and advances the revision in order", async () => {
    vi.useFakeTimers()
    let resolveFirst!: (value: DesktopNote) => void
    const update = vi.fn((id: string, input: UpdateDesktopNoteInput) => {
      if (input.expectedRevision === 1) {
        return new Promise<DesktopNote>((resolve) => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve({
        ...note,
        id,
        content: input.content,
        revision: input.expectedRevision + 1,
        updatedAt: 3,
      })
    })
    const coordinator = await createCoordinator({
      api: { create: vi.fn(), update },
      recovery: recoveryPort(),
      delayMs: 300,
      record: note,
    })

    coordinator.stage({ ...draft, content: "v2", updatedAt: 2 })
    await vi.advanceTimersByTimeAsync(300)
    coordinator.stage({ ...draft, content: "v3", updatedAt: 3 })
    resolveFirst({ ...note, content: "v2", revision: 2, updatedAt: 2 })
    await coordinator.flush()

    expect(update.mock.calls).toEqual([
      [note.id, { content: "v2", expectedRevision: 1 }],
      [note.id, { content: "v3", expectedRevision: 2 }],
    ])
    expect(coordinator.snapshot()).toMatchObject({
      status: "saved",
      record: { content: "v3", revision: 3 },
    })
  })

  it("does not create a blank draft and creates after the first nonblank edit", async () => {
    vi.useFakeTimers()
    const create = vi.fn(async ({ content }: { content: string }) => ({
      ...note,
      content,
    }))
    const coordinator = await createCoordinator({
      api: { create, update: vi.fn() },
      recovery: recoveryPort(),
      delayMs: 300,
    })
    const newDraft = { ...draft, noteId: null, baseRevision: null }

    coordinator.stage({ ...newDraft, content: "   " })
    await vi.advanceTimersByTimeAsync(300)
    expect(create).not.toHaveBeenCalled()
    coordinator.stage({ ...newDraft, content: "idea" })
    await vi.advanceTimersByTimeAsync(300)
    await coordinator.flush()
    expect(create).toHaveBeenCalledWith({ content: "idea" })
    expect(coordinator.snapshot()).toMatchObject({ status: "saved", record: { content: "idea" } })
  })

  it("keeps recovery after a failed save and succeeds on explicit retry", async () => {
    vi.useFakeTimers()
    const update = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockResolvedValueOnce({ ...note, content: "v2", revision: 2, updatedAt: 2 })
    const recovery = recoveryPort()
    const coordinator = await createCoordinator({
      api: { create: vi.fn(), update },
      recovery,
      delayMs: 300,
      record: note,
    })

    coordinator.stage({ ...draft, content: "v2", updatedAt: 2 })
    await vi.advanceTimersByTimeAsync(300)
    await coordinator.flush()
    expect(coordinator.snapshot()).toMatchObject({ status: "error", error: "disk unavailable" })
    expect(recovery.remove).not.toHaveBeenCalled()

    await coordinator.retry()
    expect(coordinator.snapshot()).toMatchObject({ status: "saved", record: { content: "v2" } })
    expect(recovery.remove).toHaveBeenCalledWith(draft.draftId)
  })

  it("stops automatic retries after a revision conflict", async () => {
    vi.useFakeTimers()
    const update = vi.fn().mockRejectedValue(new VykorApiError("conflict", 409, {}))
    const coordinator = await createCoordinator({
      api: { create: vi.fn(), update },
      recovery: recoveryPort(),
      delayMs: 300,
      record: note,
    })

    coordinator.stage({ ...draft, content: "v2", updatedAt: 2 })
    await vi.advanceTimersByTimeAsync(300)
    await coordinator.flush()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(update).toHaveBeenCalledTimes(1)
    expect(coordinator.snapshot()).toMatchObject({ status: "conflict", error: "conflict" })
  })
})
