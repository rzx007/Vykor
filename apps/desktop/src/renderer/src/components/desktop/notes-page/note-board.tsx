import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { motion, useReducedMotion } from "motion/react"
import { CirclePlus, FolderClosed } from "lucide-react"
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  TouchSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable"
import { reorderInContainer, type DesktopItem, type NoteOrganizationV1Record } from "@rzx/client"
import { SPRING_LAYOUT } from "@renderer/lib/ease"
import { ProjectFolderItem } from "@renderer/components/motion/project-folder"
import { cn } from "@renderer/lib/utils"
import { NotePaperCard, type NotePaperCardProps } from "./note-list"
import { NoteFolder } from "./note-folder"
import { describeNote, type NoteView } from "./note-model"
import { projectNoteDesktop, searchNoteOrganization } from "./note-organization"
import {
  createNoteDragMachine,
  NOTE_DRAG_DISTANCE,
  outsideFolder,
  type NoteDragTarget,
} from "./note-drag-state"
import type { NoteOrganizationController } from "./use-note-organization"

const GRID =
  "grid grid-cols-[repeat(auto-fill,minmax(min(100%,200px),1fr))] items-start gap-x-6 gap-y-8 pt-3"
const dndId = (item: DesktopItem): string => `${item.type}:${item.id}`
const parseId = (id: string): DesktopItem => ({
  type: id.startsWith("folder:") ? "folder" : "note",
  id: id.slice(id.indexOf(":") + 1),
})
const containerFor = (value: NoteOrganizationV1Record, id: string): string =>
  Object.keys(value.folderItems).find((folder) => value.folderItems[folder]!.includes(id)) ??
  "desktop"

function DropGrid({ id, children, label }: { id: string; children: ReactNode; label: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: `container:${id}` })
  return (
    <div
      ref={setNodeRef}
      data-note-container={id}
      aria-label={label}
      className={cn(GRID, "min-h-48", isOver && "outline-1 outline-border outline-dashed")}
    >
      {children}
    </div>
  )
}

function SortableItem({
  item,
  disabled,
  children,
  mergeTarget,
}: {
  item: DesktopItem
  disabled: boolean
  mergeTarget: boolean
  children: (
    handle: React.ButtonHTMLAttributes<HTMLButtonElement>,
    activator: (node: HTMLElement | null) => void
  ) => ReactNode
}) {
  const reduced = useReducedMotion()
  const sortable = useSortable({ id: dndId(item), disabled })
  return (
    <motion.div
      ref={sortable.setNodeRef}
      layout={!reduced && !sortable.isDragging}
      transition={reduced ? { duration: 0 } : SPRING_LAYOUT}
      data-sortable-id={dndId(item)}
      data-merge-target={mergeTarget || undefined}
      style={{ opacity: sortable.isDragging ? 0.2 : 1 }}
      className={cn(
        "min-w-0 rounded-sm",
        mergeTarget && "outline-2 outline-offset-4 outline-foreground/40 outline-dashed"
      )}
    >
      {children(
        { ...sortable.attributes, ...sortable.listeners, style: { touchAction: "none" } },
        sortable.setActivatorNodeRef
      )}
    </motion.div>
  )
}

export function NoteBoard({
  notes,
  organization: controller,
  query,
  loading,
  onCreate,
  ...paperProps
}: {
  notes: NoteView[]
  organization: NoteOrganizationController
  query: string
  loading: boolean
  onCreate: () => void
} & Omit<NotePaperCardProps, "note">): React.JSX.Element {
  const reduced = useReducedMotion()
  const [opened, setOpened] = useState<string | null>(null)
  const [active, setActive] = useState<DesktopItem | null>(null)
  const [preview, setPreview] = useState<NoteOrganizationV1Record | null>(null)
  const [mergeTarget, setMergeTarget] = useState<string | null>(null)
  const [announcement, announce] = useState("")
  const [renameRequested, setRenameRequested] = useState<string | null>(null)
  const [dropPosition, setDropPosition] = useState<{ container: string; index: number } | null>(
    null
  )
  const drag = useRef<{
    item: DesktopItem
    source: string
    opened: string | null
    keyboard: boolean
    over: string | null
    leftFolder: boolean
    exitedFolder: string | null
  } | null>(null)
  const machine = useRef(createNoteDragMachine())
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const point = useRef<{ x: number; y: number } | null>(null)
  const currentOpen = useRef(opened)
  const closeFolder = useCallback((id: string | null): void => {
    currentOpen.current = id
    setOpened(id)
  }, [])
  const showHoverIntent = useCallback((): void => {
    const intent = machine.current.intent
    setMergeTarget(intent.type === "merge" ? intent.noteId : null)
  }, [])
  const clearHover = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
    machine.current.reset()
    showHoverIntent()
  }, [showHoverIntent])
  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current)
    },
    []
  )
  useEffect(() => {
    const resetOnScroll = (): void => {
      if (drag.current) clearHover()
    }
    window.addEventListener("scroll", resetOnScroll, true)
    return () => window.removeEventListener("scroll", resetOnScroll, true)
  }, [clearHover])
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: NOTE_DRAG_DISTANCE - 1e-6 } }),
    useSensor(TouchSensor, { activationConstraint: { distance: NOTE_DRAG_DISTANCE - 1e-6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const value = preview ?? controller.snapshot?.organization
  const original = controller.snapshot?.organization
  const projection = value ? projectNoteDesktop(value, notes) : null
  const activeNote =
    active?.type === "note" ? notes.find((note) => note.noteId === active.id) : undefined
  const leaveFolderForAction = (): void => {
    const id = currentOpen.current
    if (!id) return
    document
      .querySelector<HTMLButtonElement>(`[data-folder-id="${id}"] button[aria-haspopup="dialog"]`)
      ?.focus({ preventScroll: true })
    closeFolder(null)
  }
  const paperActions = {
    ...paperProps,
    pinDisabled: controller.readOnly,
    onSelect: (id: string) => {
      leaveFolderForAction()
      paperProps.onSelect(id)
    },
    onDelete: (id: string) => {
      leaveFolderForAction()
      paperProps.onDelete(id)
    },
  }

  const collision: CollisionDetection = useCallback(
    (args) => {
      point.current = args.pointerCoordinates
      const openedId = currentOpen.current
      const within = args.pointerCoordinates ? pointerWithin(args) : closestCenter(args)
      // 同一区域先命中夹内纸片，再命中夹内空位；桌面背景只用作最后落点。
      const folderHits = openedId
        ? within.filter((hit) => {
            const id = String(hit.id)
            return (
              id === `container:${openedId}` ||
              (id.startsWith("note:") && original?.folderItems[openedId]?.includes(parseId(id).id))
            )
          })
        : []
      const hits = folderHits.length ? folderHits : within
      const items = hits.filter(
        (hit) =>
          !String(hit.id).startsWith("container:") &&
          (drag.current?.keyboard ||
            String(hit.id) !== (drag.current ? dndId(drag.current.item) : ""))
      )
      return items.length ? items : hits.filter((hit) => String(hit.id).startsWith("container:"))
    },
    [original]
  )

  const hover = useCallback(
    (target: NoteDragTarget | null): void => {
      const session = drag.current
      if (!session) return
      const next = machine.current.enter(target, Date.now())
      showHoverIntent()
      if (!next.changed) return
      if (hoverTimer.current) clearTimeout(hoverTimer.current)
      hoverTimer.current = null
      if (!target) return
      const complete = (): void => {
        if (!session.keyboard && point.current) {
          const element = document.querySelector<HTMLElement>(
            `[data-sortable-id="${target.type}:${target.id}"]`
          )
          const rect = element?.getBoundingClientRect()
          if (
            !rect ||
            point.current.x < rect.left ||
            point.current.x > rect.right ||
            point.current.y < rect.top ||
            point.current.y > rect.bottom
          ) {
            clearHover()
            return
          }
        }
        const ready = machine.current.tick(Date.now()).intent
        showHoverIntent()
        if (ready.type === "open-folder") closeFolder(ready.folderId)
      }
      if (next.delay === null) complete()
      else hoverTimer.current = setTimeout(complete, next.delay)
    },
    [closeFolder, showHoverIntent, clearHover]
  )

  const start = (event: DragStartEvent): void => {
    if (!original || controller.readOnly) return
    const item = parseId(String(event.active.id))
    const keyboard = event.activatorEvent.type === "keydown"
    drag.current = {
      item,
      source: item.type === "note" ? containerFor(original, item.id) : "desktop",
      opened,
      keyboard,
      over: null,
      leftFolder: false,
      exitedFolder: null,
    }
    machine.current.start({ keyboard })
    setActive(item)
    setPreview(original)
  }
  const move = (event: DragMoveEvent): void => {
    const session = drag.current
    if (!session || !original) return
    const openId = currentOpen.current
    if (openId && point.current) {
      const element =
        document.querySelector<HTMLElement>(`[data-note-folder-boundary="${openId}"]`) ??
        document.querySelector<HTMLElement>(`[data-note-container="${openId}"]`)
      if (element && outsideFolder(point.current, element.getBoundingClientRect())) {
        closeFolder(null)
        session.leftFolder = true
        session.exitedFolder = openId
        session.over = null
        clearHover()
        return
      }
    }
    const overId = event.over ? String(event.over.id) : null
    session.over = overId
    if (!overId || overId === dndId(session.item)) {
      hover(null)
      setDropPosition(null)
      return
    }
    if (overId.startsWith("container:")) {
      hover(null)
      const container = overId.slice(10)
      setDropPosition({
        container,
        index:
          container === "desktop"
            ? original.desktop.length
            : (original.folderItems[container]?.length ?? 0),
      })
      return
    }
    const target = parseId(overId)
    if (
      session.item.type === "note" &&
      target.type === "folder" &&
      target.id !== session.exitedFolder
    )
      hover(target)
    else if (
      session.item.type === "note" &&
      target.type === "note" &&
      containerFor(original, target.id) === "desktop" &&
      session.source === "desktop"
    )
      hover(target)
    else hover(null)
    const destination = target.type === "folder" ? "desktop" : containerFor(original, target.id)
    const ids =
      destination === "desktop"
        ? original.desktop.map((item) => item.id)
        : original.folderItems[destination]!
    const index = ids.indexOf(target.id)
    setDropPosition({ container: destination, index })
    // 合并目标在悬停期间固定；短暂停留后松手仍按目标索引排序。
    const mergingCandidate =
      session.item.type === "note" &&
      target.type === "note" &&
      session.source === "desktop" &&
      destination === "desktop"
    if (
      destination === session.source &&
      !mergingCandidate &&
      machine.current.intent.type !== "merge"
    ) {
      if (index >= 0)
        setPreview(
          reorderInContainer(original, {
            containerId: destination,
            activeId: session.item.id,
            toIndex: index,
          })
        )
    }
  }
  const reset = (): void => {
    clearHover()
    drag.current = null
    setActive(null)
    setPreview(null)
    setDropPosition(null)
  }
  const cancel = (): void => {
    closeFolder(drag.current?.opened ?? null)
    reset()
    announce("已取消整理，已恢复原位置")
  }
  const end = (event: DragEndEvent): void => {
    const session = drag.current
    const finalIntent = machine.current.intent
    const over =
      session?.keyboard && session.leftFolder
        ? session.over
        : event.over
          ? String(event.over.id)
          : null
    const previewValue = preview
    reset()
    if (!session || !original || !over) {
      closeFolder(session?.opened ?? null)
      return
    }
    if (over === dndId(session.item)) return
    const finish = (request: Promise<boolean>, message: string): void => {
      void request.then((saved) => {
        if (!saved) closeFolder(session.opened)
        announce(saved ? message : "整理失败，已恢复原位置")
      })
    }
    if (
      session.item.type === "note" &&
      finalIntent.type === "merge" &&
      over === `note:${finalIntent.noteId}`
    ) {
      const title = describeNote(
        notes.find((note) => note.noteId === finalIntent.noteId)?.content ?? ""
      ).title
      finish(
        controller.mergeNotes(session.item.id, finalIntent.noteId).then((folderId) => {
          if (folderId) setRenameRequested(folderId)
          return folderId !== null
        }),
        `已创建文件夹${title}`
      )
      return
    }
    const target = over.startsWith("container:") ? null : parseId(over)
    const destination = over.startsWith("container:")
      ? over.slice(10)
      : target?.type === "folder"
        ? target.id
        : target
          ? containerFor(original, target.id)
          : "desktop"
    const folderReady =
      destination !== "desktop" &&
      (currentOpen.current === destination || session.source === destination)
    if (session.source !== "desktop" && destination === "desktop" && !session.leftFolder) {
      closeFolder(session.opened)
      announce("未越过文件夹边界，已恢复原位置")
      return
    }
    if (session.item.type === "note" && folderReady) {
      const ids = original.folderItems[destination] ?? []
      const index = target?.type === "note" ? ids.indexOf(target.id) : ids.length
      const position = index < 0 ? ids.length : index
      finish(
        controller.moveToFolder(session.item.id, destination, position),
        `已放入${original.folders[destination]?.name}，第${position + 1}位`
      )
    } else if (
      session.item.type === "note" &&
      session.source !== "desktop" &&
      (destination === "desktop" || session.leftFolder)
    ) {
      closeFolder(null)
      const index = target
        ? original.desktop.findIndex((item) => item.id === target.id)
        : original.desktop.length
      const position = index < 0 ? original.desktop.length : index
      finish(
        controller.moveToDesktop(session.item.id, position),
        `已移回桌面，第${position + 1}位${original.folderItems[session.source]?.length === 2 ? "，原文件夹已自动解散" : ""}`
      )
    } else if (previewValue && session.source === "desktop") {
      const index = target
        ? original.desktop.findIndex((item) => item.id === target.id)
        : over === "container:desktop"
          ? original.desktop.length - 1
          : previewValue.desktop.findIndex((item) => item.id === session.item.id)
      finish(
        controller.reorder("desktop", session.item.id, index),
        `已移动到桌面，第${index + 1}位`
      )
    }
  }

  useEffect(() => {
    const keyboardIntent = (event: KeyboardEvent): void => {
      const session = drag.current
      if (!session?.keyboard || session.item.type !== "note") return
      if (
        event.key.toLowerCase() === "m" &&
        session.over?.startsWith("note:") &&
        session.source === "desktop"
      ) {
        event.preventDefault()
        if (machine.current.merge(parseId(session.over).id)) {
          showHoverIntent()
          announce("再按空格以合成文件夹")
        }
      }
      if (event.key === "ArrowLeft" && event.altKey && session.source !== "desktop") {
        event.preventDefault()
        event.stopImmediatePropagation()
        closeFolder(null)
        session.leftFolder = true
        session.over = "container:desktop"
      }
    }
    document.addEventListener("keydown", keyboardIntent, true)
    return () => document.removeEventListener("keydown", keyboardIntent, true)
  }, [closeFolder, showHoverIntent])

  if (!value || !projection || loading)
    return (
      <div aria-label="正在加载便签" className="py-8 text-sm text-muted-foreground">
        正在读取便签…
      </div>
    )
  const renderPaper = (note: NoteView, sortable = true): ReactNode => {
    const item: DesktopItem = { type: "note", id: note.noteId ?? note.draftId }
    if (!sortable || !note.noteId)
      return <NotePaperCard key={note.draftId} note={note} {...paperActions} />
    return (
      <SortableItem
        key={dndId(item)}
        item={item}
        disabled={controller.readOnly || paperProps.selectedKey === note.draftId}
        mergeTarget={mergeTarget === item.id}
      >
        {(handle, activator) => (
          <NotePaperCard
            note={note}
            {...paperActions}
            buttonProps={handle}
            activatorRef={activator}
          />
        )}
      </SortableItem>
    )
  }
  const withDropPosition = (container: string, children: ReactNode[]): ReactNode[] => {
    if (
      !active ||
      active.type !== "note" ||
      !dropPosition ||
      dropPosition.container !== container ||
      drag.current?.source === container
    )
      return children
    const result = [...children]
    result.splice(
      dropPosition.index < 0
        ? result.length
        : Math.max(
            0,
            dropPosition.index - (container === "desktop" ? projection.pinned.length : 0)
          ),
      0,
      <div
        key="drop-position"
        aria-label="便签放置位置"
        className="aspect-square rounded-sm border border-dashed border-foreground/30 bg-foreground/3"
      />
    )
    return result
  }
  const renderFolder = (item: DesktopItem): ReactNode => {
    const folder = value.folders[item.id]
    if (!folder) return null
    const folderNotes = (value.folderItems[item.id] ?? []).flatMap(
      (id) => projection.byId.get(id) ?? []
    )
    return (
      <SortableItem
        key={dndId(item)}
        item={item}
        disabled={controller.readOnly}
        mergeTarget={false}
      >
        {(handle) => (
          <NoteFolder
            id={item.id}
            name={folder.name}
            notes={folderNotes}
            open={opened === item.id}
            dragging={Boolean(active)}
            readOnly={controller.readOnly}
            handleProps={handle}
            onOpenChange={(next) => closeFolder(next ? item.id : null)}
            renameRequested={renameRequested === item.id}
            onRenameHandled={() => setRenameRequested(null)}
            onRename={(name) =>
              controller.renameFolder(item.id, name).then((saved) => {
                if (saved) announce(`已重命名为${name.trim()}`)
                return saved
              })
            }
            onDissolve={() => {
              closeFolder(null)
              void controller
                .dissolveFolder(item.id)
                .then((saved) =>
                  announce(
                    saved ? `已解散${folder.name}，便签已移回桌面` : "解散失败，已恢复原位置"
                  )
                )
            }}
          >
            <SortableContext
              items={folderNotes.map((note) => `note:${note.noteId}`)}
              strategy={rectSortingStrategy}
            >
              <DropGrid id={item.id} label={`文件夹${folder.name}中的便签`}>
                {withDropPosition(
                  item.id,
                  folderNotes.map((note, index) => (
                    <ProjectFolderItem key={note.draftId} id={note.draftId} index={index}>
                      {renderPaper(note)}
                    </ProjectFolderItem>
                  ))
                )}
              </DropGrid>
            </SortableContext>
          </NoteFolder>
        )}
      </SortableItem>
    )
  }
  const renderItem = (item: DesktopItem): ReactNode =>
    item.type === "folder"
      ? renderFolder(item)
      : projection.byId.get(item.id)
        ? renderPaper(projection.byId.get(item.id)!)
        : null
  const results = query.trim() ? searchNoteOrganization(value, notes, query) : null
  const desktopItems = [...projection.pinned, ...projection.desktop]
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={start}
      onDragMove={move}
      onDragOver={move}
      onDragEnd={end}
      onDragCancel={cancel}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "按空格拿起，方向键移动，再按空格放下；在另一张便签上按 M 合成文件夹，Alt 加左方向键移出文件夹，Escape 取消。",
        },
        announcements: {
          onDragStart: () => "已拿起，方向键选择位置，空格放下，Escape 取消",
          onDragOver: ({ over }) =>
            over
              ? `当前落点：${String(over.id).startsWith("folder:") ? value.folders[parseId(String(over.id)).id]?.name : String(over.id).startsWith("note:") ? describeNote(projection.byId.get(parseId(String(over.id)).id)?.content ?? "").title : "网格空位"}`
              : "没有可放置位置",
          onDragEnd: () => "已松手",
          onDragCancel: () => "已取消整理，已恢复原位置",
        },
      }}
    >
      <section aria-label="便签列表" className="min-w-0">
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>
        {results ? (
          <div className={GRID}>
            {results.folders.map(renderFolder)}
            {results.notes.map(({ note, folderName }) => (
              <div key={note.draftId}>
                {renderPaper(note, false)}
                {folderName ? (
                  <p className="mt-3 text-xs text-muted-foreground">位于：{folderName}</p>
                ) : null}
              </div>
            ))}
            {!results.folders.length && !results.notes.length ? (
              <p className="col-span-full py-8 text-sm text-muted-foreground">
                没有匹配的便签，换个关键词试试。
              </p>
            ) : null}
          </div>
        ) : (
          <SortableContext items={desktopItems.map(dndId)} strategy={rectSortingStrategy}>
            <DropGrid id="desktop" label="桌面便签和文件夹">
              <motion.button
                type="button"
                aria-label="新建便签"
                layoutId={reduced ? undefined : "note-create"}
                transition={SPRING_LAYOUT}
                onClick={(event) => {
                  event.currentTarget.focus()
                  onCreate()
                }}
                className="flex aspect-square w-full flex-col items-center justify-center gap-3 rounded-sm border border-dashed border-foreground/15 text-muted-foreground outline-none hover:bg-foreground/3 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <CirclePlus className="size-6" strokeWidth={1.75} />
                <span className="text-sm">记一句</span>
              </motion.button>
              {projection.pinned.map(renderItem)}
              {projection.drafts.map((note) => renderPaper(note, false))}
              {withDropPosition("desktop", projection.desktop.map(renderItem))}
            </DropGrid>
          </SortableContext>
        )}
      </section>
      {createPortal(
        <DragOverlay dropAnimation={null} zIndex={100}>
          {activeNote ? (
            <NotePaperCard note={activeNote} {...paperProps} overlay />
          ) : active ? (
            <div className="flex aspect-square items-center justify-center gap-3 rounded-xl bg-muted p-6">
              <FolderClosed />
              {value.folders[active.id]?.name}
            </div>
          ) : null}
        </DragOverlay>,
        document.body
      )}
    </DndContext>
  )
}
