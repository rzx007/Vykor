// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopNote } from "@shared/note-types"
import { writeRecoveryDraft, writeSelectedNoteId } from "./note-recovery"
import type { NoteView } from "./note-model"
import type { NoteSaveStatus } from "./note-save-coordinator"

interface Controller {
  notes: NoteView[]
  visibleNotes: NoteView[]
  selectedKey: string | null
  content: string
  query: string
  status: "loading" | NoteSaveStatus
  error: string | null
  setQuery(value: string): void
  createDraft(): void
  select(draftId: string): Promise<void>
  edit(content: string): void
  retrySave(): Promise<void>
  reloadConflict(): Promise<void>
  saveConflictAsNew(): Promise<void>
  removeSelected(): Promise<void>
}

async function loadHook(): Promise<() => Controller> {
  const path = "./use-notes-controller"
  const module = (await import(/* @vite-ignore */ path).catch(() => null)) as null | {
    useNotesController(): Controller
  }
  expect(module).not.toBeNull()
  return module!.useNotesController
}

const first: DesktopNote = {
  id: "n1",
  content: "first",
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
}
const second: DesktopNote = {
  id: "n2",
  content: "second",
  revision: 1,
  createdAt: 2,
  updatedAt: 2,
}

describe("useNotesController", () => {
  let container: HTMLDivElement
  let root: Root
  let latest: Controller

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function render(
    list: DesktopNote[],
    overrides: Record<string, unknown> = {}
  ): Promise<void> {
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: {
        notes: {
          list: vi.fn(async () => list),
          create: vi.fn(async ({ content }: { content: string }) => ({
            id: "created",
            content,
            revision: 1,
            createdAt: 3,
            updatedAt: 3,
          })),
          update: vi.fn(
            async (id: string, input: { content: string; expectedRevision: number }) => ({
              ...(list.find((note) => note.id === id) ?? first),
              id,
              content: input.content,
              revision: input.expectedRevision + 1,
              updatedAt: 4,
            })
          ),
          remove: vi.fn(async () => undefined),
          ...overrides,
        },
      },
    })
    const useNotesController = await loadHook()
    function Harness(): null {
      latest = useNotesController()
      return null
    }
    await act(async () => {
      root.render(<Harness />)
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it("restores the last persisted selection and overlays newer recovery content", async () => {
    writeSelectedNoteId(localStorage, first.id)
    writeRecoveryDraft(localStorage, {
      draftId: "recovery-n2",
      noteId: second.id,
      baseRevision: second.revision,
      content: "recovered second",
      updatedAt: 10,
    })

    await render([first, second])

    expect(latest.selectedKey).toBe(first.id)
    expect(latest.content).toBe("first")
    expect(latest.notes.find((note) => note.noteId === second.id)).toMatchObject({
      draftId: "recovery-n2",
      content: "recovered second",
      recovered: true,
    })
  })

  it("keeps a new blank draft local and creates it after nonblank input", async () => {
    vi.useFakeTimers()
    const create = vi.fn(async ({ content }: { content: string }) => ({
      id: "created",
      content,
      revision: 1,
      createdAt: 3,
      updatedAt: 3,
    }))
    await render([], { create })
    expect(latest.visibleNotes).toEqual([])

    act(() => latest.edit("   "))
    await act(async () => vi.advanceTimersByTimeAsync(300))
    expect(create).not.toHaveBeenCalled()
    expect(latest.visibleNotes).toEqual([])

    act(() => latest.edit("idea"))
    await act(async () => vi.advanceTimersByTimeAsync(300))
    await act(async () => Promise.resolve())
    expect(create).toHaveBeenCalledWith({ content: "idea" })
    expect(latest.visibleNotes).toHaveLength(1)
    expect(latest.notes.find((note) => note.noteId === "created")?.content).toBe("idea")
  })

  it("flushes the current note before selecting another note", async () => {
    vi.useFakeTimers()
    writeSelectedNoteId(localStorage, first.id)
    const update = vi.fn(
      async (id: string, input: { content: string; expectedRevision: number }) => ({
        ...first,
        id,
        content: input.content,
        revision: input.expectedRevision + 1,
        updatedAt: 4,
      })
    )
    await render([first, second], { update })

    act(() => latest.edit("changed"))
    await act(async () => latest.select(second.id))

    expect(update).toHaveBeenCalledWith(first.id, {
      content: "changed",
      expectedRevision: 1,
    })
    expect(latest.selectedKey).toBe(second.id)
    expect(latest.content).toBe("second")
  })

  it("keeps the selected note visible when deletion fails", async () => {
    const remove = vi.fn().mockRejectedValue(new Error("delete failed"))
    await render([first], { remove })

    await act(async () => latest.removeSelected())

    expect(remove).toHaveBeenCalledWith(first.id)
    expect(latest.notes).toHaveLength(1)
    expect(latest.content).toBe(first.content)
    expect(latest.status).toBe("error")
    expect(latest.error).toBe("delete failed")
  })

  it("waits for an in-flight create before deleting a new note", async () => {
    vi.useFakeTimers()
    let resolveCreate!: (note: DesktopNote) => void
    const create = vi.fn(
      () =>
        new Promise<DesktopNote>((resolve) => {
          resolveCreate = resolve
        })
    )
    const remove = vi.fn(async () => undefined)
    await render([], { create, remove })

    act(() => latest.edit("temporary"))
    await act(async () => vi.advanceTimersByTimeAsync(300))
    let deletion!: Promise<void>
    await act(async () => {
      deletion = latest.removeSelected()
      await Promise.resolve()
    })
    expect(remove).not.toHaveBeenCalled()

    resolveCreate({
      id: "created",
      content: "temporary",
      revision: 1,
      createdAt: 3,
      updatedAt: 3,
    })
    await act(async () => deletion)

    expect(remove).toHaveBeenCalledWith("created")
    expect(latest.visibleNotes).toEqual([])
  })
})
