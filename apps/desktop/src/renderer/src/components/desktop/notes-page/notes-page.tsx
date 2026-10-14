import { useId, useRef, useState } from "react"
import { LayoutGroup } from "motion/react"
import {
  CircleAlert,
  CirclePlus,
  FolderClosed,
  FolderOpen,
  PanelsTopLeft,
  Search,
} from "lucide-react"

import { ProjectFolder } from "@renderer/components/motion/project-folder"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@renderer/components/ui/alert"
import { Button } from "@renderer/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@renderer/components/ui/input-group"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group"
import { toast } from "@renderer/lib/toast"
import { NoteDeleteDialog } from "./note-delete-dialog"
import { NoteDetail } from "./note-detail"
import { describeNote, filterAndSortNotes } from "./note-model"
import { NoteList } from "./note-list"
import { useNotesController } from "./use-notes-controller"

function NoteSearch({
  query,
  onChange,
}: {
  query: string
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <InputGroup shape="pill">
      <InputGroupAddon>
        <Search strokeWidth={1.75} />
      </InputGroupAddon>
      <InputGroupInput
        aria-label="搜索便签"
        placeholder="找回一句想法…"
        value={query}
        onChange={(event) => onChange(event.target.value)}
      />
    </InputGroup>
  )
}

export function NotesPage(): React.JSX.Element {
  const notes = useNotesController()
  const layoutGroupId = useId()
  const returnFocus = useRef<HTMLElement | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailSource, setDetailSource] = useState<string | undefined>()
  const [gridOrder, setGridOrder] = useState<string[]>([])
  const [mode, setMode] = useState<"desk" | "collection">("desk")
  const [folderOpen, setFolderOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const selected = notes.notes.find((note) => note.draftId === notes.selectedKey)
  const papers = filterAndSortNotes(
    notes.notes.filter((note) => note.noteId !== null || Boolean(note.content.trim())),
    ""
  )
  const previews = papers.slice(0, 5).map((note) => ({
    id: note.draftId,
    content: (
      <span
        data-note-color={note.color ?? "default"}
        className="note-paper flex h-full flex-col gap-2 px-3 py-4 text-left"
      >
        <span className="line-clamp-3 text-xs font-medium break-words text-foreground">
          {describeNote(note.content).title}
        </span>
        <span className="line-clamp-4 text-xs leading-5 break-words text-muted-foreground">
          {describeNote(note.content).preview}
        </span>
      </span>
    ),
  }))

  const changeMode = (next: "desk" | "collection"): void => {
    if (next === "collection") void notes.flushSelected()
    setFolderOpen(false)
    setMode(next)
  }
  const prepareDetail = (source: string): void => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setGridOrder(notes.visibleNotes.map((note) => note.draftId))
    setDetailSource(source)
    setExpanded(false)
  }
  const createNote = (): void => {
    prepareDetail("note-create")
    setFolderOpen(false)
    setMode("desk")
    notes.createDraft()
    setDetailOpen(true)
  }
  const selectNote = async (draftId: string): Promise<void> => {
    prepareDetail(`note-${draftId}`)
    await notes.select(draftId)
    setFolderOpen(false)
    setMode("desk")
    setDetailOpen(true)
  }
  const closeDetail = (): void => {
    setDetailOpen(false)
    // 保存失败时仍保留本地草稿，并在列表上方显示处理入口。
    void notes.flushSelected()
  }
  const orderedNotes = gridOrder.length
    ? [...notes.visibleNotes].sort((left, right) => {
        const leftIndex = gridOrder.indexOf(left.draftId)
        const rightIndex = gridOrder.indexOf(right.draftId)
        return (
          (leftIndex < 0 ? gridOrder.length : leftIndex) -
          (rightIndex < 0 ? gridOrder.length : rightIndex)
        )
      })
    : notes.visibleNotes
  const list = (showCreate = false): React.JSX.Element => (
    <NoteList
      notes={orderedNotes}
      showCreate={showCreate}
      selectedKey={detailOpen ? notes.selectedKey : null}
      query={notes.query}
      loading={notes.status === "loading"}
      onCreate={createNote}
      onSelect={(draftId) => void selectNote(draftId)}
      onAppearanceChange={notes.setAppearance}
      onDelete={(draftId) => {
        setFolderOpen(false)
        setDeleteTarget(draftId)
        setDeleteOpen(true)
      }}
    />
  )

  return (
    <LayoutGroup id={layoutGroupId}>
      <section className="@container/notes flex h-full min-h-0 w-full flex-col overflow-hidden bg-background">
        <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-border/60 px-5 py-2 @3xl/notes:px-8">
          <h1 className="mr-2 text-lg font-semibold tracking-tight">便签</h1>
          <ToggleGroup
            aria-label="便签展示形态"
            value={[mode]}
            onValueChange={(value) => {
              if (value[0] === "desk" || value[0] === "collection") changeMode(value[0])
            }}
            size="sm"
          >
            <ToggleGroupItem value="desk" aria-label="桌面形态">
              <PanelsTopLeft data-icon="inline-start" />
              桌面
            </ToggleGroupItem>
            <ToggleGroupItem value="collection" aria-label="收纳形态">
              <FolderClosed data-icon="inline-start" />
              收纳
            </ToggleGroupItem>
          </ToggleGroup>
          <div className="ml-auto w-40 flex-1 @3xl/notes:max-w-64">
            <NoteSearch
              query={notes.query}
              onChange={(query) => {
                notes.setQuery(query)
                if (query) setExpanded(false)
              }}
            />
          </div>
          <Button
            shape="pill"
            aria-label="新建便签"
            disabled={notes.status === "loading"}
            onClick={(event) => {
              event.currentTarget.focus()
              createNote()
            }}
          >
            <CirclePlus data-icon="inline-start" />
            记一句
          </Button>
        </header>

        <ScrollArea
          horizontal={false}
          aria-label="滚动查看便签"
          className="min-h-0 flex-1"
          viewportClassName="h-full"
        >
          <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-5 py-8 @3xl/notes:px-8 @3xl/notes:py-10">
            {mode === "desk" ? (
              <div className="min-w-0">
                <div className="mb-5 flex items-center justify-between gap-3">
                  <h2 className="text-sm font-medium">{notes.query ? "找到的便签" : "最近写下"}</h2>
                  <Button
                    variant="ghost"
                    size="xs"
                    shape="pill"
                    onClick={() => changeMode("collection")}
                  >
                    收纳夹 · {papers.length}
                  </Button>
                </div>
                {notes.error ? (
                  <Alert variant="destructive" className="mb-6">
                    <CircleAlert />
                    <AlertTitle>
                      {notes.status === "conflict" ? "便签内容发生冲突" : "保存失败，草稿已保留"}
                    </AlertTitle>
                    <AlertDescription>{notes.error}</AlertDescription>
                    <AlertAction>
                      <Button
                        variant="ghost"
                        size="xs"
                        shape="pill"
                        onClick={() => {
                          if (selected) void selectNote(selected.draftId)
                        }}
                      >
                        返回便签处理
                      </Button>
                    </AlertAction>
                  </Alert>
                ) : null}
                {list(true)}
                {notes.query && notes.visibleNotes.length === 0 ? (
                  <p className="mt-6 text-sm text-muted-foreground">
                    没有匹配的便签，换个关键词试试。
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="flex flex-1 flex-col items-center">
                {notes.error ? (
                  <Alert variant="destructive" className="mb-8 w-full max-w-2xl">
                    <CircleAlert />
                    <AlertTitle>
                      {notes.status === "conflict" ? "便签内容发生冲突" : "保存失败，草稿已保留"}
                    </AlertTitle>
                    <AlertDescription>{notes.error}</AlertDescription>
                    <AlertAction>
                      <Button
                        variant="ghost"
                        size="xs"
                        shape="pill"
                        onClick={() => changeMode("desk")}
                      >
                        返回便签处理
                      </Button>
                    </AlertAction>
                  </Alert>
                ) : null}
                <div className="flex min-h-80 flex-col items-center justify-center gap-7 py-12">
                  <ProjectFolder
                    title="便签收纳夹"
                    count={papers.length}
                    previews={previews}
                    ariaLabel="打开便签收纳夹"
                    disabled={notes.status === "loading"}
                    expanded={folderOpen}
                    onExpandedChange={setFolderOpen}
                    expandedContent={
                      <div className="flex flex-col gap-6">
                        <div className="max-w-sm">
                          <NoteSearch query={notes.query} onChange={notes.setQuery} />
                        </div>
                        {list()}
                      </div>
                    }
                  />
                  <p aria-live="polite" className="text-sm text-muted-foreground">
                    {notes.status === "saving"
                      ? "正在存好这句想法…"
                      : notes.error
                        ? "先保留在这里，内容还在。"
                        : "纸片收好了，想用时再取出来。"}
                  </p>
                </div>
                {notes.query ? <div className="w-full">{list()}</div> : null}
                <Button variant="ghost" shape="pill" onClick={createNote}>
                  <CirclePlus data-icon="inline-start" />
                  再记一句
                </Button>
              </div>
            )}
            <footer className="mt-auto flex items-center justify-between gap-4 pt-10 text-xs text-muted-foreground">
              <span>
                {papers.length ? papers.length + " 句想法，留在这里。" : "从一句话开始。"}
              </span>
              <Button
                size="xs"
                variant="ghost"
                shape="pill"
                onClick={() => {
                  void window.desktop.notes
                    .openDirectory()
                    .catch((cause) => toast.error("无法打开便签文件夹", String(cause)))
                }}
              >
                <FolderOpen data-icon="inline-start" />
                打开便签文件夹
              </Button>
            </footer>
          </div>
        </ScrollArea>
        <NoteDetail
          open={detailOpen}
          returnFocus={returnFocus}
          layoutId={detailSource}
          selected={selected}
          content={notes.content}
          status={notes.status}
          error={notes.error}
          expanded={expanded}
          onExpand={() => setExpanded((current) => !current)}
          onClose={closeDetail}
          onExitComplete={() => {
            if (notes.selectedKey) notes.discardEmptyDraft(notes.selectedKey)
            setGridOrder([])
          }}
          onChange={notes.edit}
          onAppearanceChange={(patch) => {
            if (notes.selectedKey) notes.setAppearance(notes.selectedKey, patch)
          }}
          onRetry={() => void notes.retrySave()}
          onReloadConflict={() => void notes.reloadConflict()}
          onSaveConflictAsNew={() => void notes.saveConflictAsNew()}
          onDelete={() => {
            setDeleteTarget(notes.selectedKey)
            setDeleteOpen(true)
          }}
        />
        <NoteDeleteDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          onConfirm={() => {
            setDeleteOpen(false)
            if (deleteTarget) {
              void notes.removeSelected(deleteTarget).then(() => {
                if (deleteTarget === notes.selectedKey) setDetailOpen(false)
              })
            }
          }}
        />
      </section>
    </LayoutGroup>
  )
}
