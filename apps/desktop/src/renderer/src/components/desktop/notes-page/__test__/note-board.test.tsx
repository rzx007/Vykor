// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DndContextProps } from "@dnd-kit/core"
import { mergeNotes, reconcileOrganization } from "@rzx/client"
import { NoteBoard } from "../note-board"
import type { NoteOrganizationController } from "../use-note-organization"
import type { NoteView } from "../note-model"

const probe = vi.hoisted(() => ({ props: {} as DndContextProps, reduced: false }))
vi.mock("@dnd-kit/core", async (original) => {
  const actual = await original<typeof import("@dnd-kit/core")>()
  return {
    ...actual,
    DndContext: (props: DndContextProps) => {
      probe.props = props
      return <actual.DndContext {...props} />
    },
  }
})
vi.mock("motion/react", async (original) => ({
  ...(await original<typeof import("motion/react")>()),
  useReducedMotion: () => probe.reduced,
}))
vi.mock("../note-folder", () => ({
  NoteFolder: ({
    name,
    open,
    children,
    onOpenChange,
    renameRequested,
  }: {
    name: string
    open: boolean
    children: React.ReactNode
    onOpenChange: (value: boolean) => void
    renameRequested?: boolean
  }) => (
    <div>
      <button aria-label={`打开文件夹：${name}`} onClick={() => onOpenChange(true)}>
        {name}
      </button>
      {open ? children : null}
      {renameRequested ? <input aria-label={`重命名：${name}`} readOnly value={name} /> : null}
    </div>
  ),
}))
vi.mock("../note-list", () => ({
  NotePaperCard: ({
    note,
    overlay,
    buttonProps,
  }: {
    note: NoteView
    overlay?: boolean
    buttonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>
  }) => (
    <button {...buttonProps} aria-label={overlay ? "浮动便签" : note.content}>
      {note.content}
    </button>
  ),
}))

const notes: NoteView[] = ["a", "b", "c"].map((id) => ({
  draftId: id,
  noteId: id,
  content: id,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  recovered: false,
}))
describe("note board drag sessions", () => {
  let root: Root
  let container: HTMLDivElement
  let controller: NoteOrganizationController
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    probe.reduced = false
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    controller = {
      snapshot: {
        organization: reconcileOrganization(undefined, ["a", "b", "c"]).organization,
        etag: "e1",
        readOnly: false,
      },
      readOnly: false,
      saving: false,
      error: null,
      warning: undefined,
      refresh: vi.fn(),
      retry: vi.fn(),
      change: vi.fn(),
      reorder: vi.fn(async () => true),
      mergeNotes: vi.fn(async () => "created-folder"),
      moveToFolder: vi.fn(async () => true),
      moveToDesktop: vi.fn(async () => true),
      renameFolder: vi.fn(async () => true),
      dissolveFolder: vi.fn(async () => true),
    } as unknown as NoteOrganizationController
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
  async function show(boardNotes = notes) {
    await act(async () => {
      root.render(
        <NoteBoard
          notes={boardNotes}
          organization={controller}
          query=""
          loading={false}
          onCreate={vi.fn()}
          selectedKey={null}
          onSelect={vi.fn()}
          onAppearanceChange={vi.fn()}
          onDelete={vi.fn()}
        />
      )
    })
  }
  const start = (id = "note:a", keyboard = false) =>
    probe.props.onDragStart?.({
      active: { id },
      activatorEvent: keyboard
        ? new KeyboardEvent("keydown", { code: "Space" })
        : new MouseEvent("mousedown"),
    } as unknown as Parameters<NonNullable<DndContextProps["onDragStart"]>>[0])
  const over = (id: string | null) =>
    probe.props.onDragMove?.({ over: id ? { id } : null } as Parameters<
      NonNullable<DndContextProps["onDragMove"]>
    >[0])
  const drop = (id: string | null) =>
    probe.props.onDragEnd?.({ over: id ? { id } : null } as Parameters<
      NonNullable<DndContextProps["onDragEnd"]>
    >[0])
  it("sorts short hovers, merges at 250ms, and keeps the threshold with reduced motion", async () => {
    probe.reduced = true
    await show()
    act(() => {
      start()
      over("note:b")
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(249)
      drop("note:b")
    })
    expect(controller.mergeNotes).not.toHaveBeenCalled()
    expect(controller.reorder).toHaveBeenCalledWith("desktop", "a", 1)
    act(() => {
      start()
      over("note:b")
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(container.querySelector('[data-merge-target="true"]')).not.toBeNull()
    await act(async () => drop("note:b"))
    expect(controller.mergeNotes).toHaveBeenCalledWith("a", "b")
  })
  it("cancels without saving and clears merge intentions when scrolling or leaving", async () => {
    await show()
    act(() => {
      start()
      over("note:b")
    })
    await act(async () => vi.advanceTimersByTimeAsync(250))
    act(() => window.dispatchEvent(new Event("scroll")))
    expect(container.querySelector('[data-merge-target="true"]')).toBeNull()
    await act(async () => {
      over(null)
      probe.props.onDragCancel?.({} as never)
    })
    expect(controller.mergeNotes).not.toHaveBeenCalled()
    expect(controller.reorder).not.toHaveBeenCalled()
    expect(container.textContent).toContain("已取消整理")
  })

  it("renames the created folder even when an older folder has a future timestamp", async () => {
    controller.snapshot!.organization = mergeNotes(
      reconcileOrganization(undefined, ["a", "b", "c", "d"]).organization,
      {
        activeNoteId: "c",
        targetNoteId: "d",
        folderId: "old-folder",
        folderName: "旧夹",
        now: Date.now() + 100000,
      }
    )
    vi.mocked(controller.mergeNotes).mockImplementation(async (activeNoteId, targetNoteId) => {
      controller.snapshot!.organization = mergeNotes(controller.snapshot!.organization, {
        activeNoteId,
        targetNoteId,
        folderId: "created-folder",
        folderName: "新夹",
        now: Date.now(),
      })
      return "created-folder"
    })
    await show([...notes, { ...notes[0]!, draftId: "d", noteId: "d", content: "d" }])
    act(() => {
      start()
      over("note:b")
    })
    await act(async () => vi.advanceTimersByTimeAsync(250))
    await act(async () => drop("note:b"))
    expect(container.querySelector('input[aria-label="重命名：新夹"]')).not.toBeNull()
    expect(container.querySelector('input[aria-label="重命名：旧夹"]')).toBeNull()
  })
  it("opens a hovered folder at 400ms and saves insertion only on release", async () => {
    controller.snapshot!.organization = mergeNotes(controller.snapshot!.organization, {
      activeNoteId: "b",
      targetNoteId: "c",
      folderId: "f1",
      folderName: "工作",
      now: 1,
    })
    await show()
    act(() => {
      start()
      over("folder:f1")
    })
    await act(async () => vi.advanceTimersByTimeAsync(399))
    expect(container.querySelector('[data-note-container="f1"]')).toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(container.querySelector('[data-note-container="f1"]')).not.toBeNull()
    expect(controller.moveToFolder).not.toHaveBeenCalled()
    await act(async () => drop("container:f1"))
    expect(controller.moveToFolder).toHaveBeenCalledWith("a", "f1", 2)
  })

  it("keeps pinned notes on the desktop instead of merging or filing them", async () => {
    controller.snapshot!.organization = mergeNotes(controller.snapshot!.organization, {
      activeNoteId: "b",
      targetNoteId: "c",
      folderId: "f1",
      folderName: "工作",
      now: 1,
    })
    await show([{ ...notes[0]!, pinned: true }, notes[1]!, notes[2]!])
    act(() => {
      start("note:a")
      over("folder:f1")
    })
    await act(async () => vi.advanceTimersByTimeAsync(400))
    await act(async () => drop("folder:f1"))
    expect(controller.moveToFolder).not.toHaveBeenCalled()
    act(() => {
      start("note:a")
      over("note:b")
    })
    await act(async () => vi.advanceTimersByTimeAsync(250))
    await act(async () => drop("note:b"))
    expect(controller.mergeNotes).not.toHaveBeenCalled()
  })

  it("keeps the active keyboard target when picked up and put down without moving", async () => {
    await show()
    act(() => start("note:a", true))
    const rect = (left: number) => ({
      left,
      top: 0,
      right: left + 100,
      bottom: 100,
      width: 100,
      height: 100,
    })
    const ids = ["note:a", "note:b", "note:c"]
    const collision = probe.props.collisionDetection!({
      active: { id: "note:a" },
      collisionRect: rect(0),
      pointerCoordinates: null,
      droppableContainers: ids.map((id) => ({ id })),
      droppableRects: new Map(ids.map((id, index) => [id, rect(index * 150)])),
    } as unknown as Parameters<NonNullable<DndContextProps["collisionDetection"]>>[0])
    expect(collision[0]?.id).toBe("note:a")
    await act(async () => drop(String(collision[0]!.id)))
    expect(controller.reorder).not.toHaveBeenCalled()
    expect(controller.mergeNotes).not.toHaveBeenCalled()
  })

  it("uses Left for folder sorting and Alt Left for moving back to the desktop", async () => {
    controller.snapshot!.organization = mergeNotes(controller.snapshot!.organization, {
      activeNoteId: "b",
      targetNoteId: "c",
      folderId: "f1",
      folderName: "工作",
      now: 1,
    })
    await show()
    await act(async () =>
      (
        container.querySelector('button[aria-label="打开文件夹：工作"]') as HTMLButtonElement
      ).click()
    )
    act(() => {
      start("note:b", true)
      over("note:c")
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }))
    })
    expect(container.querySelector('[data-note-container="f1"]')).not.toBeNull()
    await act(async () => drop("note:c"))
    expect(controller.moveToFolder).toHaveBeenCalledWith("b", "f1", 0)
    act(() => {
      start("note:b", true)
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true })
      )
    })
    expect(container.querySelector('[data-note-container="f1"]')).toBeNull()
    await act(async () => drop("note:c"))
    expect(controller.moveToDesktop).toHaveBeenCalledWith("b", 2)
  })

  it("closes the folder at 24px before committing a pointer move to the desktop", async () => {
    controller.snapshot!.organization = mergeNotes(controller.snapshot!.organization, {
      activeNoteId: "b",
      targetNoteId: "c",
      folderId: "f1",
      folderName: "工作",
      now: 1,
    })
    await show()
    await act(async () =>
      (
        container.querySelector('button[aria-label="打开文件夹：工作"]') as HTMLButtonElement
      ).click()
    )
    const grid = container.querySelector('[data-note-container="f1"]') as HTMLElement
    grid.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) as DOMRect
    const pointer = (x: number) =>
      probe.props.collisionDetection!({
        pointerCoordinates: { x, y: 50 },
        droppableContainers: [],
        droppableRects: new Map(),
      } as unknown as Parameters<NonNullable<DndContextProps["collisionDetection"]>>[0])
    act(() => {
      start("note:b")
      pointer(123.9)
      over("container:desktop")
    })
    expect(container.querySelector('[data-note-container="f1"]')).not.toBeNull()
    await act(async () => drop("container:desktop"))
    expect(controller.moveToDesktop).not.toHaveBeenCalled()
    act(() => {
      start("note:b")
      pointer(124)
      over("container:desktop")
    })
    expect(container.querySelector('[data-note-container="f1"]')).toBeNull()
    expect(controller.moveToDesktop).not.toHaveBeenCalled()
    act(() => over("container:desktop"))
    await act(async () => drop("container:desktop"))
    expect(controller.moveToDesktop).toHaveBeenCalledWith("b", 2)
  })
})
